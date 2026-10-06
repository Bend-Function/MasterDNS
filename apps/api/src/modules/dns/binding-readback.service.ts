import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { dnsRecordInputSchema, type ProviderRecord } from "@masterdns/contracts";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { bindingAssignments, dnsRecords, domainBindings, endpointPools, operationSteps, providerAccounts, zones } from "@masterdns/db";
import { createProviderAdapter, dnsRecordMatches, providerRecordHash, type ProviderCredentials } from "@masterdns/providers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DnsZoneLease } from "@masterdns/automation";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { DatabaseService } from "../../infrastructure/database.module.js";

type Transaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export type BindingDeleteTarget = { record: typeof dnsRecords.$inferSelect; endpointId?: string | undefined };
const uncertainMessage = "DNS 写入结果尚未确认，无法安全核对该绑定的记录，请先恢复或核对失败的 DNS 操作";
const normalizeName = (name: string) => name.toLowerCase().replace(/\.$/, "");
// Persisted Pool records support the PostgreSQL integer TTL range, which is
// wider than the manual-record input limit. Preserve every other DNS check.
const poolRecordInputSchema = dnsRecordInputSchema.safeExtend({ ttl: z.number().int().min(1).max(2_147_483_647) });

@Injectable()
export class BindingReadbackService {
  // Called only with the Zone lease and Pool/binding locks held. Provider reads
  // establish the deletion targets; the API never writes to the provider.
  async resolveDeletion(tx: Transaction, pool: typeof endpointPools.$inferSelect, binding: typeof domainBindings.$inferSelect,
    uncertain: (typeof operationSteps.$inferSelect)[], lease: DnsZoneLease, unpublishedOnly: boolean): Promise<BindingDeleteTarget[]> {
    const [snapshot] = await tx.select({ zone: zones, account: providerAccounts }).from(zones)
      .innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id)).where(eq(zones.id, binding.zoneId));
    if (!snapshot) throw new NotFoundException("绑定对应的 Zone 不存在");
    const { zone, account } = snapshot;
    if (account.ownerUserId !== pool.ownerUserId) throw new ConflictException(uncertainMessage);
    if (account.status === "disabled" || zone.status === "disabled") throw new ConflictException("DNS 账号或 Zone 已停用，请先启用后核对记录");
    if (account.status !== "active") throw new ConflictException("DNS 账号存在错误，请先恢复或验证账号后核对记录");
    const intended = uncertain.map(step => {
      const parsed = poolRecordInputSchema.safeParse(step.input.record);
      if (!parsed.success || step.providerAccountId !== account.id || step.zoneId !== zone.id
        || step.input.zoneExternalId !== zone.externalId || step.input.poolId !== pool.id
        || step.input.bindingId !== binding.id || step.input.management !== "managed"
        || parsed.data.type !== binding.recordType || normalizeName(parsed.data.name) !== normalizeName(binding.fqdn)
        || (step.action === "update" && typeof step.input.recordExternalId !== "string")) throw new ConflictException(uncertainMessage);
      return { step, record: parsed.data };
    });
    const assignments = await tx.select({ assignment: bindingAssignments, record: dnsRecords }).from(bindingAssignments)
      .innerJoin(dnsRecords, eq(bindingAssignments.dnsRecordId, dnsRecords.id)).where(eq(bindingAssignments.domainBindingId, binding.id));
    const inventory = await tx.select().from(dnsRecords).where(and(eq(dnsRecords.zoneId, zone.id),
      eq(dnsRecords.managedByPoolId, pool.id), eq(dnsRecords.management, "managed"), isNull(dnsRecords.deletedAt),
      eq(dnsRecords.type, binding.recordType), sql`lower(rtrim(${dnsRecords.name}, '.')) = ${normalizeName(binding.fqdn)}`));
    const local = new Map([...inventory, ...assignments.map(row => row.record)].map(record => [record.externalId, record]));
    for (const record of local.values()) {
      if (record.zoneId !== zone.id || record.management !== "managed" || record.managedByPoolId !== pool.id
        || record.type !== binding.recordType || normalizeName(record.name) !== normalizeName(binding.fqdn)) throw new ConflictException(uncertainMessage);
    }
    let credentials: ProviderCredentials;
    try {
      credentials = decryptJson<ProviderCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv,
        tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, parseEncryptionKey(env.MASTER_ENCRYPTION_KEY));
    } catch {
      throw new ConflictException("DNS 凭据无法解密，请先恢复账号凭据后核对记录");
    }
    if (credentials.provider !== account.provider) throw new ConflictException(uncertainMessage);
    const adapter = createProviderAdapter(credentials);
    const records: ProviderRecord[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      lease.assertOwned();
      const page = await adapter.listRecords(zone.externalId, cursor);
      lease.assertOwned();
      if (!Array.isArray(page.items)) throw new ConflictException(uncertainMessage);
      for (const record of page.items) {
        if (!record || typeof record.externalId !== "string" || !record.externalId || seenIds.has(record.externalId) || record.zoneExternalId !== zone.externalId
          || typeof record.name !== "string" || !record.name || typeof record.type !== "string" || !record.type || typeof record.content !== "string"
          || !Number.isInteger(record.ttl) || record.ttl < 1 || !record.providerMetadata || typeof record.providerMetadata !== "object"
          || Array.isArray(record.providerMetadata)) throw new ConflictException(uncertainMessage);
        seenIds.add(record.externalId);
        records.push(record);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !cursor || seenCursors.has(cursor) || seenCursors.size >= 1_000) throw new ConflictException(uncertainMessage);
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    // Credentials and ownership may change during a slow provider read. Lock the
    // current identity after reading, verify it, and protect it through commit.
    const [currentZone] = await tx.select().from(zones).where(eq(zones.id, zone.id)).for("share");
    const [currentAccount] = await tx.select().from(providerAccounts).where(eq(providerAccounts.id, account.id)).for("share");
    if (!currentZone || !currentAccount || currentZone.providerAccountId !== account.id || currentZone.externalId !== zone.externalId
      || currentZone.status !== zone.status || currentAccount.ownerUserId !== account.ownerUserId
      || currentAccount.provider !== account.provider || currentAccount.status !== account.status
      || currentAccount.credentialCiphertext !== account.credentialCiphertext || currentAccount.credentialIv !== account.credentialIv
      || currentAccount.credentialTag !== account.credentialTag || currentAccount.credentialKeyVersion !== account.credentialKeyVersion) throw new ConflictException("DNS 账号或 Zone 在核对期间发生变化，请重试");
    lease.assertOwned();
    const rrset = records.filter(record => record.type === binding.recordType && normalizeName(record.name) === normalizeName(binding.fqdn));
    const owned = rrset.map(remote => {
      const current = local.get(remote.externalId);
      const match = intended.find(({ step, record }) => dnsRecordMatches(remote, record)
        && (step.action === "create" || step.input.recordExternalId === remote.externalId));
      if (current) {
        const expected = poolRecordInputSchema.safeParse({ ...current, priority: current.priority ?? undefined });
        if (!expected.success || (!dnsRecordMatches(remote, expected.data) && !match)) throw new ConflictException(uncertainMessage);
      } else if (!match) throw new ConflictException("发现不属于该绑定的同名 DNS 记录，请先人工核对后再删除");
      return { remote, current, endpointId: assignments.find(row => row.record.id === current?.id)?.assignment.endpointId };
    });
    // A known ID outside the expected RRset is not proof of absence.
    for (const record of records) {
      if (local.has(record.externalId) && !rrset.includes(record)) throw new ConflictException(uncertainMessage);
      if (intended.some(({ step }) => step.action === "update" && step.input.recordExternalId === record.externalId)
        && !rrset.includes(record)) throw new ConflictException(uncertainMessage);
    }
    if (unpublishedOnly && owned.length > 0) throw new ConflictException("该绑定已完成发布，请刷新页面并在 Pool 中确认删除已发布记录");
    const targets: BindingDeleteTarget[] = [];
    for (const { remote, current, endpointId } of owned) {
      const [existing] = current ? [current] : await tx.select().from(dnsRecords).where(and(eq(dnsRecords.zoneId, zone.id), eq(dnsRecords.externalId, remote.externalId))).for("update");
      // Synced unmanaged records can be adopted by exact failed-write evidence;
      // another Pool or binding's inventory must never be reassigned.
      if (existing && existing.managedByPoolId && existing.managedByPoolId !== pool.id) throw new ConflictException(uncertainMessage);
      if (existing) {
        const [other] = await tx.select({ id: bindingAssignments.domainBindingId }).from(bindingAssignments).where(and(
          eq(bindingAssignments.dnsRecordId, existing.id), sql`${bindingAssignments.domainBindingId} <> ${binding.id}`)).limit(1);
        if (other) throw new ConflictException(uncertainMessage);
      }
      const values = { zoneId: zone.id, externalId: remote.externalId, type: remote.type, name: remote.name, content: remote.content,
        ttl: remote.ttl, priority: remote.priority ?? null, providerMetadata: remote.providerMetadata, remoteHash: providerRecordHash(remote),
        management: "managed" as const, managedByPoolId: pool.id, deletedAt: null, lastSyncedAt: new Date(), updatedAt: new Date() };
      const [record] = existing
        ? await tx.update(dnsRecords).set(values).where(eq(dnsRecords.id, existing.id)).returning()
        : await tx.insert(dnsRecords).values(values).returning();
      if (!record) throw new Error("DNS readback adoption returned no row");
      targets.push({ record, endpointId });
    }
    const absent = [...local.values()].filter(record => !rrset.some(remote => remote.externalId === record.externalId));
    if (absent.length > 0) {
      const ids = absent.map(record => record.id);
      await tx.update(bindingAssignments).set({ applied: false, dnsRecordId: null, updatedAt: new Date() })
        .where(and(eq(bindingAssignments.domainBindingId, binding.id), inArray(bindingAssignments.dnsRecordId, ids)));
      await tx.update(dnsRecords).set({ deletedAt: new Date(), management: "unmanaged", managedByPoolId: null, updatedAt: new Date() }).where(inArray(dnsRecords.id, ids));
    }
    lease.assertOwned();
    return targets;
  }
}

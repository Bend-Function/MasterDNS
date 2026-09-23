import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { CloudError, createCloudAdapter, type CloudCredentials, type IdleStaticIpReleaseResult } from "@masterdns/cloud-providers";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { auditLogs, cloudAccounts, cloudIdleIpCleanups, databaseNow, idleIpReleaseInProgress, lockIdleIpAddress, recordCloudRotationThrottle, reserveCloudRotationWrite, type RotationTransaction } from "@masterdns/db";
import type { IdleIpItem, IdleIpPreview } from "@masterdns/contracts";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { env } from "../../config/env.js";
import { unresolvedRotationProtectsIdleIp, type IdleIpRotationEvidence } from "./idle-ip-rotation-protection.js";

type Account = typeof cloudAccounts.$inferSelect;
type Batch = typeof cloudIdleIpCleanups.$inferSelect;
const fingerprint = (account: Account) => createHash("sha256").update(account.credentialCiphertext).digest("hex");
const settled = (item: IdleIpItem) => ["released", "missing", "skipped", "failed"].includes(item.status);
const safeError = (error: unknown) => error instanceof CloudError ? error.code : "query_failed";

@Injectable()
export class CloudIdleIpsService {
  private readonly key = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService) {}

  private async account(actor: AuthUser, id: string, write = false) {
    const [account] = await this.database.db.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)));
    if (!account) throw new NotFoundException("Cloud account not found");
    if (account.provider !== "aws") throw new BadRequestException("Lightsail cleanup requires AWS");
    if (!account.externalAccountId || (write && !account.enabled)) throw new ConflictException("Cloud account unavailable");
    return account;
  }
  private async adapter(account: Account) {
    const credentials = decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.key);
    const adapter = createCloudAdapter({ accountId: account.id, provider: "aws", service: "lightsail", credentials });
    if ((await adapter.verifyIdentity()).externalAccountId !== account.externalAccountId) throw new ConflictException("Cloud account identity changed");
    if (!adapter.listIdleStaticIps || !adapter.releaseIdleStaticIp || !adapter.observeIdleStaticIp) throw new ConflictException("Idle cleanup unavailable");
    return adapter;
  }
  private public(batch: Batch): IdleIpPreview {
    return { id: batch.id, accountId: batch.accountId, regions: batch.regions, items: batch.items, scanErrors: batch.scanErrors, confirmedAt: batch.confirmedAt?.toISOString() ?? null, expiresAt: batch.expiresAt.toISOString(), createdAt: batch.createdAt.toISOString() };
  }
  async list(actor: AuthUser, accountId: string) {
    await this.account(actor, accountId);
    const rows = await this.database.db.select().from(cloudIdleIpCleanups).where(eq(cloudIdleIpCleanups.accountId, accountId)).orderBy(desc(cloudIdleIpCleanups.createdAt)).limit(20);
    const unresolved = await this.database.db.select().from(cloudIdleIpCleanups).where(and(eq(cloudIdleIpCleanups.accountId, accountId), sql`exists(select 1 from jsonb_array_elements(${cloudIdleIpCleanups.items}) item where item->>'status' in ('in_flight','pending','waiting'))`)).orderBy(desc(cloudIdleIpCleanups.createdAt));
    return [...new Map([...unresolved, ...rows].map(row => [row.id, this.public(row)])).values()];
  }
  async detail(actor: AuthUser, accountId: string, id: string) {
    await this.account(actor, accountId);
    const [batch] = await this.database.db.select().from(cloudIdleIpCleanups).where(and(eq(cloudIdleIpCleanups.id, id), eq(cloudIdleIpCleanups.accountId, accountId)));
    if (!batch) throw new NotFoundException("Cleanup not found");
    return this.public(batch);
  }
  async preview(actor: AuthUser, accountId: string) {
    const account = await this.account(actor, accountId, true);
    const adapter = await this.adapter(account);
    const regions = [...new Set((await adapter.listScopes()).filter(region => account.regions === null || account.regions.includes(region)))].sort();
    const items: IdleIpItem[] = [], scanErrors: Batch["scanErrors"] = [];
    for (const region of regions) {
      try {
        const targets = await adapter.listIdleStaticIps!(region);
        for (const target of targets) if (!items.some(item => item.arn === target.arn)) items.push({ ...target, status: "ready" });
      } catch (error) { scanErrors.push({ region, reason: safeError(error) }); }
    }
    return this.database.db.transaction(async tx => {
      const current = await this.lockAccount(tx, actor, accountId);
      if (!current.enabled || fingerprint(current) !== fingerprint(account) || JSON.stringify(current.regions) !== JSON.stringify(account.regions)) throw new ConflictException("Cloud account changed; scan again");
      const now = await databaseNow(tx);
      for (const item of items.sort((a, b) => a.address.localeCompare(b.address) || a.arn.localeCompare(b.arn))) {
        const reason = await this.protected(tx, account.externalAccountId!, item);
        if (reason) { item.status = "skipped"; item.reason = reason; }
      }
      const [batch] = await tx.insert(cloudIdleIpCleanups).values({ accountId, ownerUserId: account.ownerUserId, actorUserId: actor.id, externalAccountId: account.externalAccountId!, credentialFingerprint: fingerprint(account), regions, items, scanErrors, expiresAt: new Date(now.getTime() + 15 * 60_000) }).returning();
      return this.public(batch!);
    });
  }
  async confirm(actor: AuthUser, accountId: string, id: string) {
    await this.account(actor, accountId, true);
    return this.database.db.transaction(async tx => {
      const account = await this.lockAccount(tx, actor, accountId);
      const batch = await this.lockBatch(tx, accountId, id);
      if (batch.confirmedAt) return this.public(batch);
      const now = await databaseNow(tx);
      if (batch.expiresAt <= now) throw new ConflictException("Preview expired; scan again");
      this.assertWritable(account, batch);
      const [confirmed] = await tx.update(cloudIdleIpCleanups).set({ confirmedAt: now, updatedAt: now }).where(eq(cloudIdleIpCleanups.id, id)).returning();
      await this.audit(tx, batch, actor.id, "lightsail.idle_cleanup.confirm", { regions: batch.regions, count: batch.items.filter(item => item.status === "ready").length });
      return this.public(confirmed!);
    });
  }
  async execute(actor: AuthUser, accountId: string, id: string, index: number) {
    const account = await this.account(actor, accountId);
    const adapter = await this.adapter(account);
    const claim = await this.database.db.transaction(async tx => {
      const current = await this.lockAccount(tx, actor, accountId);
      // Same remote-account mutex as rotation admission, including credential aliases.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["aws", current.externalAccountId, "lightsail"])}, 624713))`);
      const batch = await this.lockBatch(tx, accountId, id);
      const now = await databaseNow(tx), item = batch.items[index];
      if (!Number.isInteger(index) || index < 0 || !item) throw new BadRequestException("Invalid cleanup item");
      if (!batch.confirmedAt) throw new ConflictException("confirmation_required");
      if (settled(item)) return null;
      if (current.externalAccountId !== batch.externalAccountId || fingerprint(current) !== fingerprint(account)) throw new ConflictException("Cloud account identity changed");
      if (item.status === "in_flight" || item.status === "pending") {
        if (item.retryAt && new Date(item.retryAt) > now) return null;
        item.retryAt = new Date(now.getTime() + 15_000).toISOString();
        await tx.update(cloudIdleIpCleanups).set({ items: batch.items, updatedAt: now }).where(eq(cloudIdleIpCleanups.id, id));
        return { item, observe: true };
      }
      this.assertWritable(current, batch);
      if (current.regions !== null && !current.regions.includes(item.region)) throw new ConflictException("Region excluded; scan again");
      const reason = await this.protected(tx, current.externalAccountId!, item);
      if (reason) {
        item.status = reason === "cleanup_in_progress" ? "waiting" : "skipped"; item.reason = reason;
        if (item.status === "waiting") item.retryAt = new Date(now.getTime() + 5000).toISOString();
      } else {
        const admission = await reserveCloudRotationWrite(tx, { accountId, service: "lightsail", region: item.region, stepId: `idle:${id}:${index}`, action: "lightsail.static-ip.release", idleCleanupId: id });
        if (!admission.allowed) { item.status = "waiting"; item.reason = admission.reason; item.retryAt = admission.retryAt.toISOString(); }
        else { item.status = "in_flight"; item.dispatchId = randomUUID(); item.dispatchedAt = now.toISOString(); item.retryAt = new Date(now.getTime() + 30_000).toISOString(); delete item.reason; }
      }
      await tx.update(cloudIdleIpCleanups).set({ items: batch.items, updatedAt: now }).where(eq(cloudIdleIpCleanups.id, id));
      await this.audit(tx, batch, actor.id, "lightsail.idle_cleanup.item", { index, address: item.address, status: item.status, reason: item.reason });
      return item.status === "in_flight" ? { item, observe: false } : null;
    });
    if (!claim) return this.detail(actor, accountId, id);
    let result: Omit<IdleStaticIpReleaseResult, "status"> & { status: IdleIpItem["status"]; retryAt?: string };
    try { result = claim.observe ? await adapter.observeIdleStaticIp!(claim.item) : await adapter.releaseIdleStaticIp!(claim.item); }
    catch (error) {
      // This adapter throws only before mutation; all uncertain outcomes after
      // dispatch are returned as pending receipts and are observed without retry.
      const definite = !claim.observe;
      result = { status: definite ? "failed" : "pending", reason: safeError(error), ...(definite ? { rejectedNoEffect: true } : {}), ...(error instanceof CloudError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
    }
    if (result.rejectedNoEffect) result.status = result.reason === "rate_limited" ? "waiting" : "failed";
    if (result.reason === "rate_limited") {
      const retryAt = await this.database.db.transaction(tx => recordCloudRotationThrottle(tx, { accountId, service: "lightsail", region: claim.item.region, stepId: `idle:${id}:${index}`, action: "lightsail.static-ip.release", ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) }));
      result.retryAt = retryAt.toISOString();
    }
    await this.database.db.transaction(async tx => {
      const batch = await this.lockBatch(tx, accountId, id), item = batch.items[index]!;
      if (settled(item) || item.dispatchId !== claim.item.dispatchId || (claim.observe && item.status === "waiting")) return;
      const { rejectedNoEffect: _rejected, retryAfterMs: _retryAfterMs, ...publicResult } = result;
      const updated = { ...item, ...publicResult };
      if (settled(updated)) { delete updated.retryAt; if (!result.reason) delete updated.reason; }
      else if (!result.retryAt) updated.retryAt = new Date(Date.now() + 15_000).toISOString();
      batch.items[index] = updated;
      await tx.update(cloudIdleIpCleanups).set({ items: batch.items, updatedAt: new Date() }).where(eq(cloudIdleIpCleanups.id, id));
      await this.audit(tx, batch, actor.id, "lightsail.idle_cleanup.result", { index, address: item.address, ...result });
    });
    return this.detail(actor, accountId, id);
  }
  private assertWritable(account: Account, batch: Batch) {
    if (!account.enabled || account.externalAccountId !== batch.externalAccountId || fingerprint(account) !== batch.credentialFingerprint) throw new ConflictException("Cloud account changed; scan again");
  }
  private async lockAccount(tx: RotationTransaction, actor: AuthUser, id: string) {
    const [account] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).for("update");
    if (!account || account.provider !== "aws") throw new NotFoundException("Cloud account not found");
    return account;
  }
  private async lockBatch(tx: RotationTransaction, accountId: string, id: string) {
    const [batch] = await tx.select().from(cloudIdleIpCleanups).where(and(eq(cloudIdleIpCleanups.id, id), eq(cloudIdleIpCleanups.accountId, accountId))).for("update");
    if (!batch) throw new NotFoundException("Cleanup not found");
    return batch;
  }
  private async protected(tx: RotationTransaction, externalAccountId: string, item: IdleIpItem) {
    await lockIdleIpAddress(tx, item.address);
    const candidate = await tx.execute(sql`select 1 from rotation_resources r join rotation_incidents i on i.id=r.incident_id
      join managed_address_slots s on s.id=i.slot_id join cloud_interfaces f on f.id=s.interface_id
      join cloud_instances v on v.id=f.instance_id join cloud_accounts a on a.id=v.account_id
      where a.provider='aws' and a.external_account_id=${externalAccountId} and v.service='lightsail' and v.region=${item.region}
      and i.status<>'complete' and r.attempt_id=i.current_attempt_id and r.role='candidate'
      and (r.address=${item.address} or r.allocation_id=${item.name} or r.resource_id=${item.arn}) limit 1`);
    if (candidate.length) return "rotation_in_progress";
    const unresolved = await tx.execute<IdleIpRotationEvidence>(sql`select st.id as "stepId", st.attempt_id as "attemptId", st.plan, st.receipt,
      a.id as "accountId", a.external_account_id as "externalAccountId", v.region, v.external_id as "instanceId", f.external_id as "interfaceId", s.id as "slotId",
      coalesce((select jsonb_agg(jsonb_build_object('allocationId',r.allocation_id,'resourceId',r.resource_id,'address',r.address,'role',r.role,'cleanupStepId',r.cleanup_step_id))
        from rotation_resources r where r.attempt_id=st.attempt_id or r.cleanup_step_id=st.id), '[]'::jsonb) as resources
      from rotation_leases l join rotation_steps st on st.id=l.unresolved_step_id
      join rotation_attempts t on t.id=st.attempt_id join rotation_incidents i on i.id=t.incident_id
      join managed_address_slots s on s.id=i.slot_id join cloud_interfaces f on f.id=s.interface_id
      join cloud_instances v on v.id=f.instance_id join cloud_accounts a on a.id=v.account_id
      where a.provider='aws' and a.external_account_id=${externalAccountId} and v.service='lightsail' and v.region=${item.region}`);
    if (unresolved.some(step => unresolvedRotationProtectsIdleIp(item, step))) return "rotation_in_progress";
    if (await idleIpReleaseInProgress(tx, externalAccountId, item.region)) return "cleanup_in_progress";
    return undefined;
  }
  private audit(tx: RotationTransaction, batch: Batch, actorUserId: string, action: string, value: unknown) {
    return tx.insert(auditLogs).values({ ownerUserId: batch.ownerUserId, actorUserId, source: "user", action, resourceType: "idle_ip_cleanup", resourceId: batch.id, afterSnapshot: value });
  }
}

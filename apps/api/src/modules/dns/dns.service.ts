import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createZoneInputSchema, createZonesInputSchema, ProviderError, type CreateZoneInput, type CreateZonesInput, type DnsRecordInput, type ZoneCreationResult, type ZoneCreationSuccess } from "@masterdns/contracts";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { CloudflareDnsAdapter, type ProviderCredentials } from "@masterdns/providers";
import { addressHealthPolicies, addressHealthStates, auditLogs, cloudAccounts, cloudEndpointLinks, cloudInstances, cloudInterfaces, dnsRecords, domainBindings, endpointPools, endpoints, getCloudTargetsForSlots, healthCheckConfigs, managedAddressSlots, operationSteps, probeGroups, providerAccounts, rotationPublications, zones } from "@masterdns/db";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { OperationsService } from "../operations/operations.service.js";
import { normalizeRecordName } from "./dns-name.js";

@Injectable()
export class DnsService {
  private readonly logger = new Logger(DnsService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
    private readonly operations: OperationsService,
  ) {}

  async listZones(actor: AuthUser) {
    const rows = await this.database.db.select({ zone: zones, accountName: providerAccounts.name, provider: providerAccounts.provider, ownerUserId: providerAccounts.ownerUserId })
      .from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
      .where(actor.role === "admin" ? undefined : eq(providerAccounts.ownerUserId, actor.id))
      .orderBy(asc(zones.nameAscii));
    // The stored status governs local availability. Activation is remote state.
    return rows.map(row => ({ ...row, zone: { ...row.zone, status: row.zone.status === "active" && ["pending", "initializing", "moved"].includes(String(row.zone.providerMetadata.zoneStatus)) ? "pending" : row.zone.status } }));
  }

  async createZone(actor: AuthUser, input: CreateZoneInput): Promise<ZoneCreationSuccess> {
    const parsed = createZoneInputSchema.parse(input);
    const account = await this.findZoneCreationAccount(actor, parsed.providerAccountId);
    const credentials = decryptJson<ProviderCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, parseEncryptionKey(env.MASTER_ENCRYPTION_KEY));
    if (credentials.provider !== "cloudflare") throw new ConflictException("DNS 账号凭据类型不匹配，请重新接入账号");
    const adapter = new CloudflareDnsAdapter(credentials.apiToken);
    const target = { name: parsed.name, accountId: parsed.cloudflareAccountId };
    let remote = await adapter.findZone(target);
    let status: ZoneCreationSuccess["status"] = "existing";
    if (!remote) {
      try {
        remote = await adapter.createZone(target);
        status = "created";
      } catch (error) {
        // A duplicate or timed-out POST may already have created the zone.
        // Only a scoped read can establish that; never replay the POST here.
        if (!(error instanceof ProviderError) || !["transient_failure", "conflict", "validation_failed"].includes(error.code)) throw error;
        try { remote = await adapter.findZone(target); } catch { throw error; }
        if (!remote) throw error;
      }
    }
    if (remote.name !== parsed.name || remote.providerMetadata.accountId !== parsed.cloudflareAccountId) throw new ConflictException("Cloudflare 返回的域名或账号不匹配，请核对 Account ID");
    const result = await this.database.db.transaction(async tx => {
      const [current] = await tx.select().from(providerAccounts).where(eq(providerAccounts.id, account.id)).for("share");
      if (!current || current.ownerUserId !== account.ownerUserId || current.status !== "active" || current.provider !== account.provider || current.credentialCiphertext !== account.credentialCiphertext || current.credentialIv !== account.credentialIv || current.credentialTag !== account.credentialTag || current.credentialKeyVersion !== account.credentialKeyVersion) {
        throw new ConflictException("DNS 账号在添加期间发生变化，域名可能已在 Cloudflare 创建，请同步账号后重试");
      }
      const values = { providerAccountId: account.id, externalId: remote.externalId, nameAscii: remote.name, providerMetadata: remote.providerMetadata };
      const [zone] = await tx.insert(zones).values(values).onConflictDoUpdate({ target: [zones.providerAccountId, zones.externalId], set: { nameAscii: values.nameAscii, providerMetadata: values.providerMetadata, updatedAt: new Date() } }).returning();
      if (!zone) throw new Error("Zone insert returned no row");
      const nameServers = Array.isArray(remote.providerMetadata.nameServers) ? remote.providerMetadata.nameServers.filter((name): name is string => typeof name === "string") : [];
      const created: ZoneCreationSuccess = { name: parsed.name, status, zoneId: zone.id, zoneStatus: remote.status, nameServers };
      await tx.insert(auditLogs).values({ ownerUserId: account.ownerUserId, actorUserId: actor.id, source: "user", action: status === "created" ? "zone.create" : "zone.import", resourceType: "zone", resourceId: zone.id, afterSnapshot: created });
      return created;
    });
    // Redis may keep an offline producer request pending indefinitely. The
    // optional record sync must not hold the durable domain response open.
    const syncFailed = () => { this.logger.warn(`Zone ${result.zoneId} added; record sync could not be queued`); };
    try {
      void this.queues.sync.add("sync-zone", { providerAccountId: account.id, zoneId: result.zoneId }, { jobId: `zone-sync-${result.zoneId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 500 }).catch(syncFailed);
    } catch { syncFailed(); }
    return result;
  }

  async createZones(actor: AuthUser, input: CreateZonesInput): Promise<{ results: ZoneCreationResult[] }> {
    const parsed = createZonesInputSchema.parse(input);
    await this.findZoneCreationAccount(actor, parsed.providerAccountId);
    const results: ZoneCreationResult[] = [];
    for (const name of parsed.names) {
      try { results.push(await this.createZone(actor, { providerAccountId: parsed.providerAccountId, cloudflareAccountId: parsed.cloudflareAccountId, name })); }
      catch (error) { results.push({ name, status: "failed", error: zoneCreationError(error) }); }
    }
    return { results };
  }

  private async findZoneCreationAccount(actor: AuthUser, id: string) {
    const [account] = await this.database.db.select().from(providerAccounts).where(and(eq(providerAccounts.id, id), actor.role === "admin" ? undefined : eq(providerAccounts.ownerUserId, actor.id))).limit(1);
    if (!account) throw new NotFoundException("DNS 账号不存在");
    if (account.provider !== "cloudflare") throw new BadRequestException("新增域名目前仅支持 Cloudflare");
    if (account.status !== "active") throw new ConflictException("DNS 账号已停用或存在错误，请先恢复账号");
    return account;
  }

  async listRecords(actor: AuthUser, zoneId: string) {
    await this.findOwnedZone(actor, zoneId);
    return this.database.db.select().from(dnsRecords)
      .where(and(eq(dnsRecords.zoneId, zoneId), isNull(dnsRecords.deletedAt)))
      .orderBy(asc(dnsRecords.name), asc(dnsRecords.type));
  }

  async listBindings(actor: AuthUser, zoneId: string) {
    const zone = await this.findOwnedZone(actor, zoneId);
    const rows = await this.database.db.select({ binding: domainBindings, poolName: endpointPools.name })
      .from(domainBindings).innerJoin(endpointPools, eq(endpointPools.id, domainBindings.poolId))
      .where(and(eq(domainBindings.zoneId, zoneId), eq(endpointPools.ownerUserId, zone.ownerUserId)))
      .orderBy(asc(domainBindings.fqdn), asc(domainBindings.recordType));
    if (!rows.length) return [];
    const poolIds = [...new Set(rows.map(row => row.binding.poolId))];
    const [links, records, pending] = await Promise.all([
      this.database.db.select({ poolId: endpoints.poolId, endpointId: endpoints.id, slotId: cloudEndpointLinks.slotId })
        .from(cloudEndpointLinks).innerJoin(endpoints, eq(endpoints.id, cloudEndpointLinks.endpointId))
        .innerJoin(managedAddressSlots, eq(managedAddressSlots.id, cloudEndpointLinks.slotId))
        .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
        .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
        .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
        .where(and(inArray(endpoints.poolId, poolIds), eq(cloudAccounts.ownerUserId, zone.ownerUserId))),
      this.listRecords(actor, zoneId),
      this.database.db.select({ bindingId: sql<string>`${operationSteps.input}->>'bindingId'`, status: operationSteps.status, action: operationSteps.action, attempts: operationSteps.attempts }).from(operationSteps)
        .where(and(eq(operationSteps.zoneId, zoneId), inArray(operationSteps.status, ["pending", "running", "failed", "skipped"]))),
    ]);
    const slotIds = [...new Set(links.map(link => link.slotId))];
    const targets = await getCloudTargetsForSlots(this.database.db, slotIds);
    const [policies, states, publications, configs, groups] = slotIds.length ? await Promise.all([
      this.database.db.select().from(addressHealthPolicies).where(inArray(addressHealthPolicies.slotId, slotIds)),
      this.database.db.select().from(addressHealthStates).where(inArray(addressHealthStates.slotId, slotIds)),
      this.database.db.select().from(rotationPublications).where(inArray(rotationPublications.slotId, slotIds)).orderBy(desc(rotationPublications.addressVersion)),
      this.database.db.select().from(healthCheckConfigs).where(inArray(healthCheckConfigs.slotId, slotIds)),
      this.database.db.select({ group: probeGroups }).from(probeGroups).innerJoin(addressHealthPolicies, eq(addressHealthPolicies.groupId, probeGroups.id)).where(inArray(addressHealthPolicies.slotId, slotIds)),
    ]) : [[], [], [], [], []];
    return rows.map(({ binding, poolName }) => {
      const sources = links.filter(link => link.poolId === binding.poolId && (!binding.originalEndpointId || link.endpointId === binding.originalEndpointId))
        .flatMap(link => { const target = targets.get(link.slotId); return target && target.slot.family === (binding.recordType === "AAAA" ? "6" : "4") ? [target] : []; });
      const published = records.some(record => record.managedByPoolId === binding.poolId && record.name.replace(/\.$/, "").toLowerCase() === binding.fqdn.replace(/\.$/, "").toLowerCase() && record.type === binding.recordType);
      const inProgress = pending.some(step => step.bindingId === binding.id && (step.status === "pending" || step.status === "running"));
      const uncertain = pending.some(step => step.bindingId === binding.id && (step.status === "failed" || step.status === "skipped") && step.attempts > 0 && (step.action === "create" || step.action === "update"));
      let waitingReason: string | null = null;
      if (inProgress) waitingReason = "DNS 变更正在排队或执行，完成后可删除绑定";
      else if (uncertain) waitingReason = "DNS 写入结果尚未确认，请先恢复或核对失败的 DNS 操作";
      else if (!published) {
        waitingReason = "等待健康验证及 DNS 发布，请打开 Pool 查看详情";
        for (const source of sources) {
          const policy = policies.find(item => item.slotId === source.slot.id);
          const config = configs.find(item => item.id === policy?.configId);
          const group = groups.find(item => item.group.id === policy?.groupId)?.group;
          const state = states.find(item => item.slotId === source.slot.id);
          const address = source.candidateAddress ?? source.currentAddress;
          const version = source.candidateAddress ? source.slot.candidateVersion : source.slot.currentVersion;
          const publication = publications.find(item => item.slotId === source.slot.id && item.addressVersion === version);
          if (!policy || policy.mode === "local" || !config?.enabled || !group) { waitingReason = "需要为云地址配置外部 Agent 健康策略"; break; }
          if (publication?.errorCode) { waitingReason = `地址发布受阻：${publication.errorCode}`; break; }
          if (!state || state.addressId !== address?.id || state.addressVersion !== version || state.policyId !== policy.id || state.policyRevision !== policy.revision || state.configId !== config.id || state.configVersion !== config.revision || state.groupRevision !== group.revision || state.healthState !== "healthy" || state.latestDecision !== "success" || state.consecutiveSuccesses < policy.successThreshold || !state.evidenceExpiresAt || state.evidenceExpiresAt <= new Date()) {
            waitingReason = "等待外部 Agent 对当前地址完成连续成功验证";
            break;
          }
          waitingReason = "已收到外部成功结果，等待云地址确认及 DNS 发布";
        }
      }
      return { ...binding, poolName, published, inProgress, cancellationBlocked: inProgress || uncertain, waitingReason, cloudSources: sources };
    });
  }

  async syncZone(actor: AuthUser, zoneId: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    await this.queues.sync.add("sync-zone", { providerAccountId: owned.providerAccountId, zoneId }, { jobId: `zone-sync-${zoneId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 500 });
    return { queued: true };
  }

  async createRecord(actor: AuthUser, zoneId: string, record: DnsRecordInput, idempotencyKey?: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    const normalized = normalizeRecordName(record, owned.nameAscii);
    await this.assertUnboundName(zoneId, normalized);
    return this.operations.createDnsOperation({
      ownerUserId: owned.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      idempotencyKey: idempotencyKey ?? randomUUID(),
      providerAccountId: owned.providerAccountId,
      zoneId,
      zoneExternalId: owned.externalId,
      action: "create",
      record: normalized,
    });
  }

  async updateRecord(actor: AuthUser, zoneId: string, recordId: string, record: DnsRecordInput, idempotencyKey?: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    const current = await this.findRecord(zoneId, recordId);
    if (current.management === "managed") throw new ConflictException("该记录由 IP Pool 管理，请修改对应策略");
    const normalized = normalizeRecordName(record, owned.nameAscii);
    await this.assertUnboundName(zoneId, normalized);
    return this.operations.createDnsOperation({
      ownerUserId: owned.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      idempotencyKey: idempotencyKey ?? randomUUID(),
      providerAccountId: owned.providerAccountId,
      zoneId,
      zoneExternalId: owned.externalId,
      action: "update",
      dnsRecordId: current.id,
      recordExternalId: current.externalId,
      record: normalized,
      beforeSnapshot: current,
    });
  }

  async deleteRecord(actor: AuthUser, zoneId: string, recordId: string, idempotencyKey?: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    const current = await this.findRecord(zoneId, recordId);
    if (current.management === "managed") throw new ConflictException("该记录由 IP Pool 管理，请先解除或删除对应策略");
    return this.operations.createDnsOperation({
      ownerUserId: owned.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      idempotencyKey: idempotencyKey ?? randomUUID(),
      providerAccountId: owned.providerAccountId,
      zoneId,
      zoneExternalId: owned.externalId,
      action: "delete",
      dnsRecordId: current.id,
      recordExternalId: current.externalId,
      beforeSnapshot: current,
    });
  }

  private async assertUnboundName(zoneId: string, record: DnsRecordInput) {
    const [binding] = await this.database.db.select({ id: domainBindings.id }).from(domainBindings)
      .where(and(eq(domainBindings.zoneId, zoneId), eq(domainBindings.fqdn, record.name), eq(domainBindings.recordType, record.type))).limit(1);
    if (binding) throw new ConflictException("该记录由 IP Pool 管理，请修改对应策略");
  }

  private async findOwnedZone(actor: AuthUser, zoneId: string) {
    const rows = await this.database.db.select({
      id: zones.id,
      externalId: zones.externalId,
      nameAscii: zones.nameAscii,
      providerAccountId: zones.providerAccountId,
      ownerUserId: providerAccounts.ownerUserId,
    }).from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
      .where(and(eq(zones.id, zoneId), actor.role === "admin" ? undefined : eq(providerAccounts.ownerUserId, actor.id))).limit(1);
    if (!rows[0]) throw new NotFoundException("域名不存在");
    return rows[0];
  }

  private async findRecord(zoneId: string, recordId: string) {
    const [record] = await this.database.db.select().from(dnsRecords).where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.zoneId, zoneId))).limit(1);
    if (!record || record.deletedAt) throw new NotFoundException("解析记录不存在");
    return record;
  }
}

function zoneCreationError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError) return { code: error.code, message: error.message };
  if (error instanceof HttpException) return { code: error.getStatus() === 404 ? "not_found" : error.getStatus() === 409 ? "conflict" : "request_failed", message: error.message };
  return { code: "internal_error", message: "添加失败，域名可能已在 Cloudflare 创建，请同步账号后重试" };
}

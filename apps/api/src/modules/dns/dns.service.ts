import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DnsRecordInput } from "@masterdns/contracts";
import { addressHealthPolicies, addressHealthStates, cloudAccounts, cloudEndpointLinks, cloudInstances, cloudInterfaces, dnsRecords, domainBindings, endpointPools, endpoints, getCloudTargetsForSlots, healthCheckConfigs, managedAddressSlots, operationSteps, probeGroups, providerAccounts, rotationPublications, zones } from "@masterdns/db";
import { randomUUID } from "node:crypto";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { OperationsService } from "../operations/operations.service.js";
import { normalizeRecordName } from "./dns-name.js";

@Injectable()
export class DnsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
    private readonly operations: OperationsService,
  ) {}

  async listZones(actor: AuthUser) {
    return this.database.db.select({ zone: zones, accountName: providerAccounts.name, provider: providerAccounts.provider, ownerUserId: providerAccounts.ownerUserId })
      .from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
      .where(actor.role === "admin" ? undefined : eq(providerAccounts.ownerUserId, actor.id))
      .orderBy(asc(zones.nameAscii));
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

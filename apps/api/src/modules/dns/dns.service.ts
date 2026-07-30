import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DnsRecordInput } from "@masterdns/contracts";
import { dnsRecords, providerAccounts, zones } from "@masterdns/db";
import { randomUUID } from "node:crypto";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { OperationsService } from "../operations/operations.service.js";

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

  async syncZone(actor: AuthUser, zoneId: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    await this.queues.sync.add("sync-zone", { providerAccountId: owned.providerAccountId, zoneId }, { jobId: `zone-sync-${zoneId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 500 });
    return { queued: true };
  }

  async createRecord(actor: AuthUser, zoneId: string, record: DnsRecordInput, idempotencyKey?: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    return this.operations.createDnsOperation({
      ownerUserId: owned.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      idempotencyKey: idempotencyKey ?? randomUUID(),
      providerAccountId: owned.providerAccountId,
      zoneId,
      zoneExternalId: owned.externalId,
      action: "create",
      record: normalizeRecordName(record, owned.nameAscii),
    });
  }

  async updateRecord(actor: AuthUser, zoneId: string, recordId: string, record: DnsRecordInput, idempotencyKey?: string) {
    const owned = await this.findOwnedZone(actor, zoneId);
    const current = await this.findRecord(zoneId, recordId);
    if (current.management === "managed") throw new ConflictException("该记录由 IP Pool 管理，请修改对应策略");
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
      record: normalizeRecordName(record, owned.nameAscii),
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

function normalizeRecordName(record: DnsRecordInput, zoneName: string): DnsRecordInput {
  const name = record.name.replace(/\.$/, "").toLowerCase();
  const zone = zoneName.replace(/\.$/, "").toLowerCase();
  if (name === "@" || name === zone) return { ...record, name: zone };
  if (name.endsWith(`.${zone}`)) return { ...record, name };
  if (!name.includes(".")) return { ...record, name: `${name}.${zone}` };
  throw new ConflictException("主机记录不属于当前域名");
}

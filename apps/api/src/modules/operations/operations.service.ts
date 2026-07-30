import { randomUUID } from "node:crypto";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { dnsRecordInputSchema, type DnsRecordInput, type OperationSource } from "@masterdns/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { dnsRecords, operationSteps, operations, providerAccounts, zones } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";

type DnsOperationInput = {
  ownerUserId: string;
  actorUserId: string;
  source: OperationSource;
  idempotencyKey: string;
  providerAccountId: string;
  zoneId: string;
  zoneExternalId: string;
  action: "create" | "update" | "delete";
  dnsRecordId?: string;
  recordExternalId?: string;
  record?: DnsRecordInput;
  beforeSnapshot?: unknown;
};

@Injectable()
export class OperationsService {
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async createDnsOperation(input: DnsOperationInput) {
    const result = await this.database.db.transaction(async (tx) => {
      const [operation] = await tx.insert(operations).values({
        ownerUserId: input.ownerUserId,
        actorUserId: input.actorUserId,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        resourceType: "dns_record",
        ...(input.dnsRecordId ? { resourceId: input.dnsRecordId } : {}),
        ...(input.beforeSnapshot !== undefined ? { beforeSnapshot: input.beforeSnapshot } : {}),
        ...(input.record !== undefined ? { desiredSnapshot: input.record } : {}),
      }).onConflictDoNothing({ target: operations.idempotencyKey }).returning();
      if (!operation) {
        const [existing] = await tx.select().from(operations).where(eq(operations.idempotencyKey, input.idempotencyKey)).limit(1);
        if (!existing) throw new Error("Idempotent operation lookup returned no row");
        if (existing.ownerUserId !== input.ownerUserId) throw new ConflictException("幂等键已被其他资源使用");
        return { operation: existing, created: false };
      }
      await tx.insert(operationSteps).values({
        operationId: operation.id,
        sequence: 1,
        providerAccountId: input.providerAccountId,
        zoneId: input.zoneId,
        ...(input.dnsRecordId ? { dnsRecordId: input.dnsRecordId } : {}),
        action: input.action,
        input: {
          zoneExternalId: input.zoneExternalId,
          ...(input.recordExternalId ? { recordExternalId: input.recordExternalId } : {}),
          ...(input.record ? { record: input.record } : {}),
        },
      });
      return { operation, created: true };
    });
    if (result.created) {
      await this.queues.operations.add("execute-operation", { operationId: result.operation.id }, {
        jobId: result.operation.id,
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    }
    return result.operation;
  }

  async list(actor: AuthUser, limit = 50) {
    const rows = await this.database.db.select().from(operations)
      .where(actor.role === "admin" ? undefined : eq(operations.ownerUserId, actor.id))
      .orderBy(desc(operations.createdAt)).limit(Math.min(limit, 200));
    return rows;
  }

  async get(actor: AuthUser, id: string) {
    const [operation] = await this.database.db.select().from(operations).where(eq(operations.id, id)).limit(1);
    if (!operation || (actor.role !== "admin" && operation.ownerUserId !== actor.id)) throw new NotFoundException("操作不存在");
    const steps = await this.database.db.select().from(operationSteps).where(eq(operationSteps.operationId, id));
    return { ...operation, steps };
  }

  async rollback(actor: AuthUser, id: string, idempotencyKey: string = randomUUID()) {
    const original = await this.get(actor, id);
    if (original.resourceType !== "dns_record") throw new ConflictException("自动化记录必须通过策略版本回滚");
    if (original.status !== "succeeded") throw new ConflictException("只有完整成功的 DNS 操作可以回滚");
    const step = original.steps[0];
    if (!step) throw new ConflictException("原操作没有可回滚步骤");
    const [zoneRow] = await this.database.db.select({ zone: zones, ownerUserId: providerAccounts.ownerUserId })
      .from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
      .where(eq(zones.id, step.zoneId)).limit(1);
    if (!zoneRow || zoneRow.ownerUserId !== original.ownerUserId) throw new NotFoundException("原操作对应的域名不存在");
    const [current] = step.dnsRecordId
      ? await this.database.db.select().from(dnsRecords).where(eq(dnsRecords.id, step.dnsRecordId)).limit(1)
      : [];
    if (current?.management === "managed") throw new ConflictException("该记录现已由 IP Pool 管理，请通过策略回滚");

    if (step.action === "create") {
      if (!current || current.deletedAt) throw new ConflictException("原操作创建的记录当前已不存在");
      return this.createDnsOperation({
        ownerUserId: original.ownerUserId,
        actorUserId: actor.id,
        source: "rollback",
        idempotencyKey,
        providerAccountId: step.providerAccountId,
        zoneId: step.zoneId,
        zoneExternalId: zoneRow.zone.externalId,
        action: "delete",
        dnsRecordId: current.id,
        recordExternalId: current.externalId,
        beforeSnapshot: current,
      });
    }

    const record = snapshotRecord(original.beforeSnapshot);
    if (step.action === "update") {
      if (!current || current.deletedAt) throw new ConflictException("待回滚记录当前已不存在");
      return this.createDnsOperation({
        ownerUserId: original.ownerUserId,
        actorUserId: actor.id,
        source: "rollback",
        idempotencyKey,
        providerAccountId: step.providerAccountId,
        zoneId: step.zoneId,
        zoneExternalId: zoneRow.zone.externalId,
        action: "update",
        dnsRecordId: current.id,
        recordExternalId: current.externalId,
        record,
        beforeSnapshot: current,
      });
    }

    if (current && !current.deletedAt) throw new ConflictException("同一记录已重新存在，不能直接回滚删除操作");
    return this.createDnsOperation({
      ownerUserId: original.ownerUserId,
      actorUserId: actor.id,
      source: "rollback",
      idempotencyKey,
      providerAccountId: step.providerAccountId,
      zoneId: step.zoneId,
      zoneExternalId: zoneRow.zone.externalId,
      action: "create",
      ...(current ? { dnsRecordId: current.id } : {}),
      record,
      beforeSnapshot: current,
    });
  }

  async retry(actor: AuthUser, id: string) {
    const operation = await this.get(actor, id);
    if (!["failed", "partial"].includes(operation.status)) throw new ConflictException("只有失败或部分成功的操作可以重试");
    await this.database.db.transaction(async (tx) => {
      await tx.update(operationSteps).set({ status: "pending", errorCode: null, errorDetail: null, nextRetryAt: null, finishedAt: null, updatedAt: new Date() })
        .where(and(eq(operationSteps.operationId, id), eq(operationSteps.status, "failed")));
      await tx.update(operations).set({ status: "pending", errorCode: null, finishedAt: null, updatedAt: new Date() }).where(eq(operations.id, id));
    });
    await this.queues.operations.add("execute-operation", { operationId: id }, {
      jobId: `retry-${id}-${randomUUID()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    return { queued: true };
  }

  async recoverPending() {
    const rows = await this.database.db.select({ id: operations.id }).from(operations)
      .where(inArray(operations.status, ["pending", "running"]));
    await Promise.all(rows.map(({ id }) => this.queues.operations.add("execute-operation", { operationId: id }, { jobId: id, removeOnComplete: 1000, removeOnFail: 1000 })));
    return rows.length;
  }
}

function snapshotRecord(snapshot: unknown): DnsRecordInput {
  if (!snapshot || typeof snapshot !== "object") throw new ConflictException("原操作没有可用的历史快照");
  const value = snapshot as Record<string, unknown>;
  return dnsRecordInputSchema.parse({
    type: value.type,
    name: value.name,
    content: value.content,
    ttl: value.ttl,
    ...(value.priority !== null && value.priority !== undefined ? { priority: value.priority } : {}),
    providerMetadata: value.providerMetadata ?? {},
  });
}

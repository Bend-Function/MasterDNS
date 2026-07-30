import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { DnsRecordInput, OperationJob, ProviderRecord } from "@masterdns/contracts";
import { ProviderError, queueNames } from "@masterdns/contracts";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  bindingAssignments,
  dnsRecords,
  domainBindings,
  endpointPools,
  operationSteps,
  operations,
  providerAccounts,
  zones,
} from "@masterdns/db";
import { providerRecordHash } from "@masterdns/providers";
import { Job, Worker } from "bullmq";
import { z } from "zod";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
import { ProviderRuntimeService } from "../providers/provider-runtime.service.js";

const stepInputSchema = z.object({
  zoneExternalId: z.string().min(1),
  recordExternalId: z.string().min(1).optional(),
  record: z.object({
    type: z.enum(["A", "AAAA", "CAA", "CNAME", "MX", "NS", "SRV", "TXT"]),
    name: z.string().min(1),
    content: z.string().min(1),
    ttl: z.number().int().positive(),
    priority: z.number().int().optional(),
    providerMetadata: z.record(z.string(), z.unknown()),
  }).optional(),
  management: z.enum(["unmanaged", "managed"]).optional(),
  poolId: z.string().uuid().optional(),
  bindingId: z.string().uuid().optional(),
  endpointId: z.string().uuid().optional(),
  assignmentMode: z.enum(["single", "set"]).optional(),
  previousEndpointIds: z.array(z.string().uuid()).optional(),
});

@Injectable()
export class OperationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperationProcessor.name);
  private worker?: Worker<OperationJob>;

  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueRuntimeService,
    private readonly providers: ProviderRuntimeService,
  ) {}

  async onModuleInit() {
    this.worker = new Worker<OperationJob>(queueNames.operations, (job) => this.process(job), {
      connection: this.queues.redis,
      concurrency: 5,
      lockDuration: 60_000,
    });
    this.worker.on("failed", (job, error) => this.logger.error(`Operation job ${job?.id ?? "unknown"} failed: ${safeError(error)}`));
    await this.recoverPending();
  }

  async onModuleDestroy() { await this.worker?.close(); }

  private async process(job: Job<OperationJob>) {
    const operationId = job.data.operationId;
    const [operation] = await this.database.db.select().from(operations).where(eq(operations.id, operationId)).limit(1);
    if (!operation || ["succeeded", "superseded"].includes(operation.status)) return;
    if (operation.resourceType === "endpoint_pool" && operation.resourceId && operation.policyRevision !== null) {
      const [pool] = await this.database.db.select({ revision: endpointPools.policyRevision }).from(endpointPools)
        .where(eq(endpointPools.id, operation.resourceId)).limit(1);
      if (!pool || pool.revision !== operation.policyRevision) {
        await this.database.db.transaction(async (tx) => {
          await tx.update(operationSteps).set({ status: "skipped", finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(operationSteps.operationId, operationId));
          await tx.update(operations).set({ status: "superseded", finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(operations.id, operationId));
        });
        return;
      }
    }
    await this.database.db.update(operations).set({ status: "running", startedAt: operation.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(operations.id, operationId));
    const steps = await this.database.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId)).orderBy(operationSteps.sequence);

    for (const step of steps) {
      if (step.status === "succeeded" || step.status === "skipped") continue;
      try {
        await this.withZoneLock(step.zoneId, () => this.executeStep(operation, step));
      } catch (error) {
        const providerError = error instanceof ProviderError
          ? error
          : new ProviderError("Unexpected operation error", "transient_failure", await this.providerForStep(step.providerAccountId), { cause: error });
        const finalAttempt = !providerError.retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        await this.database.db.update(operationSteps).set({
          status: finalAttempt ? "failed" : "pending",
          errorCode: providerError.code,
          errorDetail: providerError.message.slice(0, 512),
          nextRetryAt: finalAttempt ? null : new Date(Date.now() + (providerError.retryAfterMs ?? 1000 * 2 ** job.attemptsMade)),
          finishedAt: finalAttempt ? new Date() : null,
          updatedAt: new Date(),
        }).where(eq(operationSteps.id, step.id));
        if (["authentication_failed", "permission_denied"].includes(providerError.code)) {
          await this.database.db.update(providerAccounts).set({ status: "error", errorCode: providerError.code, updatedAt: new Date() })
            .where(eq(providerAccounts.id, step.providerAccountId));
        }
        if (!finalAttempt) throw providerError;
      }
    }

    const finalSteps = await this.database.db.select({ status: operationSteps.status, input: operationSteps.input }).from(operationSteps).where(eq(operationSteps.operationId, operationId));
    const succeeded = finalSteps.filter((step) => ["succeeded", "skipped"].includes(step.status)).length;
    const failed = finalSteps.filter((step) => step.status === "failed").length;
    const status = failed === 0 ? "succeeded" : succeeded === 0 ? "failed" : "partial";
    await this.database.db.update(operations).set({ status, finishedAt: new Date(), updatedAt: new Date(), ...(failed > 0 ? { errorCode: "one_or_more_steps_failed" } : {}) }).where(eq(operations.id, operationId));
    const bindingIds = [...new Set(finalSteps.flatMap((step) => {
      const parsed = stepInputSchema.safeParse(step.input);
      return parsed.success && parsed.data.bindingId ? [parsed.data.bindingId] : [];
    }))];
    for (const bindingId of bindingIds) {
      const related = finalSteps.filter((step) => stepInputSchema.safeParse(step.input).data?.bindingId === bindingId);
      const state = related.some((step) => step.status === "failed") ? "failed" : related.every((step) => ["succeeded", "skipped"].includes(step.status)) ? "healthy" : "switching";
      await this.database.db.update(domainBindings).set({ state, updatedAt: new Date() }).where(eq(domainBindings.id, bindingId));
    }
  }

  private async executeStep(operation: typeof operations.$inferSelect, step: typeof operationSteps.$inferSelect) {
    const input = stepInputSchema.parse(step.input);
    const { adapter } = await this.providers.forAccount(step.providerAccountId);
    await this.database.db.update(operationSteps).set({ status: "running", attempts: step.attempts + 1, startedAt: step.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(operationSteps.id, step.id));

    let remote: ProviderRecord | null = null;
    if (step.action === "create") {
      if (!input.record) throw new ProviderError("Create step is missing record input", "validation_failed", adapter.provider);
      remote = step.attempts > 0 ? await findMatchingRecord(adapter, input.zoneExternalId, input.record) : null;
      remote ??= await adapter.createRecord(input.zoneExternalId, input.record);
    } else if (step.action === "update") {
      if (!input.record || !input.recordExternalId) throw new ProviderError("Update step is incomplete", "validation_failed", adapter.provider);
      const existing = await adapter.getRecord(input.zoneExternalId, input.recordExternalId);
      if (!existing) throw new ProviderError("DNS record no longer exists", "not_found", adapter.provider);
      remote = await adapter.updateRecord(input.zoneExternalId, input.recordExternalId, input.record);
    } else {
      if (!input.recordExternalId) throw new ProviderError("Delete step is missing record ID", "validation_failed", adapter.provider);
      const existing = await adapter.getRecord(input.zoneExternalId, input.recordExternalId);
      if (existing) await adapter.deleteRecord(input.zoneExternalId, input.recordExternalId);
      const verified = await adapter.getRecord(input.zoneExternalId, input.recordExternalId);
      if (verified) throw new ProviderError("DNS record still exists after deletion", "transient_failure", adapter.provider);
    }

    await this.database.db.transaction(async (tx) => {
      let recordId = step.dnsRecordId;
      if (step.action === "delete") {
        if (recordId) await tx.update(dnsRecords).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(dnsRecords.id, recordId));
      } else if (remote) {
        const values = toDnsRecordValues(step.zoneId, remote, input.management ?? "unmanaged", input.poolId);
        if (recordId) {
          await tx.update(dnsRecords).set(values).where(eq(dnsRecords.id, recordId));
        } else {
          const [created] = await tx.insert(dnsRecords).values(values).returning({ id: dnsRecords.id });
          recordId = created?.id ?? null;
        }
      }
      if (input.bindingId && input.endpointId) {
        if (step.action === "delete") {
          await tx.update(bindingAssignments).set({ applied: false, dnsRecordId: null, updatedAt: new Date() })
            .where(and(eq(bindingAssignments.domainBindingId, input.bindingId), eq(bindingAssignments.endpointId, input.endpointId)));
        } else if (recordId) {
          if (input.assignmentMode === "single") {
            await tx.update(bindingAssignments).set({ applied: false, dnsRecordId: null, updatedAt: new Date() })
              .where(eq(bindingAssignments.domainBindingId, input.bindingId));
          }
          await tx.insert(bindingAssignments).values({
            domainBindingId: input.bindingId,
            endpointId: input.endpointId,
            dnsRecordId: recordId,
            desired: true,
            applied: true,
            reason: operation.source,
          }).onConflictDoUpdate({
            target: [bindingAssignments.domainBindingId, bindingAssignments.endpointId],
            set: { dnsRecordId: recordId, desired: true, applied: true, reason: operation.source, updatedAt: new Date() },
          });
        }
      }
      await tx.update(operationSteps).set({
        status: "succeeded",
        ...(recordId ? { dnsRecordId: recordId } : {}),
        remoteSnapshot: remote,
        errorCode: null,
        errorDetail: null,
        nextRetryAt: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(operationSteps.id, step.id));
      await tx.insert(auditLogs).values({
        ownerUserId: operation.ownerUserId,
        actorUserId: operation.actorUserId,
        source: operation.source,
        action: `dns_record.${step.action}`,
        resourceType: "dns_record",
        ...(recordId ? { resourceId: recordId } : {}),
        beforeSnapshot: operation.beforeSnapshot,
        afterSnapshot: remote,
        operationId: operation.id,
      });
    });
  }

  private async providerForStep(providerAccountId: string): Promise<"cloudflare" | "aliyun"> {
    const [account] = await this.database.db.select({ provider: providerAccounts.provider }).from(providerAccounts).where(eq(providerAccounts.id, providerAccountId)).limit(1);
    return account?.provider ?? "cloudflare";
  }

  private async recoverPending() {
    const rows = await this.database.db.select({ id: operations.id }).from(operations).where(inArray(operations.status, ["pending", "running"]));
    for (const { id } of rows) {
      await this.queues.operations.add("execute-operation", { operationId: id }, { jobId: id, attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    }
  }

  private async withZoneLock<T>(zoneId: string, action: () => Promise<T>): Promise<T> {
    const key = `masterdns:zone-lock:${zoneId}`;
    const token = randomUUID();
    const deadline = Date.now() + 30_000;
    while (await this.queues.redis.set(key, token, "PX", 90_000, "NX") !== "OK") {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for DNS zone lock ${zoneId}`);
      await delay(100);
    }
    try {
      return await action();
    } finally {
      await this.queues.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token,
      );
    }
  }
}

async function findMatchingRecord(adapter: Awaited<ReturnType<ProviderRuntimeService["forAccount"]>>["adapter"], zoneId: string, expected: DnsRecordInput): Promise<ProviderRecord | null> {
  let cursor: string | undefined;
  do {
    const page = await adapter.listRecords(zoneId, cursor);
    const match = page.items.find((record) => record.type === expected.type && record.name.toLowerCase() === expected.name.toLowerCase() && record.content === expected.content);
    if (match) return match;
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

function toDnsRecordValues(zoneId: string, record: ProviderRecord, management: "unmanaged" | "managed", poolId?: string): typeof dnsRecords.$inferInsert {
  return {
    zoneId,
    externalId: record.externalId,
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    priority: record.priority ?? null,
    providerMetadata: record.providerMetadata,
    management,
    managedByPoolId: management === "managed" ? poolId : null,
    remoteHash: providerRecordHash(record),
    lastSyncedAt: new Date(),
    deletedAt: null,
    updatedAt: new Date(),
  };
}

function safeError(error: unknown): string {
  return error instanceof ProviderError ? `${error.provider}:${error.code}` : error instanceof Error ? error.name : "unknown";
}

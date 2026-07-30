import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { DnsRecordInput, OperationJob, ProviderRecord } from "@masterdns/contracts";
import { ProviderError, queueNames } from "@masterdns/contracts";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  auditLogs,
  bindingAssignments,
  dnsRecords,
  domainBindings,
  endpointAddresses,
  endpointPools,
  endpoints,
  healthCheckConfigs,
  operationSteps,
  operations,
  policyVersions,
  providerAccounts,
  zones,
} from "@masterdns/db";
import { dnsRecordMatches, providerRecordHash } from "@masterdns/providers";
import { Job, Worker } from "bullmq";
import { z } from "zod";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
import { ProviderRuntimeService } from "../providers/provider-runtime.service.js";
import { isDnsZoneLockError, type DnsZoneLease, withDnsZoneLock, withRedisLease } from "../sync/dns-zone-lock.js";

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
  deleteBinding: z.boolean().optional(),
});

@Injectable()
export class OperationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperationProcessor.name);
  private worker?: Worker<OperationJob>;
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;

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
    this.recoveryTimer = setInterval(() => void this.recoverPending(), 30_000);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.worker?.close();
  }

  private async process(job: Job<OperationJob>) {
    const operationId = job.data.operationId;
    const lockKey = `masterdns:operation-lock:${operationId}`;
    return withRedisLease(this.queues.redis, lockKey, `operation lock ${operationId}`, (lease) => this.processLocked(job, lease), {
      leaseMs: 90_000,
      refreshIntervalMs: 30_000,
      onCleanupError: (error) => this.logger.warn(`Failed to release operation lock ${operationId}: ${safeError(error)}`),
    });
  }

  private async processLocked(job: Job<OperationJob>, operationLease: DnsZoneLease) {
    const operationId = job.data.operationId;
    const [operation] = await this.database.db.select().from(operations).where(eq(operations.id, operationId)).limit(1);
    operationLease.assertOwned();
    if (!operation || isTerminalOperationStatus(operation.status)) return;
    if (operation.resourceType === "endpoint_pool" && operation.resourceId && operation.policyRevision !== null) {
      const [pool] = await this.database.db.select({
        policyRevision: endpointPools.policyRevision,
        decisionRevision: endpointPools.decisionRevision,
      }).from(endpointPools)
        .where(eq(endpointPools.id, operation.resourceId)).limit(1);
      if (!isOperationDecisionCurrent(operation, pool)) {
        await this.supersedeOperation(operationId);
        return;
      }
    }
    await this.database.db.update(operations).set({ status: "running", startedAt: operation.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(operations.id, operationId));
    const steps = await this.database.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId)).orderBy(operationSteps.sequence);
    operationLease.assertOwned();

    for (const step of steps) {
      if (step.status === "succeeded" || step.status === "skipped") continue;
      operationLease.assertOwned();
      try {
        const applied = await withDnsZoneLock(this.queues.redis, step.zoneId, (lease) => {
          operationLease.assertOwned();
          return this.executeStep(operation, step, lease);
        }, {
          onCleanupError: (error) => this.logger.warn(`Failed to release DNS zone lock ${step.zoneId}: ${safeError(error)}`),
        });
        if (!applied) {
          await this.supersedeOperation(operationId);
          return;
        }
      } catch (error) {
        const [currentAccount] = await this.database.db.select({
          provider: providerAccounts.provider,
          status: providerAccounts.status,
        }).from(providerAccounts).where(eq(providerAccounts.id, step.providerAccountId)).limit(1);
        const providerError = error instanceof ProviderError
          ? error
          : new ProviderError("Unexpected operation error", "transient_failure", currentAccount?.provider ?? "cloudflare", { cause: error });
        const finalAttempt = shouldFinalizeOperationStepFailure({
          retryable: providerError.retryable,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
          providerStatus: currentAccount?.status,
          lockFailure: isDnsZoneLockError(error),
        });
        await this.database.db.update(operationSteps).set({
          status: finalAttempt ? "failed" : "pending",
          attempts: step.attempts + 1,
          errorCode: providerError.code,
          errorDetail: providerError.message.slice(0, 512),
          nextRetryAt: finalAttempt ? null : new Date(Date.now() + (providerError.retryAfterMs ?? 1000 * 2 ** job.attemptsMade)),
          finishedAt: finalAttempt ? new Date() : null,
          updatedAt: new Date(),
        }).where(eq(operationSteps.id, step.id));
        if (currentAccount?.status !== "disabled" && ["authentication_failed", "permission_denied"].includes(providerError.code)) {
          await this.database.db.update(providerAccounts).set({ status: "error", errorCode: providerError.code, updatedAt: new Date() })
            .where(and(eq(providerAccounts.id, step.providerAccountId), ne(providerAccounts.status, "disabled")));
        }
        if (!finalAttempt) throw providerError;
      }
      operationLease.assertOwned();
    }

    operationLease.assertOwned();
    const finalized = await this.finalizeOperation(operation);
    operationLease.assertOwned();
    if (finalized.superseded) return;
    const { status, succeeded, failed } = finalized;
    if (operation.resourceType === "endpoint_pool" && operation.resourceId) {
      const eventId = `operation-${operation.id}`;
      await this.queues.notifications.add("fanout-event", {
        kind: "fanout",
        event: {
          eventId,
          eventType: status === "succeeded" ? "dns.automatic_change_succeeded" : "dns.automatic_change_failed",
          ownerUserId: operation.ownerUserId,
          poolId: operation.resourceId,
          occurredAt: new Date().toISOString(),
          payload: {
            summary: status === "succeeded" ? "Automatic DNS changes were applied and verified." : "One or more automatic DNS changes failed.",
            operationId: operation.id,
            status,
            succeededSteps: succeeded,
            failedSteps: failed,
          },
        },
      }, {
        jobId: `fanout-${eventId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 5_000,
        removeOnFail: 5_000,
      });
    }
  }

  private async executeStep(
    operation: typeof operations.$inferSelect,
    staleStep: typeof operationSteps.$inferSelect,
    lease: DnsZoneLease,
  ): Promise<boolean> {
    const [step] = await this.database.db.select().from(operationSteps).where(eq(operationSteps.id, staleStep.id)).limit(1);
    if (!step || ["succeeded", "failed", "skipped"].includes(step.status)) return true;
    const input = stepInputSchema.parse(step.input);
    const { adapter } = await this.providers.forAccount(step.providerAccountId);
    if (!await this.prepareStep(operation, step)) return false;
    return this.database.db.transaction(async (tx) => {
      if (operation.resourceType === "endpoint_pool" && operation.resourceId && operation.policyRevision !== null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.resourceId}))`);
        const [pool] = await tx.select({
          policyRevision: endpointPools.policyRevision,
          decisionRevision: endpointPools.decisionRevision,
        }).from(endpointPools).where(eq(endpointPools.id, operation.resourceId)).limit(1);
        if (!isOperationDecisionCurrent(operation, pool)) {
          await tx.update(operationSteps).set({ status: "skipped", finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(operationSteps.id, step.id));
          return false;
        }
      }
      lease.assertOwned();
      let remote: ProviderRecord | null = null;
      if (step.action === "create") {
        if (!input.record) throw new ProviderError("Create step is missing record input", "validation_failed", adapter.provider);
        remote = step.attempts > 0 ? await findMatchingRecord(adapter, input.zoneExternalId, input.record) : null;
        remote ??= await adapter.createRecord(input.zoneExternalId, input.record);
        remote = await verifyRemoteRecord(adapter, input.zoneExternalId, remote.externalId, input.record);
      } else if (step.action === "update") {
        if (!input.record || !input.recordExternalId) throw new ProviderError("Update step is incomplete", "validation_failed", adapter.provider);
        const existing = await adapter.getRecord(input.zoneExternalId, input.recordExternalId);
        if (!existing) throw new ProviderError("DNS record no longer exists", "not_found", adapter.provider);
        remote = dnsRecordMatches(existing, input.record)
          ? existing
          : await adapter.updateRecord(input.zoneExternalId, input.recordExternalId, input.record);
        remote = await verifyRemoteRecord(adapter, input.zoneExternalId, remote.externalId, input.record);
      } else {
        if (!input.recordExternalId) throw new ProviderError("Delete step is missing record ID", "validation_failed", adapter.provider);
        await deleteRemoteRecordAndVerify(adapter, input.zoneExternalId, input.recordExternalId);
      }

      lease.assertOwned();
      let recordId = step.dnsRecordId;
      if (step.action === "delete") {
        if (recordId) await tx.update(dnsRecords).set({
          deletedAt: new Date(),
          management: "unmanaged",
          managedByPoolId: null,
          updatedAt: new Date(),
        }).where(eq(dnsRecords.id, recordId));
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
      if (recordId && operation.resourceType === "dns_record" && !operation.resourceId) {
        await tx.update(operations).set({ resourceId: recordId, updatedAt: new Date() }).where(eq(operations.id, operation.id));
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
      lease.assertOwned();
      return true;
    });
  }

  private async prepareStep(operation: typeof operations.$inferSelect, step: typeof operationSteps.$inferSelect): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      if (operation.resourceType === "endpoint_pool" && operation.resourceId && operation.policyRevision !== null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.resourceId}))`);
        const [pool] = await tx.select({
          policyRevision: endpointPools.policyRevision,
          decisionRevision: endpointPools.decisionRevision,
        }).from(endpointPools).where(eq(endpointPools.id, operation.resourceId)).limit(1);
        if (!isOperationDecisionCurrent(operation, pool)) return false;
      }
      await tx.update(operationSteps).set({
        status: "running",
        attempts: step.attempts + 1,
        startedAt: step.startedAt ?? new Date(),
        updatedAt: new Date(),
      }).where(eq(operationSteps.id, step.id));
      return true;
    });
  }

  private async finalizeOperation(operation: typeof operations.$inferSelect): Promise<{
    superseded: boolean;
    status: "succeeded" | "partial" | "failed";
    succeeded: number;
    failed: number;
  }> {
    return this.database.db.transaction(async (tx) => {
      if (operation.resourceType === "endpoint_pool" && operation.resourceId && operation.policyRevision !== null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.resourceId}))`);
        const [pool] = await tx.select({
          policyRevision: endpointPools.policyRevision,
          decisionRevision: endpointPools.decisionRevision,
        }).from(endpointPools).where(eq(endpointPools.id, operation.resourceId)).limit(1);
        if (!isOperationDecisionCurrent(operation, pool)) {
          await tx.update(operationSteps).set({ status: "skipped", finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(operationSteps.operationId, operation.id), inArray(operationSteps.status, ["pending", "running"])));
          await tx.update(operations).set({ status: "superseded", finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(operations.id, operation.id));
          return { superseded: true, status: "failed", succeeded: 0, failed: 0 };
        }
      }

      const finalSteps = await tx.select({ status: operationSteps.status, input: operationSteps.input })
        .from(operationSteps).where(eq(operationSteps.operationId, operation.id));
      const succeeded = finalSteps.filter((step) => ["succeeded", "skipped"].includes(step.status)).length;
      const failed = finalSteps.filter((step) => step.status === "failed").length;
      const status = failed === 0 ? "succeeded" as const : succeeded === 0 ? "failed" as const : "partial" as const;
      await tx.update(operations).set({
        status,
        finishedAt: new Date(),
        updatedAt: new Date(),
        ...(failed > 0 ? { errorCode: "one_or_more_steps_failed" } : {}),
      }).where(eq(operations.id, operation.id));

      const bindingIds = [...new Set(finalSteps.flatMap((step) => {
        const parsed = stepInputSchema.safeParse(step.input);
        return parsed.success && parsed.data.bindingId ? [parsed.data.bindingId] : [];
      }))];
      for (const bindingId of bindingIds) {
        const related = finalSteps.filter((step) => stepInputSchema.safeParse(step.input).data?.bindingId === bindingId);
        const state = related.some((step) => step.status === "failed") ? "failed" : related.every((step) => ["succeeded", "skipped"].includes(step.status)) ? "healthy" : "switching";
        const shouldDelete = state === "healthy" && related.some((step) => stepInputSchema.safeParse(step.input).data?.deleteBinding === true);
        if (shouldDelete) {
          const [binding] = await tx.select({ poolId: domainBindings.poolId }).from(domainBindings).where(eq(domainBindings.id, bindingId)).limit(1);
          await tx.delete(domainBindings).where(eq(domainBindings.id, bindingId));
          if (binding) {
            const [pool] = await tx.update(endpointPools).set({ policyRevision: sql`${endpointPools.policyRevision} + 1`, updatedAt: new Date() })
              .where(eq(endpointPools.id, binding.poolId)).returning();
            if (pool) {
              const [endpointRows, addresses, bindings, checks] = await Promise.all([
                tx.select().from(endpoints).where(eq(endpoints.poolId, binding.poolId)),
                tx.select({ address: endpointAddresses }).from(endpointAddresses).innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id)).where(eq(endpoints.poolId, binding.poolId)),
                tx.select().from(domainBindings).where(eq(domainBindings.poolId, binding.poolId)),
                tx.select().from(healthCheckConfigs).where(or(
                  eq(healthCheckConfigs.poolId, binding.poolId),
                  inArray(healthCheckConfigs.endpointId, tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.poolId, binding.poolId))),
                  inArray(healthCheckConfigs.domainBindingId, tx.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, binding.poolId))),
                )),
              ]);
              await tx.insert(policyVersions).values({
                poolId: binding.poolId,
                version: pool.policyRevision,
                snapshot: { pool, endpoints: endpointRows, addresses: addresses.map((row) => row.address), bindings, healthChecks: checks },
                reason: "binding.delete",
                actorUserId: operation.actorUserId,
              });
            }
          }
          await tx.insert(auditLogs).values({
            ownerUserId: operation.ownerUserId,
            actorUserId: operation.actorUserId,
            source: operation.source,
            action: "binding.delete",
            resourceType: "domain_binding",
            resourceId: bindingId,
            operationId: operation.id,
          });
        } else {
          await tx.update(domainBindings).set({ state, updatedAt: new Date() }).where(eq(domainBindings.id, bindingId));
        }
      }
      return { superseded: false, status, succeeded, failed };
    });
  }

  private async recoverPending() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const rows = await this.database.db.select({ id: operations.id }).from(operations).where(inArray(operations.status, ["pending", "running"]));
      const slot = Math.floor(Date.now() / 30_000);
      for (const { id } of rows) {
        await this.queues.operations.add("execute-operation", { operationId: id }, { jobId: `recover-operation-${id}-${slot}`, attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
      }
    } catch (error) {
      this.logger.error(`Operation recovery scan failed: ${safeError(error)}`);
    } finally {
      this.recovering = false;
    }
  }

  private async supersedeOperation(operationId: string) {
    await this.database.db.transaction(async (tx) => {
      await tx.update(operationSteps).set({ status: "skipped", finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(operationSteps.operationId, operationId), inArray(operationSteps.status, ["pending", "running"])));
      await tx.update(operations).set({ status: "superseded", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(operations.id, operationId));
    });
  }
}

export function shouldFinalizeOperationStepFailure(input: {
  retryable: boolean;
  attemptsMade: number;
  maxAttempts: number;
  providerStatus: typeof providerAccounts.$inferSelect["status"] | undefined;
  lockFailure: boolean;
}): boolean {
  if (input.providerStatus === "disabled" || input.lockFailure) return false;
  return !input.retryable || input.attemptsMade + 1 >= input.maxAttempts;
}

export function isTerminalOperationStatus(status: typeof operations.$inferSelect["status"]): boolean {
  return ["succeeded", "partial", "failed", "superseded"].includes(status);
}

export function isOperationDecisionCurrent(
  operation: Pick<typeof operations.$inferSelect, "policyRevision" | "decisionRevision">,
  pool: Pick<typeof endpointPools.$inferSelect, "policyRevision" | "decisionRevision"> | undefined,
): boolean {
  return pool !== undefined
    && operation.policyRevision === pool.policyRevision
    && (operation.decisionRevision === null || operation.decisionRevision === pool.decisionRevision);
}

async function findMatchingRecord(adapter: Awaited<ReturnType<ProviderRuntimeService["forAccount"]>>["adapter"], zoneId: string, expected: DnsRecordInput): Promise<ProviderRecord | null> {
  let cursor: string | undefined;
  do {
    const page = await adapter.listRecords(zoneId, cursor);
    const match = page.items.find((record) => dnsRecordMatches(record, expected));
    if (match) return match;
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

async function verifyRemoteRecord(
  adapter: Awaited<ReturnType<ProviderRuntimeService["forAccount"]>>["adapter"],
  zoneId: string,
  recordId: string,
  expected: DnsRecordInput,
): Promise<ProviderRecord> {
  const verified = await adapter.getRecord(zoneId, recordId);
  if (!verified || !dnsRecordMatches(verified, expected)) {
    throw new ProviderError("DNS record did not match the desired state after write", "transient_failure", adapter.provider);
  }
  return verified;
}

export async function deleteRemoteRecordAndVerify(
  adapter: Awaited<ReturnType<ProviderRuntimeService["forAccount"]>>["adapter"],
  zoneId: string,
  recordId: string,
): Promise<void> {
  const existing = await adapter.getRecord(zoneId, recordId);
  if (existing) {
    try {
      await adapter.deleteRecord(zoneId, recordId);
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === "not_found")) throw error;
    }
  }
  const verified = await adapter.getRecord(zoneId, recordId);
  if (verified) throw new ProviderError("DNS record still exists after deletion", "transient_failure", adapter.provider);
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

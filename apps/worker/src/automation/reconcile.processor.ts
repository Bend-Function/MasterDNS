import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { evaluateStrategy } from "@masterdns/automation";
import type { DnsRecordInput, PoolReconcileJob, StrategyDecision } from "@masterdns/contracts";
import { queueNames } from "@masterdns/contracts";
import {
  bindingAssignments,
  dnsRecords,
  domainBindings,
  endpointAddresses,
  endpointPools,
  endpoints,
  failoverEvents,
  operationSteps,
  operations,
  providerAccounts,
  zones,
} from "@masterdns/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Job, Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

type PendingStep = {
  providerAccountId: string;
  zoneId: string;
  dnsRecordId?: string;
  action: "create" | "update" | "delete";
  input: Record<string, unknown>;
};

@Injectable()
export class ReconcileProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileProcessor.name);
  private worker?: Worker<PoolReconcileJob>;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    this.worker = new Worker<PoolReconcileJob>(queueNames.reconcile, (job) => this.process(job), {
      connection: this.queues.redis,
      concurrency: 4,
      lockDuration: 60_000,
    });
    this.worker.on("failed", (job, error) => this.logger.error(`Reconcile job ${job?.id ?? "unknown"} failed: ${safeError(error)}`));
  }

  async onModuleDestroy() { await this.worker?.close(); }

  private async process(job: Job<PoolReconcileJob>) {
    const outcome = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${job.data.poolId}))`);
      const [pool] = await tx.select().from(endpointPools).where(eq(endpointPools.id, job.data.poolId)).limit(1);
      if (!pool) return null;

      const idempotencyKey = `pool:${pool.id}:revision:${pool.policyRevision}:event:${job.data.eventId}`;
      const [existingOperation] = await tx.select({ id: operations.id }).from(operations)
        .where(eq(operations.idempotencyKey, idempotencyKey)).limit(1);
      if (existingOperation) return { operationId: existingOperation.id };

      const [poolEndpoints, bindings, assignments, addresses] = await Promise.all([
        tx.select().from(endpoints).where(eq(endpoints.poolId, pool.id)),
        tx.select().from(domainBindings).where(eq(domainBindings.poolId, pool.id)),
        tx.select().from(bindingAssignments)
          .innerJoin(domainBindings, eq(bindingAssignments.domainBindingId, domainBindings.id))
          .where(eq(domainBindings.poolId, pool.id)),
        tx.select().from(endpointAddresses)
          .innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id))
          .where(and(eq(endpoints.poolId, pool.id), eq(endpointAddresses.state, "current"))),
      ]);
      const assignmentRows = assignments.map((row) => row.binding_assignments);
      const decision = evaluateStrategy({
        eventId: job.data.eventId,
        trigger: job.data.trigger,
        strategy: pool.strategy,
        selectionMode: pool.selectionMode,
        recoveryMode: pool.recoveryMode,
        endpoints: poolEndpoints.map((endpoint) => ({
          id: endpoint.id,
          priority: endpoint.priority,
          lifecycle: endpoint.lifecycle,
          healthState: job.data.force && endpoint.lifecycle === "enabled" ? "healthy" : endpoint.healthState,
          activeBindingCount: assignmentRows.filter((assignment) => assignment.endpointId === endpoint.id && assignment.applied).length,
        })),
        bindings: bindings.map((binding) => {
          const applied = assignmentRows.filter((assignment) => assignment.domainBindingId === binding.id && assignment.applied).map((assignment) => assignment.endpointId);
          return {
            id: binding.id,
            ...(binding.originalEndpointId ? { originalEndpointId: binding.originalEndpointId } : {}),
            currentEndpointIds: applied,
          };
        }),
        ...(pool.roundRobinCursor ? { roundRobinCursor: pool.roundRobinCursor } : {}),
      });

      if (!pool.enabled) {
        await tx.insert(failoverEvents).values({
          poolId: pool.id,
          endpointId: job.data.endpointId ?? null,
          eventType: "pool.reconcile_paused",
          evidence: eventEvidence(job.data, pool.policyRevision),
          decision,
        });
        return null;
      }

      if (decision.noHealthyEndpoints) {
        await tx.update(endpointPools).set({ state: "unhealthy", updatedAt: new Date() }).where(eq(endpointPools.id, pool.id));
        await tx.insert(failoverEvents).values({
          poolId: pool.id,
          endpointId: job.data.endpointId ?? null,
          eventType: "pool.no_healthy_endpoint",
          evidence: eventEvidence(job.data, pool.policyRevision),
          decision,
        });
        return null;
      }

      const bindingIds = decision.decisions.map((item) => item.bindingId);
      const bindingMap = new Map(bindings.map((binding) => [binding.id, binding]));
      const zoneRows = bindingIds.length === 0
        ? []
        : await tx.select({ zone: zones, providerAccountId: providerAccounts.id })
          .from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
          .where(inArray(zones.id, bindings.filter((binding) => bindingIds.includes(binding.id)).map((binding) => binding.zoneId)));
      const zoneMap = new Map(zoneRows.map((row) => [row.zone.id, row]));
      const recordIds = assignmentRows.flatMap((assignment) => assignment.dnsRecordId ? [assignment.dnsRecordId] : []);
      const records = recordIds.length === 0 ? [] : await tx.select().from(dnsRecords).where(inArray(dnsRecords.id, recordIds));
      const recordMap = new Map(records.map((record) => [record.id, record]));
      const addressMap = new Map(addresses.map((row) => [`${row.endpoint_addresses.endpointId}:${row.endpoint_addresses.family}`, row.endpoint_addresses]));
      const pending: PendingStep[] = [];

      for (const item of decision.decisions) {
        const binding = bindingMap.get(item.bindingId);
        if (!binding) continue;
        const zone = zoneMap.get(binding.zoneId);
        if (!zone) throw new Error(`Zone ${binding.zoneId} is unavailable for Pool reconcile`);
        const family = binding.recordType === "AAAA" ? "6" : "4";
        const existing = assignmentRows.filter((assignment) => assignment.domainBindingId === binding.id);

        await tx.update(bindingAssignments).set({ desired: false, updatedAt: new Date() })
          .where(eq(bindingAssignments.domainBindingId, binding.id));
        for (const endpointId of item.desiredEndpointIds) {
          await tx.insert(bindingAssignments).values({
            domainBindingId: binding.id,
            endpointId,
            desired: true,
            applied: existing.some((assignment) => assignment.endpointId === endpointId && assignment.applied),
            reason: item.reason,
          }).onConflictDoUpdate({
            target: [bindingAssignments.domainBindingId, bindingAssignments.endpointId],
            set: { desired: true, reason: item.reason, updatedAt: new Date() },
          });
        }

        if (pool.strategy === "healthy_set") {
          this.planHealthySet(pending, item, binding, zone, existing, recordMap, addressMap, pool.id);
        } else {
          this.planSingleAssignment(pending, item, binding, zone, existing, recordMap, addressMap, pool.id);
        }
        await tx.update(domainBindings).set({ state: pending.some((step) => step.input.bindingId === binding.id) ? "switching" : "healthy", desiredRevision: pool.policyRevision, updatedAt: new Date() })
          .where(eq(domainBindings.id, binding.id));
      }

      if (decision.nextRoundRobinCursor) {
        await tx.update(endpointPools).set({ roundRobinCursor: decision.nextRoundRobinCursor, updatedAt: new Date() }).where(eq(endpointPools.id, pool.id));
      }
      if (pending.length === 0) {
        await tx.update(endpointPools).set({ lastReconciledAt: new Date(), updatedAt: new Date() }).where(eq(endpointPools.id, pool.id));
        await tx.insert(failoverEvents).values({
          poolId: pool.id,
          endpointId: job.data.endpointId ?? null,
          eventType: "pool.reconcile_no_change",
          evidence: eventEvidence(job.data, pool.policyRevision),
          decision,
        });
        return null;
      }

      const [operation] = await tx.insert(operations).values({
        ownerUserId: pool.ownerUserId,
        source: operationSource(job.data.trigger),
        idempotencyKey,
        resourceType: "endpoint_pool",
        resourceId: pool.id,
        policyRevision: pool.policyRevision,
        desiredSnapshot: decision,
      }).returning({ id: operations.id });
      if (!operation) throw new Error("Pool operation insert returned no row");
      await tx.insert(operationSteps).values(pending.map((step, index) => ({
        operationId: operation.id,
        sequence: index + 1,
        providerAccountId: step.providerAccountId,
        zoneId: step.zoneId,
        dnsRecordId: step.dnsRecordId,
        action: step.action,
        input: step.input,
      })));
      await tx.insert(failoverEvents).values({
        poolId: pool.id,
        endpointId: job.data.endpointId ?? null,
        operationId: operation.id,
        eventType: `pool.${job.data.trigger}`,
        evidence: eventEvidence(job.data, pool.policyRevision),
        decision,
      });
      await tx.update(endpointPools).set({ lastReconciledAt: new Date(), updatedAt: new Date() }).where(eq(endpointPools.id, pool.id));
      return { operationId: operation.id };
    });

    if (outcome?.operationId) {
      await this.queues.operations.add("execute-operation", { operationId: outcome.operationId }, {
        jobId: outcome.operationId,
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 5_000,
        removeOnFail: 5_000,
      });
    }
  }

  private planSingleAssignment(
    pending: PendingStep[],
    decision: StrategyDecision["decisions"][number],
    binding: typeof domainBindings.$inferSelect,
    zone: { zone: typeof zones.$inferSelect; providerAccountId: string },
    assignments: (typeof bindingAssignments.$inferSelect)[],
    records: Map<string, typeof dnsRecords.$inferSelect>,
    addresses: Map<string, typeof endpointAddresses.$inferSelect>,
    poolId: string,
  ) {
    const endpointId = decision.desiredEndpointIds[0];
    if (!endpointId) return;
    const address = requiredAddress(addresses, endpointId, binding.recordType);
    const applied = assignments.filter((assignment) => assignment.applied && assignment.dnsRecordId).sort((a, b) => a.assignedAt.getTime() - b.assignedAt.getTime());
    const current = applied[0];
    const currentRecord = current?.dnsRecordId ? records.get(current.dnsRecordId) : undefined;
    const record = recordInput(binding, address.address);
    const metadata = managedMetadata(poolId, binding.id, endpointId, decision.previousEndpointIds, "single");
    if (currentRecord && !currentRecord.deletedAt) {
      if (currentRecord.content !== address.address || current?.endpointId !== endpointId) {
        pending.push({
          providerAccountId: zone.providerAccountId,
          zoneId: zone.zone.id,
          dnsRecordId: currentRecord.id,
          action: "update",
          input: { zoneExternalId: zone.zone.externalId, recordExternalId: currentRecord.externalId, record, ...metadata },
        });
      }
    } else {
      pending.push({
        providerAccountId: zone.providerAccountId,
        zoneId: zone.zone.id,
        action: "create",
        input: { zoneExternalId: zone.zone.externalId, record, ...metadata },
      });
    }
    for (const extra of applied.slice(1)) {
      const extraRecord = extra.dnsRecordId ? records.get(extra.dnsRecordId) : undefined;
      if (extraRecord && !extraRecord.deletedAt) pending.push({
        providerAccountId: zone.providerAccountId,
        zoneId: zone.zone.id,
        dnsRecordId: extraRecord.id,
        action: "delete",
        input: {
          zoneExternalId: zone.zone.externalId,
          recordExternalId: extraRecord.externalId,
          ...managedMetadata(poolId, binding.id, extra.endpointId, decision.previousEndpointIds, "single"),
        },
      });
    }
  }

  private planHealthySet(
    pending: PendingStep[],
    decision: StrategyDecision["decisions"][number],
    binding: typeof domainBindings.$inferSelect,
    zone: { zone: typeof zones.$inferSelect; providerAccountId: string },
    assignments: (typeof bindingAssignments.$inferSelect)[],
    records: Map<string, typeof dnsRecords.$inferSelect>,
    addresses: Map<string, typeof endpointAddresses.$inferSelect>,
    poolId: string,
  ) {
    const desired = new Set(decision.desiredEndpointIds);
    for (const endpointId of desired) {
      const address = requiredAddress(addresses, endpointId, binding.recordType);
      const assignment = assignments.find((item) => item.endpointId === endpointId);
      const currentRecord = assignment?.dnsRecordId ? records.get(assignment.dnsRecordId) : undefined;
      const action = currentRecord && !currentRecord.deletedAt ? "update" : "create";
      if (action === "update" && currentRecord?.content === address.address && assignment?.applied) continue;
      pending.push({
        providerAccountId: zone.providerAccountId,
        zoneId: zone.zone.id,
        ...(currentRecord ? { dnsRecordId: currentRecord.id } : {}),
        action,
        input: {
          zoneExternalId: zone.zone.externalId,
          ...(currentRecord ? { recordExternalId: currentRecord.externalId } : {}),
          record: recordInput(binding, address.address),
          ...managedMetadata(poolId, binding.id, endpointId, decision.previousEndpointIds, "set"),
        },
      });
    }
    for (const assignment of assignments.filter((item) => item.applied && !desired.has(item.endpointId))) {
      const record = assignment.dnsRecordId ? records.get(assignment.dnsRecordId) : undefined;
      if (!record || record.deletedAt) continue;
      pending.push({
        providerAccountId: zone.providerAccountId,
        zoneId: zone.zone.id,
        dnsRecordId: record.id,
        action: "delete",
        input: {
          zoneExternalId: zone.zone.externalId,
          recordExternalId: record.externalId,
          ...managedMetadata(poolId, binding.id, assignment.endpointId, decision.previousEndpointIds, "set"),
        },
      });
    }
  }
}

function requiredAddress(addresses: Map<string, typeof endpointAddresses.$inferSelect>, endpointId: string, recordType: string) {
  const family = recordType === "AAAA" ? "6" : "4";
  const address = addresses.get(`${endpointId}:${family}`);
  if (!address) throw new Error(`Endpoint ${endpointId} has no current IPv${family} address`);
  return address;
}

function recordInput(binding: typeof domainBindings.$inferSelect, content: string): DnsRecordInput {
  return {
    type: binding.recordType as "A" | "AAAA",
    name: binding.fqdn,
    content,
    ttl: binding.ttl,
    providerMetadata: binding.providerMetadata,
  };
}

function managedMetadata(poolId: string, bindingId: string, endpointId: string, previousEndpointIds: string[], assignmentMode: "single" | "set") {
  return { management: "managed", poolId, bindingId, endpointId, previousEndpointIds, assignmentMode };
}

function eventEvidence(job: PoolReconcileJob, policyRevision: number) {
  return { eventId: job.eventId, trigger: job.trigger, policyRevision, force: job.force ?? false };
}

function operationSource(trigger: PoolReconcileJob["trigger"]): "failover" | "recovery" {
  return trigger === "recovery" ? "recovery" : "failover";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}

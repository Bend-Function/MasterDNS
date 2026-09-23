import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { NotificationEvent } from "@masterdns/contracts";
import {
  addressHealthPolicies,
  addressHealthStates,
  cloudAccounts,
  cloudEndpointLinks,
  cloudInstances,
  cloudInterfaces,
  endpoints,
  endpointAddresses,
  endpointPools,
  managedAddressSlots,
  rotationAttempts,
  rotationIncidents,
  rotationPublications,
  rotationResources,
  rotationSteps,
} from "@masterdns/db";
import { and, asc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

const SCAN_INTERVAL_MS = 30_000;
const SCAN_BATCH_SIZE = 100;

@Injectable()
export class NotificationStateScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationStateScannerService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private healthCursor: string | undefined;
  private rotationCursor: string | undefined;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async scanOnce(batchSize = SCAN_BATCH_SIZE) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.scanHealth(batchSize);
      await this.scanRotations(batchSize);
    } catch (error) {
      this.logger.warn(`Notification state scan failed: ${safeError(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async scanHealth(batchSize: number) {
    const rows = await this.database.db.select({
      state: addressHealthStates,
      policy: addressHealthPolicies,
      endpointPool: endpointPools,
      account: cloudAccounts,
      endpointAddress: endpointAddresses,
    }).from(addressHealthStates)
      .leftJoin(addressHealthPolicies, eq(addressHealthStates.policyId, addressHealthPolicies.id))
      .leftJoin(endpoints, eq(addressHealthStates.endpointId, endpoints.id))
      .leftJoin(endpointAddresses, and(eq(addressHealthStates.addressId, endpointAddresses.id), eq(addressHealthStates.endpointId, endpointAddresses.endpointId), eq(addressHealthStates.family, endpointAddresses.family)))
      .leftJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
      .leftJoin(managedAddressSlots, eq(addressHealthStates.slotId, managedAddressSlots.id))
      .leftJoin(cloudInterfaces, eq(managedAddressSlots.interfaceId, cloudInterfaces.id))
      .leftJoin(cloudInstances, eq(cloudInterfaces.instanceId, cloudInstances.id))
      .leftJoin(cloudAccounts, eq(cloudInstances.accountId, cloudAccounts.id))
      .where(and(this.healthCursor ? gt(addressHealthStates.id, this.healthCursor) : undefined, or(isNull(addressHealthStates.endpointId), ne(endpointAddresses.state, "previous"))))
      .orderBy(asc(addressHealthStates.id))
      .limit(batchSize);
    if (rows.length === 0) {
      this.healthCursor = undefined;
      return;
    }
    const poolIdsBySlot = await this.poolIdsBySlot(rows.flatMap(({ state }) => state.slotId ? [state.slotId] : []));
    const events = rows.flatMap(({ state, policy, endpointPool, account, endpointAddress }) => {
      const ownerUserId = endpointPool?.ownerUserId ?? account?.ownerUserId;
      if (!ownerUserId) return [];
      const poolIds = state.slotId
        ? (poolIdsBySlot.get(state.slotId) ?? []).filter((pool) => pool.ownerUserId === ownerUserId).map((pool) => pool.poolId)
        : endpointPool ? [endpointPool.id] : [];
      const event = healthEvent(state, policy, ownerUserId, poolIds, endpointAddress);
      return event ? [event] : [];
    });
    await Promise.all(events.map((event) => this.enqueue(event)));
    this.healthCursor = rows.length === batchSize ? rows.at(-1)!.state.id : undefined;
  }

  private async scanRotations(batchSize: number) {
    const rows = await this.database.db.select({ incident: rotationIncidents, attempt: rotationAttempts })
      .from(rotationIncidents)
      .leftJoin(rotationAttempts, eq(rotationIncidents.currentAttemptId, rotationAttempts.id))
      .where(this.rotationCursor ? gt(rotationIncidents.id, this.rotationCursor) : undefined)
      .orderBy(asc(rotationIncidents.id))
      .limit(batchSize);
    if (rows.length === 0) {
      this.rotationCursor = undefined;
      return;
    }
    const incidentIds = rows.map(({ incident }) => incident.id);
    const attemptIds = rows.flatMap(({ attempt }) => attempt ? [attempt.id] : []);
    const [publications, resources, steps, poolIdsBySlot] = await Promise.all([
      this.database.db.select({ id: rotationPublications.id, incidentId: rotationPublications.incidentId, status: rotationPublications.status, errorCode: rotationPublications.errorCode })
        .from(rotationPublications).where(inArray(rotationPublications.incidentId, incidentIds)),
      this.database.db.select({ id: rotationResources.id, incidentId: rotationResources.incidentId, cleanupStatus: rotationResources.cleanupStatus })
        .from(rotationResources).where(inArray(rotationResources.incidentId, incidentIds)),
      attemptIds.length > 0
        ? this.database.db.select({ id: rotationSteps.id, attemptId: rotationSteps.attemptId, status: rotationSteps.status, errorCode: rotationSteps.errorCode })
          .from(rotationSteps).where(inArray(rotationSteps.attemptId, attemptIds))
        : Promise.resolve([]),
      this.poolIdsBySlot(rows.map(({ incident }) => incident.slotId)),
    ]);
    const events = rows.map(({ incident, attempt }) => {
      const pools = (poolIdsBySlot.get(incident.slotId) ?? [])
        .filter((pool) => pool.ownerUserId === incident.ownerUserId)
        .map((pool) => pool.poolId);
      return rotationEvent(
        incident,
        attempt,
        publications.filter((item) => item.incidentId === incident.id),
        resources.filter((item) => item.incidentId === incident.id),
        steps.filter((item) => item.attemptId === attempt?.id),
        pools,
      );
    });
    await Promise.all(events.map((event) => this.enqueue(event)));
    this.rotationCursor = rows.length === batchSize ? rows.at(-1)!.incident.id : undefined;
  }

  private async poolIdsBySlot(slotIds: string[]) {
    const result = new Map<string, Array<{ poolId: string; ownerUserId: string }>>();
    if (slotIds.length === 0) return result;
    const rows = await this.database.db.select({
      slotId: cloudEndpointLinks.slotId,
      poolId: endpointPools.id,
      ownerUserId: endpointPools.ownerUserId,
    }).from(cloudEndpointLinks)
      .innerJoin(endpoints, eq(cloudEndpointLinks.endpointId, endpoints.id))
      .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
      .where(inArray(cloudEndpointLinks.slotId, [...new Set(slotIds)]));
    for (const row of rows) result.set(row.slotId, [...(result.get(row.slotId) ?? []), { poolId: row.poolId, ownerUserId: row.ownerUserId }]);
    return result;
  }

  private async enqueue(event: NotificationEvent) {
    await this.queues.notifications.add("fanout-event", { kind: "fanout", event }, {
      jobId: `fanout-${event.eventId.replaceAll(":", "-")}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    });
  }
}

function healthEvent(
  state: typeof addressHealthStates.$inferSelect,
  policy: typeof addressHealthPolicies.$inferSelect | null,
  ownerUserId: string,
  poolIds: string[],
  address: typeof endpointAddresses.$inferSelect | null,
): NotificationEvent | undefined {
  const currentPolicy = !!policy
    && policy.revision === state.policyRevision
    && policy.configId === state.configId
    && policy.family === state.family
    && (state.slotId ? policy.slotId === state.slotId : policy.endpointId === state.endpointId);
  const confirmedFailure = state.latestDecision === "failure" && currentPolicy
    && state.healthState === "unhealthy" && state.consecutiveFailures >= policy.failureThreshold;
  const confirmedRecovery = state.latestDecision === "success" && currentPolicy
    && state.healthState === "healthy" && state.consecutiveSuccesses >= policy.successThreshold;
  if (state.latestDecision !== "unknown" && !confirmedFailure && !confirmedRecovery) return undefined;
  const eventType = confirmedFailure
    ? "health.target_failed"
    : confirmedRecovery
      ? "health.target_recovered"
      : "health.insufficient_probes";
  const targetId = state.slotId ?? state.endpointId!;
  const label = address ? `${address.state === "candidate" ? "Candidate" : "Current"} address ${address.address} for target ${targetId}` : `Health target ${targetId}`;
  const summary = state.latestDecision === "failure"
    ? `${label} failed its health checks.`
    : state.latestDecision === "success"
      ? `${label} recovered.`
      : `${label} has insufficient valid probe evidence.`;
  return {
    eventId: stateEventId(["health", state.id, state.stateChangedAt.toISOString(), state.latestDecision, state.healthState]),
    eventType,
    ownerUserId,
    ...(poolIds.length > 0 ? { poolIds: [...new Set(poolIds)].sort() } : {}),
    occurredAt: state.stateChangedAt.toISOString(),
    payload: {
      summary,
      healthStateId: state.id,
      targetId,
      ...(address ? { addressId: address.id, address: address.address, addressRole: address.state } : {}),
      targetType: state.slotId ? "managed_address_slot" : "endpoint",
      family: state.family,
      decision: state.latestDecision,
      healthState: state.healthState,
      consecutiveResults: confirmedFailure ? state.consecutiveFailures : confirmedRecovery ? state.consecutiveSuccesses : 0,
      threshold: confirmedFailure ? policy.failureThreshold : confirmedRecovery ? policy.successThreshold : null,
    },
  };
}

function rotationEvent(
  incident: typeof rotationIncidents.$inferSelect,
  attempt: typeof rotationAttempts.$inferSelect | null,
  publications: Array<Pick<typeof rotationPublications.$inferSelect, "id" | "status" | "errorCode">>,
  resources: Array<Pick<typeof rotationResources.$inferSelect, "id" | "cleanupStatus">>,
  steps: Array<Pick<typeof rotationSteps.$inferSelect, "id" | "status" | "errorCode">>,
  poolIds: string[],
): NotificationEvent {
  const publicationState = publications.map((item) => [item.id, item.status, item.errorCode]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const cleanupState = resources.map((item) => [item.id, item.cleanupStatus]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const stepState = steps.map((item) => [item.id, item.status, item.errorCode]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const errorCodes = [incident.errorCode, ...publications.map((item) => item.errorCode), ...steps.map((item) => item.errorCode)].filter((code): code is string => !!code);
  const { eventType, summary } = classifyRotation(incident, publications, resources, errorCodes);
  return {
    eventId: stateEventId(["rotation", incident.id, incident.status, incident.phase, incident.currentSegmentId, incident.currentAttemptId, incident.errorCode, publicationState, cleanupState, stepState]),
    eventType,
    ownerUserId: incident.ownerUserId,
    ...(poolIds.length > 0 ? { poolIds: [...new Set(poolIds)].sort() } : {}),
    occurredAt: (incident.completedAt ?? incident.updatedAt).toISOString(),
    payload: {
      summary,
      incidentId: incident.id,
      slotId: incident.slotId,
      family: incident.family,
      status: incident.status,
      phase: incident.phase,
      errorCode: incident.errorCode,
      segmentId: incident.currentSegmentId,
      attemptId: incident.currentAttemptId,
      attemptSequence: attempt?.sequence ?? null,
      publicationStatus: summarizeStatuses(publications.map((item) => item.status)),
      cleanupStatus: summarizeStatuses(resources.map((item) => item.cleanupStatus)),
    },
  };
}

function classifyRotation(
  incident: typeof rotationIncidents.$inferSelect,
  publications: Array<Pick<typeof rotationPublications.$inferSelect, "status">>,
  resources: Array<Pick<typeof rotationResources.$inferSelect, "cleanupStatus">>,
  errorCodes: string[],
) {
  if (incident.terminatedAt) return { eventType: "rotation.terminated", summary: `Rotation ${incident.id} was terminated by the user; remaining resources require manual review.` };
  if (resources.some((item) => item.cleanupStatus === "failed") || errorCodes.some((code) => /cleanup/.test(code))) {
    return { eventType: "rotation.cleanup_failed", summary: `Rotation ${incident.id} could not finish address cleanup.` };
  }
  if (publications.some((item) => item.status === "failed") || errorCodes.some((code) => /dns|publication/.test(code))) {
    return { eventType: "rotation.dns_partial", summary: `Rotation ${incident.id} has incomplete DNS publication.` };
  }
  if (errorCodes.some((code) => /permission|access_denied|unauthori[sz]ed|forbidden|quota/.test(code))) {
    return { eventType: "rotation.permission_or_quota", summary: `Rotation ${incident.id} is blocked by cloud permission or quota.` };
  }
  if (incident.status === "exhausted") return { eventType: "rotation.exhausted", summary: `Rotation ${incident.id} exhausted its address-change budget.` };
  if (incident.status === "complete") return { eventType: "rotation.completed", summary: `Rotation ${incident.id} and its required cleanup completed.` };
  if (incident.status === "paused") return { eventType: "rotation.paused", summary: `Rotation ${incident.id} is paused.` };
  if (incident.phase === "candidate") return { eventType: "rotation.candidate_verification", summary: `Rotation ${incident.id} is verifying its candidate address.` };
  if (incident.phase === "publish") return { eventType: "rotation.dns_publication", summary: `Rotation ${incident.id} is publishing verified DNS state.` };
  if (incident.phase === "cleanup" && resources.length > 0 && resources.every((item) => item.cleanupStatus === "retained" || item.cleanupStatus === "released")) {
    return { eventType: "rotation.cleanup_completed", summary: `Rotation ${incident.id} finished its required address cleanup.` };
  }
  if (incident.phase === "cleanup") return { eventType: "rotation.cleanup", summary: `Rotation ${incident.id} is cleaning up its prior address.` };
  return { eventType: "rotation.started", summary: `Rotation ${incident.id} is changing its cloud address.` };
}

function summarizeStatuses(statuses: string[]) {
  if (statuses.length === 0) return "not_started";
  const unique = [...new Set(statuses)];
  return unique.length === 1 ? unique[0] : "partial";
}

function stateEventId(identity: unknown[]) {
  return `state:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}

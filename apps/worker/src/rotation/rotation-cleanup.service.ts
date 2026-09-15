import { randomUUID } from "node:crypto";
import { Injectable, Optional, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  CloudError,
  planCloudRotationCleanup,
  type CloudInventory,
  type CloudObservation,
  type CloudStepResult,
  type CleanupOwnershipSnapshot,
} from "@masterdns/cloud-providers";
import {
  cloudAddresses,
  databaseNow,
  dnsRecords,
  endpointAddresses,
  managedAddressSlots,
  rotationAttempts,
  rotationIncidents,
  rotationLeases,
  rotationPublications,
  rotationResources,
  rotationSteps,
  rotationStepObservations,
  lockRotationContext,
  type RotationContext,
  type RotationTransaction,
} from "@masterdns/db";
import type { SlotRef } from "@masterdns/contracts";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
import { CloudRuntimeService } from "../cloud/cloud-runtime.service.js";
import { acquireRotationLease, releaseRotationLease, verifyRotationLease } from "./rotation-lock.js";
import { livePublicationMatches, publicationAuthorizationError } from "./rotation-publication.service.js";
type Resource = typeof rotationResources.$inferSelect;
const noEffect = new Set([
  "permission_denied",
  "quota_exceeded",
  "rate_limited",
  "credentials_expired",
  "invalid_credentials",
  "cleanup_not_authorized",
  "remote_identity_changed",
  "resource_ownership_ambiguous",
  "rotation_unsupported",
]);
@Injectable()
export class RotationCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(RotationCleanupService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: CloudRuntimeService,
    @Optional() private readonly queues?: QueueRuntimeService,
  ) {}
  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.recover();
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : "cleanup_failed");
    } finally {
      this.running = false;
    }
  }
  async recover() {
    const rows = await this.database.db
      .select({ id: rotationResources.id })
      .from(rotationResources)
      .where(
        and(inArray(rotationResources.cleanupStatus, ["pending", "failed"]), sql`${rotationResources.cleanupDueAt} <= clock_timestamp()`),
      )
      .limit(200);
    for (const r of rows) await this.run(r.id, new Date());
    const incidents = await this.database.db
      .select({ id: rotationIncidents.id })
      .from(rotationIncidents)
      .where(and(eq(rotationIncidents.phase, "cleanup"), ne(rotationIncidents.status, "complete")))
      .limit(200);
    for (const i of incidents) await this.complete(i.id);
  }
  async run(resourceId: string, _now: Date) {
    // Admission always uses database time. A caller-provided future clock cannot bypass TTL.
    const initial = await this.database.db.transaction(async (tx) => {
      const [r] = await tx.select().from(rotationResources).where(eq(rotationResources.id, resourceId));
      if (!r || !["pending", "failed"].includes(r.cleanupStatus)) return;
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, r.incidentId));
      if (!incident) return;
      const c = await lockRotationContext(tx, incident.slotId);
      const lease = await acquireRotationLease(tx, c.physicalKey, randomUUID());
      if (!lease) return;
      const physical = await verifyRotationLease(tx, lease);
      const [step] = r.cleanupStepId ? await tx.select().from(rotationSteps).where(eq(rotationSteps.id, r.cleanupStepId)) : [];
      if (
        c.physicalKey !== incident.physicalKey ||
        (physical?.incidentId && physical.incidentId !== incident.id) ||
        (physical?.unresolvedStepId && physical.unresolvedStepId !== step?.id)
      ) {
        await releaseRotationLease(tx, lease);
        return;
      }
      return { c, r, incident, lease, step };
    });
    if (!initial) return;
    const { c, r, lease } = initial;
    try {
      const observing = initial.step && ["in_flight", "pending", "ambiguous"].includes(initial.step.status);
      const adapter = await this.runtime.adapter(c.account.id, c.instance.service, { observation: !!observing });
      if (observing) {
        if (!adapter.observeDetails) throw new Error("cleanup_observation_unavailable");
        const step = initial.step!;
        const result = await adapter.observeDetails({
          ...step.plan,
          arguments: { ...step.plan.arguments, receipt: step.receipt ?? {}, previousExecution: true },
        });
        await this.receipt(r, step.id, result, true);
        return;
      }
      const live = await adapter.inspect({
        accountId: c.account.id,
        service: c.instance.service,
        region: c.instance.region,
        instanceId: c.instance.externalId,
      });
      const dispatched = await this.database.db.transaction(async (tx) => {
        const current = await lockRotationContext(tx, c.slot.id);
        const physical = await verifyRotationLease(tx, lease);
        if (!physical || physical.unresolvedStepId) return;
        const [resource] = await tx.select().from(rotationResources).where(eq(rotationResources.id, r.id)).for("update");
        if (!resource) return;
        const now = await databaseNow(tx);
        if (current.account.credentialCiphertext !== c.account.credentialCiphertext || current.physicalKey !== c.physicalKey)
          throw new Error("cleanup_identity_changed");
        await this.eligible(tx, current, resource, now);
        if (!livePublicationMatches(current, live)) throw new Error("cleanup_replacement_not_live");
        // IPv6 may remain on this exact ENI until unassignment. Allocations must be detached;
        // provider execute additionally reads the allocation's account-wide attachment/tags/ARN.
        const oldLive = live.interfaces.flatMap((i) => i.addresses.map((a) => ({ i, a }))).find((x) => x.a.address === resource.address);
        if (
          oldLive &&
          (current.slot.family !== "6" ||
            current.instance.service !== "ec2" ||
            oldLive.i.id !== current.iface!.externalId ||
            oldLive.a.primary)
        )
          throw new Error("cleanup_resource_attached");
        const plan = await this.plan(tx, current, resource);
        const stepId = resource.cleanupStepId ?? `cleanup:${resource.id}`;
        const [last] = await tx
          .select({ sequence: sql<number>`coalesce(max(${rotationSteps.sequence}),0)` })
          .from(rotationSteps)
          .where(eq(rotationSteps.attemptId, resource.attemptId));
        if (!resource.cleanupStepId)
          await tx
            .insert(rotationSteps)
            .values({ id: stepId, attemptId: resource.attemptId, sequence: Number(last!.sequence) + 1, plan: { ...plan, id: stepId } });
        const [persisted] = await tx.select().from(rotationSteps).where(eq(rotationSteps.id, stepId)).for("update");
        if (!persisted || !["prepared", "not_applied", "rejected_no_effect"].includes(persisted.status)) return;
        await tx
          .update(rotationSteps)
          .set({ status: "in_flight", fence: lease.revision, dispatchedAt: now, updatedAt: now, errorCode: null })
          .where(eq(rotationSteps.id, stepId));
        await tx
          .update(rotationResources)
          .set({ cleanupStepId: stepId, cleanupStatus: "pending", cleanupError: null })
          .where(eq(rotationResources.id, resource.id));
        await tx
          .update(rotationLeases)
          .set({ incidentId: resource.incidentId, unresolvedStepId: stepId })
          .where(eq(rotationLeases.physicalKey, lease.physicalKey));
        return { ...persisted.plan, id: stepId };
      });
      if (!dispatched) return;
      let result: CloudStepResult;
      try {
        result = await adapter.execute(dispatched);
      } catch (e) {
        if (e instanceof CloudError && noEffect.has(e.code)) await this.rejectNoEffect(r, dispatched.id, e.code);
        throw e;
      }
      await this.receipt(r, dispatched.id, result, false);
    } catch (e) {
      const code = e instanceof CloudError ? e.code : e instanceof Error ? e.message.slice(0, 80) : "cleanup_failed";
      await this.database.db
        .update(rotationResources)
        .set({
          cleanupStatus: "failed",
          cleanupError: code,
          cleanupDueAt: new Date(Math.max(r.cleanupDueAt?.getTime() ?? 0, Date.now() + 30000)),
        })
        .where(and(eq(rotationResources.id, r.id), ne(rotationResources.cleanupStatus, "released")));
      if (r.cleanupError !== code && code !== "cleanup_grace_pending") {
        this.logger.warn(`Cleanup ${r.id}: ${code}`);
        await this.queues?.notifications.add(
          "fanout-event",
          {
            kind: "fanout",
            event: {
              eventId: randomUUID(),
              eventType: "rotation.cleanup_failed",
              ownerUserId: c.account.ownerUserId,
              occurredAt: new Date().toISOString(),
              payload: { summary: "Cloud address cleanup needs attention", resourceId: r.id, errorCode: code },
            },
          },
          { removeOnComplete: 1000, removeOnFail: 1000 },
        );
      }
    } finally {
      await this.database.db.transaction((tx) => releaseRotationLease(tx, lease));
    }
  }
  private async eligible(tx: RotationTransaction, c: RotationContext, r: Resource, now: Date) {
    const error = publicationAuthorizationError(c);
    if (error) throw new Error(error);
    if (!r.cleanupDueAt || r.cleanupDueAt > now) throw new Error("cleanup_grace_pending");
    if (r.origin !== "system" && !c.authorization!.allowReleaseAddress) throw new Error("original_address_release_not_authorized");
    if (r.origin === "system" && !r.ownershipAttemptId) throw new Error("resource_ownership_ambiguous");
    if (c.slot.candidateAddressId || c.slot.currentVersion !== r.cleanupAddressVersion || c.address?.address === r.address)
      throw new Error("cleanup_current_candidate_retained");
    const [publication] = await tx
      .select()
      .from(rotationPublications)
      .where(
        and(
          eq(rotationPublications.slotId, c.slot.id),
          eq(rotationPublications.addressVersion, c.slot.currentVersion),
          eq(rotationPublications.status, "applied"),
        ),
      );
    if (!publication) throw new Error("cleanup_publication_pending");
    const [endpoint] = await tx
      .select({ id: endpointAddresses.id })
      .from(endpointAddresses)
      .where(and(sql`${endpointAddresses.address}::inet = ${r.address}::inet`, inArray(endpointAddresses.state, ["current", "candidate"])));
    const [record] = await tx
      .select({ id: dnsRecords.id })
      .from(dnsRecords)
      .where(
        and(
          sql`case when ${dnsRecords.type} in ('A','AAAA') then ${dnsRecords.content}::inet = ${r.address}::inet else false end`,
          isNull(dnsRecords.deletedAt),
        ),
      );
    const [slot] = await tx
      .select({ id: managedAddressSlots.id })
      .from(managedAddressSlots)
      .innerJoin(
        cloudAddresses,
        or(eq(cloudAddresses.id, managedAddressSlots.currentAddressId), eq(cloudAddresses.id, managedAddressSlots.candidateAddressId)),
      )
      .where(sql`${cloudAddresses.address}::inet = ${r.address}::inet`);
    if (endpoint || record || slot) throw new Error("cleanup_resource_referenced");
  }
  private async plan(tx: RotationTransaction, c: RotationContext, r: Resource) {
    const [attempt] = await tx.select().from(rotationAttempts).where(eq(rotationAttempts.id, r.attemptId));
    if (!attempt) throw new Error("cleanup_attempt_missing");
    const slot = r.snapshot.slot as SlotRef | undefined;
    if (
      !slot ||
      slot.accountId !== c.account.id ||
      slot.instanceId !== c.instance.externalId ||
      slot.interfaceId !== c.iface!.externalId ||
      slot.region !== c.instance.region ||
      slot.service !== c.instance.service ||
      slot.slotId !== c.slot.id
    )
      throw new Error("cleanup_identity_changed");
    const before = structuredClone((r.snapshot.inventory ?? attempt.beforeInventory) as CloudInventory);
    const iface = before.interfaces.find((i) => i.id === slot.interfaceId);
    if (!iface) throw new Error("cleanup_identity_changed");
    if (r.role === "candidate") {
      const receipt = r.snapshot.receipt as CloudStepResult | undefined;
      if (
        receipt?.candidateAddress !== r.address ||
        (r.allocationId && receipt?.allocationId !== r.allocationId) ||
        (r.resourceId && receipt?.resourceId !== r.resourceId)
      )
        throw new Error("resource_ownership_ambiguous");
      const previous = iface.addresses.find((a) => a.family === slot.family);
      iface.addresses = iface.addresses.filter((a) => a.family !== slot.family);
      iface.addresses.push({
        ...previous,
        address: r.address,
        family: slot.family,
        primary: slot.family === 4,
        ...(r.allocationId ? { allocationId: r.allocationId } : {}),
        ...(r.resourceId ? { resourceId: r.resourceId } : {}),
      });
    }
    const original = iface.addresses.find((a) => a.address === r.address && a.family === slot.family);
    if (!original || original.allocationId !== (r.allocationId ?? undefined) || (r.resourceId && original.resourceId !== r.resourceId))
      throw new Error("resource_ownership_ambiguous");
    const ownershipSnapshot: CleanupOwnershipSnapshot | undefined =
      r.origin === "user" && r.allocationId
        ? {
            accountId: slot.accountId,
            instanceId: slot.instanceId,
            interfaceId: slot.interfaceId,
            allocationId: r.allocationId,
            address: r.address,
            ...(r.resourceId ? { resourceId: r.resourceId } : {}),
          }
        : undefined;
    return planCloudRotationCleanup({ ...slot, address: r.address }, before, {
      attemptId: r.attemptId,
      releaseAuthorized: true,
      publishedAddress: c.address!.address,
      ...(r.ownershipAttemptId ? { ownershipAttemptId: r.ownershipAttemptId } : {}),
      ...(ownershipSnapshot ? { ownershipSnapshot } : {}),
    })[0]!;
  }
  private async receipt(r: Resource, stepId: string, result: CloudStepResult, observation: boolean) {
    await this.database.db.transaction(async (tx) => {
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, r.incidentId));
      if (!incident) return;
      await lockRotationContext(tx, incident.slotId);
      const [step] = await tx.select().from(rotationSteps).where(eq(rotationSteps.id, stepId)).for("update");
      if (!step || step.attemptId !== r.attemptId || step.plan.arguments.phase !== "post_publish_cleanup")
        throw new Error("cleanup_step_changed");
      const old = step.receipt ?? {};
      const conflict = ["allocationId", "resourceId"].some((k) => {
        const expected = old[k] ?? r[k as "allocationId" | "resourceId"];
        return expected && (result as Record<string, unknown>)[k] && expected !== (result as Record<string, unknown>)[k];
      });
      const status =
        step.status === "applied"
          ? "applied"
          : conflict || step.status === "ambiguous"
            ? "ambiguous"
            : observation
              ? (result as CloudObservation).status
              : "pending";
      await tx.insert(rotationStepObservations).values({ stepId, observation, result: { ...result } });
      await tx
        .update(rotationSteps)
        .set({
          status,
          receipt: {
            ...old,
            ...result,
            ...(old.allocationId ? { allocationId: old.allocationId } : {}),
            ...(old.resourceId ? { resourceId: old.resourceId } : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(rotationSteps.id, stepId));
      if (status === "applied" || status === "not_applied")
        await tx
          .update(rotationLeases)
          .set({ unresolvedStepId: null })
          .where(and(eq(rotationLeases.physicalKey, incident.physicalKey), eq(rotationLeases.unresolvedStepId, stepId)));
      await tx
        .update(rotationResources)
        .set({
          cleanupStatus: status === "applied" ? "released" : status === "ambiguous" ? "failed" : "pending",
          cleanupError: status === "ambiguous" ? "cleanup_ownership_ambiguous" : null,
          ...(status === "applied" ? { attached: false, referenced: false } : {}),
        })
        .where(eq(rotationResources.id, r.id));
    });
  }
  private async rejectNoEffect(r: Resource, stepId: string, code: string) {
    await this.database.db.transaction(async (tx) => {
      const [i] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, r.incidentId));
      if (!i) return;
      await lockRotationContext(tx, i.slotId);
      await tx.update(rotationSteps).set({ status: "rejected_no_effect", errorCode: code }).where(eq(rotationSteps.id, stepId));
      await tx
        .update(rotationLeases)
        .set({ unresolvedStepId: null })
        .where(and(eq(rotationLeases.physicalKey, i.physicalKey), eq(rotationLeases.unresolvedStepId, stepId)));
    });
  }
  async complete(incidentId: string) {
    await this.database.db.transaction(async (tx) => {
      const [i] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, incidentId));
      if (!i || i.phase !== "cleanup" || i.status === "complete") return;
      const c = await lockRotationContext(tx, i.slotId);
      const [physical] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, c.physicalKey)).for("update");
      if (physical?.unresolvedStepId) return;
      const remaining = await tx
        .select({ id: rotationResources.id })
        .from(rotationResources)
        .where(and(eq(rotationResources.incidentId, incidentId), inArray(rotationResources.cleanupStatus, ["pending", "failed"])));
      if (remaining.length) return;
      const [publication] = await tx
        .select()
        .from(rotationPublications)
        .where(and(eq(rotationPublications.incidentId, incidentId), eq(rotationPublications.status, "applied")));
      if (!publication) return;
      const now = await databaseNow(tx);
      await tx
        .update(rotationIncidents)
        .set({ status: "complete", phase: "complete", completedAt: now, updatedAt: now, errorCode: null })
        .where(eq(rotationIncidents.id, incidentId));
      await tx
        .update(rotationLeases)
        .set({ incidentId: null })
        .where(and(eq(rotationLeases.physicalKey, c.physicalKey), eq(rotationLeases.incidentId, incidentId)));
    });
  }
}

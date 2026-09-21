import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
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
  addressHealthStates,
  probeRoundSequences,
  resetHealthEvidence,
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
  lockRotationHealth,
  healthRevisionMatches,
  rotationAuthorizationError,
  reserveCloudRotationWrite,
  recordCloudRotationThrottle,
  type RotationContext,
  type RotationTransaction,
} from "@masterdns/db";
import type { SlotRef } from "@masterdns/contracts";
import { DatabaseService } from "../database.service.js";
import { CloudRuntimeService } from "../cloud/cloud-runtime.service.js";
import { acquireRotationLease, releaseRotationLease, verifyRotationLease } from "./rotation-lock.js";
import { livePublicationMatches } from "./rotation-publication.service.js";
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
      const identity = cleanupIdentity(r);
      if (identity && !r.cleanupStepId) {
        const aliases = (await tx.select().from(rotationResources).where(eq(rotationResources.incidentId, incident.id)).orderBy(asc(rotationResources.createdAt), asc(rotationResources.id)))
          .filter(other => cleanupIdentity(other) === identity);
        const canonical = aliases.find(other => other.cleanupStepId) ?? aliases[0]!;
        if (canonical.id !== r.id) {
          await tx.update(rotationResources).set({ snapshot: { ...r.snapshot, cleanupCanonicalResourceId: canonical.id },
            cleanupStatus: canonical.cleanupStatus, cleanupError: canonical.cleanupError,
            ...(canonical.cleanupStatus === "released" ? { attached: false, referenced: false } : {}) }).where(eq(rotationResources.id, r.id));
          return;
        }
      }
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
        // Gate only new writes; dispatched effects still need observation after pause/revocation.
        const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, r.incidentId)).for("update");
        if (!incident || incident.pausedByUserId || incident.status !== "active") return;
        const physical = await verifyRotationLease(tx, lease);
        if (!physical || physical.unresolvedStepId || (physical.incidentId && physical.incidentId !== incident.id)) return;
        const [resource] = await tx.select().from(rotationResources).where(eq(rotationResources.id, r.id)).for("update");
        if (!resource) return;
        const now = await databaseNow(tx);
        if (current.account.credentialCiphertext !== c.account.credentialCiphertext || current.physicalKey !== c.physicalKey)
          throw new Error("cleanup_identity_changed");
        await this.eligible(tx, current, incident, resource, now);
        if (!livePublicationMatches(current, live)) throw new Error("cleanup_replacement_not_live");
        // IPv6 may remain on this exact ENI until unassignment. Allocations must be detached;
        // provider execute additionally reads the allocation's account-wide attachment/tags/ARN.
        const oldLive = live.interfaces.flatMap((i) => i.addresses.map((a) => ({ i, a }))).find((x) => x.a.address === resource.address);
        if (
          oldLive &&
          !(current.instance.service === "linode" && current.slot.family === "4" && oldLive.i.id === current.iface!.externalId &&
            oldLive.i.addresses.some(a => a.family === 4 && a.address === current.address?.address && a.address !== resource.address)) &&
          (current.slot.family !== "6" ||
            current.instance.service !== "ec2" ||
            oldLive.i.id !== current.iface!.externalId ||
            oldLive.a.primary)
        )
          throw new Error("cleanup_resource_attached");
        // A started chain owns the physical guest configuration until its last step settles.
        const siblings = await tx.select().from(rotationResources).where(and(eq(rotationResources.incidentId, incident.id), ne(rotationResources.id, resource.id), inArray(rotationResources.cleanupStatus, ["pending", "failed"])));
        if (siblings.some(other => other.cleanupStepId && Array.isArray(other.snapshot.cleanupStepIds) && other.snapshot.cleanupStepIds.length > 1)) return;
        let stepId = resource.cleanupStepId;
        if (!stepId) {
          const plans = await this.plan(tx, current, resource, live);
          if (!plans.length) throw new Error("cleanup_plan_ambiguous");
          const [last] = await tx.select({ sequence: sql<number>`coalesce(max(${rotationSteps.sequence}),0)` }).from(rotationSteps).where(eq(rotationSteps.attemptId, resource.attemptId));
          const ids = plans.map((_, index) => index === 0 ? `cleanup:${resource.id}` : `cleanup:${resource.id}:${index}`);
          await tx.insert(rotationSteps).values(plans.map((plan, index) => ({ id: ids[index]!, attemptId: resource.attemptId, sequence: Number(last!.sequence) + index + 1,
            plan: { ...plan, id: ids[index]!, arguments: { ...plan.arguments, cleanupResourceId: resource.id } } })));
          resource.snapshot = { ...resource.snapshot, cleanupStepIds: ids };
          await tx.update(rotationResources).set({ snapshot: resource.snapshot, cleanupStepId: ids[0]! }).where(eq(rotationResources.id, resource.id));
          stepId = ids[0]!;
          resource.cleanupStepId = stepId;
        }
        const chain = await this.chain(tx, resource);
        const persisted = chain.find(s => s.id === stepId);
        if (!persisted || !["prepared", "not_applied", "rejected_no_effect"].includes(persisted.status)) return;
        if (persisted.plan.action === "linode.instance.reboot" && !current.authorization!.allowStopStart) throw new Error("stop_not_authorized");
        const applied = await tx.select().from(rotationSteps).where(eq(rotationSteps.attemptId, resource.attemptId)).orderBy(asc(rotationSteps.sequence));
        const prior = applied.filter(s => s.status === "applied" && (s.plan.arguments.phase === "rotation" || chain.some(member => member.id === s.id)));
        const allocation = prior.filter(s => s.plan.arguments.phase === "rotation" && s.plan.action.endsWith(".allocate")).at(-1);
        const plan = { ...persisted.plan, arguments: { ...persisted.plan.arguments, priorReceipts: prior.map(s => ({ action: s.plan.action, receipt: s.receipt })),
          ...(allocation ? { candidateReceipt: allocation.receipt } : {}), allowStop: current.authorization!.allowStopStart } };
        const admission = await reserveCloudRotationWrite(tx, { accountId: current.account.id, service: current.instance.service, region: current.instance.region, stepId, action: plan.action });
        if (!admission.allowed) {
          await tx.update(rotationResources).set({ cleanupStatus: "pending", cleanupError: "rotation_rate_limited", cleanupDueAt: admission.retryAt }).where(eq(rotationResources.id, resource.id));
          await tx.update(rotationIncidents).set({ errorCode: "rotation_rate_limited", nextRunAt: admission.retryAt, updatedAt: now }).where(and(eq(rotationIncidents.id, incident.id), eq(rotationIncidents.phase, "cleanup")));
          return;
        }
        await tx
          .update(rotationSteps)
          .set({ plan, status: "in_flight", fence: lease.revision, dispatchedAt: now, updatedAt: now, errorCode: null })
          .where(eq(rotationSteps.id, stepId));
        await tx
          .update(rotationResources)
          .set({ cleanupStepId: stepId, cleanupStatus: "pending", cleanupError: null })
          .where(eq(rotationResources.id, resource.id));
        await tx
          .update(rotationLeases)
          .set({ incidentId: resource.incidentId, unresolvedStepId: stepId })
          .where(eq(rotationLeases.physicalKey, lease.physicalKey));
        await tx.update(rotationIncidents).set({ errorCode: null, updatedAt: now }).where(and(eq(rotationIncidents.id, incident.id), eq(rotationIncidents.errorCode, "rotation_rate_limited"), eq(rotationIncidents.phase, "cleanup")));
        return { ...plan, id: stepId };
      });
      if (!dispatched) return;
      let result: CloudStepResult;
      try {
        result = await adapter.execute(dispatched);
      } catch (e) {
        if (e instanceof CloudError && noEffect.has(e.code)) {
          await this.rejectNoEffect(r, dispatched.id, e.code, e.retryAfterMs);
          if (e.code === "rate_limited") return;
        }
        throw e;
      }
      await this.receipt(r, dispatched.id, result, false);
    } catch (e) {
      const code = e instanceof CloudError ? e.code : e instanceof Error ? e.message.slice(0, 80) : "cleanup_failed";
      if (code === "cleanup_grace_pending") return;
      // P11c's durable scanner is the only notification/routing authority.
      await this.database.db.transaction(async (tx) => {
        await lockRotationContext(tx, c.slot.id);
        const failed = await tx
          .update(rotationResources)
          .set({
            cleanupStatus: "failed",
            cleanupError: code,
            cleanupDueAt: new Date(Math.max(r.cleanupDueAt?.getTime() ?? 0, Date.now() + 30000)),
          })
          .where(and(eq(rotationResources.id, r.id), ne(rotationResources.cleanupStatus, "released")))
          .returning({ id: rotationResources.id });
        if (failed.length)
          await tx
            .update(rotationIncidents)
            .set({ errorCode: "cleanup_failed", updatedAt: new Date() })
            .where(and(eq(rotationIncidents.id, r.incidentId), eq(rotationIncidents.phase, "cleanup")));
      });
      if (r.cleanupError !== code) this.logger.warn(`Cleanup ${r.id}: ${code}`);
    } finally {
      await this.database.db.transaction((tx) => releaseRotationLease(tx, lease));
    }
  }
  private async eligible(tx: RotationTransaction, c: RotationContext, incident: typeof rotationIncidents.$inferSelect, r: Resource, now: Date) {
    const error = rotationAuthorizationError(c, incident.trigger);
    if (error) throw new Error(error);
    const health = await lockRotationHealth(tx, c);
    if (incident.physicalKey !== c.physicalKey || incident.authorizationRevision !== c.authorization!.revision ||
      incident.policyRevision !== c.policy!.revision || incident.addressVersion !== c.addressVersion || (incident.trigger !== "manual" && !healthRevisionMatches(incident, health)))
      throw new Error("cleanup_incident_changed");
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
  private async plan(tx: RotationTransaction, c: RotationContext, r: Resource, live?: CloudInventory) {
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
    const allocationReceipt = async (attemptId: string | null, address: string) => {
      if (!attemptId) return undefined;
      const steps = await tx.select().from(rotationSteps).where(eq(rotationSteps.attemptId, attemptId)).orderBy(asc(rotationSteps.sequence));
      return steps.find(step => step.status === "applied" && step.plan.arguments.phase === "rotation" && step.plan.action.endsWith(".allocate") && step.receipt?.candidateAddress === address)?.receipt as CloudStepResult | undefined;
    };
    const cleanupReceipt = await allocationReceipt(r.ownershipAttemptId, r.address);
    const publishedReceipt = await allocationReceipt(c.address?.attemptId ?? null, c.address!.address);
    const iface = before.interfaces.find((i) => i.id === slot.interfaceId);
    if (!iface) throw new Error("cleanup_identity_changed");
    if (r.role === "candidate") {
      const receipt = cleanupReceipt ?? r.snapshot.receipt as CloudStepResult | undefined;
      if (
        receipt?.candidateAddress !== r.address ||
        (r.allocationId && receipt?.allocationId !== r.allocationId) ||
        (r.resourceId && receipt?.resourceId !== r.resourceId)
      )
        throw new Error("resource_ownership_ambiguous");
      const previous = slot.service === "ec2" || slot.service === "lightsail" ? iface.addresses.find((a) => a.family === slot.family) : undefined;
      iface.addresses = iface.addresses.filter((a) => slot.service === "linode" ? a.address !== r.address : a.family !== slot.family);
      iface.addresses.push({
        ...previous,
        ...(receipt?.after?.addressMetadata && typeof receipt.after.addressMetadata === "object" ? { metadata: receipt.after.addressMetadata as Record<string, unknown> } : {}),
        ...(typeof receipt?.after?.privateAddress === "string" ? { privateAddress: receipt.after.privateAddress } : {}),
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
      (r.origin === "user" || slot.service === "azure_vm" || slot.service === "linode") && r.allocationId
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
      allowStop: c.authorization!.allowStopStart,
      ...(live ? { publishedInventory: live } : {}),
      ...(publishedReceipt ? { publishedReceipt, publishedAttemptId: c.address!.attemptId! } : {}),
      ...(cleanupReceipt ? { cleanupReceipt } : {}),
      ...(r.ownershipAttemptId ? { ownershipAttemptId: r.ownershipAttemptId } : {}),
      ...(ownershipSnapshot ? { ownershipSnapshot } : {}),
    });
  }
  private async chain(tx: RotationTransaction, resource: Resource, recordingReceipt = false) {
    const ids = resource.snapshot.cleanupStepIds ?? (resource.cleanupStepId ? [resource.cleanupStepId] : []);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length || !ids.includes(resource.cleanupStepId)) throw new Error("cleanup_plan_ambiguous");
    const steps = await tx.select().from(rotationSteps).where(inArray(rotationSteps.id, ids as string[])).orderBy(asc(rotationSteps.sequence)).for("update");
    if (steps.length !== ids.length || steps.some((step, index) => step.id !== ids[index] || step.attemptId !== resource.attemptId || step.plan.arguments.phase !== "post_publish_cleanup" ||
      (resource.snapshot.cleanupStepIds !== undefined ? step.plan.arguments.cleanupResourceId !== resource.id : step.plan.arguments.cleanupResourceId !== undefined && step.plan.arguments.cleanupResourceId !== resource.id) || step.plan.id !== step.id)) throw new Error("cleanup_plan_ambiguous");
    const pointer = ids.indexOf(resource.cleanupStepId);
    if (steps.slice(0, pointer).some(step => step.status !== "applied" && !(recordingReceipt && step.status === "ambiguous")) || steps.slice(pointer + 1).some(step => step.status !== "prepared")) throw new Error("cleanup_plan_ambiguous");
    return steps;
  }
  private async receipt(r: Resource, stepId: string, result: CloudStepResult, observation: boolean) {
    await this.database.db.transaction(async (tx) => {
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, r.incidentId));
      if (!incident) return;
      const context = await lockRotationContext(tx, incident.slotId);
      const [resource] = await tx.select().from(rotationResources).where(eq(rotationResources.id, r.id)).for("update");
      if (!resource) return;
      const chain = await this.chain(tx, resource, true);
      const historyAmbiguous = chain.some(member => member.id !== stepId && member.status === "ambiguous");
      const [step] = await tx.select().from(rotationSteps).where(eq(rotationSteps.id, stepId)).for("update");
      if (!step || !chain.some(member => member.id === stepId) || step.attemptId !== r.attemptId || step.plan.arguments.phase !== "post_publish_cleanup")
        throw new Error("cleanup_step_changed");
      const old = step.receipt ?? {};
      const conflict = ["allocationId", "resourceId"].some((k) => {
        const expected = old[k] ?? r[k as "allocationId" | "resourceId"];
        return expected && (result as Record<string, unknown>)[k] && expected !== (result as Record<string, unknown>)[k];
      });
      const status =
        conflict || step.status === "ambiguous"
          ? "ambiguous"
          : step.status === "applied"
            ? "applied"
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
            ...(step.status === "applied" ? {} : result),
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
      // Late receipts are retained on their step; only the current pointer may advance.
      if (resource.cleanupStepId !== stepId) {
        if (status === "ambiguous") {
          await tx.update(rotationResources).set({ cleanupStatus: "failed", cleanupError: "cleanup_ownership_ambiguous" }).where(eq(rotationResources.id, r.id));
          await tx.update(rotationIncidents).set({ errorCode: "cleanup_failed" }).where(eq(rotationIncidents.id, r.incidentId));
        }
        return;
      }
      const next = status === "applied" && !historyAmbiguous ? chain[chain.findIndex(member => member.id === stepId) + 1] : undefined;
      let snapshot = resource.snapshot;
      if (status === "applied" && step.status !== "applied" && step.plan.action === "linode.instance.reboot") {
        const now = await databaseNow(tx);
        const [sequence] = await tx.select().from(probeRoundSequences).where(eq(probeRoundSequences.slotId, context.slot.id));
        const health = await lockRotationHealth(tx, context);
        const cutoff = Math.max(sequence?.lastSequence ?? 0, health.state?.lastAppliedSequence ?? 0);
        snapshot = { ...snapshot, cleanupHealthCutoff: cutoff, cleanupHealthAfter: now.toISOString() };
        await tx.update(addressHealthStates).set({ ...resetHealthEvidence, lastAppliedSequence: cutoff, updatedAt: now }).where(eq(addressHealthStates.slotId, context.slot.id));
      }
      await tx.update(rotationResources).set({
        snapshot,
        cleanupStepId: next?.id ?? stepId,
        cleanupStatus: status === "ambiguous" || historyAmbiguous ? "failed" : status === "applied" && !next ? "released" : "pending",
        cleanupError: status === "ambiguous" || historyAmbiguous ? "cleanup_ownership_ambiguous" : null,
        ...(status === "applied" ? { attached: false, referenced: false } : {}),
      }).where(eq(rotationResources.id, r.id));
      if (status === "applied" && !next && !historyAmbiguous) {
        const identity = cleanupIdentity(resource);
        if (identity) {
          const aliases = await tx.select().from(rotationResources).where(and(eq(rotationResources.incidentId, r.incidentId), ne(rotationResources.id, r.id), isNull(rotationResources.cleanupStepId)));
          for (const alias of aliases.filter(other => cleanupIdentity(other) === identity)) {
            await tx.update(rotationResources).set({ cleanupStatus: "released", cleanupError: null, attached: false, referenced: false,
              snapshot: { ...alias.snapshot, cleanupCanonicalResourceId: r.id } }).where(eq(rotationResources.id, alias.id));
          }
        }
      }
      const [remainingFailure] = await tx.select({ id: rotationResources.id }).from(rotationResources)
        .where(and(eq(rotationResources.incidentId, r.incidentId), eq(rotationResources.cleanupStatus, "failed")));
      if (remainingFailure) await tx.update(rotationIncidents).set({ errorCode: "cleanup_failed", updatedAt: new Date() })
        .where(and(eq(rotationIncidents.id, r.incidentId), eq(rotationIncidents.phase, "cleanup")));
      else await tx.update(rotationIncidents).set({ errorCode: null, updatedAt: new Date() })
        .where(and(eq(rotationIncidents.id, r.incidentId), eq(rotationIncidents.phase, "cleanup"), eq(rotationIncidents.errorCode, "cleanup_failed")));
    });
  }
  private async rejectNoEffect(r: Resource, stepId: string, code: string, retryAfterMs?: number) {
    await this.database.db.transaction(async (tx) => {
      const [i] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, r.incidentId));
      if (!i) return;
      const c = await lockRotationContext(tx, i.slotId);
      const [step] = await tx.select().from(rotationSteps).where(eq(rotationSteps.id, stepId)).for("update");
      if (!step || step.status !== "in_flight") return;
      if (code === "rate_limited") {
        const retryAt = await recordCloudRotationThrottle(tx, { accountId: c.account.id, service: c.instance.service, region: c.instance.region, stepId, action: step.plan.action, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
        await tx.update(rotationResources).set({ cleanupStatus: "pending", cleanupError: "rotation_rate_limited", cleanupDueAt: retryAt }).where(eq(rotationResources.id, r.id));
        await tx.update(rotationIncidents).set({ errorCode: "rotation_rate_limited", nextRunAt: retryAt }).where(and(eq(rotationIncidents.id, r.incidentId), eq(rotationIncidents.phase, "cleanup")));
      }
      await tx.update(rotationSteps).set({ status: "rejected_no_effect", errorCode: code }).where(and(eq(rotationSteps.id, stepId), eq(rotationSteps.status, "in_flight")));
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
      const resources = await tx.select().from(rotationResources).where(eq(rotationResources.incidentId, incidentId));
      const rebooted = resources.filter(resource => typeof resource.snapshot.cleanupHealthCutoff === "number");
      if (rebooted.length) {
        const health = await lockRotationHealth(tx, c);
        const cutoff = Math.max(...rebooted.map(resource => Number(resource.snapshot.cleanupHealthCutoff)));
        if (!health.success || !healthRevisionMatches(i, health) || !health.state || health.state.lastAppliedSequence <= cutoff) {
          await tx.update(rotationIncidents).set({ errorCode: health.failure ? "cleanup_health_failed" : "probe_insufficient", updatedAt: health.now }).where(eq(rotationIncidents.id, incidentId));
          return;
        }
      }
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

/** Only known system allocation provenance can alias two historical resource rows. */
function cleanupIdentity(resource: Resource): string | undefined {
  const slot = resource.snapshot.slot as SlotRef | undefined;
  if (!slot || !["azure_vm", "linode"].includes(slot.service) || resource.origin !== "system" || !resource.ownershipAttemptId || !resource.allocationId || !resource.resourceId) return undefined;
  const ownership = resource.snapshot.ownership as { metadata?: Record<string, unknown> } | undefined;
  const receipt = resource.snapshot.receipt as CloudStepResult | undefined;
  const receiptMetadata = receipt?.after?.addressMetadata as Record<string, unknown> | undefined;
  const guid = ownership?.metadata?.resourceGuid ?? receiptMetadata?.resourceGuid ?? null;
  return JSON.stringify([slot.accountId, slot.service, slot.region, slot.instanceId, slot.interfaceId, resource.address, resource.allocationId, resource.resourceId, resource.ownershipAttemptId, guid]);
}

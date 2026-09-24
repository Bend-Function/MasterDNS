import { allocationIdentity } from "../cloud/allocation-identity.js";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nextRotationAction, type RotationSnapshot, type RotationStepSnapshot, type RotationCloudRejection } from "@masterdns/automation";
import { planCloudRotation, type CloudInventory, type CloudObservation, type CloudStepResult } from "@masterdns/cloud-providers";
import { cloudAddresses, databaseNow, healthRevisionMatches, lockRotationContext, lockRotationHealth, resetHealthEvidence, addressHealthStates, managedAddressSlots, rotationAttempts, rotationAudit, rotationBudgetSegments, rotationIncidents, rotationLeases, rotationPublications, rotationResources, rotationSteps, rotationStepObservations, rotationAuthorizationError, type RotationContext, type RotationTransaction } from "@masterdns/db";
import { DatabaseService } from "../database.service.js";
import { reserveCloudRotationWrite, recordCloudRotationThrottle } from "@masterdns/db";
import { acquireRotationLease, releaseRotationLease, verifyRotationLease, type RotationLease } from "./rotation-lock.js";

type Incident = typeof rotationIncidents.$inferSelect;
type Step = typeof rotationSteps.$inferSelect;
export type RotationRun = Awaited<ReturnType<RotationStore["read"]>>;
export type AdapterIdentity = { credentialCiphertext: string; externalAccountId: string | null };

@Injectable()
export class RotationStore {
  constructor(private readonly database: DatabaseService) {}
  async claim(id: string) {
    return this.database.db.transaction(async tx => {
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id));
      if (!incident || incident.status === "complete") return;
      const c = await lockRotationContext(tx, incident.slotId);
      const lease = await acquireRotationLease(tx, c.physicalKey, randomUUID());
      if (!lease) { await deferFailedClaim(tx, id); return; }
      const [physical] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, c.physicalKey));
      if (physical?.incidentId && physical.incidentId !== id) {
        await releaseRotationLease(tx, lease); await deferFailedClaim(tx, id); return;
      }
      return lease;
    });
  }
  async release(lease: RotationLease) { await this.database.db.transaction(tx => releaseRotationLease(tx, lease)); }
  async read(id: string, lease: RotationLease) { return this.transaction(id, async (tx, c, incident) => this.snapshot(tx, c, incident, lease)); }
  private async snapshot(tx: RotationTransaction, c: RotationContext, incident: Incident, lease: RotationLease) {
    const h = await lockRotationHealth(tx, c);
    const physical = await verifyRotationLease(tx, lease);
    const [budget] = await tx.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.id, incident.currentSegmentId)).for("update");
    if (!budget) throw new Error("rotation_budget_missing");
    const [attempt] = incident.currentAttemptId ? await tx.select().from(rotationAttempts).where(eq(rotationAttempts.id, incident.currentAttemptId)).for("update") : [];
    const steps = attempt ? await tx.select().from(rotationSteps).where(eq(rotationSteps.attemptId, attempt.id)).orderBy(asc(rotationSteps.sequence)).for("update") : [];
    const [publication] = await tx.select().from(rotationPublications).where(and(eq(rotationPublications.slotId, c.slot.id), eq(rotationPublications.addressVersion, incident.addressVersion)));
    const snapshot: RotationSnapshot = {
      phase: incident.phase,
      authorization: { lifecycleBlocked: c.lifecycleBlocked, managed: !!c.account.enabled && !!c.account.externalAccountId && !!c.authorization?.managed, familyEnabled: (incident.trigger !== "health" || !!c.policy?.enabled) && !!(c.slot.family === "4" ? c.authorization?.allowIpv4Rotation : c.authorization?.allowIpv6Rotation), present: !!c.iface && !!c.address?.inventoryPresent && c.instance.metadata.present !== false && c.iface.scanGeneration === c.instance.scanGeneration,
        regionAllowed: !!c.scope && (c.account.regions === null || c.account.regions.includes(c.instance.region)), conflictingManager: c.conflictingManager },
      revisions: { authorization: c.authorization?.revision ?? 0, policy: c.policy?.revision ?? 0, address: c.addressVersion },
      expectedRevisions: { authorization: incident.authorizationRevision, policy: incident.policyRevision, address: incident.addressVersion },
      lease: { held: !!physical, revision: physical?.revision ?? 0, expectedRevision: lease.revision },
      budget: { segmentId: budget.id, attemptsUsed: budget.attemptsUsed, maxAttempts: budget.maxAttempts, exhausted: budget.exhausted },
      nextAttemptAt: incident.nextAttemptAt.getTime(),
      attempt: attempt ? { attemptId: attempt.id, segmentId: attempt.segmentId, charged: attempt.charged, steps: steps.filter(s => s.plan.arguments.phase !== "post_publish_cleanup").map(stepSnapshot) } : null,
      candidate: c.slot.candidateAddressId && h.policy && h.config ? {
        addressVersion: c.slot.candidateVersion, probeConfigRevision: h.config.revision, successThreshold: h.policy.successThreshold, failureThreshold: h.policy.failureThreshold,
        probeWindowEndsAt: incident.candidateDeadline?.getTime() ?? h.now.getTime(), nextProbeAt: h.state?.nextRoundAt?.getTime() ?? h.now.getTime(),
        evidence: h.matches && h.state?.lastCheckedAt && h.state.evidenceExpiresAt ? {
          addressVersion: h.state.addressVersion, probeConfigRevision: h.state.configVersion, decision: h.state.latestDecision,
          consecutiveSuccesses: h.state.consecutiveSuccesses, consecutiveFailures: h.state.consecutiveFailures,
          observedAt: h.state.lastCheckedAt.getTime(), expiresAt: h.state.evidenceExpiresAt.getTime(),
        } : null,
      } : null,
      publication: publication?.status === "applied" || publication?.status === "in_flight" ? { status: publication.status, addressVersion: publication.addressVersion } : { status: publication?.status ?? "pending" },
      cleanup: { status: "failed" }, // Completion remains with P10 after all required cleanup settles.
    };
    let action = nextRotationAction(snapshot, h.now.getTime());
    if (incident.terminatedAt) return { c, incident, h, physical, budget, attempt, steps, snapshot, action: { kind: "wait" as const, reason: "instance_busy" as const }, publication };
    if (action.kind !== "observe") {
      if (incident.pausedByUserId) action = { kind: "wait", reason: "instance_busy" };
      else if (incident.status === "paused" && incident.phase === "cloud") action = { kind: "wait", reason: "instance_busy" };
      else if (incident.trigger !== "manual" && !healthRevisionMatches(incident, h)) action = { kind: "pause", reason: "configuration_changed" };
      else if (c.physicalKey !== incident.physicalKey) action = { kind: "pause", reason: "remote_identity_changed" };
    }
    if (incident.trigger === "health" && action.kind === "execute" && h.success && !attempt?.charged && !physical?.unresolvedStepId) {
      action = c.slot.candidateAddressId ? { kind: "publish", mode: "dispatch", addressVersion: c.slot.candidateVersion } : { kind: "complete" };
    }
    if (action.kind === "execute" && incident.errorCode === "rotation_rate_limited" && incident.nextRunAt > h.now) {
      action = { kind: "wait", reason: "rate_limited", until: incident.nextRunAt.getTime() };
    }
    return { c, incident, h, physical, budget, attempt, steps, snapshot, action, publication };
  }
  async prepare(id: string, lease: RotationLease, inventory: CloudInventory, identity: AdapterIdentity) {
    return this.transaction(id, async (tx, c, incident) => {
      const run = await this.snapshot(tx, c, incident, lease);
      this.assertIdentity(c, identity);
      if (run.action.kind !== "execute" || run.action.operation !== "prepare_attempt") return false;
      if (run.physical?.unresolvedStepId || (run.physical?.incidentId && run.physical.incidentId !== id)) return false;
      if (!c.address || !c.iface) return false;
      const attemptId = randomUUID();
      const slot = { accountId: c.account.id, service: c.instance.service, region: c.instance.region, instanceId: c.instance.externalId, interfaceId: c.iface.externalId, slotId: c.slot.id, address: c.address.address, family: c.slot.family === "4" ? 4 as const : 6 as const };
      const plan = planCloudRotation(slot, inventory, { allowStop: c.authorization!.allowStopStart, attemptId });
      const previous = await tx.select({ sequence: rotationAttempts.sequence }).from(rotationAttempts).where(eq(rotationAttempts.incidentId, id));
      const failed = await tx.select({ address: rotationResources.address }).from(rotationResources).where(and(eq(rotationResources.incidentId, id), eq(rotationResources.role, "candidate")));
      if (run.attempt && incident.phase === "candidate") await tx.update(rotationAttempts).set({ status: "candidate_failed" }).where(eq(rotationAttempts.id, run.attempt.id));
      await tx.insert(rotationAttempts).values({ id: attemptId, incidentId: id, segmentId: run.budget.id, sequence: previous.length + 1, beforeInventory: inventory as unknown as Record<string, unknown> });
      await tx.insert(rotationSteps).values(plan.map((step, sequence) => ({ id: step.id, attemptId, sequence, plan: { ...step, arguments: { ...step.arguments, failedCandidates: failed.map(f => f.address) } } })));
      const original = inventory.interfaces.find(i => i.id === slot.interfaceId)?.addresses.find(a => a.address === slot.address && a.family === slot.family);
      await tx.insert(rotationResources).values({ incidentId: id, attemptId, addressId: c.address.id, address: c.address.address, allocationId: original?.allocationId, resourceId: original?.resourceId, origin: c.address.origin, ownershipAttemptId: c.address.attemptId, role: "original", snapshot: { slot, inventory, ownership: original } });
      await tx.update(rotationIncidents).set({ phase: "cloud", currentAttemptId: attemptId, errorCode: null, status: "active", nextRunAt: run.h.now, updatedAt: run.h.now }).where(eq(rotationIncidents.id, id));
      await tx.update(rotationLeases).set({ incidentId: id }).where(eq(rotationLeases.physicalKey, lease.physicalKey));
      await rotationAudit(tx, incident, "rotation.attempt_prepared", undefined, { attemptId, segmentId: run.budget.id }); return true;
    });
  }
  async dispatch(id: string, lease: RotationLease, stepId: string, identity: AdapterIdentity) {
    return this.transaction(id, async (tx, c, incident) => {
      const run = await this.snapshot(tx, c, incident, lease); this.assertIdentity(c, identity);
      if (run.action.kind !== "execute" || run.action.operation !== "cloud_step" || run.action.stepId !== stepId || !run.attempt || !run.physical || run.physical.unresolvedStepId || run.physical.incidentId !== id) return;
      const error = rotationAuthorizationError(c, incident.trigger); if (error) throw new Error(error);
      const step = run.steps.find(s => s.id === stepId)!;
      if (step.plan.action === "linode.instance.reboot" && !c.authorization!.allowStopStart) throw new Error("stop_not_authorized");
      const prior = run.steps.filter(s => s.status === "applied" && s.plan.arguments.phase === "rotation" && s.sequence < step.sequence);
      const allocation = prior.filter(s => s.plan.action.endsWith(".allocate")).at(-1);
      const plan = { ...step.plan, arguments: { ...step.plan.arguments, priorReceipts: prior.map(s => ({ action: s.plan.action, receipt: s.receipt })), allowStop: c.authorization!.allowStopStart, ...(allocation ? { candidateReceipt: allocation.receipt } : {}) } };
      const admission = await reserveCloudRotationWrite(tx, {
        accountId: c.account.id, service: c.instance.service, region: c.instance.region, stepId, action: plan.action,
        remainingSteps: run.steps.filter(s => s.sequence >= step.sequence && s.plan.arguments.phase === "rotation" && ["prepared", "not_applied", "rejected_no_effect"].includes(s.status)).map(s => ({ id: s.id, action: s.plan.action })),
      });
      if (!admission.allowed) {
        await tx.update(rotationIncidents).set({ errorCode: "rotation_rate_limited", nextRunAt: admission.retryAt, updatedAt: run.h.now }).where(eq(rotationIncidents.id, id));
        if (incident.errorCode !== "rotation_rate_limited") await rotationAudit(tx, incident, "rotation.rate_limit_wait", undefined, { stepId, ruleId: admission.ruleId, retryAt: admission.retryAt.toISOString() });
        return;
      }
      if (!run.attempt.charged) {
        await tx.update(rotationAttempts).set({ charged: true, chargedAt: run.h.now, status: "cloud" }).where(eq(rotationAttempts.id, run.attempt.id));
        await tx.update(rotationBudgetSegments).set({ attemptsUsed: run.budget.attemptsUsed + 1 }).where(eq(rotationBudgetSegments.id, run.budget.id));
        await tx.update(rotationIncidents).set({ nextAttemptAt: new Date(run.h.now.getTime() + c.policy!.minIntervalSeconds * 1000) }).where(eq(rotationIncidents.id, id));
      }
      await tx.update(rotationSteps).set({ plan, status: "in_flight", fence: lease.revision, dispatchedAt: run.h.now, observeDeadline: new Date(run.h.now.getTime() + c.policy!.cloudWaitSeconds * 1000), receipt: null, errorCode: null, retryAt: null, updatedAt: run.h.now }).where(eq(rotationSteps.id, stepId));
      await tx.update(rotationIncidents).set({ errorCode: null, nextRunAt: run.h.now, updatedAt: run.h.now }).where(eq(rotationIncidents.id, id));
      await tx.update(rotationLeases).set({ unresolvedStepId: stepId }).where(eq(rotationLeases.physicalKey, lease.physicalKey));
      await rotationAudit(tx, incident, "rotation.dispatched", undefined, { attemptId: run.attempt.id, stepId, fence: lease.revision });
      return plan;
    });
  }
  async saveReceipt(id: string, stepId: string, result: CloudStepResult, observation = false) {
    // Late responses still belong to the original durable step, including after a
    // lease handoff. Never discard the only cloud receipt because its fence expired.
    await this.transaction(id, async (tx, c, incident) => {
      const [step] = await tx.select().from(rotationSteps).where(eq(rotationSteps.id, stepId)).for("update");
      if (!step || step.attemptId !== incident.currentAttemptId) throw new Error("rotation_step_changed");
      if (step.status === "abandoned" || incident.errorCode === "cloud_state_reset") {
        await tx.insert(rotationStepObservations).values({ stepId, observation, result: { ...result } });
        return;
      }
      const now = await databaseNow(tx); const old = step.receipt ?? {};
      const conflict = ["resourceId", "allocationId"].some(key => old[key] && (result as Record<string, unknown>)[key] && old[key] !== (result as Record<string, unknown>)[key]);
      const receipt = { ...old, ...(step.status === "applied" ? {} : result), ...(old.resourceId ? { resourceId: old.resourceId } : {}), ...(old.allocationId ? { allocationId: old.allocationId } : {}) };
      const status = conflict ? "ambiguous" : step.status === "ambiguous" ? "ambiguous" : step.status === "applied" ? "applied" : observation ? (result as CloudObservation).status : "pending";
      await tx.update(rotationSteps).set({ receipt, status, updatedAt: now }).where(eq(rotationSteps.id, stepId));
      await tx.insert(rotationStepObservations).values({ stepId, observation, result: { ...result }, createdAt: now });
      if (incident.terminatedAt) return;
      if (status === "applied" || status === "not_applied") await tx.update(rotationLeases).set({ unresolvedStepId: null }).where(and(eq(rotationLeases.physicalKey, incident.physicalKey), eq(rotationLeases.unresolvedStepId, stepId)));
      if (status === "applied" && !incident.pausedByUserId && ["rotation_runtime_failed", "cloud_convergence_timeout", "temporary_cloud_error"].includes(incident.errorCode ?? "")) await tx.update(rotationIncidents).set({ status: "active", errorCode: null }).where(eq(rotationIncidents.id, id));
      if (status === "ambiguous") await this.pauseIn(tx, incident, "resource_ownership_ambiguous", now);
      const steps = await tx.select().from(rotationSteps).where(eq(rotationSteps.attemptId, step.attemptId)).orderBy(asc(rotationSteps.sequence));
      if (!conflict && typeof receipt.candidateAddress === "string" && isIP(receipt.candidateAddress) === Number(c.slot.family)
        && (incident.phase === "cloud" || incident.phase === "candidate")) {
        // Receipt arrival order is not cloud-plan order. A late allocation read
        // must not replace a later applied attachment's aggregate resource state.
        const confirmed = steps.filter(s => s.status === "applied" && s.plan.arguments.phase === "rotation" && s.receipt?.candidateAddress === receipt.candidateAddress).at(-1);
        const resourceReceipt = confirmed?.receipt ?? receipt;
        const attached = !!confirmed && !confirmed.plan.action.endsWith("allocate");
        const referenced = c.address?.address === resourceReceipt.candidateAddress;
        const resourceId = typeof resourceReceipt.resourceId === "string" ? resourceReceipt.resourceId : null;
        const snapshot = { receipt: resourceReceipt, slot: (confirmed ?? step).plan.arguments.slot };
        await tx.insert(rotationResources).values({ incidentId: id, attemptId: step.attemptId, address: receipt.candidateAddress, allocationId: typeof resourceReceipt.allocationId === "string" ? resourceReceipt.allocationId : null, resourceId, origin: "system", ownershipAttemptId: step.attemptId, role: "candidate", attached, referenced, snapshot }).onConflictDoUpdate({ target: [rotationResources.attemptId, rotationResources.role], set: { resourceId: sql`coalesce(${rotationResources.resourceId}, ${resourceId})`, attached, referenced, snapshot } });
      }
      if (steps.every(s => s.status === "applied")) await this.installCandidate(tx, c, incident, steps, now);
      await tx.update(rotationIncidents).set({ nextRunAt: new Date(now.getTime() + (status === "pending" ? 5000 : 0)) }).where(eq(rotationIncidents.id, id));
    });
  }
  async reject(id: string, stepId: string, code: string, noEffect: boolean, retryAfterMs?: number) {
    await this.transaction(id, async (tx, c, incident) => {
      if (incident.terminatedAt) return;
      const now = await databaseNow(tx);
      const [step] = await tx.select().from(rotationSteps).where(eq(rotationSteps.id, stepId)).for("update");
      if (!step || step.attemptId !== incident.currentAttemptId || step.status === "applied") return;
      if (!noEffect) {
        await tx.update(rotationSteps).set({ errorCode: code, updatedAt: now }).where(eq(rotationSteps.id, stepId));
        await tx.update(rotationIncidents).set({ errorCode: code, nextRunAt: new Date(now.getTime() + 5000) }).where(eq(rotationIncidents.id, id)); return;
      }
      const retryAt = code === "rate_limited" ? await recordCloudRotationThrottle(tx, { accountId: c.account.id, service: c.instance.service, region: c.instance.region, stepId, action: step.plan.action, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }) : null;
      await tx.update(rotationSteps).set({ status: "rejected_no_effect", errorCode: code, retryAt, updatedAt: now }).where(eq(rotationSteps.id, stepId));
      await tx.update(rotationLeases).set({ unresolvedStepId: null }).where(and(eq(rotationLeases.physicalKey, incident.physicalKey), eq(rotationLeases.unresolvedStepId, stepId)));
      const [attempt] = await tx.select().from(rotationAttempts).where(eq(rotationAttempts.id, step.attemptId)).for("update");
      if (step.sequence === 0 && attempt?.charged) {
        await tx.update(rotationAttempts).set({ charged: false, chargedAt: null }).where(eq(rotationAttempts.id, attempt.id));
        await tx.update(rotationBudgetSegments).set({ attemptsUsed: sql`${rotationBudgetSegments.attemptsUsed} - 1` }).where(eq(rotationBudgetSegments.id, attempt.segmentId));
        await tx.update(rotationIncidents).set({ nextAttemptAt: now }).where(eq(rotationIncidents.id, id));
      }
      if (code !== "rate_limited") await this.pauseIn(tx, incident, code, now);
      else await tx.update(rotationIncidents).set({ errorCode: "rotation_rate_limited", nextRunAt: retryAt!, updatedAt: now }).where(eq(rotationIncidents.id, id));
      await rotationAudit(tx, incident, "rotation.rejected_no_effect", undefined, { stepId, code });
    });
  }
  async settle(id: string, lease: RotationLease) {
    await this.transaction(id, async (tx, c, incident) => {
      if (incident.terminatedAt) return;
      const run = await this.snapshot(tx, c, incident, lease); const action = run.action;
      if (action.kind === "publish" && action.mode === "dispatch" && run.h.success && c.slot.candidateAddressId) {
        await tx.insert(rotationPublications).values({ slotId: c.slot.id, addressVersion: c.slot.candidateVersion, addressId: c.slot.candidateAddressId, incidentId: id }).onConflictDoNothing();
        await tx.update(rotationIncidents).set({ phase: "publish", status: "active", errorCode: null, nextRunAt: new Date(run.h.now.getTime() + 30000), updatedAt: run.h.now }).where(eq(rotationIncidents.id, id));
        if (run.attempt) await tx.update(rotationAttempts).set({ status: run.attempt.charged ? "verified" : "abandoned" }).where(eq(rotationAttempts.id, run.attempt.id));
      } else if (action.kind === "complete" && run.h.success && !run.attempt?.charged && !c.slot.candidateAddressId && c.slot.currentVersion > 0) {
        const pendingCleanup = await tx.select({ id: rotationResources.id }).from(rotationResources).where(and(eq(rotationResources.incidentId, id), inArray(rotationResources.cleanupStatus, ["pending", "failed"])));
        if (pendingCleanup.length) {
          await tx.update(rotationIncidents).set({ phase: "cleanup", errorCode: "cleanup_pending", nextRunAt: run.h.now, updatedAt: run.h.now }).where(eq(rotationIncidents.id, id));
          return;
        }
        await tx.update(rotationIncidents).set({ phase: "complete", status: "complete", errorCode: null, completedAt: run.h.now, updatedAt: run.h.now }).where(eq(rotationIncidents.id, id));
        await tx.update(rotationLeases).set({ incidentId: null }).where(and(eq(rotationLeases.physicalKey, incident.physicalKey), eq(rotationLeases.incidentId, id)));
        if (run.attempt) await tx.update(rotationAttempts).set({ status: "abandoned" }).where(eq(rotationAttempts.id, run.attempt.id));
        await rotationAudit(tx, incident, "rotation.current_recovered");
      } else if (action.kind === "pause") await this.pauseIn(tx, incident, action.reason, run.h.now);
      else {
        // Queue retries of the same paused observation must not look like a new
        // failure to the schedule reconciler after an explicit schedule resume.
        const unchangedPause = action.kind === "wait" && (incident.status === "paused" || incident.status === "exhausted");
        await tx.update(rotationIncidents).set({ errorCode: action.kind === "probe" ? "probe_insufficient" : incident.errorCode,
          nextRunAt: action.kind === "wait" && action.until ? new Date(action.until) : new Date(run.h.now.getTime() + 15000),
          updatedAt: unchangedPause ? sql`${rotationIncidents.updatedAt}` : run.h.now }).where(eq(rotationIncidents.id, id));
      }
    });
  }
  async defer(id: string) { await this.database.db.update(rotationIncidents).set({ nextRunAt: sql`greatest(${rotationIncidents.nextRunAt}, clock_timestamp() + interval '30 seconds')` }).where(eq(rotationIncidents.id, id)); }
  async pause(id: string, code: string) { await this.transaction(id, async (tx, _c, incident) => this.pauseIn(tx, incident, code, await databaseNow(tx))); }
  private async pauseIn(tx: RotationTransaction, incident: Incident, code: string, now: Date) {
    if (incident.terminatedAt) return;
    if (code === "attempts_exhausted") await tx.update(rotationBudgetSegments).set({ exhausted: true }).where(eq(rotationBudgetSegments.id, incident.currentSegmentId));
    const status = code === "attempts_exhausted" ? "exhausted" : "paused";
    const unchangedPause = incident.status === status && incident.errorCode === code;
    await tx.update(rotationIncidents).set({ status, errorCode: code, nextRunAt: new Date(now.getTime() + 15000),
      updatedAt: unchangedPause ? sql`${rotationIncidents.updatedAt}` : now }).where(eq(rotationIncidents.id, incident.id));
    if (incident.errorCode !== code) await rotationAudit(tx, incident, "rotation.paused", undefined, { code });
  }
  private async installCandidate(tx: RotationTransaction, c: RotationContext, incident: Incident, steps: Step[], now: Date) {
    if (incident.phase !== "cloud") return;
    const result = steps.at(-1)!.receipt as CloudStepResult | null;
    if (!result?.candidateAddress || isIP(result.candidateAddress) !== Number(c.slot.family)) { await this.pauseIn(tx, incident, "candidate_missing", now); return; }
    if (c.addressVersion !== incident.addressVersion || c.physicalKey !== incident.physicalKey) { await this.pauseIn(tx, incident, "address_version_changed", now); return; }
    const [attempt] = await tx.select().from(rotationAttempts).where(eq(rotationAttempts.id, steps[0]!.attemptId));
    if (!attempt) throw new Error("rotation_attempt_missing");
    const providerMetadata = result.after?.addressMetadata;
    const metadata = { ...(c.instance.service === "azure_vm" ? { allocationIdentity: allocationIdentity(result) } : {}), providerMetadata: providerMetadata && typeof providerMetadata === "object" && !Array.isArray(providerMetadata) ? providerMetadata : {},
      ...(typeof result.after?.privateAddress === "string" ? { privateAddress: result.after.privateAddress } : {}),
      ...(result.resourceId ? { resourceId: result.resourceId } : {}) };
    const [address] = await tx.insert(cloudAddresses).values({ interfaceId: c.slot.interfaceId, family: c.slot.family, kind: "host", address: result.candidateAddress, remoteAllocationId: result.allocationId, metadata, origin: "system", attemptId: attempt.id, inventoryPresent: true, scanGeneration: c.instance.scanGeneration, lastSeenAt: now }).onConflictDoUpdate({ target: [cloudAddresses.interfaceId, cloudAddresses.family, cloudAddresses.address], targetWhere: sql`${cloudAddresses.kind} = 'host'`, set: { lastSeenAt: now, inventoryPresent: true, scanGeneration: c.instance.scanGeneration, metadata } }).returning();
    const version = Math.max(c.slot.currentVersion, c.slot.candidateVersion) + 1;
    await tx.update(managedAddressSlots).set({ candidateAddressId: address!.id, candidateVersion: version, updatedAt: now }).where(eq(managedAddressSlots.id, c.slot.id));
    await tx.update(addressHealthStates).set(resetHealthEvidence).where(eq(addressHealthStates.slotId, c.slot.id));
    await tx.update(rotationAttempts).set({ status: "candidate", candidateAddressId: address!.id, candidateVersion: version, candidateRepeated: !!result.candidateRepeated }).where(eq(rotationAttempts.id, attempt.id));
    await tx.insert(rotationResources).values({ incidentId: incident.id, attemptId: attempt.id, addressId: address!.id, address: address!.address, allocationId: result.allocationId, resourceId: result.resourceId, origin: address!.origin, ownershipAttemptId: address!.attemptId, role: "candidate", snapshot: { receipt: result, inventory: attempt.beforeInventory } }).onConflictDoUpdate({ target: [rotationResources.attemptId, rotationResources.role], set: { addressId: address!.id, attached: true, referenced: true } });
    if (incident.trigger === "manual") {
      // Every plan step has been read back as applied. Manual authority permits
      // publication of this exact version; it does not create probe evidence.
      await tx.insert(rotationPublications).values({ slotId: c.slot.id, addressVersion: version, addressId: address!.id, incidentId: incident.id }).onConflictDoNothing();
    }
    await tx.update(rotationIncidents).set({ phase: incident.trigger === "manual" ? "publish" : "candidate", ...(incident.pendingSegmentId ? { currentSegmentId: incident.pendingSegmentId, pendingSegmentId: null } : {}), addressVersion: version, candidateDeadline: incident.trigger === "manual" ? null : new Date(now.getTime() + (c.policy?.candidateWindowSeconds ?? 180) * 1000), nextRunAt: now, updatedAt: now }).where(eq(rotationIncidents.id, incident.id));
    await tx.update(rotationLeases).set({ incidentId: null }).where(and(eq(rotationLeases.physicalKey, incident.physicalKey), eq(rotationLeases.incidentId, incident.id)));
    await rotationAudit(tx, incident, "rotation.candidate", undefined, { addressVersion: version, attemptId: attempt.id });
  }
  private assertIdentity(c: RotationContext, identity: AdapterIdentity) { if (c.account.credentialCiphertext !== identity.credentialCiphertext || c.account.externalAccountId !== identity.externalAccountId) throw new Error("authorization_changed"); }
  private async transaction<T>(id: string, action: (tx: RotationTransaction, c: RotationContext, incident: Incident) => Promise<T>) {
    return this.database.db.transaction(async tx => {
      const [identity] = await tx.select({ slotId: rotationIncidents.slotId }).from(rotationIncidents).where(eq(rotationIncidents.id, id));
      if (!identity) throw new Error("rotation_not_found");
      const c = await lockRotationContext(tx, identity.slotId);
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
      return action(tx, c, incident!);
    });
  }
}
function stepSnapshot(s: Step): RotationStepSnapshot {
  if (s.status === "pending" || s.status === "in_flight") return { stepId: s.id, status: s.status, observeDeadline: s.observeDeadline!.getTime() };
  if (s.status === "rejected_no_effect") return { stepId: s.id, status: s.status, reason: s.errorCode as RotationCloudRejection, retryAt: s.retryAt?.getTime() ?? null };
  return { stepId: s.id, status: s.status };
}

async function deferFailedClaim(tx: RotationTransaction, id: string) {
  // Preserve later deadlines while moving busy/foreign-plan work behind other
  // due incidents. Failed claims must not monopolize the oldest queue page.
  await tx.update(rotationIncidents).set({ nextRunAt: sql`greatest(${rotationIncidents.nextRunAt}, clock_timestamp() + interval '15 seconds')` }).where(eq(rotationIncidents.id, id));
}

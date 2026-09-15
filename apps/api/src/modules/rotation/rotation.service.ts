import { rotationDisplay } from "./rotation-display.js";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { auditLogs, cloudAccounts, cloudInstances, cloudInterfaces, createRotationIncident, databaseNow, lockRotationContext, lockRotationHealth, managedAddressSlots, resumeRotationIncident, rotationAttempts, rotationAudit, rotationBudgetSegments, rotationIncidents, rotationPolicies, rotationPublications, rotationResources, rotationSteps, type RotationTransaction } from "@masterdns/db";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { withCloudRequest } from "../cloud/cloud-idempotency.js";
import type { RotationPolicyInput, RotationResumeInput } from "./rotation.schemas.js";

@Injectable()
export class RotationService {
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}
  async policy(actor: AuthUser, slotId: string) {
    await this.ownedSlot(actor, slotId);
    const [policy] = await this.database.db.select().from(rotationPolicies).where(eq(rotationPolicies.slotId, slotId));
    return policy ?? { slotId, enabled: false, revision: 0, maxAttempts: 3, minIntervalSeconds: 60, cloudWaitSeconds: 120, candidateWindowSeconds: 180 };
  }
  async setPolicy(actor: AuthUser, slotId: string, input: RotationPolicyInput) {
    await this.ownedSlot(actor, slotId);
    return this.transaction(async tx => {
      const c = await lockRotationContext(tx, slotId);
      if ((c.policy?.revision ?? 0) !== input.revision) throw new ConflictException("Policy revision has changed");
      if (input.enabled) {
        const h = await lockRotationHealth(tx, c);
        if (!h.configured || !h.policy) throw new ConflictException("External health policy is required");
        const requiredWindow = Math.max(h.policy.successThreshold, h.policy.failureThreshold) * h.policy.checkIntervalSeconds + h.policy.executionWindowSeconds;
        if (input.candidateWindowSeconds < requiredWindow) throw new ConflictException("Candidate window must cover the configured health thresholds");
      }
      const now = await databaseNow(tx);
      const values = { ...input, revision: input.revision + 1, updatedAt: now };
      const [policy] = await tx.insert(rotationPolicies).values({ slotId, ...values }).onConflictDoUpdate({ target: rotationPolicies.slotId, set: values }).returning();
      await tx.insert(auditLogs).values({ ownerUserId: c.account.ownerUserId, actorUserId: actor.id, source: "user", action: "rotation.policy", resourceType: "address_slot", resourceId: slotId, beforeSnapshot: c.policy, afterSnapshot: policy });
      return policy!;
    });
  }
  async start(actor: AuthUser, slotId: string, key: string) {
    const owned = await this.ownedSlot(actor, slotId);
    const result = await this.transaction(async tx => withCloudRequest(tx, { key, actorUserId: actor.id, ownerUserId: owned.ownerUserId, action: "rotation.start", request: { slotId } }, async () => {
      const c = await lockRotationContext(tx, slotId);
      const h = await lockRotationHealth(tx, c);
      // The client never supplies a failure-event identity or budget authority.
      return createRotationIncident(tx, c, `health-${h.state?.lastRoundId ?? "missing"}-${c.addressVersion}`, actor.id);
    }));
    await this.wake(result.id); return result;
  }
  async list(actor: AuthUser) {
    return this.database.db.select().from(rotationIncidents).where(actor.role === "admin" ? undefined : eq(rotationIncidents.ownerUserId, actor.id)).orderBy(desc(rotationIncidents.createdAt)).limit(200);
  }
  async detail(actor: AuthUser, id: string) {
    const incident = await this.ownedIncident(actor, id);
    const [segments, attempts, steps, resources, publications] = await Promise.all([
      this.database.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, id)).orderBy(asc(rotationBudgetSegments.createdAt)),
      this.database.db.select({ id: rotationAttempts.id, segmentId: rotationAttempts.segmentId, sequence: rotationAttempts.sequence, status: rotationAttempts.status, charged: rotationAttempts.charged, chargedAt: rotationAttempts.chargedAt, candidateAddressId: rotationAttempts.candidateAddressId, candidateVersion: rotationAttempts.candidateVersion, candidateRepeated: rotationAttempts.candidateRepeated }).from(rotationAttempts).where(eq(rotationAttempts.incidentId, id)).orderBy(asc(rotationAttempts.sequence)),
      this.database.db.select({ id: rotationSteps.id, attemptId: rotationSteps.attemptId, sequence: rotationSteps.sequence, status: rotationSteps.status, errorCode: rotationSteps.errorCode, dispatchedAt: rotationSteps.dispatchedAt, observeDeadline: rotationSteps.observeDeadline, retryAt: rotationSteps.retryAt }).from(rotationSteps).innerJoin(rotationAttempts, eq(rotationAttempts.id, rotationSteps.attemptId)).where(eq(rotationAttempts.incidentId, id)),
      this.database.db.select({ id: rotationResources.id, addressId: rotationResources.addressId, attemptId: rotationResources.attemptId, address: rotationResources.address, role: rotationResources.role, origin: rotationResources.origin, cleanupStatus: rotationResources.cleanupStatus, cleanupDueAt: rotationResources.cleanupDueAt }).from(rotationResources).where(eq(rotationResources.incidentId, id)),
      this.database.db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, id)),
    ]);
    const display = await this.database.db.transaction(tx => rotationDisplay(tx, incident.slotId));
    return { incident, segments, attempts, steps, resources, publications, ...display };
  }
  async pause(actor: AuthUser, id: string) {
    const owned = await this.ownedIncident(actor, id);
    return this.transaction(async tx => {
      await lockRotationContext(tx, owned.slotId);
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
      if (!incident || incident.status === "complete") throw new ConflictException("Rotation has completed");
      const now = await databaseNow(tx);
      const [updated] = await tx.update(rotationIncidents).set({ status: "paused", pausedByUserId: actor.id, errorCode: "manual_pause", nextRunAt: now, updatedAt: now }).where(eq(rotationIncidents.id, id)).returning();
      await rotationAudit(tx, updated!, "rotation.pause", actor.id); return updated!;
    });
  }
  async resume(actor: AuthUser, id: string, key: string, input: RotationResumeInput = {}) {
    const owned = await this.ownedIncident(actor, id);
    const result = await this.transaction(async tx => withCloudRequest(tx, { key, actorUserId: actor.id, ownerUserId: owned.ownerUserId, action: "rotation.resume", request: { incidentId: id, expectedPolicyRevision: input.expectedPolicyRevision } }, async () => {
      const c = await lockRotationContext(tx, owned.slotId);
      if (input.expectedPolicyRevision !== undefined && c.policy?.revision !== input.expectedPolicyRevision) throw new ConflictException("Rotation policy revision has changed");
      return resumeRotationIncident(tx, c, id, actor.id);
    }));
    await this.wake(id); return result;
  }
  private async ownedSlot(actor: AuthUser, id: string) {
    const [row] = await this.database.db.select({ ownerUserId: cloudAccounts.ownerUserId }).from(managedAddressSlots).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId)).innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId)).innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId)).where(and(eq(managedAddressSlots.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)));
    if (!row) throw new NotFoundException("Address slot not found"); return row;
  }
  private async ownedIncident(actor: AuthUser, id: string) {
    const [row] = await this.database.db.select().from(rotationIncidents).where(and(eq(rotationIncidents.id, id), actor.role === "admin" ? undefined : eq(rotationIncidents.ownerUserId, actor.id)));
    if (!row) throw new NotFoundException("Rotation not found"); return row;
  }
  private async transaction<T>(action: (tx: RotationTransaction) => Promise<T>) {
    try { return await this.database.db.transaction(action); }
    catch (error) { if (error instanceof Error && /^(rotation_|cloud_observation_required|external_health_required|confirmed_failure_required|authorization_revoked|family_disabled|region_excluded|resource_not_found|conflicting_manager)/.test(error.message)) throw new ConflictException(error.message); throw error; }
  }
  private async wake(incidentId: string) { await this.queues.rotation.add("rotate", { incidentId }, { jobId: `rotation-${incidentId}`, removeOnComplete: true, removeOnFail: true }).catch(() => undefined); }
}

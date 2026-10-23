import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { CloudError } from "@masterdns/cloud-providers";
import { cloudInterfaces, managedAddressSlots, rotationIncidents, resetCloudInstanceState, lockRotationContext, databaseNow, rotationAudit, type RotationTransaction } from "@masterdns/db";
import { DatabaseService } from "../database.service.js";
import { CloudRuntimeService } from "../cloud/cloud-runtime.service.js";
import { acquireRotationLease, releaseRotationLease, verifyRotationLease } from "./rotation-lock.js";
import { boundedCloudCall, RotationCallTimeout } from "./rotation-cloud-call.js";

const resetErrors = new Set(["cloud_reset_pending", "cloud_reset_sync_failed", "rotation_runtime_failed", "rotation_call_timeout", "cloud_convergence_timeout", "temporary_cloud_error", "unknown_cloud_error", "cloud_operation_failed", "cloud_not_applied", "cleanup_failed", "cleanup_health_failed", "dns_partial", "attempts_exhausted", "recovery_retries_exhausted", "resource_not_found", "ambiguous", "ambiguous_cloud_state", "resource_ownership_ambiguous", "candidate_failed", "address_version_changed"]);

@Injectable()
export class RotationResetRecoveryService {
  constructor(private readonly database: DatabaseService, private readonly runtime: CloudRuntimeService) {}

  /** true means this failed task belongs to sync/reset recovery, not step replay. */
  async recover(id: string): Promise<boolean> {
    const admission = await this.database.db.transaction(async tx => {
      const [identity] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id));
      if (!identity || identity.status === "complete" || identity.terminatedAt || identity.pausedByUserId || !resetErrors.has(identity.errorCode ?? "")) return { handled: false };
      const c = await lockRotationContext(tx, identity.slotId);
      const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
      if (!incident || incident.status === "complete" || incident.terminatedAt || incident.pausedByUserId || !resetErrors.has(incident.errorCode ?? "")) return { handled: false };
      if (c.account.provider !== "aws" || !["ec2", "lightsail"].includes(c.instance.service)) return { handled: false };
      if (!c.policy?.enabled) return { handled: ["cloud_reset_pending", "cloud_reset_sync_failed"].includes(incident.errorCode ?? "") };
      if (!c.account.enabled || !c.authorization?.managed || !(c.slot.family === "4" ? c.authorization.allowIpv4Rotation : c.authorization.allowIpv6Rotation)
        || c.lifecycleBlocked || c.conflictingManager || !c.account.externalAccountId || c.account.regions && !c.account.regions.includes(c.instance.region)
        || c.authorization.revision !== incident.authorizationRevision || c.policy.revision !== incident.policyRevision) return { handled: true };
      const now = await databaseNow(tx);
      if (["cloud_reset_pending", "cloud_reset_sync_failed"].includes(incident.errorCode ?? "") && incident.recoveryRetryAt && incident.recoveryRetryAt > now) return { handled: true };
      if (c.slot.resetRecoveryRetries >= c.policy.maxRecoveryRetries) {
        await tx.update(rotationIncidents).set({ status: "exhausted", errorCode: "recovery_retries_exhausted", recoveryRetries: c.slot.resetRecoveryRetries, recoveryRetryAt: null, nextRunAt: new Date(now.getTime() + 30000) }).where(eq(rotationIncidents.id, id));
        return { handled: true };
      }
      // Fresh queued health work may be superseded by the instance-wide reset.
      // Blocking it here would deadlock both families behind the failed owner.
      if (await hasBlockingSibling(tx, c.instance.id, id)) return { handled: true };
      const lease = await acquireRotationLease(tx, c.physicalKey, randomUUID());
      if (!lease) return { handled: true };
      const physical = await verifyRotationLease(tx, lease);
      if (physical?.incidentId && physical.incidentId !== id) { await releaseRotationLease(tx, lease); return { handled: true }; }
      const retry = c.slot.resetRecoveryRetries + 1;
      await tx.update(managedAddressSlots).set({ resetRecoveryRetries: retry, updatedAt: now }).where(eq(managedAddressSlots.id, c.slot.id));
      await tx.update(rotationIncidents).set({ status: "active", errorCode: "cloud_reset_pending", lastRecoveryError: incident.lastRecoveryError ?? incident.errorCode,
        recoveryRetries: retry, recoveryRetryAt: new Date(now.getTime() + 45000), nextRunAt: new Date(now.getTime() + 45000), updatedAt: now }).where(eq(rotationIncidents.id, id));
      await rotationAudit(tx, incident, "rotation.auto_reset_started", undefined, { retry, maxRetries: c.policy.maxRecoveryRetries });
      return { handled: true, c, lease, retry };
    });
    if (!admission.c || !admission.lease) return admission.handled;
    const { c, lease } = admission;
    const timeoutMs = Math.min(c.policy!.cloudWaitSeconds, 30) * 1000;
    const deadline = Date.now() + timeoutMs;
    try {
      // Adapter identity verification runs outside reset's account locks.
      const adapter = await boundedCloudCall(() => this.runtime.adapter(c.account.id, c.instance.service), timeoutMs);
      await resetCloudInstanceState(this.database.db, {
        account: c.account, instance: c.instance, source: "failover",
        beforeInspect: async tx => {
          if (!await verifyRotationLease(tx, lease)) throw new Error("reset_lease_lost");
          const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
          const current = await lockRotationContext(tx, c.slot.id);
          if (!incident || incident.status !== "active" || incident.terminatedAt || incident.pausedByUserId || incident.errorCode !== "cloud_reset_pending"
            || !current.policy?.enabled || current.policy.revision !== c.policy!.revision || current.authorization?.revision !== c.authorization?.revision)
            throw new Error("reset_authorization_changed");
          if (await hasBlockingSibling(tx, c.instance.id, id)) throw new Error("reset_other_incident_active");
        },
        afterInspect: async tx => { if (!await verifyRotationLease(tx, lease)) throw new Error("reset_lease_lost"); },
        inspect: () => boundedCloudCall(() => adapter.inspect({ accountId: c.account.id, service: c.instance.service, region: c.instance.region, instanceId: c.instance.externalId }), Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      await this.database.db.transaction(async tx => {
        const current = await lockRotationContext(tx, c.slot.id);
        if (!await verifyRotationLease(tx, lease)) return;
        const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
        if (!incident || incident.status === "complete" || incident.terminatedAt || incident.pausedByUserId) return;
        const now = await databaseNow(tx);
        const exhausted = current.slot.resetRecoveryRetries >= (current.policy?.maxRecoveryRetries ?? 5);
        const code = error instanceof RotationCallTimeout ? "rotation_call_timeout" : error instanceof CloudError ? error.code : "cloud_reset_sync_failed";
        const retryAt = new Date(now.getTime() + Math.max((current.policy?.minIntervalSeconds ?? 60) * 1000, error instanceof CloudError ? error.retryAfterMs ?? 0 : 0));
        await tx.update(rotationIncidents).set({ status: exhausted ? "exhausted" : "active", errorCode: exhausted ? "recovery_retries_exhausted" : "cloud_reset_sync_failed", lastRecoveryError: code,
          recoveryRetryAt: exhausted ? null : retryAt, nextRunAt: retryAt, updatedAt: now }).where(eq(rotationIncidents.id, id));
        await rotationAudit(tx, incident, exhausted ? "rotation.recovery_exhausted" : "rotation.auto_reset_failed", undefined, { code, retry: current.slot.resetRecoveryRetries });
      });
    } finally {
      await this.database.db.transaction(tx => releaseRotationLease(tx, lease));
    }
    return true;
  }
}

async function hasBlockingSibling(tx: RotationTransaction, instanceId: string, incidentId: string) {
  const siblings = await tx.select({ incident: rotationIncidents }).from(rotationIncidents)
    .innerJoin(managedAddressSlots, eq(managedAddressSlots.id, rotationIncidents.slotId))
    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
    .where(and(eq(cloudInterfaces.instanceId, instanceId), ne(rotationIncidents.id, incidentId), ne(rotationIncidents.status, "complete")));
  return siblings.some(({ incident }) => incident.status !== "active" || incident.phase !== "cloud" || incident.trigger !== "health"
    || incident.pausedByUserId || incident.terminatedAt || incident.currentAttemptId);
}

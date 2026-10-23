import { and, eq, inArray } from "drizzle-orm";
import { rotationAudit, rotationIncidents, rotationSteps, type RotationContext, type RotationTransaction } from "@masterdns/db";
type Incident = typeof rotationIncidents.$inferSelect;

export async function scheduleRotationRecovery(tx: RotationTransaction, c: RotationContext, incident: Incident, code: string, now: Date, notBefore?: Date) {
  if (incident.status === "complete" || incident.terminatedAt || incident.pausedByUserId || incident.errorCode === "recovery_retries_exhausted") return;
  if (incident.recoveryRetryAt && incident.recoveryRetryAt > now) return;
  const maxRetries = c.policy?.maxRecoveryRetries ?? 5;
  if (incident.recoveryRetries >= maxRetries) {
    await tx.update(rotationIncidents).set({ status: "exhausted", errorCode: "recovery_retries_exhausted", lastRecoveryError: code,
      recoveryRetryAt: null, nextRunAt: new Date(now.getTime() + 30000), updatedAt: now }).where(eq(rotationIncidents.id, incident.id));
    await rotationAudit(tx, incident, "rotation.recovery_exhausted", undefined, { code, retries: incident.recoveryRetries, maxRetries });
    return;
  }
  const retryAt = new Date(Math.max(now.getTime() + (c.policy?.minIntervalSeconds ?? 60) * 1000, notBefore?.getTime() ?? 0));
  await tx.update(rotationIncidents).set({ status: "active", recoveryRetries: incident.recoveryRetries + 1, recoveryRetryAt: retryAt,
    lastRecoveryError: code, errorCode: code === "rate_limited" ? "rotation_rate_limited" : incident.phase === "cleanup" ? "cleanup_failed" : code, nextRunAt: retryAt, updatedAt: now }).where(eq(rotationIncidents.id, incident.id));
  // A fresh observation window begins after the retry delay. Uncertain steps
  // remain unresolved: a deadline never grants permission to repeat a write.
  if (incident.phase === "cloud" && incident.currentAttemptId) await tx.update(rotationSteps).set({ observeDeadline: new Date(retryAt.getTime() + (c.policy?.cloudWaitSeconds ?? 120) * 1000) })
    .where(and(eq(rotationSteps.attemptId, incident.currentAttemptId), inArray(rotationSteps.status, ["in_flight", "pending"])));
  await rotationAudit(tx, incident, "rotation.auto_retry", undefined, { code, retry: incident.recoveryRetries + 1, maxRetries, retryAt: retryAt.toISOString() });
}

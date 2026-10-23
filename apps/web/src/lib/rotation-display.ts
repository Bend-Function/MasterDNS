export type RotationLimitIncident = { status?: string; errorCode: string | null; nextRunAt: string };
export type RotationLimitResource = { cleanupError: string | null; cleanupDueAt: string | null };

/** Incident scheduling state is not health: active must never render as normal. */
export function rotationStatusValue(incident: { status: string; errorCode: string | null; terminatedAt?: string | null; recoveryRetryAt?: string | null }, resources: Array<{ cleanupStatus: string }> = []): string {
  if (incident.status === "complete" && incident.errorCode === "cloud_state_reset") return "reset";
  if (incident.terminatedAt) return "terminated";
  if (incident.status === "paused" || incident.status === "exhausted") return incident.status;
  if (incident.recoveryRetryAt || incident.errorCode === "rotation_rate_limited") return "retrying";
  if (resources.some(resource => resource.cleanupStatus === "failed")) return "failed";
  if (incident.errorCode && !["probe_insufficient", "instance_lifecycle_busy", "cleanup_pending"].includes(incident.errorCode)) return "failed";
  return incident.status === "complete" ? "succeeded" : "running";
}

export function rotationLimitWait(incident: RotationLimitIncident, resources: RotationLimitResource[]): { label: string; retryAt: string } | null {
  if (incident.errorCode === "rotation_limit_too_low") return { label: "换址额度不足以完成一次换址；请提高云账号使用比例后恢复任务", retryAt: incident.nextRunAt };
  if (incident.errorCode === "rotation_rate_limited") return { label: "等待换址额度", retryAt: incident.nextRunAt };
  const cleanup = resources.find((resource) => resource.cleanupError === "rotation_rate_limited" && resource.cleanupDueAt);
  return cleanup?.cleanupDueAt ? { label: "等待换址额度", retryAt: cleanup.cleanupDueAt } : null;
}

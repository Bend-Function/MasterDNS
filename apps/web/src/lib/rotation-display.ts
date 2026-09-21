export type RotationLimitIncident = { status?: string; errorCode: string | null; nextRunAt: string };
export type RotationLimitResource = { cleanupError: string | null; cleanupDueAt: string | null };

export function rotationLimitWait(incident: RotationLimitIncident, resources: RotationLimitResource[]): { label: string; retryAt: string } | null {
  if (incident.errorCode === "rotation_limit_too_low") return { label: "换址额度不足以完成一次换址；请提高云账号使用比例后恢复任务", retryAt: incident.nextRunAt };
  if (incident.errorCode === "rotation_rate_limited") return { label: "等待换址额度", retryAt: incident.nextRunAt };
  const cleanup = resources.find((resource) => resource.cleanupError === "rotation_rate_limited" && resource.cleanupDueAt);
  return cleanup?.cleanupDueAt ? { label: "等待换址额度", retryAt: cleanup.cleanupDueAt } : null;
}

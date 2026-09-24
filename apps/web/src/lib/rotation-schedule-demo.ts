import type { RotationSchedule } from "@masterdns/contracts/rotation";
import type { ScheduleRequest } from "./rotation-schedule";

const savedSchedules = new Map<string, RotationSchedule>();
export function previewRotationSchedule(slotId: string): RotationSchedule {
  const saved = savedSchedules.get(slotId);
  if (saved) return saved;
  const at = new Date().toISOString();
  const schedule: RotationSchedule = { slotId, enabled: false, intervalMinutes: 1440, revision: 0, nextRunAt: null, activeIncidentId: null, lastStartedAt: null, lastCompletedAt: null, lastHandledIncidentId: null, pausedReason: null, updatedAt: at };
  if (slotId === "slot-v4") Object.assign(schedule, { enabled: true, intervalMinutes: 120, revision: 2, activeIncidentId: "rotation-01", lastStartedAt: at });
  if (slotId === "azure-4") Object.assign(schedule, { enabled: true, intervalMinutes: 60, revision: 1, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() });
  if (slotId === "linode-4") Object.assign(schedule, { enabled: true, intervalMinutes: 30, revision: 4, pausedReason: "manual_pause", activeIncidentId: "rotation-paused", lastStartedAt: at });
  savedSchedules.set(slotId, schedule);
  return schedule;
}

/** Preview-only writes stay in memory and never call the API. */
export const previewScheduleRequest: ScheduleRequest = async (path, init) => {
  const match = /\/rotation-schedules\/([^/]+)(\/resume)?$/.exec(path);
  if (!match) throw new Error("预览日程路径无效");
  const current = previewRotationSchedule(decodeURIComponent(match[1]!));
  if (!init) return current;
  const input = JSON.parse(init.body as string) as { enabled?: boolean; intervalMinutes?: number };
  const resume = Boolean(match[2]);
  const enabled = input.enabled ?? current.enabled;
  const intervalMinutes = input.intervalMinutes ?? current.intervalMinutes;
  const changed = resume || enabled !== current.enabled || intervalMinutes !== current.intervalMinutes;
  const next = changed ? { ...current, enabled, intervalMinutes, revision: current.revision + 1, pausedReason: resume ? null : current.pausedReason, nextRunAt: enabled ? new Date(Date.now() + intervalMinutes * 60_000).toISOString() : null, updatedAt: new Date().toISOString() } : current;
  savedSchedules.set(current.slotId, next);
  return next;
};

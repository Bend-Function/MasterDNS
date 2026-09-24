import type { RotationScheduleUpdateInput } from "@masterdns/contracts";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { databaseNow, type RotationTransaction } from "./rotation-context.js";
import { rotationIncidents, rotationSchedules } from "./schema/index.js";

export type PersistedRotationSchedule = typeof rotationSchedules.$inferSelect;

export function rotationScheduleDeadline(now: Date, intervalMinutes: number) {
  return new Date(now.getTime() + intervalMinutes * 60_000);
}

export async function readRotationSchedule(tx: RotationTransaction, slotId: string) {
  const [schedule] = await tx.select().from(rotationSchedules).where(eq(rotationSchedules.slotId, slotId));
  return schedule;
}

export async function lockRotationSchedule(tx: RotationTransaction, slotId: string) {
  const [schedule] = await tx.select().from(rotationSchedules).where(eq(rotationSchedules.slotId, slotId)).for("update");
  return schedule;
}

export async function updateRotationScheduleConfiguration(
  tx: RotationTransaction,
  slotId: string,
  input: RotationScheduleUpdateInput,
) {
  const before = await lockRotationSchedule(tx, slotId);
  const revision = before?.revision ?? 0;
  if (revision !== input.revision) throw new Error("rotation_schedule_revision_conflict");

  const changed = (before?.enabled ?? false) !== input.enabled
    || (before?.intervalMinutes ?? 1440) !== input.intervalMinutes;
  if (!changed) return { before, schedule: before, changed: false as const };

  const [latestCompletion] = await tx.select({ id: rotationIncidents.id, completedAt: rotationIncidents.completedAt })
    .from(rotationIncidents)
    .where(and(
      eq(rotationIncidents.slotId, slotId),
      eq(rotationIncidents.status, "complete"),
      isNotNull(rotationIncidents.completedAt),
    ))
    .orderBy(desc(rotationIncidents.completedAt), desc(rotationIncidents.createdAt))
    .limit(1)
    .for("share");
  const now = await databaseNow(tx);
  const activeIncidentId = before?.activeIncidentId ?? null;
  const values = {
    enabled: input.enabled,
    intervalMinutes: input.intervalMinutes,
    revision: revision + 1,
    nextRunAt: input.enabled ? rotationScheduleDeadline(now, input.intervalMinutes) : null,
    lastHandledIncidentId: activeIncidentId
      ? before?.lastHandledIncidentId ?? null
      : latestCompletion?.id ?? before?.lastHandledIncidentId ?? null,
    lastCompletedAt: latestCompletion?.completedAt ?? before?.lastCompletedAt ?? null,
    updatedAt: now,
  };
  const [schedule] = before
    ? await tx.update(rotationSchedules).set(values).where(eq(rotationSchedules.slotId, slotId)).returning()
    : await tx.insert(rotationSchedules).values({ slotId, ...values }).returning();
  return { before, schedule: schedule!, changed: true as const };
}

export async function resumeRotationSchedule(tx: RotationTransaction, slotId: string, revision: number) {
  const before = await lockRotationSchedule(tx, slotId);
  if (!before) throw new Error("rotation_schedule_not_found");
  if (before.revision !== revision) throw new Error("rotation_schedule_revision_conflict");
  if (!before.enabled) throw new Error("rotation_schedule_disabled");
  if (!before.pausedReason) throw new Error("rotation_schedule_not_paused");

  const now = await databaseNow(tx);
  const [schedule] = await tx.update(rotationSchedules).set({
    revision: before.revision + 1,
    nextRunAt: rotationScheduleDeadline(now, before.intervalMinutes),
    lastHandledIncidentId: before.activeIncidentId ?? before.lastHandledIncidentId,
    pausedReason: null,
    updatedAt: now,
  }).where(eq(rotationSchedules.slotId, slotId)).returning();
  return { before, schedule: schedule! };
}

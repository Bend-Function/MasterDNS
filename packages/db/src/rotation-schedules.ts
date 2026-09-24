import type { RotationScheduleUpdateInput } from "@masterdns/contracts";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
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

  const activeIncident = await lockScheduleIncident(tx, before);
  const latestCompletion = await latestScheduleCompletion(tx, slotId);
  const now = await databaseNow(tx);
  // A success already visible to PATCH belongs to the configuration baseline.
  // Keep unacknowledged termination associated so reconciliation still pauses.
  const activeIncidentId = activeIncident?.status === "complete" && !activeIncident.terminatedAt
    ? null : before?.activeIncidentId ?? null;
  const values = {
    enabled: input.enabled,
    intervalMinutes: input.intervalMinutes,
    revision: revision + 1,
    activeIncidentId,
    nextRunAt: input.enabled ? rotationScheduleDeadline(now, input.intervalMinutes) : null,
    lastHandledIncidentId: activeIncidentId
      ? before?.lastHandledIncidentId ?? null
      : latestCompletion?.id ?? before?.lastHandledIncidentId ?? null,
    lastHandledIncidentUpdatedAt: activeIncidentId
      ? sql`${rotationSchedules.lastHandledIncidentUpdatedAt}`
      : latestCompletion ? incidentObservationTime(latestCompletion.id) : before ? sql`${rotationSchedules.lastHandledIncidentUpdatedAt}` : null,
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

  // Context and schedule are already locked; consume the exact incident observation.
  const activeIncident = await lockScheduleIncident(tx, before);
  const latestCompletion = await latestScheduleCompletion(tx, slotId);
  const activeIncidentId = activeIncident?.status === "complete" ? null : before.activeIncidentId;
  const observationId = activeIncidentId ?? latestCompletion?.id;
  const now = await databaseNow(tx);
  const [schedule] = await tx.update(rotationSchedules).set({
    revision: before.revision + 1,
    activeIncidentId,
    nextRunAt: rotationScheduleDeadline(now, before.intervalMinutes),
    lastCompletedAt: latestCompletion?.completedAt ?? before.lastCompletedAt,
    lastHandledIncidentId: observationId ?? before.lastHandledIncidentId,
    lastHandledIncidentUpdatedAt: observationId
      ? incidentObservationTime(observationId) : sql`${rotationSchedules.lastHandledIncidentUpdatedAt}`,
    pausedReason: null,
    updatedAt: now,
  }).where(eq(rotationSchedules.slotId, slotId)).returning();
  return { before, schedule: schedule! };
}

// Callers hold context and schedule locks before inspecting incident state.
async function lockScheduleIncident(tx: RotationTransaction, schedule: PersistedRotationSchedule | undefined) {
  if (!schedule?.activeIncidentId) return undefined;
  const [incident] = await tx.select({ status: rotationIncidents.status, terminatedAt: rotationIncidents.terminatedAt })
    .from(rotationIncidents).where(eq(rotationIncidents.id, schedule.activeIncidentId)).for("update");
  return incident;
}

async function latestScheduleCompletion(tx: RotationTransaction, slotId: string) {
  const [incident] = await tx.select({ id: rotationIncidents.id, completedAt: rotationIncidents.completedAt })
    .from(rotationIncidents)
    .where(and(
      eq(rotationIncidents.slotId, slotId),
      eq(rotationIncidents.status, "complete"),
      isNotNull(rotationIncidents.completedAt),
    ))
    .orderBy(desc(rotationIncidents.completedAt), desc(rotationIncidents.createdAt), desc(rotationIncidents.id))
    .limit(1)
    .for("share");
  return incident;
}

// Keep PostgreSQL timestamp precision: passing these through Date would discard
// microseconds and could make an already consumed pause look new on every scan.
function incidentObservationTime(id: string) {
  return sql`(select updated_at from rotation_incidents where id = ${id})`;
}

/** Caller holds lockRotationContext. Reconcile before considering new admission. */
export async function reconcileRotationSchedule(tx: RotationTransaction, slotId: string) {
  const schedule = await lockRotationSchedule(tx, slotId);
  if (!schedule) return undefined;
  const observation = () => tx.select({
    incident: rotationIncidents,
    handled: sql<boolean>`${rotationIncidents.id} = ${rotationSchedules.lastHandledIncidentId}
      and ${rotationIncidents.updatedAt} is not distinct from ${rotationSchedules.lastHandledIncidentUpdatedAt}`,
  }).from(rotationIncidents)
    .innerJoin(rotationSchedules, eq(rotationSchedules.slotId, rotationIncidents.slotId));
  let [row] = await observation().where(and(
    eq(rotationIncidents.slotId, slotId),
    schedule.activeIncidentId ? eq(rotationIncidents.id, schedule.activeIncidentId) : ne(rotationIncidents.status, "complete"),
  )).limit(1).for("update", { of: rotationIncidents });
  if (!row && !schedule.activeIncidentId) {
    [row] = await observation().where(and(eq(rotationIncidents.slotId, slotId), eq(rotationIncidents.status, "complete"), isNotNull(rotationIncidents.completedAt)))
      .orderBy(desc(rotationIncidents.completedAt), desc(rotationIncidents.createdAt), desc(rotationIncidents.id))
      .limit(1).for("update", { of: rotationIncidents });
  }
  if (!row) return schedule;
  const { incident, handled } = row;
  // Configuration baselines deliberately consume historical completions. A linked
  // incident's later success must still be handled after an explicit resume.
  if (incident.status === "complete" && !schedule.activeIncidentId && schedule.lastHandledIncidentId === incident.id) return schedule;
  const now = await databaseNow(tx);
  if (incident.terminatedAt || incident.status === "paused" || incident.status === "exhausted") {
    if (handled) {
      if (incident.status !== "complete" || !schedule.activeIncidentId) return schedule;
      // Explicit resume may consume termination before the scanner gets here.
      // Release the completed association without consuming that resume again.
      const [updated] = await tx.update(rotationSchedules).set({ activeIncidentId: null, updatedAt: now })
        .where(eq(rotationSchedules.slotId, slotId)).returning();
      return updated!;
    }
    const [updated] = await tx.update(rotationSchedules).set({
      activeIncidentId: incident.status === "complete" ? null : incident.id,
      lastHandledIncidentId: incident.id,
      lastHandledIncidentUpdatedAt: incidentObservationTime(incident.id),
      pausedReason: schedule.pausedReason ?? incident.errorCode ?? (incident.terminatedAt ? "manual_terminated" : `rotation_${incident.status}`),
      nextRunAt: null,
      updatedAt: now,
    }).where(eq(rotationSchedules.slotId, slotId)).returning();
    return updated!;
  }
  if (incident.status === "complete" && incident.completedAt) {
    const [updated] = await tx.update(rotationSchedules).set({
      activeIncidentId: null,
      lastCompletedAt: incident.completedAt,
      lastHandledIncidentId: incident.id,
      lastHandledIncidentUpdatedAt: incidentObservationTime(incident.id),
      nextRunAt: schedule.enabled && !schedule.pausedReason ? rotationScheduleDeadline(incident.completedAt, schedule.intervalMinutes) : null,
      updatedAt: now,
    }).where(eq(rotationSchedules.slotId, slotId)).returning();
    return updated!;
  }
  if (!schedule.activeIncidentId) {
    const [updated] = await tx.update(rotationSchedules).set({ activeIncidentId: incident.id, lastStartedAt: incident.createdAt, updatedAt: now })
      .where(eq(rotationSchedules.slotId, slotId)).returning();
    return updated!;
  }
  return schedule;
}

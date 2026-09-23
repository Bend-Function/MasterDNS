import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cloudRotationReservations, operationSteps, operations, reconcileIntents, rotationAttempts, rotationIncidents, rotationLeases, rotationPolicies, rotationPublications, rotationResources, rotationSteps } from "./schema/index.js";
import { databaseNow, lockRotationContext, type RotationTransaction } from "./rotation-context.js";
import { rotationAudit } from "./rotation-incidents.js";

export async function terminateRotationIncident(tx: RotationTransaction, id: string, actorUserId: string) {
  const [identity] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id));
  if (!identity) throw new Error("rotation_not_found");
  await lockRotationContext(tx, identity.slotId);
  const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
  if (!incident) throw new Error("rotation_not_found");
  if (incident.terminatedAt) return incident;
  if (incident.status === "complete") throw new Error("rotation_not_resumable");
  const now = await databaseNow(tx);
  const publications = await tx.select().from(rotationPublications).where(eq(rotationPublications.incidentId, id));
  const children = publications.flatMap(publication => publication.children);
  for (const poolId of [...new Set(children.map(child => child.poolId))].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${poolId}))`);
  const eventIds = children.map(child => child.eventId);
  if (eventIds.length) await tx.update(reconcileIntents).set({ completedAt: now, updatedAt: now }).where(inArray(reconcileIntents.eventId, eventIds));
  const operationIds = [...new Set(publications.flatMap(publication => [publication.operationId, ...publication.children.map(child => child.operationId)]).filter((value): value is string => !!value))];
  // Reconcile may have committed an operation before publication observation has
  // copied its id into children. Cancel those operations by their durable key too.
  const keys = children.map(child => `pool:${child.poolId}:revision:${child.policyRevision}:event:${child.eventId}`);
  if (keys.length) {
    const planned = await tx.select({ id: operations.id }).from(operations).where(inArray(operations.idempotencyKey, keys));
    operationIds.push(...planned.map(operation => operation.id));
  }
  if (operationIds.length) {
    await tx.update(operations).set({ status: "superseded", updatedAt: now }).where(and(inArray(operations.id, operationIds), inArray(operations.status, ["pending", "running", "partial", "failed"])));
    await tx.update(operationSteps).set({ status: "skipped", finishedAt: now, updatedAt: now }).where(and(inArray(operationSteps.operationId, operationIds), inArray(operationSteps.status, ["pending", "failed"])));
  }
  await tx.update(rotationPolicies).set({ enabled: false, revision: sql`${rotationPolicies.revision} + 1`, updatedAt: now }).where(eq(rotationPolicies.slotId, incident.slotId));
  // Keep resources and receipts as history. Termination is not proof of deletion.
  await tx.update(rotationResources).set({ cleanupStatus: "retained", cleanupError: "manual_terminated", cleanupDueAt: null })
    .where(and(eq(rotationResources.incidentId, id), inArray(rotationResources.cleanupStatus, ["pending", "failed"])));
  const steps = await tx.select({ id: rotationSteps.id }).from(rotationSteps).innerJoin(rotationAttempts, eq(rotationAttempts.id, rotationSteps.attemptId)).where(eq(rotationAttempts.incidentId, id));
  if (steps.length) await tx.delete(cloudRotationReservations).where(and(inArray(cloudRotationReservations.stepId, steps.map(step => step.id)), isNull(cloudRotationReservations.consumedAt)));
  await tx.update(rotationPublications).set({ errorCode: "manual_terminated", updatedAt: now }).where(eq(rotationPublications.incidentId, id));
  // Fence work that claimed a lease before this transaction. Preserve unresolved
  // effect identity: cancellation cannot assert an in-flight cloud call had no effect.
  await tx.update(rotationLeases).set({ holder: null, expiresAt: now, revision: sql`${rotationLeases.revision} + 1`,
    incidentId: sql`case when ${rotationLeases.unresolvedStepId} is null then null else ${rotationLeases.incidentId} end` })
    .where(eq(rotationLeases.incidentId, id));
  const [updated] = await tx.update(rotationIncidents).set({ status: "complete", terminatedAt: now, completedAt: now, pausedByUserId: actorUserId, errorCode: "manual_terminated", updatedAt: now }).where(eq(rotationIncidents.id, id)).returning();
  await rotationAudit(tx, updated!, "rotation.terminate", actorUserId);
  return updated!;
}

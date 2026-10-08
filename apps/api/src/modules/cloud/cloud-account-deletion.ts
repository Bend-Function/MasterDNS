import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, notExists, or, sql } from "drizzle-orm";
import {
  auditLogs, cloudAccounts, cloudEndpointLinks, cloudIdleIpCleanups, cloudInstances, cloudInterfaces,
  cloudLifecycleOperations, cloudTrafficStopPolicies, databaseNow, endpointAddresses, endpointPools, endpoints,
  managedAddressSlots, operations, operationSteps, reconcileIntents, rotationAttempts, rotationBudgetSegments,
  rotationIncidents, rotationLeases, rotationPolicies, rotationPublications, rotationResources,
  rotationSchedules, rotationStepObservations, rotationSteps, type MasterDnsDatabase,
} from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";

/** Local removal only. Physical cloud budgets and power holds survive credential re-imports. */
export async function removeCloudAccount(database: MasterDnsDatabase, actor: AuthUser, id: string) {
  // Probe lease/result handlers lock a task before its slot. Cascading deletion can
  // become a deadlock victim; all effects here are local and safe to roll back/retry.
  for (let attempt = 0; ; attempt++) {
    try { return await removeCloudAccountOnce(database, actor, id); }
    catch (error) {
      let cause: unknown = error;
      while (cause && typeof cause === "object" && "cause" in cause && cause.cause) cause = cause.cause;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "40P01" && code !== "40001") throw error;
      if (attempt >= 2) throw new ConflictException("配置正在被其他操作修改，请刷新后重试");
    }
  }
}

async function removeCloudAccountOnce(database: MasterDnsDatabase, actor: AuthUser, id: string) {
  return database.transaction(async tx => {
    const [account] = await tx.select().from(cloudAccounts).where(and(
      eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id),
    )).for("update");
    if (!account) throw new NotFoundException("Cloud account not found");
    // Match worker admission: account -> instances -> slots -> physical leases -> Pools.
    const instances = await tx.select().from(cloudInstances).where(eq(cloudInstances.accountId, id)).orderBy(asc(cloudInstances.id)).for("update");
    const instanceIds = instances.map(instance => instance.id);
    const slots = await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots)
      .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
      .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
      .where(eq(cloudInstances.accountId, id)).orderBy(asc(managedAddressSlots.id)).for("update", { of: managedAddressSlots });
    const slotIds = slots.map(slot => slot.id);
    const incidents = slotIds.length ? await tx.select({ id: rotationIncidents.id }).from(rotationIncidents).where(inArray(rotationIncidents.slotId, slotIds)).orderBy(asc(rotationIncidents.id)) : [];
    const incidentIds = incidents.map(incident => incident.id);
    const attempts = incidentIds.length ? await tx.select({ id: rotationAttempts.id }).from(rotationAttempts).where(inArray(rotationAttempts.incidentId, incidentIds)) : [];
    const attemptIds = attempts.map(attempt => attempt.id);
    const steps = attemptIds.length ? await tx.select({ id: rotationSteps.id, status: rotationSteps.status }).from(rotationSteps).where(inArray(rotationSteps.attemptId, attemptIds)) : [];
    const stepIds = steps.map(step => step.id);
    const lifecycle = instanceIds.length ? await tx.select({ id: cloudLifecycleOperations.id, status: cloudLifecycleOperations.status }).from(cloudLifecycleOperations).where(inArray(cloudLifecycleOperations.instanceId, instanceIds)) : [];
    const cleanups = await tx.select().from(cloudIdleIpCleanups).where(eq(cloudIdleIpCleanups.accountId, id)).for("update");
    const unresolvedMessage = "账号仍有已发出但结果未确认的云操作，请等待结果确认或处理未决状态后再删除";
    if (steps.some(step => ["in_flight", "pending", "ambiguous"].includes(step.status))
      || lifecycle.some(operation => ["in_flight", "unknown"].includes(operation.status))
      || cleanups.some(cleanup => cleanup.items.some(item => ["in_flight", "pending"].includes(item.status)))) throw new ConflictException(unresolvedMessage);
    const now = await databaseNow(tx);
    const leaseFilter = or(
      incidentIds.length ? inArray(rotationLeases.incidentId, incidentIds) : undefined,
      stepIds.length ? inArray(rotationLeases.unresolvedStepId, stepIds) : undefined,
      lifecycle.length ? inArray(rotationLeases.holder, lifecycle.map(operation => operation.id)) : undefined,
    );
    if (leaseFilter) {
      const leases = await tx.select().from(rotationLeases).where(leaseFilter).orderBy(asc(rotationLeases.physicalKey)).for("update");
      if (leases.some(lease => lease.unresolvedStepId)) throw new ConflictException(unresolvedMessage);
      // Keep the monotonic fence, so an already claimed worker cannot regain authority.
      await tx.update(rotationLeases).set({ holder: null, incidentId: null, unresolvedStepId: null, expiresAt: now, revision: sql`${rotationLeases.revision}+1`, updatedAt: now }).where(leaseFilter);
    }

    const links = slotIds.length ? await tx.select({ endpointId: cloudEndpointLinks.endpointId, family: cloudEndpointLinks.family, poolId: endpoints.poolId }).from(cloudEndpointLinks)
      .innerJoin(endpoints, eq(endpoints.id, cloudEndpointLinks.endpointId)).where(inArray(cloudEndpointLinks.slotId, slotIds)) : [];
    const publications = slotIds.length ? await tx.select().from(rotationPublications).where(inArray(rotationPublications.slotId, slotIds)) : [];
    const children = publications.flatMap(publication => publication.children);
    const poolIds = [...new Set([...links.map(link => link.poolId), ...children.map(child => child.poolId)])].sort();
    for (const poolId of poolIds) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${poolId}))`);
    }
    if (children.length) await tx.update(reconcileIntents).set({ completedAt: now, updatedAt: now }).where(inArray(reconcileIntents.eventId, children.map(child => child.eventId)));
    const operationIds = publications.flatMap(publication => [publication.operationId, ...publication.children.map(child => child.operationId)]).filter((value): value is string => !!value);
    if (children.length) {
      // Reconcile may have persisted a job before copying its ID into the publication.
      const planned = await tx.select({ id: operations.id }).from(operations).where(inArray(operations.idempotencyKey, children.map(child => `pool:${child.poolId}:revision:${child.policyRevision}:event:${child.eventId}`)));
      operationIds.push(...planned.map(operation => operation.id));
    }
    if (operationIds.length) {
      await tx.update(operations).set({ status: "superseded", finishedAt: now, updatedAt: now }).where(and(inArray(operations.id, operationIds), inArray(operations.status, ["pending", "running", "partial", "failed"])));
      await tx.update(operationSteps).set({ status: "skipped", nextRetryAt: null, finishedAt: now, updatedAt: now }).where(and(inArray(operationSteps.operationId, operationIds), inArray(operationSteps.status, ["pending", "running", "failed"])));
    }

    if (slotIds.length) {
      await tx.delete(cloudEndpointLinks).where(inArray(cloudEndpointLinks.slotId, slotIds));
      for (const link of links) await tx.update(endpointAddresses).set({ source: "static" }).where(and(eq(endpointAddresses.endpointId, link.endpointId), eq(endpointAddresses.family, link.family), eq(endpointAddresses.source, "cloud")));
      if (links.length) await tx.update(endpoints).set({ addressMode: "static", updatedAt: now }).where(and(
        inArray(endpoints.id, links.map(link => link.endpointId)),
        notExists(tx.select({ id: cloudEndpointLinks.id }).from(cloudEndpointLinks).where(eq(cloudEndpointLinks.endpointId, endpoints.id))),
      ));
      // Restrictive foreign keys deliberately require explicit workflow cleanup.
      await tx.delete(rotationSchedules).where(inArray(rotationSchedules.slotId, slotIds));
      await tx.delete(rotationPublications).where(inArray(rotationPublications.slotId, slotIds));
      await tx.delete(rotationPolicies).where(inArray(rotationPolicies.slotId, slotIds));
    }
    // Sibling publications may share the cancelled Pool operation. Give them one
    // durable replacement decision that their existing observers can adopt.
    for (const poolId of poolIds) {
      const [pool] = await tx.update(endpointPools).set({ decisionRevision: sql`${endpointPools.decisionRevision}+1`, updatedAt: now }).where(eq(endpointPools.id, poolId)).returning();
      if (pool) await tx.insert(reconcileIntents).values({ poolId, eventId: randomUUID(), policyRevision: pool.policyRevision, decisionRevision: pool.decisionRevision, trigger: "configuration", source: "user" });
    }
    if (incidentIds.length) await tx.delete(rotationResources).where(inArray(rotationResources.incidentId, incidentIds));
    if (stepIds.length) await tx.delete(rotationStepObservations).where(inArray(rotationStepObservations.stepId, stepIds));
    // Reservations cascade from steps; remote quota buckets remain untouched.
    if (attemptIds.length) {
      await tx.delete(rotationSteps).where(inArray(rotationSteps.attemptId, attemptIds));
      await tx.delete(rotationAttempts).where(inArray(rotationAttempts.id, attemptIds));
    }
    if (incidentIds.length) {
      await tx.delete(rotationBudgetSegments).where(inArray(rotationBudgetSegments.incidentId, incidentIds));
      await tx.delete(rotationIncidents).where(inArray(rotationIncidents.id, incidentIds));
    }
    if (instanceIds.length) {
      await tx.delete(cloudLifecycleOperations).where(inArray(cloudLifecycleOperations.instanceId, instanceIds));
      await tx.delete(cloudTrafficStopPolicies).where(inArray(cloudTrafficStopPolicies.instanceId, instanceIds));
    }
    await tx.delete(cloudIdleIpCleanups).where(eq(cloudIdleIpCleanups.accountId, id));
    // Delete slots before the address cascade, because their host pointers use RESTRICT.
    if (slotIds.length) await tx.delete(managedAddressSlots).where(inArray(managedAddressSlots.id, slotIds));
    await tx.delete(cloudAccounts).where(eq(cloudAccounts.id, id));
    const result = { deleted: true, deletedInstances: instances.length };
    await tx.insert(auditLogs).values({ ownerUserId: account.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_account.delete", resourceType: "cloud_account", resourceId: id,
      beforeSnapshot: { id, name: account.name, provider: account.provider, externalAccountId: account.externalAccountId }, afterSnapshot: result });
    return result;
  });
}

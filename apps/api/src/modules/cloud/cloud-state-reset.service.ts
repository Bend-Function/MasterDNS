import { isIP } from "node:net";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { createCloudAdapter, type CloudCredentials, type CloudInventory } from "@masterdns/cloud-providers";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { addressHealthPolicies, addressHealthStates, auditLogs, cloudAccounts, cloudAddresses, cloudEndpointLinks, cloudIdleIpCleanups, cloudInstances, cloudInterfaces, cloudScanScopes, databaseNow, managedAddressSlots, probeRounds, probeTasks, resetHealthEvidence, rotationAttempts, rotationIncidents, rotationLeases, rotationPolicies, rotationPublications, rotationResources, rotationSteps, cloudRotationReservations, terminateRotationIncident, operationSteps, operations, reconcileIntents } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { env } from "../../config/env.js";
import { instanceLifecycleBlocksRotation } from "@masterdns/db";

@Injectable()
export class CloudStateResetService {
  private readonly key = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService) {}

  async reset(actor: AuthUser, instanceId: string) {
    const [before] = await this.database.db.select({ instance: cloudInstances, account: cloudAccounts }).from(cloudInstances)
      .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
      .where(and(eq(cloudInstances.id, instanceId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)));
    if (!before) throw new NotFoundException("Cloud instance not found");
    const { account, instance } = before;
    if (account.provider !== "aws" || !account.enabled || !account.externalAccountId || (account.regions && !account.regions.includes(instance.region))) throw new ConflictException("AWS instance is outside enabled account scope");
    const credentials = decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.key);
    const adapter = createCloudAdapter({ accountId: account.id, provider: account.provider, service: instance.service, credentials });
    return this.database.db.transaction(async tx => {
      const [currentAccount] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, account.id)).for("update");
      const [current] = await tx.select().from(cloudInstances).where(eq(cloudInstances.id, instanceId)).for("update");
      if (!currentAccount?.enabled || !current || current.updatedAt.getTime() !== instance.updatedAt.getTime() || current.externalId !== instance.externalId || currentAccount.updatedAt.getTime() !== account.updatedAt.getTime() || currentAccount.credentialCiphertext !== account.credentialCiphertext || currentAccount.externalAccountId !== account.externalAccountId || currentAccount.ownerUserId !== account.ownerUserId) throw new ConflictException("Cloud state changed during read; retry synchronization");
      const physicalKey = JSON.stringify([account.provider, account.externalAccountId, instance.service, instance.region, instance.externalId]);
      const originalSlots = await tx.select().from(managedAddressSlots).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId)).where(eq(cloudInterfaces.instanceId, instanceId)).orderBy(asc(managedAddressSlots.id));
      const ids = originalSlots.map(row => row.managed_address_slots.id);
      const incidents = ids.length ? await tx.select().from(rotationIncidents).where(inArray(rotationIncidents.slotId, ids)).orderBy(asc(rotationIncidents.id)) : [];
      const incidentIds = incidents.map(row => row.id);
      await tx.insert(rotationLeases).values({ physicalKey }).onConflictDoNothing();
      const [lease] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, physicalKey)).for("update");
      if (await instanceLifecycleBlocksRotation(tx, physicalKey)) throw new ConflictException("实例正在启停、删除或保持停机状态，不能重置轮换状态");
      if (lease?.incidentId && !incidentIds.includes(lease.incidentId)) throw new ConflictException("Another cloud account owns this instance's operation");
      // Hold the normal cloud admission fences across inspection. New local
      // operations cannot replace the address between this read and commit.
      for (const id of ids) await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots).where(eq(managedAddressSlots.id, id)).for("update");
      if ((await adapter.verifyIdentity()).externalAccountId !== account.externalAccountId) throw new ConflictException("Cloud account identity changed");
      const live = await adapter.inspect({ accountId: account.id, service: instance.service, region: instance.region, instanceId: instance.externalId });
      this.validate(live, instance);
      const now = await databaseNow(tx);
      const policies = ids.length ? await tx.select().from(rotationPolicies).where(inArray(rotationPolicies.slotId, ids)) : [];
      const boundSlots = new Set(ids.length ? (await tx.select({ slotId: cloudEndpointLinks.slotId }).from(cloudEndpointLinks).where(inArray(cloudEndpointLinks.slotId, ids))).map(row => row.slotId) : []);
      const healthSlots = new Set(ids.length ? (await tx.select({ slotId: addressHealthPolicies.slotId }).from(addressHealthPolicies).where(inArray(addressHealthPolicies.slotId, ids))).map(row => row.slotId) : []);
      // Stop workers with the same transactional fences as explicit termination.
      for (const incident of incidents) if (incident.status !== "complete") await terminateRotationIncident(tx, incident.id, actor.id);
      for (const policy of policies) await tx.update(rotationPolicies).set({ enabled: policy.enabled, updatedAt: now }).where(eq(rotationPolicies.slotId, policy.slotId));
      const resources = incidentIds.length ? await tx.select().from(rotationResources).where(inArray(rotationResources.incidentId, incidentIds)) : [];
      if (ids.length) {
        // Completed history also needs a fence against late conflicting receipts.
        await tx.update(rotationIncidents).set({ terminatedAt: sql`coalesce(${rotationIncidents.terminatedAt},${now.toISOString()}::timestamptz)`, status: "complete", errorCode: "cloud_state_reset", updatedAt: now }).where(inArray(rotationIncidents.id, incidentIds));
        const publications = await tx.select().from(rotationPublications).where(inArray(rotationPublications.slotId, ids));
        const children = publications.flatMap(publication => publication.children);
        for (const poolId of [...new Set(children.map(child => child.poolId))].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${poolId}))`);
        if (children.length) await tx.update(reconcileIntents).set({ completedAt: now, updatedAt: now }).where(inArray(reconcileIntents.eventId, children.map(child => child.eventId)));
        const operationIds = publications.flatMap(publication => [publication.operationId, ...publication.children.map(child => child.operationId)]).filter((id): id is string => !!id);
        if (children.length) {
          const planned = await tx.select({ id: operations.id }).from(operations).where(inArray(operations.idempotencyKey, children.map(child => `pool:${child.poolId}:revision:${child.policyRevision}:event:${child.eventId}`)));
          operationIds.push(...planned.map(row => row.id));
        }
        if (operationIds.length) {
          await tx.update(operations).set({ status: "superseded", updatedAt: now }).where(and(inArray(operations.id, operationIds), inArray(operations.status, ["pending", "running", "partial", "failed"])));
          await tx.update(operationSteps).set({ status: "skipped", nextRetryAt: null, finishedAt: now, updatedAt: now }).where(and(inArray(operationSteps.operationId, operationIds), inArray(operationSteps.status, ["pending", "running", "failed"])));
        }
        const attempts = await tx.select().from(rotationAttempts).where(inArray(rotationAttempts.incidentId, incidentIds));
        const attemptIds = attempts.map(row => row.id);
        if (attemptIds.length) {
          const steps = await tx.select({ id: rotationSteps.id }).from(rotationSteps).where(inArray(rotationSteps.attemptId, attemptIds));
          if (steps.length) await tx.delete(cloudRotationReservations).where(and(inArray(cloudRotationReservations.stepId, steps.map(row => row.id)), isNull(cloudRotationReservations.consumedAt)));
          // Abandoned means deliberately stopped, never "the cloud call did not happen".
          await tx.update(rotationSteps).set({ status: "abandoned", errorCode: "cloud_state_reset", retryAt: null, updatedAt: now }).where(and(inArray(rotationSteps.attemptId, attemptIds), ne(rotationSteps.status, "applied")));
        }
        await tx.update(rotationResources).set({ cleanupStatus: "retained", cleanupDueAt: null, cleanupError: "cloud_state_reset" }).where(and(inArray(rotationResources.incidentId, incidentIds), ne(rotationResources.cleanupStatus, "released")));
        await tx.update(rotationPublications).set({ errorCode: "manual_terminated", updatedAt: now }).where(inArray(rotationPublications.slotId, ids));
      }
      await tx.update(rotationLeases).set({ holder: null, expiresAt: now, incidentId: null, unresolvedStepId: null, revision: sql`${rotationLeases.revision}+1`, updatedAt: now }).where(eq(rotationLeases.physicalKey, physicalKey));
      const interfaces = await tx.select().from(cloudInterfaces).where(eq(cloudInterfaces.instanceId, instanceId));
      const oldAddresses = interfaces.length ? await tx.select().from(cloudAddresses).where(inArray(cloudAddresses.interfaceId, interfaces.map(row => row.id))) : [];
      const involved = new Set([...oldAddresses.map(row => row.address), ...resources.map(row => row.address), ...live.interfaces.flatMap(iface => iface.addresses.map(address => address.address))]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([account.provider, account.externalAccountId, instance.service])},624713))`);
      const batches = await tx.select().from(cloudIdleIpCleanups).where(eq(cloudIdleIpCleanups.externalAccountId, account.externalAccountId!)).for("update");
      for (const batch of batches) {
        let changed = false;
        const items = batch.items.map(item => {
          if (item.region !== instance.region || !involved.has(item.address) || !["ready", "waiting", "in_flight", "pending"].includes(item.status)) return item;
          changed = true;
          const next = { ...item, status: "skipped" as const, reason: "cloud_state_reset" }; delete next.retryAt;
          return next;
        });
        if (changed) await tx.update(cloudIdleIpCleanups).set({ items, updatedAt: now }).where(eq(cloudIdleIpCleanups.id, batch.id));
      }
      await tx.insert(cloudScanScopes).values({ accountId: account.id, service: instance.service, region: instance.region, generation: instance.scanGeneration }).onConflictDoNothing();
      const [scope] = await tx.select().from(cloudScanScopes).where(and(eq(cloudScanScopes.accountId, account.id), eq(cloudScanScopes.service, instance.service), eq(cloudScanScopes.region, instance.region)));
      const generation = Math.max(1, scope?.generation ?? instance.scanGeneration);
      await tx.update(cloudInstances).set({ metadata: { ...instance.metadata, present: true, providerMetadata: live.metadata ?? {}, ...(live.nativeName ? { nativeName: live.nativeName } : {}), ...(live.ipv6Only === undefined ? {} : { ipv6Only: live.ipv6Only }) }, name: live.name, state: live.state, scanGeneration: generation, lastSeenAt: now, updatedAt: now }).where(eq(cloudInstances.id, instanceId));
      if (interfaces.length) await tx.update(cloudAddresses).set({ inventoryPresent: false, updatedAt: now }).where(inArray(cloudAddresses.interfaceId, interfaces.map(row => row.id)));
      if (ids.length) await tx.update(managedAddressSlots).set({ candidateAddressId: null, updatedAt: now }).where(inArray(managedAddressSlots.id, ids));
      const refreshedSlots: string[] = [];
      for (const remote of live.interfaces) {
        const [iface] = await tx.insert(cloudInterfaces).values({ instanceId, externalId: remote.id, scanGeneration: generation, lastSeenAt: now,
          metadata: { providerMetadata: remote.metadata ?? {}, ...(remote.deviceIndex === undefined ? {} : { deviceIndex: remote.deviceIndex }), primaryAddresses: remote.addresses.filter(address => address.primary).map(address => address.address) } })
          .onConflictDoUpdate({ target: [cloudInterfaces.instanceId, cloudInterfaces.externalId], set: { metadata: { providerMetadata: remote.metadata ?? {}, ...(remote.deviceIndex === undefined ? {} : { deviceIndex: remote.deviceIndex }), primaryAddresses: remote.addresses.filter(address => address.primary).map(address => address.address) }, scanGeneration: generation, lastSeenAt: now, updatedAt: now } }).returning();
        for (const observed of remote.addresses.filter(address => address.prefixLength === undefined)) {
          const family = observed.family === 4 ? "4" as const : "6" as const;
          const previous = oldAddresses.find(address => address.interfaceId === iface!.id && address.family === family && address.address === observed.address);
          const sameAllocation = previous?.remoteAllocationId === (observed.allocationId ?? null) && (previous?.metadata.resourceId ?? null) === (observed.resourceId ?? null);
          const metadata = { ...(sameAllocation ? previous?.metadata : {}), providerMetadata: observed.metadata ?? {}, ...(observed.privateAddress ? { privateAddress: observed.privateAddress } : {}), ...(observed.resourceId ? { resourceId: observed.resourceId } : {}) };
          const values = { interfaceId: iface!.id, family, kind: "host" as const, address: observed.address, origin: sameAllocation && previous ? previous.origin : "user" as const, attemptId: sameAllocation ? previous?.attemptId ?? null : null, metadata, remoteAllocationId: observed.allocationId ?? null, inventoryPresent: true, scanGeneration: generation, lastSeenAt: now, updatedAt: now };
          const [address] = await tx.insert(cloudAddresses).values(values).onConflictDoUpdate({ target: [cloudAddresses.interfaceId, cloudAddresses.family, cloudAddresses.address], targetWhere: sql`${cloudAddresses.kind}='host'`, set: values }).returning();
          const candidates = originalSlots.map(row => row.managed_address_slots).filter(slot => slot.interfaceId === iface!.id && slot.family === family && !refreshedSlots.includes(slot.id));
          const role = observed.metadata?.awsAddressScope;
          const primaryCandidates = observed.primary ? candidates.filter(slot => {
            const old = oldAddresses.find(address => address.id === slot.currentAddressId);
            const oldRole = (old?.metadata.providerMetadata as Record<string, unknown> | undefined)?.awsAddressScope;
            return slot.name.startsWith("primary") && (family === "6" || role === oldRole || slot.name === `primary-${role}`);
          }) : [];
          const priority = (slot: typeof managedAddressSlots.$inferSelect) => (boundSlots.has(slot.id) ? 100 : 0) + (healthSlots.has(slot.id) ? 20 : 0) + (policies.some(policy => policy.slotId === slot.id) ? 10 : 0) + (slot.name === `primary-${role}` ? 5 : 0) + (slot.currentAddressId === address!.id || slot.candidateAddressId === address!.id ? 1 : 0);
          primaryCandidates.sort((a, b) => priority(b) - priority(a));
          const existing = primaryCandidates[0] ?? candidates.find(slot => slot.currentAddressId === address!.id || slot.candidateAddressId === address!.id);
          let slot = existing;
          if (!slot) [slot] = await tx.insert(managedAddressSlots).values({ interfaceId: iface!.id, family, name: observed.primary ? `observed-${role ?? family}-${address!.id.slice(0, 8)}` : observed.address, currentAddressId: address!.id }).onConflictDoNothing().returning();
          if (!slot) throw new ConflictException("Address slot changed; retry synchronization");
          refreshedSlots.push(slot.id);
          await tx.update(managedAddressSlots).set({ currentAddressId: address!.id, currentVersion: 0, candidateAddressId: address!.id, candidateVersion: Math.max(slot.currentVersion, slot.candidateVersion) + 1, updatedAt: now }).where(eq(managedAddressSlots.id, slot.id));
        }
      }
      const resetIds = [...new Set([...ids, ...refreshedSlots])];
      if (resetIds.length) {
        await tx.update(addressHealthStates).set({ ...resetHealthEvidence, stateChangedAt: now, updatedAt: now }).where(inArray(addressHealthStates.slotId, resetIds));
        const rounds = await tx.update(probeRounds).set({ status: "superseded", consensusResult: "unknown", finalizedAt: now }).where(and(inArray(probeRounds.slotId, resetIds), eq(probeRounds.status, "pending"))).returning({ id: probeRounds.id });
        if (rounds.length) await tx.update(probeTasks).set({ status: "stale" }).where(inArray(probeTasks.roundId, rounds.map(row => row.id)));
      }
      await tx.insert(auditLogs).values({ ownerUserId: account.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_instance.reset_state", resourceType: "cloud_instance", resourceId: instanceId,
        beforeSnapshot: { slots: originalSlots.map(row => row.managed_address_slots), incidentIds }, afterSnapshot: { observedAddresses: live.interfaces.flatMap(iface => iface.addresses.map(address => address.address)), resetIncidents: incidents.length, awaitingVerification: true } });
      return { reset: true, resetIncidents: incidents.length, observedAddresses: live.interfaces.flatMap(iface => iface.addresses.filter(address => address.prefixLength === undefined).map(address => address.address)), awaitingVerification: true };
    });
  }
  private validate(live: CloudInventory, instance: typeof cloudInstances.$inferSelect) {
    if (live.ref.accountId !== instance.accountId || live.ref.instanceId !== instance.externalId || live.ref.region !== instance.region || live.ref.service !== instance.service || !live.interfaces.length) throw new ConflictException("Cloud inventory identity is incomplete");
    const ids = new Set<string>();
    for (const iface of live.interfaces) {
      if (!iface.id || ids.has(iface.id) || !iface.addresses.length) throw new BadRequestException("Incomplete cloud interfaces"); ids.add(iface.id);
      if (iface.addresses.some(address => isIP(address.address) !== address.family)) throw new BadRequestException("Invalid cloud address");
    }
  }
}

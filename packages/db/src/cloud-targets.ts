import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { MasterDnsDatabase } from "./index.js";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, managedAddressSlots, rotationAttempts, rotationIncidents } from "./schema/index.js";

export type CloudTargetSummary = {
  /** Display-only correspondence attached by inventory views; never a probe target. */
  observedAddress?: { id: string; address: string } | null;
  currentAddressObserved: boolean;
  candidateAddressObserved: boolean;
  inventoryCurrent: boolean;
  activeCandidate: boolean;
  available: boolean;
  account: Pick<typeof cloudAccounts.$inferSelect, "id" | "name" | "provider">;
  instance: Pick<typeof cloudInstances.$inferSelect, "id" | "name" | "externalId" | "service" | "region">;
  slot: Pick<typeof managedAddressSlots.$inferSelect, "id" | "name" | "family" | "currentVersion" | "candidateVersion">;
  currentAddress: { id: string; address: string } | null;
  candidateAddress: { id: string; address: string } | null;
};

/** Callers must restrict slot IDs to targets visible to the requesting user. */
export async function getCloudTargetsForSlots(db: Pick<MasterDnsDatabase, "select">, slotIds: readonly string[]): Promise<Map<string, CloudTargetSummary>> {
  if (!slotIds.length) return new Map();
  const candidate = alias(cloudAddresses, "candidate_address");
  const rows = await db.select({
    freshness: {
      enabled: cloudAccounts.enabled, regions: cloudAccounts.regions, metadata: cloudInstances.metadata,
      instanceGeneration: cloudInstances.scanGeneration, interfaceGeneration: cloudInterfaces.scanGeneration,
      scopeGeneration: cloudScanScopes.generation, currentGeneration: cloudAddresses.scanGeneration, candidateGeneration: candidate.scanGeneration,
      currentPresent: cloudAddresses.inventoryPresent, candidatePresent: candidate.inventoryPresent,
    },
    activeCandidate: sql<boolean>`exists (select 1 from ${rotationIncidents}
      inner join ${rotationAttempts} on ${rotationAttempts.id} = ${rotationIncidents.currentAttemptId}
      where ${rotationIncidents.slotId} = ${managedAddressSlots.id} and ${rotationIncidents.status} <> 'complete'
      and ${rotationIncidents.terminatedAt} is null
      and ${rotationAttempts.candidateAddressId} = ${managedAddressSlots.candidateAddressId}
      and ${rotationAttempts.candidateVersion} = ${managedAddressSlots.candidateVersion})`,
    account: { id: cloudAccounts.id, name: cloudAccounts.name, provider: cloudAccounts.provider },
    instance: { id: cloudInstances.id, name: cloudInstances.name, externalId: cloudInstances.externalId, service: cloudInstances.service, region: cloudInstances.region },
    slot: { id: managedAddressSlots.id, name: managedAddressSlots.name, family: managedAddressSlots.family, currentVersion: managedAddressSlots.currentVersion, candidateVersion: managedAddressSlots.candidateVersion },
    currentAddress: { id: cloudAddresses.id, address: cloudAddresses.address },
    candidateAddress: { id: candidate.id, address: candidate.address },
  }).from(managedAddressSlots)
    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
    .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
    .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
    .leftJoin(cloudScanScopes, and(eq(cloudScanScopes.accountId, cloudInstances.accountId), eq(cloudScanScopes.service, cloudInstances.service), eq(cloudScanScopes.region, cloudInstances.region)))
    .leftJoin(cloudAddresses, eq(cloudAddresses.id, managedAddressSlots.currentAddressId))
    .leftJoin(candidate, eq(candidate.id, managedAddressSlots.candidateAddressId))
    .where(inArray(managedAddressSlots.id, [...new Set(slotIds)]));
  return new Map(rows.map(({ freshness, ...row }) => {
    const instanceCurrent = freshness.metadata.present !== false
      && (freshness.scopeGeneration === null || freshness.scopeGeneration === freshness.instanceGeneration)
      && freshness.interfaceGeneration === freshness.instanceGeneration;
    const currentAddressObserved = instanceCurrent && !!row.currentAddress && freshness.currentPresent === true && freshness.currentGeneration === freshness.instanceGeneration;
    const candidateAddressObserved = instanceCurrent && !!row.candidateAddress && freshness.candidatePresent === true && freshness.candidateGeneration === freshness.instanceGeneration;
    // Probe/publication authority stays on the selected candidate. Visibility may
    // also show a separately observed current address, without authorizing it.
    const inventoryCurrent = row.candidateAddress ? candidateAddressObserved : currentAddressObserved;
    const available = freshness.enabled && (freshness.regions === null || freshness.regions.includes(row.instance.region))
      && instanceCurrent && (row.candidateAddress ? freshness.candidatePresent : freshness.currentPresent) === true && (inventoryCurrent || row.activeCandidate);
    return [row.slot.id, { ...row, currentAddressObserved, candidateAddressObserved, inventoryCurrent, available }];
  }));
}

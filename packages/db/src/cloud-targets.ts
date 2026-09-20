import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { MasterDnsDatabase } from "./index.js";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, managedAddressSlots } from "./schema/index.js";

export type CloudTargetSummary = {
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
    account: { id: cloudAccounts.id, name: cloudAccounts.name, provider: cloudAccounts.provider },
    instance: { id: cloudInstances.id, name: cloudInstances.name, externalId: cloudInstances.externalId, service: cloudInstances.service, region: cloudInstances.region },
    slot: { id: managedAddressSlots.id, name: managedAddressSlots.name, family: managedAddressSlots.family, currentVersion: managedAddressSlots.currentVersion, candidateVersion: managedAddressSlots.candidateVersion },
    currentAddress: { id: cloudAddresses.id, address: cloudAddresses.address },
    candidateAddress: { id: candidate.id, address: candidate.address },
  }).from(managedAddressSlots)
    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
    .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
    .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
    .leftJoin(cloudAddresses, eq(cloudAddresses.id, managedAddressSlots.currentAddressId))
    .leftJoin(candidate, eq(candidate.id, managedAddressSlots.candidateAddressId))
    .where(inArray(managedAddressSlots.id, [...new Set(slotIds)]));
  return new Map(rows.map(row => [row.slot.id, row]));
}

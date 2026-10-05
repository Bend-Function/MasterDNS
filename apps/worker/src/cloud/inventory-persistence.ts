import { and, eq, sql } from "drizzle-orm";
import { cloudAddresses, cloudInstances, deletedLinodeTemporaryInstances, forgetDeletedLinodeTemporaryInstance, matchesLinodeTemporaryInstance, type RotationTransaction } from "@masterdns/db";
import { getCloudServiceRegistration, type CloudInventory } from "@masterdns/cloud-providers";
import type { CloudService } from "@masterdns/contracts";

/** Persistence extensions run under the inventory transaction's account/scope locks. */
type InventoryPersistence = {
  includes(item: CloudInventory): boolean;
  complete(tx: RotationTransaction): Promise<void>;
};
type PrepareInventoryPersistence = (tx: RotationTransaction, accountId: string, region: string) => Promise<InventoryPersistence>;
const inventoryPersistence: Partial<Record<CloudService, PrepareInventoryPersistence>> = {
  linode: async (tx, accountId, region) => {
    const deletedHelpers = await deletedLinodeTemporaryInstances(tx, accountId, region);
    return {
      includes: item => !deletedHelpers.some(proof => matchesLinodeTemporaryInstance({ externalId: item.ref.instanceId, name: item.name, created: item.metadata?.instanceCreated }, proof)),
      complete: async tx => {
        if (!deletedHelpers.length) return;
        const retained = await tx.select({ externalId: cloudInstances.externalId }).from(cloudInstances)
          .where(and(eq(cloudInstances.accountId, accountId), eq(cloudInstances.service, "linode"), eq(cloudInstances.region, region)));
        const retainedIds = new Set(retained.map(instance => instance.externalId));
        for (const proof of deletedHelpers) {
          if (retainedIds.has(proof.id) && await forgetDeletedLinodeTemporaryInstance(tx, proof)) retainedIds.delete(proof.id);
        }
      },
    };
  },
};
export async function prepareInventoryPersistence(tx: RotationTransaction, service: CloudService, accountId: string, region: string): Promise<InventoryPersistence> {
  return inventoryPersistence[service]?.(tx, accountId, region) ?? { includes: () => true, complete: async () => {} };
}

/** Legacy proof is anchored atomically from stored data, never incoming inventory. */
export function refreshedAddressMetadata(service: CloudService, metadata: Record<string, unknown>) {
  if (!getCloudServiceRegistration(service)?.workflow?.preserveAllocationIdentity) return metadata;
  return sql`${JSON.stringify(metadata)}::jsonb || case
    when ${cloudAddresses.metadata} ? 'allocationIdentity' then jsonb_build_object('allocationIdentity', ${cloudAddresses.metadata}->'allocationIdentity')
    when ${cloudAddresses.origin} = 'system' or nullif(${cloudAddresses.metadata}->'providerMetadata'->>'resourceGuid', '') is not null
      then jsonb_build_object('allocationIdentity', jsonb_build_object('allocationId', ${cloudAddresses.remoteAllocationId}, 'resourceId', ${cloudAddresses.metadata}->'resourceId', 'resourceGuid', ${cloudAddresses.metadata}->'providerMetadata'->'resourceGuid'))
    else '{}'::jsonb end`;
}

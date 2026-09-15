import { and, eq, inArray, ne } from "drizzle-orm";
import {
  addressHealthStates,
  cloudAccounts,
  cloudEndpointLinks,
  cloudInstances,
  cloudInterfaces,
  endpointAddresses,
  endpoints,
  managedAddressSlots,
  rotationIncidents,
} from "./schema/index.js";
import { lockRotationContext, type RotationContext, type RotationTransaction } from "./rotation-context.js";
import { resetHealthEvidence } from "./address-health.js";
export type CloudPolicyLink = {
  endpointId: string;
  family: "4" | "6";
  slotId: string;
  accountId: string;
  externalAccountId: string | null;
  service: "ec2" | "lightsail";
  region: string;
  instanceId: string;
  interfaceId: string;
};
export async function captureCloudPolicyLinks(tx: RotationTransaction, poolId: string): Promise<CloudPolicyLink[]> {
  return tx
    .select({
      endpointId: cloudEndpointLinks.endpointId,
      family: cloudEndpointLinks.family,
      slotId: cloudEndpointLinks.slotId,
      accountId: cloudAccounts.id,
      externalAccountId: cloudAccounts.externalAccountId,
      service: cloudInstances.service,
      region: cloudInstances.region,
      instanceId: cloudInstances.externalId,
      interfaceId: cloudInterfaces.externalId,
    })
    .from(cloudEndpointLinks)
    .innerJoin(endpoints, eq(endpoints.id, cloudEndpointLinks.endpointId))
    .innerJoin(managedAddressSlots, eq(managedAddressSlots.id, cloudEndpointLinks.slotId))
    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
    .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
    .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
    .where(eq(endpoints.poolId, poolId));
}
/** Restore identity, never a historic IP. P7 retests the current observed slot;
 * P10 checks its live cloud attachment before any DNS publication. */
export async function prepareCloudPolicyRestore(tx: RotationTransaction, poolId: string, ownerUserId: string, links: CloudPolicyLink[]) {
  const contexts = new Map<string, RotationContext>();
  for (const link of [...links].sort((a, b) => a.slotId.localeCompare(b.slotId))) {
    const c = await lockRotationContext(tx, link.slotId);
    if (
      c.account.ownerUserId !== ownerUserId ||
      !c.account.enabled ||
      !c.account.externalAccountId ||
      !c.authorization?.managed ||
      !c.scope ||
      (c.account.regions !== null && !c.account.regions.includes(c.instance.region)) ||
      c.conflictingManager ||
      c.instance.metadata.present === false ||
      c.iface?.scanGeneration !== c.instance.scanGeneration ||
      link.accountId !== c.account.id ||
      link.externalAccountId !== c.account.externalAccountId ||
      link.service !== c.instance.service ||
      link.region !== c.instance.region ||
      link.instanceId !== c.instance.externalId ||
      link.interfaceId !== c.iface?.externalId ||
      link.family !== c.slot.family ||
      !c.slot.currentAddressId
    )
      throw new Error("cloud_restore_identity_unavailable");
    const [incident] = await tx
      .select({ id: rotationIncidents.id })
      .from(rotationIncidents)
      .where(and(eq(rotationIncidents.slotId, c.slot.id), ne(rotationIncidents.status, "complete")));
    if (incident || c.slot.candidateAddressId) throw new Error("cloud_restore_rotation_pending");
    contexts.set(c.slot.id, c);
  }
  const current = await captureCloudPolicyLinks(tx, poolId);
  // Mode/slot migrations require the dedicated binding flow; fail before writes.
  if (
    current.length !== links.length ||
    current.some((l) => !links.some((w) => w.endpointId === l.endpointId && w.family === l.family && w.slotId === l.slotId))
  )
    throw new Error("cloud_restore_link_transition_unsupported");
  for (const c of contexts.values()) {
    await tx
      .update(managedAddressSlots)
      .set({
        candidateAddressId: c.slot.currentAddressId,
        candidateVersion: Math.max(c.slot.currentVersion, c.slot.candidateVersion) + 1,
        updatedAt: new Date(),
      })
      .where(eq(managedAddressSlots.id, c.slot.id));
    await tx
      .update(addressHealthStates)
      .set({ ...resetHealthEvidence, updatedAt: new Date() })
      .where(eq(addressHealthStates.slotId, c.slot.id));
    const linked = await tx
      .select({ id: cloudEndpointLinks.endpointId })
      .from(cloudEndpointLinks)
      .where(eq(cloudEndpointLinks.slotId, c.slot.id));
    if (linked.length)
      await tx
        .update(endpointAddresses)
        .set({ healthState: "unknown", consecutiveSuccesses: 0, consecutiveFailures: 0, lastCheckedAt: null })
        .where(
          and(
            inArray(
              endpointAddresses.endpointId,
              linked.map((l) => l.id),
            ),
            eq(endpointAddresses.family, c.slot.family),
            eq(endpointAddresses.state, "current"),
          ),
        );
  }
}

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, instanceAuthorizations, managedAddressSlots, rotationPolicies } from "./schema/index.js";
import type { MasterDnsDatabase } from "./index.js";
export type RotationTransaction = Parameters<Parameters<MasterDnsDatabase["transaction"]>[0]>[0];
export async function databaseNow(tx: RotationTransaction) {
  const rows = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  return new Date(rows[0]!.now);
}
export async function lockRotationContext(tx: RotationTransaction, slotId: string) {
  const [identity] = await tx.select({ accountId: cloudInstances.accountId, instanceId: cloudInstances.id }).from(managedAddressSlots)
    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId)).innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId)).where(eq(managedAddressSlots.id, slotId));
  if (!identity) throw new Error("rotation_not_found");
  // Same ordering as account updates, grants and inventory scans. This transaction is
  // the admission boundary; a subsequent revocation cannot retract an accepted call.
  const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, identity.accountId)).for("update");
  const [instance] = await tx.select().from(cloudInstances).where(eq(cloudInstances.id, identity.instanceId)).for("update");
  const [slot] = await tx.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, slotId)).for("update");
  if (!account || !instance || !slot) throw new Error("rotation_not_found");
  const [iface] = await tx.select().from(cloudInterfaces).where(eq(cloudInterfaces.id, slot.interfaceId)).for("share");
  const [authorization] = await tx.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, instance.id)).for("share");
  const [policy] = await tx.select().from(rotationPolicies).where(eq(rotationPolicies.slotId, slot.id)).for("share");
  const selectedId = slot.candidateAddressId ?? slot.currentAddressId;
  const [address] = selectedId ? await tx.select().from(cloudAddresses).where(eq(cloudAddresses.id, selectedId)).for("share") : [];
  const [scope] = await tx.select().from(cloudScanScopes).where(and(eq(cloudScanScopes.accountId, account.id), eq(cloudScanScopes.service, instance.service), eq(cloudScanScopes.region, instance.region))).for("share");
  const conflicts = account.externalAccountId ? await tx.select({ id: cloudInstances.id }).from(cloudInstances)
    .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId)).innerJoin(instanceAuthorizations, eq(instanceAuthorizations.instanceId, cloudInstances.id))
    .where(and(eq(cloudAccounts.provider, account.provider), eq(cloudAccounts.externalAccountId, account.externalAccountId), eq(cloudInstances.service, instance.service), eq(cloudInstances.region, instance.region), eq(cloudInstances.externalId, instance.externalId), ne(cloudInstances.id, instance.id), eq(instanceAuthorizations.managed, true))) : [];
  const physicalKey = JSON.stringify([account.provider, account.externalAccountId, instance.service, instance.region, instance.externalId]);
  return { account, instance, iface, slot, address, authorization, policy, scope, physicalKey, conflictingManager: conflicts.length > 0,
    addressVersion: slot.candidateAddressId ? slot.candidateVersion : slot.currentVersion };
}
export type RotationContext = Awaited<ReturnType<typeof lockRotationContext>>;
export function rotationAuthorizationError(c: RotationContext, trigger: "health" | "manual" = "health"): string | undefined {
  if (!c.account.enabled || !c.account.externalAccountId || !c.authorization?.managed) return "authorization_revoked";
  if ((trigger === "health" && !c.policy?.enabled) || !(c.slot.family === "4" ? c.authorization.allowIpv4Rotation : c.authorization.allowIpv6Rotation)) return "family_disabled";
  if (!c.scope || (c.account.regions !== null && !c.account.regions.includes(c.instance.region))) return "region_excluded";
  if (!c.iface || !c.address || c.instance.metadata.present === false || c.iface.scanGeneration !== c.instance.scanGeneration) return "resource_not_found";
  if (c.conflictingManager) return "conflicting_manager";
}

/** Prelock the entire hierarchy before callers acquire any Pool lock. Sorting
 * slots alone is insufficient: different slot sets can invert account order. */
export async function lockRotationContexts(tx: RotationTransaction, slotIds: string[]) {
  const ids = [...new Set(slotIds)].sort();
  const contexts = new Map<string, RotationContext>();
  if (!ids.length) return contexts;
  const identities = () => tx.select({ slotId: managedAddressSlots.id, interfaceId: cloudInterfaces.id, accountId: cloudInstances.accountId, instanceId: cloudInstances.id })
    .from(managedAddressSlots).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
    .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId)).where(inArray(managedAddressSlots.id, ids));
  const before = await identities();
  if (before.length !== ids.length) throw new Error("rotation_not_found");
  for (const id of [...new Set(before.map(row => row.accountId))].sort()) await tx.select({ id: cloudAccounts.id }).from(cloudAccounts).where(eq(cloudAccounts.id, id)).for("update");
  for (const id of [...new Set(before.map(row => row.instanceId))].sort()) await tx.select({ id: cloudInstances.id }).from(cloudInstances).where(eq(cloudInstances.id, id)).for("update");
  for (const id of ids) await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots).where(eq(managedAddressSlots.id, id)).for("update");
  for (const id of [...new Set(before.map(row => row.interfaceId))].sort()) await tx.select({ id: cloudInterfaces.id }).from(cloudInterfaces).where(eq(cloudInterfaces.id, id)).for("share");
  const after = await identities();
  if (after.length !== before.length || after.some(row => !before.some(old => old.slotId === row.slotId && old.accountId === row.accountId && old.instanceId === row.instanceId && old.interfaceId === row.interfaceId))) throw new Error("rotation_identity_changed");
  for (const id of ids) contexts.set(id, await lockRotationContext(tx, id));
  return contexts;
}

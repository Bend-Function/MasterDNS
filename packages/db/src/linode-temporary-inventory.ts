import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { cloudAccounts, cloudInstances, cloudInterfaces, managedAddressSlots, rotationSteps } from "./schema/index.js";
import { linodeTemporaryInstanceProof, type LinodeTemporaryInstanceProof } from "./rotation-temporary-instances.js";
import type { RotationTransaction } from "./rotation-context.js";

/** A confirmed delete receipt also prevents a scan started earlier from resurrecting the helper. */
export async function deletedLinodeTemporaryInstances(tx: RotationTransaction, accountId: string, region: string) {
  const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId));
  if (account?.provider !== "linode" || !account.externalAccountId) return [];
  const steps = await tx.select({ attemptId: rotationSteps.attemptId, plan: rotationSteps.plan }).from(rotationSteps).where(and(
    eq(rotationSteps.status, "applied"),
    sql`${rotationSteps.plan}->>'action' = 'linode.swap.delete'`,
    sql`${rotationSteps.plan}->'arguments'->'linodeSwapReceipt'->'after'->'temporaryInstance'->>'accountId' = ${accountId}`,
    sql`${rotationSteps.plan}->'arguments'->'linodeSwapReceipt'->'after'->'temporaryInstance'->>'region' = ${region}`,
  ));
  return steps.flatMap(step => {
    const proof = linodeTemporaryInstanceProof(step.plan.arguments.linodeSwapReceipt);
    return proof && proof.attemptId === step.attemptId && proof.externalAccountId === account.externalAccountId ? [proof] : [];
  });
}

export function matchesLinodeTemporaryInstance(
  instance: { externalId: string; name: string | null; created: unknown },
  proof: LinodeTemporaryInstanceProof,
) {
  return instance.externalId === proof.id && instance.name === proof.label && instance.created === proof.created;
}

/** Call only after observing deletion. Keep referenced resources; deletion must not erase user bindings/history. */
export async function forgetDeletedLinodeTemporaryInstance(tx: RotationTransaction, proof: LinodeTemporaryInstanceProof) {
  const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, proof.accountId)).for("update");
  if (account?.provider !== "linode" || account.externalAccountId !== proof.externalAccountId) return false;
  const [instance] = await tx.select().from(cloudInstances).where(and(
    eq(cloudInstances.accountId, account.id), eq(cloudInstances.service, "linode"),
    eq(cloudInstances.region, proof.region), eq(cloudInstances.externalId, proof.id),
  )).for("update");
  const metadata = instance?.metadata.providerMetadata as Record<string, unknown> | undefined;
  if (!instance || !matchesLinodeTemporaryInstance({ ...instance, created: metadata?.instanceCreated }, proof)) return false;
  const slots = await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots)
    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
    .where(eq(cloudInterfaces.instanceId, instance.id)).orderBy(asc(managedAddressSlots.id)).for("update", { of: managedAddressSlots });
  // All writers of these associations serialize through the account/instance locks above.
  const [references] = await tx.execute<{ protected: boolean }>(sql`select (
    exists (select 1 from instance_authorizations where instance_id = ${instance.id} and managed)
    or exists (select 1 from cloud_lifecycle_operations where instance_id = ${instance.id})
    or exists (select 1 from cloud_traffic_stop_policies where instance_id = ${instance.id})
    or exists (
      select 1 from managed_address_slots s join cloud_interfaces i on i.id = s.interface_id
      where i.instance_id = ${instance.id} and (
        exists (select 1 from cloud_endpoint_links where slot_id = s.id)
        or exists (select 1 from health_check_configs where slot_id = s.id)
        or exists (select 1 from address_health_policies where slot_id = s.id)
        or exists (select 1 from address_health_states where slot_id = s.id)
        or exists (select 1 from probe_rounds where slot_id = s.id)
        or exists (select 1 from rotation_policies where slot_id = s.id)
        or exists (select 1 from rotation_schedules where slot_id = s.id)
        or exists (select 1 from rotation_incidents where slot_id = s.id)
        or exists (select 1 from rotation_publications where slot_id = s.id)
      )
    )
  ) as protected`);
  if (references?.protected) return false;
  // Slots reference addresses with RESTRICT, so remove slots before cascading interfaces/addresses.
  if (slots.length) await tx.delete(managedAddressSlots).where(inArray(managedAddressSlots.id, slots.map(slot => slot.id)));
  await tx.delete(cloudInstances).where(eq(cloudInstances.id, instance.id));
  return true;
}

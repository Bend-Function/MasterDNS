import { addressHealthPolicies, cloudAddresses, endpointAddresses, getCloudTargetsForSlots, healthCheckConfigs, managedAddressSlots, probeGroups, probeRounds } from "@masterdns/db";
import { eq } from "drizzle-orm";
import type { ProbeTransaction } from "./probe-agent-auth.js";

type Round = typeof probeRounds.$inferSelect;
// Hold target/config/cohort locks through observation insertion; P7 uses the same order.
export async function lockRoundState(tx: ProbeTransaction, snapshot: Round, now: Date) {
  let targetMatches = false;
  if (snapshot.slotId) {
    const [slot] = await tx.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, snapshot.slotId)).for("share");
    const addressId = slot?.candidateAddressId ?? slot?.currentAddressId;
    const version = slot?.candidateAddressId ? slot.candidateVersion : slot?.currentVersion;
    const [address] = addressId ? await tx.select().from(cloudAddresses).where(eq(cloudAddresses.id, addressId)).for("share") : [];
    const available = slot && (await getCloudTargetsForSlots(tx, [slot.id])).get(slot.id)?.available;
    targetMatches = !!available && !!address && version === snapshot.addressVersion && version > 0 && address.address === snapshot.address && address.family === snapshot.family;
  } else if (snapshot.endpointAddressId) {
    const [address] = await tx.select().from(endpointAddresses).where(eq(endpointAddresses.id, snapshot.endpointAddressId)).for("share");
    targetMatches = !!address && address.endpointId === snapshot.endpointId && address.state !== "previous" && address.address === snapshot.address && address.family === snapshot.family;
  }
  const [config] = await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, snapshot.configId)).for("share");
  const [group] = snapshot.groupId ? await tx.select().from(probeGroups).where(eq(probeGroups.id, snapshot.groupId)).for("share") : [];
  const [policy] = snapshot.policyId ? await tx.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, snapshot.policyId)).for("share") : [];
  const policyMatches = snapshot.policyId ? !!policy && policy.mode !== "local" && policy.revision === snapshot.policyRevision && policy.configId === snapshot.configId && policy.groupId === snapshot.groupId && policy.slotId === snapshot.slotId && policy.endpointId === snapshot.endpointId && policy.family === snapshot.family : snapshot.policyRevision === null;
  const [round] = await tx.select().from(probeRounds).where(eq(probeRounds.id, snapshot.id)).for("share");
  const fresh = !!round && policyMatches && targetMatches && !!config?.enabled && config.revision === snapshot.configVersion
    && (snapshot.groupId ? group?.revision === snapshot.groupRevision : snapshot.groupRevision === null)
    && round.status === "pending" && round.deadline > now && round.resultExpiresAt > now;
  return { round, fresh };
}

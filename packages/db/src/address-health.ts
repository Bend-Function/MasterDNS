import { and, eq, ne, sql } from "drizzle-orm";
import { addressHealthStates, cloudAddresses, endpointAddresses, endpointPools, endpoints, managedAddressSlots } from "./schema/index.js";
import type { ProbeTransaction } from "./probe-rounds.js";
export type HealthTargetIdentity = { slotId?: string | null | undefined; endpointId?: string | null | undefined; endpointAddressId?: string | null | undefined; family: "4" | "6" };
export function healthTargetWhere(table: typeof addressHealthStates, target: HealthTargetIdentity) {
  return target.slotId ? eq(table.slotId, target.slotId) : and(eq(table.endpointId, target.endpointId!), eq(table.family, target.family), target.endpointAddressId ? eq(table.addressId, target.endpointAddressId) : undefined);
}
// Caller holds the slot lock. This starts verification only; P10 owns publication/fanout.
export async function initializeSlotCandidate(tx: ProbeTransaction, slotId: string, now = new Date()) {
  const [slot] = await tx.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, slotId)).for("update");
  if (!slot) return undefined;
  if (!slot.candidateAddressId && slot.currentAddressId && slot.currentVersion === 0) {
    const [initialized] = await tx.update(managedAddressSlots).set({ candidateAddressId: slot.currentAddressId, candidateVersion: 1, updatedAt: now }).where(eq(managedAddressSlots.id, slot.id)).returning();
    return initialized;
  }
  return slot;
}
export async function lockHealthTarget(tx: ProbeTransaction, target: HealthTargetIdentity, initialize = false, now = new Date()) {
  const targets = await lockHealthTargets(tx, target, initialize, now);
  return target.endpointAddressId
    ? targets.find(address => address.addressId === target.endpointAddressId)
    : targets.find(address => address.endpointAddress?.state === "candidate") ?? targets[0];
}
export async function lockHealthTargets(tx: ProbeTransaction, target: HealthTargetIdentity, initialize = false, now = new Date()) {
  if (target.slotId) {
    const slot = initialize ? await initializeSlotCandidate(tx, target.slotId, now) : (await tx.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, target.slotId)).for("update"))[0];
    const addressId = slot?.candidateAddressId ?? slot?.currentAddressId;
    const [address] = addressId ? await tx.select().from(cloudAddresses).where(eq(cloudAddresses.id, addressId)).for("share") : [];
    if (!slot || !address || slot.family !== target.family) return [];
    return [{ slot, addressId: address.id, address: address.address, family: slot.family, addressVersion: slot.candidateAddressId ? slot.candidateVersion : slot.currentVersion, endpoint: undefined, pool: undefined, endpointAddress: undefined }];
  }
  const [snapshot] = await tx.select().from(endpoints).where(eq(endpoints.id, target.endpointId!));
  if (!snapshot) return [];
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${snapshot.poolId}))`);
  const [endpoint] = await tx.select().from(endpoints).where(eq(endpoints.id, snapshot.id)).for("update");
  const [pool] = await tx.select().from(endpointPools).where(eq(endpointPools.id, snapshot.poolId));
  const addresses = await tx.select().from(endpointAddresses).where(and(eq(endpointAddresses.endpointId, snapshot.id), eq(endpointAddresses.family, target.family), ne(endpointAddresses.state, "previous"))).for("update");
  if (!endpoint || !pool || endpoint.lifecycle !== "enabled" || endpoint.addressMode === "cloud") return [];
  return addresses.sort((a, b) => Number(b.state === "current") - Number(a.state === "current")).map(address => ({ slot: undefined, endpoint, pool, endpointAddress: address, addressId: address.id, address: address.address, family: address.family, addressVersion: 1 }));
}
export const resetHealthEvidence = { healthState: "unknown" as const, consecutiveSuccesses: 0, consecutiveFailures: 0, latestDecision: "unknown" as const, evidenceExpiresAt: null, lastCheckedAt: null, nextRoundAt: null };
// Consumers must additionally lock/recheck current target, policy, config and group identity.
export function hasFreshHealthEvidence(state: typeof addressHealthStates.$inferSelect, decision: "success" | "failure", thresholds: { successThreshold: number; failureThreshold: number }, now = new Date()) {
  return state.latestDecision === decision && !!state.evidenceExpiresAt && state.evidenceExpiresAt > now
    && (decision === "success" ? state.healthState === "healthy" && state.consecutiveSuccesses >= thresholds.successThreshold : state.healthState === "unhealthy" && state.consecutiveFailures >= thresholds.failureThreshold);
}

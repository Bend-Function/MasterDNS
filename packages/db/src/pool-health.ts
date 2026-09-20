import type { HealthState } from "@masterdns/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { MasterDnsDatabase } from "./index.js";
import { bindingEndpointHealth, cloudEndpointLinks, domainBindings, endpointAddresses, endpointPools, endpoints, healthCheckConfigs } from "./schema/index.js";

export type PoolHealthInput = {
  endpoints: Array<{ id: string; lifecycle: string; addressFamilies?: Array<"4" | "6"> }>;
  addresses: Array<{ id: string; endpointId: string; family: "4" | "6"; healthState: HealthState }>;
  bindings: Array<{ id: string; recordType: string }>;
  bindingHealth: Array<{ domainBindingId: string; endpointId: string; endpointAddressId: string | null; healthState: HealthState }>;
  overrideBindingIds: string[];
};

export type PoolHealthSummary = {
  state: HealthState;
  bindingStates: Record<string, HealthState>;
  endpointStates: Record<string, HealthState>;
  endpointCount: number;
  healthyEndpointCount: number;
  waitingBindingCount: number;
};

// This is an availability projection, not a DNS publication decision. Publication
// still requires the exact cloud identity, authorization and external evidence.
export function projectPoolHealth(input: PoolHealthInput): PoolHealthSummary {
  const enabled = input.endpoints.filter(endpoint => endpoint.lifecycle === "enabled");
  const addressesByEndpoint = new Map(enabled.map(endpoint => [endpoint.id, input.addresses.filter(address => address.endpointId === endpoint.id)]));
  const overrides = new Set(input.overrideBindingIds);
  const bindingStates: Record<string, HealthState> = {};
  for (const binding of input.bindings) {
    const family = binding.recordType === "AAAA" ? "6" : "4";
    const states = enabled.flatMap(endpoint => {
      const addresses = addressesByEndpoint.get(endpoint.id)!;
      const address = addresses.find(candidate => candidate.family === family);
      // A brand new endpoint is waiting for its first verified address. A node
      // with only the other address family is not a candidate for this binding.
      if (!address) return (endpoint.addressFamilies?.length ? endpoint.addressFamilies.includes(family) : addresses.length === 0) ? ["unknown" as const] : [];
      if (!overrides.has(binding.id)) return [address.healthState];
      const health = input.bindingHealth.find(row => row.domainBindingId === binding.id && row.endpointId === endpoint.id && row.endpointAddressId === address.id);
      return [health?.healthState ?? "unknown"];
    });
    bindingStates[binding.id] = summarizeHealth(states);
  }
  const endpointStates = Object.fromEntries(enabled.map(endpoint => [endpoint.id, summarizeHealth(addressesByEndpoint.get(endpoint.id)!.map(address => address.healthState))]));
  return {
    state: summarizeHealth(input.bindings.length ? Object.values(bindingStates) : Object.values(endpointStates)),
    bindingStates,
    endpointStates,
    endpointCount: enabled.length,
    healthyEndpointCount: Object.values(endpointStates).filter(state => state === "healthy").length,
    waitingBindingCount: Object.values(bindingStates).filter(state => state === "unknown" || state === "recovering").length,
  };
}

function summarizeHealth(states: HealthState[]): HealthState {
  if (states.length === 0) return "unknown";
  if (states.every(state => state === "healthy")) return "healthy";
  if (states.some(state => state === "healthy" || state === "degraded")) return "degraded";
  if (states.some(state => state === "recovering")) return "recovering";
  if (states.some(state => state === "unknown")) return "unknown";
  return "unhealthy";
}

type Reader = Pick<MasterDnsDatabase, "select">;
export async function getPoolHealthSummaries(db: Reader, poolIds: string[]): Promise<Map<string, PoolHealthSummary>> {
  if (poolIds.length === 0) return new Map();
  const [endpointRows, addressRows, bindings, healthRows, checks, cloudLinks] = await Promise.all([
    db.select({ id: endpoints.id, poolId: endpoints.poolId, lifecycle: endpoints.lifecycle }).from(endpoints).where(inArray(endpoints.poolId, poolIds)),
    db.select({ address: endpointAddresses, poolId: endpoints.poolId }).from(endpointAddresses).innerJoin(endpoints, eq(endpoints.id, endpointAddresses.endpointId)).where(and(inArray(endpoints.poolId, poolIds), eq(endpointAddresses.state, "current"))),
    db.select({ id: domainBindings.id, poolId: domainBindings.poolId, recordType: domainBindings.recordType }).from(domainBindings).where(inArray(domainBindings.poolId, poolIds)),
    db.select({ health: bindingEndpointHealth, poolId: domainBindings.poolId }).from(bindingEndpointHealth).innerJoin(domainBindings, eq(domainBindings.id, bindingEndpointHealth.domainBindingId)).where(inArray(domainBindings.poolId, poolIds)),
    db.select({ bindingId: domainBindings.id, poolId: domainBindings.poolId }).from(healthCheckConfigs).innerJoin(domainBindings, eq(domainBindings.id, healthCheckConfigs.domainBindingId)).where(and(inArray(domainBindings.poolId, poolIds), eq(healthCheckConfigs.enabled, true))),
    db.select({ endpointId: cloudEndpointLinks.endpointId, family: cloudEndpointLinks.family }).from(cloudEndpointLinks).innerJoin(endpoints, eq(endpoints.id, cloudEndpointLinks.endpointId)).where(inArray(endpoints.poolId, poolIds)),
  ]);
  return new Map(poolIds.map(poolId => [poolId, projectPoolHealth({
    endpoints: endpointRows.filter(row => row.poolId === poolId).map(row => ({ ...row, addressFamilies: cloudLinks.filter(link => link.endpointId === row.id).map(link => link.family) })),
    addresses: addressRows.filter(row => row.poolId === poolId).map(row => row.address),
    bindings: bindings.filter(row => row.poolId === poolId),
    bindingHealth: healthRows.filter(row => row.poolId === poolId).map(row => row.health),
    overrideBindingIds: checks.filter(row => row.poolId === poolId).map(row => row.bindingId),
  })]));
}

// Callers serialize Pool mutations with its existing advisory transaction lock.
export async function refreshPoolHealth(db: Reader & Pick<MasterDnsDatabase, "update">, poolId: string) {
  const summary = (await getPoolHealthSummaries(db, [poolId])).get(poolId)!;
  await db.update(endpointPools).set({ state: summary.state, updatedAt: new Date() }).where(eq(endpointPools.id, poolId));
  return summary;
}

import { describe, expect, it } from "vitest";
import { projectPoolHealth, type PoolHealthInput } from "./pool-health.js";

const endpoint = { id: "edge", lifecycle: "enabled" };
const address = { id: "ipv4", endpointId: "edge", family: "4" as const, healthState: "healthy" as const };
const binding = { id: "a", recordType: "A" };
function input(overrides: Partial<PoolHealthInput> = {}): PoolHealthInput {
  return { endpoints: [endpoint], addresses: [address], bindings: [binding], bindingHealth: [], overrideBindingIds: [], ...overrides };
}

describe("Pool health projection", () => {
  it("keeps an unpublished address waiting instead of declaring a failed probe", () => {
    expect(projectPoolHealth(input({ addresses: [] }))).toMatchObject({ state: "unknown", waitingBindingCount: 1 });
  });

  it("uses binding overrides regardless of the order base and binding results arrive", () => {
    const snapshot = input({ overrideBindingIds: ["a"], bindingHealth: [{ domainBindingId: "a", endpointId: "edge", endpointAddressId: "ipv4", healthState: "unhealthy" }] });
    expect(projectPoolHealth(snapshot).state).toBe("unhealthy");
    expect(projectPoolHealth({ ...snapshot, addresses: [{ ...address, healthState: "unhealthy" }], bindingHealth: [{ ...snapshot.bindingHealth[0]!, healthState: "healthy" }] }).state).toBe("healthy");
  });

  it("ignores disabled overrides and evidence for a previous address", () => {
    const previous = { domainBindingId: "a", endpointId: "edge", endpointAddressId: "previous", healthState: "unhealthy" as const };
    expect(projectPoolHealth(input({ bindingHealth: [previous] })).state).toBe("healthy");
    expect(projectPoolHealth(input({ bindingHealth: [previous], overrideBindingIds: ["a"] })).state).toBe("unknown");
  });

  it("keeps IPv4 and IPv6 eligibility independent", () => {
    const summary = projectPoolHealth(input({ addresses: [address, { ...address, id: "ipv6", family: "6", healthState: "unhealthy" }], bindings: [binding, { id: "aaaa", recordType: "AAAA" }] }));
    expect(summary.bindingStates).toEqual({ a: "healthy", aaaa: "unhealthy" });
    expect(summary.state).toBe("degraded");
  });

  it("ignores disabled endpoints and missing families on other nodes", () => {
    const summary = projectPoolHealth(input({ endpoints: [endpoint, { id: "disabled", lifecycle: "disabled" }, { id: "v6-only", lifecycle: "enabled" }], addresses: [address, { ...address, endpointId: "disabled", id: "disabled-v4", healthState: "unhealthy" }, { ...address, endpointId: "v6-only", id: "v6", family: "6", healthState: "unhealthy" }] }));
    expect(summary.state).toBe("healthy");
  });

  it("does not count an unverified IPv6 cloud slot against an IPv4 binding", () => {
    expect(projectPoolHealth(input({ endpoints: [endpoint, { id: "new-ipv6", lifecycle: "enabled", addressFamilies: ["6"] }] })).state).toBe("healthy");
  });

  it("does not treat an unknown backup as a confirmed failure", () => {
    const summary = projectPoolHealth(input({ endpoints: [endpoint, { id: "new", lifecycle: "enabled" }], addresses: [{ ...address, healthState: "unhealthy" }] }));
    expect(summary.state).toBe("unknown");
  });

  it("clears a former failure immediately once current addresses become healthy", () => {
    expect(projectPoolHealth(input()).state).toBe("healthy");
  });
});

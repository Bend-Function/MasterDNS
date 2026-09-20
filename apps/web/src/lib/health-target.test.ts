import { describe, expect, it } from "vitest";
import { actualEndpointFamilies, healthPolicyDisplay, reconcileEndpointFamily } from "./health-target";
import { demoHealthPolicies, demoProbeGroups } from "./probe-demo";
import type { AddressHealthPolicy } from "./probe-types";

describe("effective cloud health", () => {
  const now = Date.parse("2026-09-21T00:00:00Z");
  const group = demoProbeGroups[0]!;
  const policy: AddressHealthPolicy = {
    ...demoHealthPolicies[0]!,
    cloudTarget: {
      account: { id: "account", name: "test", provider: "aws" },
      instance: { id: "instance", name: "edge", externalId: "i-edge", service: "ec2", region: "us-east-1" },
      slot: { id: "slot-v4", name: "primary", family: "4", currentVersion: 1, candidateVersion: 2 },
      currentAddress: { id: "address-old", address: "192.0.2.1" },
      candidateAddress: { id: "address-v4", address: "192.0.2.2" },
    },
    state: { ...demoHealthPolicies[0]!.state!, evidenceExpiresAt: new Date(now + 60000).toISOString() },
  };
  it("shows only current candidate evidence with matching revisions as healthy", () => {
    expect(healthPolicyDisplay(policy, group, now).status).toBe("healthy");
    for (const change of [{ addressId: "address-old" }, { addressVersion: 1 }, { configVersion: 9 }, { policyRevision: 9 }, { groupRevision: 9 }, { latestDecision: "unknown" as const }, { evidenceExpiresAt: new Date(now).toISOString() }]) {
      expect(healthPolicyDisplay({ ...policy, state: { ...policy.state!, ...change } }, group, now).status).toBe("unknown");
    }
  });
  it("requires consecutive success and external authority", () => {
    expect(healthPolicyDisplay({ ...policy, state: { ...policy.state!, consecutiveSuccesses: 1 } }, group, now).status).toBe("recovering");
    expect(healthPolicyDisplay({ ...policy, mode: "local" }, group, now)).toMatchObject({ status: "unknown", reason: "云地址需要外部 Agent 验证，本地结果不能用于发布" });
    expect(healthPolicyDisplay(policy, undefined, now).status).toBe("unknown");
  });
});

describe("ordinary endpoint address families", () => {
  const endpoint = { addresses: [
    { family: "4" as const, state: "previous" },
    { family: "6" as const, state: "current" },
    { family: "6" as const, state: "candidate" },
  ] };

  it("offers only families with a current actual address", () => {
    expect(actualEndpointFamilies(endpoint)).toEqual(["6"]);
  });

  it("revalidates an old family when the endpoint changes", () => {
    expect(reconcileEndpointFamily("4", endpoint)).toBe("6");
    expect(reconcileEndpointFamily("4", { addresses: [] })).toBeNull();
  });
});

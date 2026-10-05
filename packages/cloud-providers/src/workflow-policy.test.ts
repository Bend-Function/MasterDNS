import { describe, expect, it } from "vitest";
import * as policies from "./workflow-policy.js";
import type { CloudInventory } from "./provider.js";

const slot = { accountId: "account", service: "ec2" as const, region: "region", instanceId: "instance", interfaceId: "interface", slotId: "slot", address: "192.0.2.1", family: 4 as const };
const old = { address: slot.address, family: 4 as const, primary: true, allocationId: "old", privateAddress: "10.0.0.1", metadata: { awsAddressScope: "public" } };
const next = { ...old, address: "192.0.2.2", allocationId: "new" };
const live: CloudInventory = { ref: slot, name: "vm", state: "running", interfaces: [{ id: slot.interfaceId, addresses: [old, next] }] };

describe("provider workflow policies", () => {
  it("preserves Azure receipt generation and rejects recycled allocation identity", () => {
    expect(policies.azureWorkflowPolicy).toBeDefined();
    const receipt = { allocationId: "allocation", resourceId: "resource", after: { addressMetadata: { resourceGuid: "generation-1" } } };
    const metadata = policies.azureWorkflowPolicy.candidateAddressMetadata(receipt);
    expect(metadata).toMatchObject({ allocationIdentity: { allocationId: "allocation", resourceId: "resource", resourceGuid: "generation-1" } });
    const stored = { address: old.address, remoteAllocationId: "allocation", origin: "system", metadata };
    expect(policies.azureWorkflowPolicy.publicationAddressMatches(stored, { ...old, allocationId: "allocation", resourceId: "resource", metadata: { resourceGuid: "generation-2" } })).toBe(false);
    expect(policies.azureWorkflowPolicy.publicationAddressMatches({ ...stored, metadata: {} }, old)).toBe(false);
  });
  it("allows cleanup only for provider-specific attached address roles", () => {
    expect(policies.linodeWorkflowPolicy.cleanupAttachedAddressAllowed(slot, old.address, next.address, live)).toBe(true);
    expect(policies.ec2WorkflowPolicy.cleanupAttachedAddressAllowed(slot, old.address, next.address, live)).toBe(false);
    const ipv6 = { ...slot, family: 6 as const };
    const v6live = { ...live, interfaces: [{ id: slot.interfaceId, addresses: [{ ...old, family: 6 as const, primary: false }] }] };
    expect(policies.ec2WorkflowPolicy.cleanupAttachedAddressAllowed(ipv6, old.address, next.address, v6live)).toBe(true);
    expect(policies.lightsailWorkflowPolicy.cleanupAttachedAddressAllowed(ipv6, old.address, next.address, v6live)).toBe(false);
  });
  it("retains AWS private address proof and Linode unrelated IPv4 addresses during cleanup reconstruction", () => {
    const candidate = { address: next.address, allocationId: "new", resourceId: null };
    expect(policies.ec2WorkflowPolicy.reconstructCleanupCandidate(slot, [old], candidate, {})).toEqual([{ ...old, address: next.address, allocationId: "new" }]);
    expect(policies.linodeWorkflowPolicy.reconstructCleanupCandidate(slot, [old, next], candidate, {})).toHaveLength(2);
    expect(policies.azureWorkflowPolicy.reconstructCleanupCandidate(slot, [old], candidate, {})[0]?.privateAddress).toBeUndefined();
  });
  it("separates AWS primary address roles and allocation-less IPv6 release", () => {
    expect(policies.ec2WorkflowPolicy.inventoryAddressRole(old.metadata)).toBe("public");
    expect(policies.azureWorkflowPolicy.inventoryAddressRole(old.metadata)).toBeUndefined();
    expect(policies.ec2WorkflowPolicy.cleanupCanReleaseWithoutAllocation(6)).toBe(true);
    expect(policies.ec2WorkflowPolicy.cleanupCanReleaseWithoutAllocation(4)).toBe(false);
    expect(policies.linodeWorkflowPolicy.cleanupCanReleaseWithoutAllocation(6)).toBe(false);
  });
});

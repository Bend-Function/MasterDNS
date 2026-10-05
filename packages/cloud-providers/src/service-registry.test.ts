import { describe, expect, it } from "vitest";
import type { SlotRef } from "@masterdns/contracts";
import * as cloud from "./index.js";
import type { CloudInventoryAdapter } from "./provider.js";

const slot: SlotRef = { accountId: "account", service: "ec2", region: "us-east-1", instanceId: "i-one", interfaceId: "eni-one", slotId: "slot", family: 4, address: "192.0.2.1" };
const inventory: cloud.CloudInventory = { ref: slot, name: "one", state: "running", interfaces: [{ id: slot.interfaceId, deviceIndex: 0, addresses: [{ address: slot.address, family: 4, primary: true }] }] };
const readOnly: CloudInventoryAdapter = {
  verifyIdentity: async () => ({ externalAccountId: "external" }),
  listScopes: async () => [slot.region],
  discover: async () => ({ items: [inventory] }),
  inspect: async () => inventory,
};

describe("service registration capability boundaries", () => {
  it("rejects rotation without workflow before a factory or planner can run", () => {
    const invalid = {
      service: "ec2" as const,
      provider: "aws" as const,
      createAdapter: () => { throw new Error("must_not_create"); },
      rotation: {
        capabilities: () => cloud.evaluateCapabilities(slot, inventory),
        planRotation: () => { throw new Error("must_not_plan"); },
        planCleanup: () => { throw new Error("must_not_plan_cleanup"); },
      },
    };
    expect(() => {
      // @ts-expect-error A rotation registration must supply its workflow policy.
      const registry = new cloud.CloudServiceRegistry([invalid]);
      registry.createAdapter({ accountId: slot.accountId, service: "ec2", credentials: { kind: "role" } });
      registry.planRotation(slot, inventory, { allowStop: false, attemptId: "attempt" });
    }).toThrow("invalid_cloud_registration");
  });
  it("registers a genuine inventory-only implementation and refuses rotation without mutation stubs", async () => {
    expect(cloud.CloudServiceRegistry).toBeTypeOf("function");
    const registry = new cloud.CloudServiceRegistry([{ service: "ec2", provider: "aws", createAdapter: () => readOnly }]);
    const adapter = registry.createAdapter({ accountId: slot.accountId, service: "ec2", credentials: { kind: "role" } });
    expect(await adapter.discover(slot.region)).toEqual({ items: [inventory] });
    expect("execute" in adapter).toBe(false);
    expect(cloud.hasCloudRotation(adapter)).toBe(false);
    expect(() => cloud.requireCloudRotation(adapter)).toThrow(expect.objectContaining({ code: "rotation_unsupported", reason: "rotation_unavailable" }));
    expect(registry.evaluateCapabilities(slot, inventory)).toMatchObject({ available: false, reason: "service_unavailable" });
    expect(() => registry.planRotation(slot, inventory, { allowStop: false, attemptId: "attempt" })).toThrow(expect.objectContaining({ code: "rotation_unsupported", reason: "service_unavailable" }));
    expect(() => registry.planCleanup(slot, inventory, { attemptId: "attempt", releaseAuthorized: true, publishedAddress: "192.0.2.2" })).toThrow("rotation_unsupported");
  });
  it("rejects partial mutation implementations and preserves optional detailed observation", () => {
    expect(cloud.hasCloudRotation).toBeTypeOf("function");
    expect(cloud.hasCloudRotation({ ...readOnly, execute: async () => ({}) })).toBe(false);
    const adapter = { ...readOnly, capabilities: () => cloud.evaluateCapabilities(slot, inventory), execute: async () => ({}), observe: async () => "pending" as const };
    expect(cloud.requireCloudRotation(adapter)).toBe(adapter);
    expect("observeDetails" in adapter).toBe(false);
    expect(cloud.hasCloudLifecycle(readOnly)).toBe(false);
    expect(cloud.hasCloudTraffic(readOnly)).toBe(false);
    expect(cloud.hasCloudIdleIps(readOnly)).toBe(false);
  });
  it("rejects unknown registrations and cross-provider credentials before adapter creation", () => {
    expect(cloud.CloudServiceRegistry).toBeTypeOf("function");
    const registry = new cloud.CloudServiceRegistry([{ service: "ec2", provider: "aws", createAdapter: () => { throw new Error("must_not_create"); } }]);
    expect(() => registry.createAdapter({ accountId: "account", service: "ec2", credentials: { kind: "linode_token", token: "fake" } })).toThrow("invalid_credentials");
    expect(() => registry.createAdapter({ accountId: "account", service: "missing" as never, credentials: { kind: "role" } })).toThrow(expect.objectContaining({ code: "rotation_unsupported", reason: "service_unavailable" }));
    expect(() => new cloud.CloudServiceRegistry([{ service: "ec2", provider: "linode", createAdapter: () => readOnly }])).toThrow("invalid_cloud_registration");
  });
});

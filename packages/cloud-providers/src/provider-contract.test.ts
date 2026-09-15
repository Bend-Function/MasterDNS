import { describe, expect, it } from "vitest";
import { cloudProviderServices, cloudServiceProvider, validCloudRegion, type SlotRef } from "@masterdns/contracts";
import { createCloudAdapter } from "./factory.js";
import { evaluateCapabilities } from "./capabilities.js";
import { makeRotationStep, planCloudRotation, rotationArguments } from "./rotation-plan.js";
import type { CloudInventory } from "./provider.js";

describe("provider dispatch contracts", () => {
  it("preserves AWS factory identity calls and rejects cross-provider credentials", async () => {
    const adapter = createCloudAdapter({ accountId: "account", service: "ec2", credentials: { kind: "role" } }, { stsSend: async () => ({ Account: "123456789012" }) });
    expect(await adapter.verifyIdentity()).toEqual({ externalAccountId: "123456789012" });
    expect(() => createCloudAdapter({ accountId: "account", service: "ec2", credentials: { kind: "linode_token", token: "secret" } })).toThrow("invalid_credentials");
    expect(() => createCloudAdapter({ accountId: "account", provider: "azure", service: "ec2", credentials: { kind: "role" } })).toThrow("invalid_credentials");
    expect(() => createCloudAdapter({ accountId: "account", service: "linode", credentials: { kind: "linode_token", token: "secret" } })).toThrow(expect.objectContaining({ code: "rotation_unsupported", reason: "service_unavailable" }));
  });
  it("maps scopes without routing a new service through Lightsail", () => {
    expect(cloudProviderServices).toEqual({ aws: ["ec2", "lightsail"], azure: ["azure_vm"], linode: ["linode"] });
    expect(cloudServiceProvider("azure_vm")).toBe("azure");
    expect(validCloudRegion("aws", "ap-south")).toBe(false);
    expect(validCloudRegion("linode", "ap-south")).toBe(true);
    for (const service of ["azure_vm", "linode"] as const) {
      const slot: SlotRef = { accountId: "account", service, region: "region", instanceId: "instance", interfaceId: "interface", slotId: "slot", family: 4, address: "192.0.2.1" };
      const inventory: CloudInventory = { ref: slot, name: "instance", state: "running", interfaces: [{ id: "interface", addresses: [{ address: slot.address, family: 4, primary: true }] }] };
      expect(evaluateCapabilities(slot, inventory)).toMatchObject({ available: false, reason: "service_unavailable" });
      expect(() => planCloudRotation(slot, inventory, { allowStop: true, attemptId: "attempt" })).toThrow("rotation_unsupported");
      const step = makeRotationStep(service === "azure_vm" ? "azure.public-ip.allocate" : "linode.ipv4.allocate", { slot, before: inventory, phase: "rotation", attemptId: "attempt", allowStop: true, priorReceipts: [{ action: "allocate", receipt: { candidateAddress: "192.0.2.2" } }] }, 0);
      expect(rotationArguments(step).priorReceipts).toEqual([{ action: "allocate", receipt: { candidateAddress: "192.0.2.2" } }]);
    }
  });
});

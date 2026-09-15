import { describe, expect, it } from "vitest";

import { evaluateCapabilities } from "./index.js";
import type { CloudInventory } from "./index.js";

const ec2Inventory: CloudInventory = {
  ref: { accountId: "local-account", service: "ec2", region: "us-east-1", instanceId: "i-01" },
  name: "edge",
  state: "running",
  interfaces: [{ id: "eni-01", deviceIndex: 0, addresses: [{ address: "2001:db8::1", family: 6, primary: true }] }],
};

describe("capability evaluation", () => {
  it("does not allow rotation of an EC2 primary IPv6 address", () => {
    const slot = { ...ec2Inventory.ref, slotId: "ipv6-primary", interfaceId: "eni-01", address: "2001:db8::1", family: 6 as const };
    expect(evaluateCapabilities(slot, ec2Inventory)).toMatchObject({
      available: false,
      reason: "primary_ipv6_immutable",
      permission: "unverified",
    });
  });

  it("marks a technically supported EC2 IPv4 slot without claiming write permission", () => {
    const inventory: CloudInventory = {
      ...ec2Inventory,
      interfaces: [{ id: "eni-01", deviceIndex: 0, addresses: [{ address: "198.51.100.4", family: 4, primary: true }] }],
    };
    const slot = { ...inventory.ref, slotId: "ipv4-primary", interfaceId: "eni-01", address: "198.51.100.4", family: 4 as const };
    expect(evaluateCapabilities(slot, inventory)).toEqual({
      available: true,
      permission: "unverified",
      requiresStop: false,
      releasesOldAddress: false,
      canRestoreOldAddress: false,
    });
  });

  it("rejects Lightsail IPv6-only instance rotation", () => {
    const inventory: CloudInventory = {
      ref: { accountId: "local-account", service: "lightsail", region: "us-east-1", instanceId: "arn:aws:lightsail:us-east-1:123:Instance/id" },
      nativeName: "ipv6-only",
      name: "ipv6-only",
      state: "running",
      ipv6Only: true,
      interfaces: [{ id: "primary", addresses: [{ address: "2001:db8::2", family: 6, primary: true }] }],
    };
    const slot = { ...inventory.ref, slotId: "primary", interfaceId: "primary", address: "2001:db8::2", family: 6 as const };
    expect(evaluateCapabilities(slot, inventory)).toMatchObject({ available: false, reason: "lightsail_ipv6_only" });
  });

  it("rejects a slot that does not belong to the inspected inventory", () => {
    const slot = { ...ec2Inventory.ref, instanceId: "i-other", slotId: "ipv6", interfaceId: "eni-01", address: "2001:db8::1", family: 6 as const };
    expect(evaluateCapabilities(slot, ec2Inventory)).toMatchObject({ available: false, reason: "inventory_mismatch" });
  });

  it("evaluates the selected secondary IPv6 address instead of another primary address", () => {
    const inventory: CloudInventory = {
      ...ec2Inventory,
      interfaces: [{ id: "eni-01", deviceIndex: 0, addresses: [
        { address: "2001:db8::1", family: 6, primary: true },
        { address: "2001:db8::2", family: 6, primary: false },
      ] }],
    };
    const slot = { ...inventory.ref, slotId: "ipv6-secondary", interfaceId: "eni-01", address: "2001:db8::2", family: 6 as const };
    expect(evaluateCapabilities(slot, inventory)).toMatchObject({ available: true, permission: "unverified" });
  });

  it("rejects an EC2 address on a non-primary network interface", () => {
    const inventory: CloudInventory = {
      ...ec2Inventory,
      interfaces: [{ id: "eni-secondary", deviceIndex: 1, addresses: [{ address: "198.51.100.8", family: 4, primary: true }] }],
    };
    const slot = { ...inventory.ref, slotId: "secondary-eni", interfaceId: "eni-secondary", address: "198.51.100.8", family: 4 as const };
    expect(evaluateCapabilities(slot, inventory)).toMatchObject({ available: false, reason: "secondary_interface_unsupported" });
  });
});

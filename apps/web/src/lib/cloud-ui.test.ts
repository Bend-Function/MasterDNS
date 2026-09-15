import { describe, expect, it, vi } from "vitest";
import type { AddressSlot, CloudAuthorization } from "./cloud-types";
import { authorizationPayload, selectableCloudSlots, submitCloudIntent } from "./cloud-ui";
import { createIntentKey } from "./intent-key";

const slot = (overrides: Partial<AddressSlot> = {}): AddressSlot => ({
  slot: {
    id: "slot-v4",
    interfaceId: "interface-1",
    family: "4",
    name: "public-v4",
    currentAddressId: "address-1",
    currentVersion: 1,
  },
  currentAddress: { id: "address-1", address: "192.0.2.10", family: "4" },
  ref: {
    accountId: "account-1",
    service: "ec2",
    region: "ap-southeast-2",
    instanceId: "i-1",
    interfaceId: "eni-1",
    slotId: "slot-v4",
    address: "192.0.2.10",
    family: 4,
  },
  capability: {
    available: true,
    permission: "unverified",
    requiresStop: false,
    releasesOldAddress: false,
    canRestoreOldAddress: false,
  },
  inScope: true,
  ...overrides,
});

describe("cloud source selection", () => {
  it("offers only the exact address family requested by the record type", () => {
    const v6 = slot({
      slot: { id: "slot-v6", interfaceId: "interface-1", family: "6", name: "public-v6", currentAddressId: "address-2", currentVersion: 1 },
      currentAddress: { id: "address-2", address: "2001:db8::10", family: "6" },
      ref: { accountId: "account-1", service: "ec2", region: "ap-southeast-2", instanceId: "i-1", interfaceId: "eni-1", slotId: "slot-v6", address: "2001:db8::10", family: 6 },
    });

    expect(selectableCloudSlots("AAAA", [slot(), v6]).map((entry) => entry.slot.id)).toEqual(["slot-v6"]);
  });

  it("does not offer slots that are out of scope, absent, disabled, unmanaged, or technically unavailable", () => {
    const unavailable = slot({ capability: { available: false, reason: "primary_ipv6_immutable", permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false } });

    expect(selectableCloudSlots("A", [slot(), slot({ inScope: false }), unavailable], { accountEnabled: true, instancePresent: true, managed: true })).toHaveLength(1);
    expect(selectableCloudSlots("A", [slot()], { accountEnabled: false, instancePresent: true, managed: true })).toEqual([]);
    expect(selectableCloudSlots("A", [slot()], { accountEnabled: true, instancePresent: false, managed: true })).toEqual([]);
    expect(selectableCloudSlots("A", [slot()], { accountEnabled: true, instancePresent: true, managed: false })).toEqual([]);
  });
});

describe("cloud authorization", () => {
  it("sends a complete replacement including false permission flags", () => {
    const authorization: CloudAuthorization = {
      instanceId: "instance-1",
      revision: 7,
      managed: true,
      allowIpv4Rotation: true,
      allowIpv6Rotation: false,
      allowStopStart: false,
      allowReleaseAddress: false,
    };

    expect(authorizationPayload(authorization)).toEqual({
      revision: 7,
      managed: true,
      allowIpv4Rotation: true,
      allowIpv6Rotation: false,
      allowStopStart: false,
      allowReleaseAddress: false,
    });
  });
});

describe("cloud intent submission", () => {
  it("reuses the key after failure and resets it only after success", async () => {
    const keys = ["intent-1", "intent-2"];
    const intent = createIntentKey(() => keys.shift() ?? "unexpected");
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("created")
      .mockResolvedValueOnce("created again");

    await expect(submitCloudIntent(intent, request)).rejects.toThrow("temporary failure");
    await expect(submitCloudIntent(intent, request)).resolves.toBe("created");
    await expect(submitCloudIntent(intent, request)).resolves.toBe("created again");
    expect(request.mock.calls.map(([key]) => key)).toEqual(["intent-1", "intent-1", "intent-2"]);
  });
});

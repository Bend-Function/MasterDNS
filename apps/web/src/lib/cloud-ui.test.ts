import { describe, expect, it, vi } from "vitest";
import type { AddressSlot, CloudAuthorization } from "./cloud-types";
import { authorizationPayload, loadCloudScopes, loadVisibleInstanceAddresses, selectableCloudSlots, slotsMatchingExistingRecord, submitCloudIntent } from "./cloud-ui";
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

  it("does not offer slots that are out of scope, absent, disabled, or unmanaged", () => {
    expect(selectableCloudSlots("A", [slot(), slot({ inScope: false })], { accountEnabled: true, instancePresent: true, managed: true })).toHaveLength(1);
    expect(selectableCloudSlots("A", [slot()], { accountEnabled: false, instancePresent: true, managed: true })).toEqual([]);
    expect(selectableCloudSlots("A", [slot()], { accountEnabled: true, instancePresent: false, managed: true })).toEqual([]);
    expect(selectableCloudSlots("A", [slot()], { accountEnabled: true, instancePresent: true, managed: false })).toEqual([]);
  });

  it("allows an immutable primary IPv6 slot to be bound for monitoring without granting rotation", () => {
    const immutable = slot({
      slot: { id: "slot-v6", interfaceId: "interface-1", family: "6", name: "primary-v6", currentAddressId: "address-2", currentVersion: 1 },
      currentAddress: { id: "address-2", address: "2001:db8::10", family: "6" },
      capability: { available: false, reason: "primary_ipv6_immutable", permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false },
    });

    expect(selectableCloudSlots("AAAA", [immutable]).map((entry) => entry.slot.id)).toEqual(["slot-v6"]);
  });

  it("limits takeover to a slot whose canonical address matches the existing record", () => {
    const compressed = slot({
      slot: { id: "slot-v6", interfaceId: "interface-1", family: "6", name: "public-v6", currentAddressId: "address-2", currentVersion: 1 },
      currentAddress: { id: "address-2", address: "2001:db8::1", family: "6" },
    });

    expect(slotsMatchingExistingRecord("AAAA", "2001:0db8:0:0:0:0:0:1", [compressed]).map((entry) => entry.slot.id)).toEqual(["slot-v6"]);
    expect(slotsMatchingExistingRecord("AAAA", "2001:db8::2", [compressed])).toEqual([]);
  });
});

describe("cloud inventory loading", () => {
  it("preserves successful account scopes and reports failures by account", async () => {
    const result = await loadCloudScopes([{ id: "account-1" }, { id: "account-2" }], async (id) => {
      if (id === "account-2") throw new Error("scope unavailable");
      return [{ id: "scope-1" }] as never[];
    });

    expect(result.scopes).toEqual({ "account-1": [{ id: "scope-1" }] });
    expect(result.errors).toEqual({ "account-2": "scope unavailable" });
  });

  it("loads addresses only for the bounded visible rows and keeps row errors", async () => {
    const requested: string[] = [];
    const rows = Array.from({ length: 9 }, (_, index) => ({ instance: { id: `instance-${index}` } })) as never[];
    const result = await loadVisibleInstanceAddresses(rows, 3, async (id) => {
      requested.push(id);
      if (id === "instance-1") throw new Error("detail unavailable");
      return [{ id: `address-${id}` }] as never[];
    });

    expect(requested).toEqual(["instance-0", "instance-1", "instance-2"]);
    expect(result.errors).toEqual({ "instance-1": "detail unavailable" });
    expect(Object.keys(result.addresses)).toEqual(["instance-0", "instance-2"]);
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

describe("provider-aware rotation eligibility", () => {
  it("requires downtime permission for Linode rotation while preserving bindable SLAAC", async () => {
    const { cloudRotationBlock, rotationDowntimeNotice, cloudServiceLabel } = await import("./cloud-ui");
    const linode = slot({ ref: { ...slot().ref!, service: "linode" }, capability: { ...slot().capability!, requiresStop: true } });
    const auth = { instanceId: "instance-1", revision: 0, managed: true, allowIpv4Rotation: true, allowIpv6Rotation: false, allowStopStart: false, allowReleaseAddress: true };
    expect(cloudRotationBlock(linode, auth)).toMatch(/重启/);
    expect(cloudRotationBlock(linode, { ...auth, allowStopStart: true })).toBeNull();
    expect(rotationDowntimeNotice(linode, true)).toMatch(/再次重启/);
    expect(rotationDowntimeNotice(linode, false)).toMatch(/重启/);
    expect(cloudServiceLabel("azure_vm")).toMatch(/Azure/);
    expect(cloudServiceLabel("linode")).toMatch(/Linode/);
    const slaac = slot({ slot: { ...slot().slot, family: "6" }, currentAddress: { id: "v6", address: "2001:db8::1", family: "6" }, capability: { ...slot().capability!, available: false, reason: "linode_slaac_ipv6_immutable" } });
    expect(selectableCloudSlots("AAAA", [slaac])).toHaveLength(1);
    expect(cloudRotationBlock(slaac, { ...auth, allowIpv6Rotation: true })).toMatch(/SLAAC/);
  });
});

describe("cloud error presentation", () => {
  it("explains a quota API failure without conflating cleanup health with missing probes", async () => {
    const { ApiError } = await import("./api");
    const { cloudErrorMessage, capabilityReason } = await import("./cloud-ui");
    expect(cloudErrorMessage(new ApiError(502, "quota_exceeded", "quota_exceeded"), "失败")).toMatch(/配额/);
    expect(cloudErrorMessage(new ApiError(400, "validation_failed", "无效区域"), "失败")).toBe("无效区域");
    expect(capabilityReason("cleanup_health_failed")).toContain("清理重启后");
    expect(capabilityReason("probe_insufficient")).toContain("证据不足");
  });
});

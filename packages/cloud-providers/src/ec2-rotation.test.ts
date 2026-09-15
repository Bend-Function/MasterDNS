import { describe, expect, it } from "vitest";
import * as providers from "./index.js";
import type { CloudInventory } from "./provider.js";
import type { CloudStep, SlotRef } from "@masterdns/contracts";

const credentials = { kind: "access_key" as const, accessKeyId: "fake", secretAccessKey: "fake" };
const ref = { accountId: "local", service: "ec2" as const, region: "us-east-1", instanceId: "i-one" };
const slot: SlotRef = { ...ref, slotId: "v4", interfaceId: "eni-main", address: "198.51.100.1", family: 4 };
const inventory: CloudInventory = { ref, name: "one", state: "running", interfaces: [{ id: "eni-main", deviceIndex: 0, addresses: [{ address: slot.address, family: 4, primary: true }] }] };
const eni = { NetworkInterfaceId: "eni-main", Attachment: { InstanceId: "i-one", DeviceIndex: 0 }, PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: "10.0.0.1", Association: { PublicIp: slot.address } }], Ipv6Addresses: [] };
const plan = (s = slot, i = inventory, allowStop = false) => providers.planCloudRotation(s, i, { allowStop, attemptId: "attempt-1" });
const adapter = (send: (c: any) => Promise<any>) => new providers.Ec2CloudAdapter("local", credentials, { ec2Send: send });

it("prefers direct primary ENI toggling even when stopping is permitted", async () => {
  const steps = plan(slot, inventory, true);
  expect(steps.map(s => s.action)).toEqual(["ec2.auto-ipv4.disable", "ec2.auto-ipv4.enable"]);
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    writes.push(c); return {};
  });
  await cloud.execute(steps[0]!);
  expect(writes.map(c => [c.constructor.name, c.input])).toEqual([["ModifyNetworkInterfaceAttributeCommand", { NetworkInterfaceId: "eni-main", AssociatePublicIpAddress: false }]]);
});

it("rejects primary IPv6 with an explicit unsupported reason", () => {
  const s = { ...slot, family: 6 as const, address: "2001:db8::1" };
  const i = { ...inventory, interfaces: [{ id: "eni-main", deviceIndex: 0, addresses: [{ address: s.address, family: 6 as const, primary: true }] }] };
  expect(() => plan(s, i)).toThrowError(expect.objectContaining({ code: "rotation_unsupported", reason: "primary_ipv6_immutable" }));
});

it("refuses a moved primary interface before any mutation", async () => {
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, Attachment: { InstanceId: "i-other", DeviceIndex: 0 } }] };
    writes.push(c); return {};
  });
  await expect(cloud.execute(plan()[0]!)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("observes public IP changes and identifies recycled candidates", async () => {
  const cloud = adapter(async () => ({ NetworkInterfaces: [eni] }));
  const step = plan()[1]!;
  await expect(cloud.observeDetails(step)).resolves.toMatchObject({ status: "applied", candidateAddress: slot.address, candidateRepeated: true });
});

it("allocates tagged EIPs, saves the receipt and never releases the old EIP in the rotation plan", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "eipalloc-old" }] }] };
  const steps = plan(slot, i);
  expect(steps.map(s => s.action)).toEqual(["ec2.eip.allocate", "ec2.eip.associate"]);
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [] };
    writes.push(c); return { AllocationId: "eipalloc-new", PublicIp: "198.51.100.2" };
  });
  await expect(cloud.execute(steps[0]!)).resolves.toMatchObject({ remoteId: "eipalloc-new", allocationId: "eipalloc-new", candidateAddress: "198.51.100.2", before: expect.any(Object), after: expect.any(Object) });
  expect(writes[0].input.TagSpecifications[0].Tags).toEqual(expect.arrayContaining([{ Key: "masterdns:attempt", Value: "attempt-1" }, { Key: "masterdns:instance", Value: "i-one" }]));
});

it("never steals an attempt EIP attached to another instance", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = plan(slot, i)[1]!;
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "new", InstanceId: "i-other", NetworkInterfaceId: "eni-other", Tags: providers.rotationTags(step) }] };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  expect(writes).toEqual([]);
});

it("uses non-reassociating EIP association to the selected private address", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = plan(slot, i)[1]!;
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "new", PublicIp: "198.51.100.2", Tags: providers.rotationTags(step) }] };
    writes.push(c); return { AssociationId: "assoc-new" };
  });
  await cloud.execute(step);
  expect(writes[0].input).toEqual({ AllocationId: "new", NetworkInterfaceId: "eni-main", PrivateIpAddress: "10.0.0.1", AllowReassociation: false });
});

it("adds mutable IPv6 without removing the old address and treats unreceipted deltas as ambiguous", async () => {
  const s = { ...slot, address: "2001:db8::1", family: 6 as const };
  const i = { ...inventory, interfaces: [{ id: "eni-main", deviceIndex: 0, addresses: [{ address: s.address, family: 6 as const, primary: false }] }] };
  const steps = plan(s, i);
  expect(steps.map(s => s.action)).toEqual(["ec2.ipv6.assign"]);
  let addresses = [{ Ipv6Address: s.address, IsPrimaryIpv6: false }];
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, Ipv6Addresses: addresses }] };
    writes.push(c); return { AssignedIpv6Addresses: ["2001:db8::2"] };
  });
  const result = await cloud.execute(steps[0]!);
  expect(result).toMatchObject({ candidateAddress: "2001:db8::2" });
  expect(writes[0].input).toEqual({ NetworkInterfaceId: "eni-main", Ipv6AddressCount: 1 });
  addresses = [...addresses, { Ipv6Address: "2001:db8::2", IsPrimaryIpv6: false }];
  await expect(cloud.observe(steps[0]!)).resolves.toBe("ambiguous");
  const receipted: CloudStep = { ...steps[0]!, arguments: { ...steps[0]!.arguments, receipt: result } };
  await expect(cloud.observe(receipted)).resolves.toBe("applied");
});

it("does not retry a rejected write or fall back to stopping", async () => {
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    writes.push(c.constructor.name);
    throw Object.assign(new Error("secret"), { name: "RequestLimitExceeded" });
  });
  await expect(cloud.execute(plan(slot, inventory, true)[0]!)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  expect(writes).toEqual(["ModifyNetworkInterfaceAttributeCommand"]);
});

it("supports an EIP on a secondary ENI but refuses an automatic IPv4 there", () => {
  const s = { ...slot, interfaceId: "eni-secondary" };
  const i = { ...inventory, interfaces: [{ id: "eni-secondary", deviceIndex: 1, addresses: [{ address: s.address, family: 4 as const, primary: false, allocationId: "eipalloc-old", privateAddress: "10.0.0.2" }] }] };
  expect(plan(s, i).map(s => s.action)).toEqual(["ec2.eip.allocate", "ec2.eip.associate"]);
  expect(() => plan(s, { ...i, interfaces: [{ ...i.interfaces[0]!, addresses: [{ address: s.address, family: 4, primary: false }] }] })).toThrow();
});

it("rejects private IPv4 during planning", () => {
  const s = { ...slot, address: "10.0.0.1" };
  const i = { ...inventory, interfaces: [{ id: "eni-main", deviceIndex: 0, addresses: [{ address: s.address, family: 4 as const, primary: true }] }] };
  expect(() => plan(s, i)).toThrowError(expect.objectContaining({ code: "rotation_unsupported", reason: "private_ipv4_unsupported" }));
});

it("will not repeat an uncertain allocation on recovery", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = plan(slot, i)[0]!;
  step.arguments.previousExecution = true;
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [] };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  expect(writes).toEqual([]);
});

it("treats duplicate tagged resources as ambiguous instead of choosing one", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = plan(slot, i)[0]!;
  const cloud = adapter(async c => c.constructor.name === "DescribeNetworkInterfacesCommand" ? { NetworkInterfaces: [eni] } : { Addresses: [{ AllocationId: "one", Tags: providers.rotationTags(step) }, { AllocationId: "two", Tags: providers.rotationTags(step) }] });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
});

it("does not accept the candidate EIP attached to the wrong private IP on the selected ENI", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = plan(slot, i)[1]!;
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, PrivateIpAddresses: [...eni.PrivateIpAddresses, { Primary: false, PrivateIpAddress: "10.0.0.2", Association: { PublicIp: "198.51.100.2" } }] }] };
    return { Addresses: [{ AllocationId: "new", PublicIp: "198.51.100.2", PrivateIpAddress: "10.0.0.2", NetworkInterfaceId: "eni-main", Tags: providers.rotationTags(step) }] };
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
});

it("only creates destructive cleanup after explicit publication authorization", async () => {
  const s = { ...slot, family: 6 as const, address: "2001:db8::1" };
  const i = { ...inventory, interfaces: [{ id: "eni-main", deviceIndex: 0, addresses: [{ address: s.address, family: 6 as const, primary: false }] }] };
  const options = { attemptId: "attempt-1", releaseAuthorized: true, publishedAddress: "2001:db8::2" };
  expect(() => providers.planCloudRotationCleanup(s, i, { ...options, releaseAuthorized: false })).toThrowError(expect.objectContaining({ code: "cleanup_not_authorized" }));
  const step = providers.planCloudRotationCleanup(s, i, options)[0]!;
  expect(step).toMatchObject({ action: "ec2.ipv6.unassign", destructive: true });
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, Ipv6Addresses: [{ Ipv6Address: s.address, IsPrimaryIpv6: false }, { Ipv6Address: "2001:db8::2", IsPrimaryIpv6: false }] }] };
    writes.push(c); return {};
  });
  await cloud.execute(step);
  expect(writes.map(c => [c.constructor.name, c.input])).toEqual([["UnassignIpv6AddressesCommand", { NetworkInterfaceId: "eni-main", Ipv6Addresses: ["2001:db8::1"] }]]);
});

it("releases only a detached, verified managed EIP from its original owning attempt", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "eipalloc-old" }] }] };
  const step = providers.planCloudRotationCleanup(slot, i, { attemptId: "attempt-1", releaseAuthorized: true, publishedAddress: "198.51.100.2", ownershipAttemptId: "old-attempt" })[0]!;
  const oldOwnerStep = { ...step, arguments: { ...step.arguments, attemptId: "old-attempt" } };
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: "10.0.0.1", Association: { PublicIp: "198.51.100.2" } }] }] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "eipalloc-old", PublicIp: slot.address, Tags: providers.rotationTags(oldOwnerStep) }] };
    writes.push(c); return {};
  });
  await cloud.execute(step);
  expect(writes.map(c => [c.constructor.name, c.input])).toEqual([["ReleaseAddressCommand", { AllocationId: "eipalloc-old" }]]);
});

it("refuses cleanup if the supposed published replacement is no longer assigned", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = { ...plan(slot, i)[0]!, action: "ec2.eip.release" };
  step.arguments = { ...step.arguments, phase: "post_publish_cleanup", releaseAuthorized: true, publishedAddress: "198.51.100.2", ownershipAttemptId: "attempt-1" };
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "old", PublicIp: slot.address, Tags: providers.rotationTags(step) }] };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("refuses auto IPv4 enable until disabling is remotely visible", async () => {
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [eni] };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(plan()[1]!)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("records a successful EIP association as pending until the target private IP shows it", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = plan(slot, i)[1]!;
  let attached = false;
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: "10.0.0.1", Association: { PublicIp: attached ? "198.51.100.2" : slot.address } }] }] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "new", PublicIp: "198.51.100.2", Tags: providers.rotationTags(step), ...(attached ? { NetworkInterfaceId: "eni-main", PrivateIpAddress: "10.0.0.1" } : {}) }] };
    return { AssociationId: "assoc-new" };
  });
  step.arguments.receipt = await cloud.execute(step);
  await expect(cloud.observe(step)).resolves.toBe("pending");
  attached = true;
  await expect(cloud.observeDetails(step)).resolves.toMatchObject({ status: "applied", candidateAddress: "198.51.100.2" });
});

it("never applies automatic IPv4 toggling to device zero on a secondary network card", async () => {
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, Attachment: { ...eni.Attachment, NetworkCardIndex: 1 } }] };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(plan()[0]!)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("allows explicitly authorized imported EIP cleanup only with matching trusted ownership evidence", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "eipalloc-imported" }] }] };
  const ownershipSnapshot = { accountId: "local", instanceId: "i-one", interfaceId: "eni-main", allocationId: "eipalloc-imported", address: slot.address };
  const step = providers.planCloudRotationCleanup(slot, i, { attemptId: "attempt-1", releaseAuthorized: true, publishedAddress: "198.51.100.2", ownershipSnapshot })[0]!;
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: "10.0.0.1", Association: { PublicIp: "198.51.100.2" } }] }] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "eipalloc-imported", PublicIp: slot.address }] };
    writes.push(c); return {};
  });
  await cloud.execute(step);
  expect(writes[0].input).toEqual({ AllocationId: "eipalloc-imported" });
  step.arguments.ownershipSnapshot = { ...ownershipSnapshot, instanceId: "i-other" };
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  expect(writes).toHaveLength(1);
});

it("requires the published EIP replacement on the exact selected private address before cleanup", async () => {
  const i = { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old" }] }] };
  const step = providers.planCloudRotationCleanup(slot, i, { attemptId: "attempt-1", releaseAuthorized: true, publishedAddress: "198.51.100.2", ownershipAttemptId: "attempt-1" })[0]!;
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ ...eni, PrivateIpAddresses: [...eni.PrivateIpAddresses, { Primary: false, PrivateIpAddress: "10.0.0.2", Association: { PublicIp: "198.51.100.2" } }] }] };
    if (c.constructor.name === "DescribeAddressesCommand") return { Addresses: [{ AllocationId: "old", PublicIp: slot.address, Tags: providers.rotationTags(step) }] };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

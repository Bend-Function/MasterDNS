import { expect, it } from "vitest";
import * as providers from "./index.js";
import type { CloudInventory } from "./provider.js";
import type { CloudStep, SlotRef } from "@masterdns/contracts";

const ref = { accountId: "local", service: "lightsail" as const, region: "us-east-1", instanceId: "arn:aws:lightsail:us-east-1:123:Instance/stable" };
const slot: SlotRef = { ...ref, slotId: "v4", interfaceId: "primary", address: "198.51.100.1", family: 4 };
const inventory: CloudInventory = { ref, nativeName: "one", name: "one", state: "running", ipv6Only: false, interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4, primary: true, allocationId: "old-static", resourceId: "arn:static:old" }] }] };
const instance = { arn: ref.instanceId, name: "one", isStaticIp: true, state: { name: "running" }, ipAddressType: "dualstack", publicIpAddress: slot.address, ipv6Addresses: ["2001:db8::1"] };
const plan = (s = slot, i = inventory): CloudStep[] => providers.planCloudRotation(s, i, { allowStop: false, attemptId: "attempt-1" }).map(step => ({
  ...step,
  arguments: { ...step.arguments, ...(step.action.endsWith("detach") || step.action.endsWith("attach") ? {
    candidateReceipt: { allocationId: "masterdns-attempt-1", resourceId: "arn:static:candidate", candidateAddress: "198.51.100.2" },
  } : {}) },
}));
const adapter = (send: (c: any) => Promise<any>) => new providers.LightsailCloudAdapter("local", { kind: "access_key", accessKeyId: "fake", secretAccessKey: "fake" }, { lightsailSend: send });

it("plans static allocation, detach, attach with no implicit release", () => {
  expect(plan().map(s => s.action)).toEqual(["lightsail.static-ip.allocate", "lightsail.static-ip.detach", "lightsail.static-ip.attach"]);
});

it("cycles dualstack IPv6 through ipv4 without any bundle update", async () => {
  const s = { ...slot, family: 6 as const, address: "2001:db8::1" };
  const i = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: s.address, family: 6 as const, primary: true }] }] };
  const steps = plan(s, i);
  expect(steps.map(s => s.action)).toEqual(["lightsail.ipv6.disable", "lightsail.ipv6.enable"]);
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    writes.push(c); return { operations: [{ id: "op-1", status: "Started" }] };
  });
  await expect(cloud.execute(steps[0]!)).resolves.toMatchObject({ operationId: "op-1" });
  expect(writes.map(c => c.input)).toEqual([{ resourceName: "one", resourceType: "Instance", ipAddressType: "ipv4" }]);
});

it("requires both operation completion and the remote attachment", async () => {
  const step = plan()[2]!;
  step.arguments.receipt = { operationId: "op-1" };
  let status = "Started";
  let attachedTo: string | undefined;
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, publicIpAddress: "198.51.100.2" } };
    if (c.constructor.name === "GetOperationCommand") return { operation: { id: "op-1", status, resourceName: "one" } };
    return { staticIp: { name: providers.rotationResourceName(step), arn: "arn:static:candidate", ipAddress: "198.51.100.2", attachedTo } };
  });
  await expect(cloud.observe(step)).resolves.toBe("pending");
  status = "Succeeded";
  await expect(cloud.observe(step)).resolves.toBe("pending");
  attachedTo = "one";
  await expect(cloud.observeDetails(step)).resolves.toMatchObject({ status: "applied", candidateAddress: "198.51.100.2", candidateRepeated: false });
});

it("rejects a recreated Lightsail instance before a write", async () => {
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, arn: "different" } };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(plan()[0]!)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("refuses to detach an original static IP now attached elsewhere", async () => {
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: c.input.staticIpName, attachedTo: "other", ipAddress: slot.address } };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(plan()[1]!)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  expect(writes).toEqual([]);
});

it("allocates a deterministic static name and persists every asynchronous operation ID", async () => {
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    if (c.constructor.name === "GetStaticIpCommand") {
      if (c.input.staticIpName === "old-static") return { staticIp: { name: "old-static", arn: "arn:static:old", ipAddress: slot.address, attachedTo: "one" } };
      throw Object.assign(new Error("missing"), { name: "NotFoundException" });
    }
    writes.push(c); return { operations: [{ id: "op-1", status: "Started" }, { id: "op-2", status: "Started" }] };
  });
  await expect(cloud.execute(plan()[0]!)).resolves.toMatchObject({ allocationId: "masterdns-attempt-1", operationId: "op-1", operationIds: ["op-1", "op-2"] });
  expect(writes.map(c => [c.constructor.name, c.input])).toEqual([["AllocateStaticIpCommand", { staticIpName: "masterdns-attempt-1" }]]);
});

it("waits for every operation and surfaces failed operations without secret details", async () => {
  const step = plan()[2]!;
  step.arguments.receipt = { operationIds: ["op-1", "op-2"] };
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    return { operation: { id: c.input.operationId, resourceName: "one", status: c.input.operationId === "op-1" ? "Succeeded" : "Failed", errorCode: "AccessDeniedException", errorDetails: "SECRET" } };
  });
  const error = await cloud.observe(step).catch(e => e);
  expect(error).toMatchObject({ code: "permission_denied", retryable: false });
  expect(JSON.stringify(error)).not.toContain("SECRET");
});

it("does not attach a replacement over a third-party static IP", async () => {
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, publicIpAddress: "198.51.100.77", isStaticIp: true } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: c.input.staticIpName, arn: c.input.staticIpName === "old-static" ? "arn:static:old" : "arn:static:candidate", ipAddress: c.input.staticIpName === "old-static" ? slot.address : "198.51.100.2" } };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(plan()[2]!)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("enables IPv6 only after IPv4-only state is verified", async () => {
  const s = { ...slot, family: 6 as const, address: "2001:db8::1" };
  const i = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: s.address, family: 6 as const, primary: true }] }] };
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, ipAddressType: "unknown" } };
    writes.push(c); return {};
  });
  await expect(cloud.execute(plan(s, i)[1]!)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("detaches the old static IP then attaches only the free attempt allocation", async () => {
  let detached = false;
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: !detached } };
    if (c.constructor.name === "GetStaticIpCommand") {
      return { staticIp: c.input.staticIpName === "old-static"
        ? { name: "old-static", arn: "arn:static:old", ipAddress: slot.address, ...(detached ? {} : { attachedTo: "one" }) }
        : { name: "masterdns-attempt-1", arn: "arn:static:candidate", ipAddress: "198.51.100.2" } };
    }
    writes.push(c);
    if (c.constructor.name === "DetachStaticIpCommand") detached = true;
    return { operations: [{ id: "op-1", status: "Started" }] };
  });
  await cloud.execute(plan()[1]!);
  await cloud.execute(plan()[2]!);
  expect(writes.map(c => [c.constructor.name, c.input])).toEqual([
    ["DetachStaticIpCommand", { staticIpName: "old-static" }],
    ["AttachStaticIpCommand", { instanceName: "one", staticIpName: "masterdns-attempt-1" }],
  ]);
});

it("releases a known managed static IP only after its replacement is published", async () => {
  const i = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "masterdns-old-attempt", resourceId: "arn:static:old" }] }] };
  const step = providers.planCloudRotationCleanup(slot, i, { attemptId: "attempt-1", ownershipAttemptId: "old-attempt", releaseAuthorized: true, publishedAddress: "198.51.100.2" })[0]!;
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, publicIpAddress: "198.51.100.2" } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: "masterdns-old-attempt", arn: "arn:static:old", ipAddress: slot.address } };
    writes.push(c); return { operations: [{ id: "release-1", status: "Started" }] };
  });
  await expect(cloud.execute(step)).resolves.toMatchObject({ operationId: "release-1" });
  expect(writes.map(c => [c.constructor.name, c.input])).toEqual([["ReleaseStaticIpCommand", { staticIpName: "masterdns-old-attempt" }]]);
  step.arguments.releaseAuthorized = false;
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "cleanup_not_authorized" });
  expect(writes).toHaveLength(1);
});

it("does not infer completed asynchronous execution when the receipt has no operation ID", async () => {
  const step = plan()[0]!;
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    if (c.constructor.name === "GetStaticIpCommand") {
      if (c.input.staticIpName === "old-static") return { staticIp: { name: "old-static", arn: "arn:static:old", ipAddress: slot.address, attachedTo: "one" } };
      throw Object.assign(new Error("missing"), { name: "NotFoundException" });
    }
    return { operations: [] };
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
});

it("does not replace an unknown Lightsail address type during planning", () => {
  const s = { ...slot, family: 6 as const, address: "2001:db8::1" };
  const { ipv6Only: _, ...unknownMode } = inventory;
  const i = { ...unknownMode, interfaces: [{ id: "primary", addresses: [{ address: s.address, family: 6 as const, primary: true }] }] };
  expect(() => plan(s, i)).toThrowError(expect.objectContaining({ code: "rotation_unsupported", reason: "lightsail_address_type_unknown" }));
});

it("allows trusted imported static IP cleanup but rejects a recreated resource with the same name", async () => {
  const i = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "old-static", resourceId: "arn:static:original" }] }] };
  const ownershipSnapshot = { accountId: "local", instanceId: ref.instanceId, interfaceId: "primary", allocationId: "old-static", address: slot.address, resourceId: "arn:static:original" };
  const step = providers.planCloudRotationCleanup(slot, i, { attemptId: "attempt-1", releaseAuthorized: true, publishedAddress: "198.51.100.2", ownershipSnapshot })[0]!;
  let arn = "arn:static:original";
  const writes: any[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, publicIpAddress: "198.51.100.2" } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: "old-static", ipAddress: slot.address, arn } };
    writes.push(c); return { operations: [{ id: "release", status: "Started" }] };
  });
  await cloud.execute(step);
  expect(writes[0].input).toEqual({ staticIpName: "old-static" });
  arn = "arn:static:recreated";
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  expect(writes).toHaveLength(1);
});

it("never lets a managed static name override a conflicting original ARN", async () => {
  const i = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4 as const, primary: true, allocationId: "masterdns-old-attempt", resourceId: "arn:static:original" }] }] };
  const step = providers.planCloudRotationCleanup(slot, i, { attemptId: "attempt-1", ownershipAttemptId: "old-attempt", releaseAuthorized: true, publishedAddress: "198.51.100.2" })[0]!;
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, publicIpAddress: "198.51.100.2" } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: "masterdns-old-attempt", arn: "arn:static:recreated", ipAddress: slot.address } };
    writes.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  expect(writes).toEqual([]);
});

it.each(["detach", "attach"])("rejects a recreated candidate during %s and its observation", async action => {
  const step = plan()[action === "detach" ? 1 : 2]!;
  step.arguments.candidateReceipt = { allocationId: "masterdns-attempt-1", resourceId: "arn:static:candidate", candidateAddress: "198.51.100.2" };
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: false } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: c.input.staticIpName === "old-static"
      ? { name: "old-static", arn: "arn:static:old", ipAddress: slot.address, attachedTo: "one" }
      : { name: "masterdns-attempt-1", arn: "arn:static:recreated", ipAddress: "198.51.100.2" } };
    writes.push(c.constructor.name); return { operations: [{ id: "op-1", status: "Started" }] };
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  expect(writes).toEqual([]);
});

it("rejects a recreated original static allocation before detaching it", async () => {
  const i = { ...inventory, interfaces: [{ id: "primary", addresses: [{ ...inventory.interfaces[0]!.addresses[0]!, resourceId: "arn:static:old" }] }] };
  const step = plan(slot, i)[1]!;
  step.arguments.candidateReceipt = { allocationId: "masterdns-attempt-1", resourceId: "arn:static:candidate", candidateAddress: "198.51.100.2" };
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: c.input.staticIpName === "old-static"
      ? { name: "old-static", arn: "arn:static:recreated", ipAddress: slot.address, attachedTo: "one" }
      : { name: "masterdns-attempt-1", arn: "arn:static:candidate", ipAddress: "198.51.100.2" } };
    writes.push(c.constructor.name); return { operations: [{ id: "op-1", status: "Started" }] };
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  expect(writes).toEqual([]);
});

it("persists the first observed allocation ARN and rejects a different ARN on recovery", async () => {
  const step = plan()[0]!;
  step.arguments.receipt = { allocationId: "masterdns-attempt-1", operationId: "op-allocate" };
  let arn = "arn:static:candidate";
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance };
    if (c.constructor.name === "GetOperationCommand") return { operation: { id: "op-allocate", resourceName: "masterdns-attempt-1", status: "Succeeded" } };
    return { staticIp: { name: "masterdns-attempt-1", arn, ipAddress: "198.51.100.2" } };
  });
  const observed = await cloud.observeDetails(step);
  expect(observed).toMatchObject({ status: "applied", resourceId: "arn:static:candidate" });
  step.arguments.receipt = observed;
  arn = "arn:static:recreated";
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
});

it("converts an explicitly managed dynamic IPv4 slot with allocate and attach only", async () => {
  const dynamic: CloudInventory = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4, primary: true }] }] };
  const cloudCalls: string[] = [];
  let allocated = false;
  let attached = false;
  const cloud = adapter(async c => {
    cloudCalls.push(c.constructor.name);
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: attached, publicIpAddress: attached ? "198.51.100.2" : slot.address } };
    if (c.constructor.name === "GetStaticIpCommand") {
      if (!allocated) throw Object.assign(new Error("missing"), { name: "NotFoundException" });
      return { staticIp: { name: "masterdns-attempt-1", arn: "arn:static:candidate", ipAddress: "198.51.100.2", ...(attached ? { attachedTo: "one" } : {}) } };
    }
    if (c.constructor.name === "GetOperationCommand") return { operation: { id: c.input.operationId, status: "Succeeded", resourceName: c.input.operationId === "allocate" ? "masterdns-attempt-1" : "one" } };
    if (c.constructor.name === "AllocateStaticIpCommand") { allocated = true; return { operations: [{ id: "allocate", status: "Started" }] }; }
    if (c.constructor.name === "AttachStaticIpCommand") { attached = true; return { operations: [{ id: "attach", status: "Started" }] }; }
    throw new Error(`Unexpected command ${c.constructor.name}`);
  });
  expect(cloud.capabilities(slot, dynamic)).toMatchObject({ available: true, releasesOldAddress: true, canRestoreOldAddress: false, requiresStop: false });
  const steps = providers.planCloudRotation(slot, dynamic, { allowStop: true, attemptId: "attempt-1" });
  expect(steps.map(s => s.action)).toEqual(["lightsail.static-ip.allocate", "lightsail.static-ip.attach"]);
  steps[0]!.arguments.receipt = await cloud.execute(steps[0]!);
  const allocation = await cloud.observeDetails(steps[0]!);
  expect(allocation).toMatchObject({ status: "applied", resourceId: "arn:static:candidate", allocationId: "masterdns-attempt-1" });
  steps[0]!.arguments.receipt = allocation;
  steps[1]!.arguments.candidateReceipt = allocation;
  steps[1]!.arguments.receipt = await cloud.execute(steps[1]!);
  await expect(cloud.observeDetails(steps[1]!)).resolves.toMatchObject({ status: "applied", resourceId: "arn:static:candidate", candidateAddress: "198.51.100.2" });
  expect(cloudCalls.filter(name => !name.startsWith("Get"))).toEqual(["AllocateStaticIpCommand", "AttachStaticIpCommand"]);
});

it("refuses dynamic conversion when a different public address is now assigned", async () => {
  const dynamic: CloudInventory = { ...inventory, interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4, primary: true }] }] };
  const steps = providers.planCloudRotation(slot, dynamic, { allowStop: false, attemptId: "attempt-1" });
  const step = steps[1]!;
  step.arguments.candidateReceipt = { allocationId: "masterdns-attempt-1", resourceId: "arn:static:candidate", candidateAddress: "198.51.100.2" };
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: false, publicIpAddress: "198.51.100.77" } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: "masterdns-attempt-1", arn: "arn:static:candidate", ipAddress: "198.51.100.2" } };
    writes.push(c.constructor.name); return { operations: [{ id: "unexpected", status: "Started" }] };
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "remote_identity_changed" });
  expect(writes).toEqual([]);
});

it("refuses to attach a same-name candidate without a persisted allocation identity", async () => {
  const step = providers.planCloudRotation(slot, inventory, { allowStop: false, attemptId: "attempt-1" })[2]!;
  const writes: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: false } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: "masterdns-attempt-1", arn: "arn:static:candidate", ipAddress: "198.51.100.2" } };
    writes.push(c.constructor.name); return { operations: [{ id: "unexpected", status: "Started" }] };
  });
  await expect(cloud.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  await expect(cloud.observe(step)).resolves.toBe("ambiguous");
  expect(writes).toEqual([]);
});

it.each([
  { label: "detached", attachedTo: undefined, arn: "arn:static:old", ipAddress: slot.address, currentIp: slot.address },
  { label: "moved", attachedTo: "other", arn: "arn:static:old", ipAddress: slot.address, currentIp: slot.address },
  { label: "recreated", attachedTo: "one", arn: "arn:static:other", ipAddress: slot.address, currentIp: slot.address },
  { label: "address changed", attachedTo: "one", arn: "arn:static:old", ipAddress: "198.51.100.77", currentIp: slot.address },
  { label: "instance address changed", attachedTo: "one", arn: "arn:static:old", ipAddress: slot.address, currentIp: "198.51.100.77" },
])("refuses a fresh Lightsail allocation when the original is $label", async ({ attachedTo, arn, ipAddress, currentIp }) => {
  const allocations: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: true, publicIpAddress: currentIp } };
    if (c.constructor.name === "GetStaticIpCommand") {
      if (c.input.staticIpName !== "old-static") throw Object.assign(new Error("absent"), { name: "NotFoundException" });
      return { staticIp: { name: "old-static", arn, ipAddress, attachedTo } };
    }
    allocations.push(c.constructor.name); return { operations: [{ id: "unexpected", status: "Started" }] };
  });
  await expect(cloud.execute(plan()[0]!)).rejects.toBeInstanceOf(providers.CloudError);
  expect(allocations).toEqual([]);
});

it("recovers the receipted Lightsail allocation after original detachment without allocating again", async () => {
  const step = plan()[0]!;
  step.arguments.receipt = { allocationId: "masterdns-attempt-1", resourceId: "arn:static:candidate", candidateAddress: "198.51.100.2" };
  const allocations: string[] = [];
  const cloud = adapter(async c => {
    if (c.constructor.name === "GetInstanceCommand") return { instance: { ...instance, isStaticIp: false, publicIpAddress: "198.51.100.77" } };
    if (c.constructor.name === "GetStaticIpCommand") return { staticIp: { name: "masterdns-attempt-1", arn: "arn:static:candidate", ipAddress: "198.51.100.2" } };
    allocations.push(c.constructor.name); return {};
  });
  await expect(cloud.execute(step)).resolves.toMatchObject({ resourceId: "arn:static:candidate" });
  expect(allocations).toEqual([]);
});

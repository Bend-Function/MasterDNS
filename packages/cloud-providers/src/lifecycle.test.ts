import { describe, expect, it } from "vitest";
import type { CloudLifecycleSnapshot, CloudRef } from "@masterdns/contracts";

import { AzureCloudAdapter } from "./azure.js";
import { Ec2CloudAdapter } from "./ec2.js";
import { LightsailCloudAdapter } from "./lightsail.js";
import { LinodeCloudAdapter } from "./linode.js";

const awsCredentials = { kind: "access_key" as const, accessKeyId: "key", secretAccessKey: "secret" };

describe("EC2 lifecycle", () => {
  const ref: CloudRef = { accountId: "account", service: "ec2", region: "us-east-1", instanceId: "i-0123456789abcdef0" };

  it("normalizes state and issues one graceful provider write for each lifecycle action", async () => {
    let state = "stopped";
    const calls: any[] = [];
    const adapter = new Ec2CloudAdapter("account", awsCredentials, { ec2Send: async command => {
      calls.push(command);
      if (command.constructor.name === "DescribeInstancesCommand") return { Reservations: [{ Instances: [{ InstanceId: ref.instanceId, State: { Name: state }, Tags: [{ Key: "Name", Value: "web" }] }] }] };
      state = command.constructor.name === "StartInstancesCommand" ? "pending"
        : command.constructor.name === "StopInstancesCommand" ? "stopping" : "shutting-down";
      return {};
    } });

    const snapshot = await adapter.inspectLifecycle(ref);
    expect(snapshot).toEqual({ ref, identity: ref.instanceId, state: "stopped", nativeName: "web" });
    await adapter.mutateLifecycle("start", snapshot);
    state = "running";
    await adapter.mutateLifecycle("stop", { ...snapshot, state: "running" });
    state = "stopped";
    await adapter.mutateLifecycle("delete", snapshot);

    expect(calls.filter(command => command.constructor.name !== "DescribeInstancesCommand").map(command => [command.constructor.name, command.input])).toEqual([
      ["StartInstancesCommand", { InstanceIds: [ref.instanceId] }],
      ["StopInstancesCommand", { InstanceIds: [ref.instanceId], Force: false, Hibernate: false, SkipOsShutdown: false }],
      ["TerminateInstancesCommand", { InstanceIds: [ref.instanceId], Force: false, SkipOsShutdown: false }],
    ]);
  });

  it("completes an already desired action without a duplicate write and blocks identity or account changes", async () => {
    const writes: string[] = [];
    const adapter = new Ec2CloudAdapter("account", awsCredentials, { ec2Send: async command => {
      if (command.constructor.name !== "DescribeInstancesCommand") writes.push(command.constructor.name);
      return { Reservations: [{ Instances: [{ InstanceId: ref.instanceId, State: { Name: "running" } }] }] };
    } });
    const snapshot = await adapter.inspectLifecycle(ref);
    await expect(adapter.mutateLifecycle("start", snapshot)).resolves.toEqual({ completed: true });
    await expect(adapter.mutateLifecycle("stop", { ...snapshot, identity: "i-11111111111111111" })).rejects.toMatchObject({ code: "remote_identity_changed" });
    await expect(adapter.mutateLifecycle("delete", { ...snapshot, ref: { ...ref, accountId: "other" } })).rejects.toMatchObject({ code: "remote_identity_changed" });
    expect(writes).toEqual([]);
  });

  it("rejects an invalid runtime action instead of falling through to delete", async () => {
    const writes: string[] = [];
    const adapter = new Ec2CloudAdapter("account", awsCredentials, { ec2Send: async command => {
      if (command.constructor.name !== "DescribeInstancesCommand") writes.push(command.constructor.name);
      return { Reservations: [{ Instances: [{ InstanceId: ref.instanceId, State: { Name: "running" } }] }] };
    } });
    const snapshot = await adapter.inspectLifecycle(ref);
    await expect(adapter.mutateLifecycle("restart" as never, snapshot)).rejects.toMatchObject({ code: "cloud_operation_failed" });
    expect(writes).toEqual([]);
  });

  it("treats a provider 404 as deleted only for a valid exact reference", async () => {
    const missing = Object.assign(new Error("missing"), { name: "InvalidInstanceID.NotFound" });
    const adapter = new Ec2CloudAdapter("account", awsCredentials, { ec2Send: async () => { throw missing; } });
    await expect(adapter.inspectLifecycle(ref)).resolves.toMatchObject({ identity: ref.instanceId, state: "deleted" });
    await expect(adapter.inspectLifecycle({ ...ref, instanceId: "not-an-instance" })).rejects.toMatchObject({ code: "remote_identity_changed" });
  });
});

describe("Lightsail lifecycle", () => {
  const arn = "arn:aws:lightsail:us-east-1:123456789012:Instance/11111111-2222-3333-4444-555555555555";
  const ref: CloudRef = { accountId: "account", service: "lightsail", region: "us-east-1", instanceId: arn };

  it("resolves the ARN to a name, rechecks the exact ARN, and returns operation receipts", async () => {
    let state = "stopped";
    const calls: any[] = [];
    const adapter = new LightsailCloudAdapter("account", awsCredentials, { lightsailSend: async command => {
      calls.push(command);
      if (command.constructor.name === "GetInstancesCommand") return { instances: [{ arn, name: "web" }] };
      if (command.constructor.name === "GetInstanceCommand") return { instance: { arn, name: "web", state: { name: state } } };
      return { operations: [{ id: `op-${calls.length}`, isTerminal: false }] };
    } });

    const snapshot = await adapter.inspectLifecycle(ref);
    expect(snapshot).toEqual({ ref, identity: arn, state: "stopped", nativeName: "web" });
    await expect(adapter.mutateLifecycle("start", snapshot)).resolves.toEqual({ operationIds: ["op-4"] });
    state = "running";
    await adapter.mutateLifecycle("stop", { ...snapshot, state: "running" });
    state = "stopped";
    await adapter.mutateLifecycle("delete", snapshot);

    expect(calls.filter(command => ["StartInstanceCommand", "StopInstanceCommand", "DeleteInstanceCommand"].includes(command.constructor.name)).map(command => [command.constructor.name, command.input])).toEqual([
      ["StartInstanceCommand", { instanceName: "web" }],
      ["StopInstanceCommand", { instanceName: "web", force: false }],
      ["DeleteInstanceCommand", { instanceName: "web", forceDeleteAddOns: false }],
    ]);
  });

  it("refuses a reused name with a different ARN before any write", async () => {
    const writes: string[] = [];
    const adapter = new LightsailCloudAdapter("account", awsCredentials, { lightsailSend: async command => {
      if (command.constructor.name === "GetInstanceCommand") return { instance: { arn: arn.replace("11111111", "aaaaaaaa"), name: "web", state: { name: "running" } } };
      writes.push(command.constructor.name);
      return {};
    } });
    const snapshot: CloudLifecycleSnapshot = { ref, identity: arn, state: "running", nativeName: "web" };
    await expect(adapter.mutateLifecycle("delete", snapshot)).rejects.toMatchObject({ code: "remote_identity_changed" });
    expect(writes).toEqual([]);
  });

  it("observes an exact-name 404 as deleted but rejects a malformed ARN before reading", async () => {
    const missing = Object.assign(new Error("missing"), { name: "NotFoundException" });
    const adapter = new LightsailCloudAdapter("account", awsCredentials, { lightsailSend: async command => {
      if (command.constructor.name === "GetInstancesCommand") return { instances: [{ arn, name: "web" }] };
      throw missing;
    } });
    await expect(adapter.inspectLifecycle(ref)).resolves.toMatchObject({ identity: arn, state: "deleted", nativeName: "web" });
    await expect(adapter.inspectLifecycle({ ...ref, instanceId: "web" })).rejects.toMatchObject({ code: "remote_identity_changed" });
  });
});

type AzureFake = { state: string; identity: string; exists: boolean; calls: Array<{ method: string; path: string }> };
const azureVmId = "/subscriptions/subscription-1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/web";
function azureAdapter(fake: AzureFake) {
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token", expires_in: 3600 });
    const method = init.method ?? "GET";
    fake.calls.push({ method, path: `${url.pathname}${url.search}` });
    if (method !== "GET") return new Response("{}", { status: 202, headers: { Location: `${url.origin}/subscriptions/subscription-1/providers/Microsoft.Compute/locations/eastus/operations/op-1?api-version=2025-04-01` } });
    if (!fake.exists) return new Response("{}", { status: 404 });
    if (url.pathname.endsWith("/instanceView")) return Response.json({ statuses: [{ code: `PowerState/${fake.state}` }] });
    return Response.json({ id: azureVmId, name: "web", location: "eastus", properties: { vmId: fake.identity, provisioningState: "Succeeded" } });
  };
  return new AzureCloudAdapter("account", { kind: "azure_service_principal", tenantId: "tenant-1", subscriptionId: "subscription-1", clientId: "client-1", clientSecret: "secret" }, { fetch: fetcher });
}

describe("Azure VM lifecycle", () => {
  const ref: CloudRef = { accountId: "account", service: "azure_vm", region: "eastus", instanceId: azureVmId };

  it("distinguishes allocated stop from deallocated stop and uses deallocate plus non-force delete", async () => {
    const fake: AzureFake = { state: "stopped", identity: "vm-guid-1", exists: true, calls: [] };
    const adapter = azureAdapter(fake);
    const snapshot = await adapter.inspectLifecycle(ref);
    expect(snapshot).toEqual({ ref, identity: "vm-guid-1", state: "stopped_allocated", nativeName: "web" });

    await expect(adapter.mutateLifecycle("stop", snapshot)).resolves.toEqual({ operationId: expect.stringContaining("/operations/op-1?") });
    fake.state = "deallocated";
    await expect(adapter.mutateLifecycle("stop", snapshot)).resolves.toEqual({ completed: true });
    fake.state = "deallocated";
    await adapter.mutateLifecycle("start", snapshot);
    fake.state = "running";
    await adapter.mutateLifecycle("delete", snapshot);

    expect(fake.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path])).toEqual([
      ["POST", `${azureVmId}/deallocate?api-version=2025-04-01&hibernate=false`],
      ["POST", `${azureVmId}/start?api-version=2025-04-01`],
      ["DELETE", `${azureVmId}?api-version=2025-04-01&forceDeletion=false`],
    ]);
  });

  it("requires vmId and blocks a recreated VM or cross-account snapshot before writing", async () => {
    const fake: AzureFake = { state: "running", identity: "vm-guid-2", exists: true, calls: [] };
    const adapter = azureAdapter(fake);
    const snapshot: CloudLifecycleSnapshot = { ref, identity: "vm-guid-1", state: "running", nativeName: "web" };
    await expect(adapter.mutateLifecycle("delete", snapshot)).rejects.toMatchObject({ code: "remote_identity_changed" });
    await expect(adapter.mutateLifecycle("stop", { ...snapshot, ref: { ...ref, accountId: "other" } })).rejects.toMatchObject({ code: "remote_identity_changed" });
    fake.identity = "";
    await expect(adapter.inspectLifecycle(ref)).rejects.toMatchObject({ code: "remote_identity_changed" });
    expect(fake.calls.filter(call => call.method !== "GET")).toEqual([]);
  });

  it("returns deleted on an exact valid ARM 404 but not on an invalid resource ID", async () => {
    const fake: AzureFake = { state: "running", identity: "vm-guid-1", exists: false, calls: [] };
    const adapter = azureAdapter(fake);
    await expect(adapter.inspectLifecycle(ref)).resolves.toMatchObject({ identity: azureVmId, state: "deleted" });
    await expect(adapter.inspectLifecycle({ ...ref, instanceId: "/not/a/vm" })).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
  });
});

type LinodeFake = { state: string; created: string; exists: boolean; id: number; calls: Array<{ method: string; path: string; body?: unknown }> };
function linodeAdapter(fake: LinodeFake) {
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    fake.calls.push({ method, path: url.pathname.replace("/v4", ""), ...(body === undefined ? {} : { body }) });
    const headers = { "X-Customer-UUID": "customer-uuid", "X-OAuth-Scopes": "linodes:read_write" };
    if (!fake.exists && method === "GET") return new Response("{}", { status: 404, headers });
    if (method === "GET") return Response.json({ id: fake.id, label: "web", region: "us-east", status: fake.state, created: fake.created }, { headers });
    return new Response("{}", { status: 200, headers });
  };
  return new LinodeCloudAdapter("account", { kind: "linode_token", token: "secret" }, { fetch: fetcher });
}

describe("Linode lifecycle", () => {
  const ref: CloudRef = { accountId: "account", service: "linode", region: "us-east", instanceId: "42" };

  it("uses id, region, and creation time as stable identity and emits exact writes", async () => {
    const fake: LinodeFake = { state: "offline", created: "2025-01-02T03:04:05", exists: true, id: 42, calls: [] };
    const adapter = linodeAdapter(fake);
    const snapshot = await adapter.inspectLifecycle(ref);
    expect(snapshot).toEqual({ ref, identity: "42:us-east:2025-01-02T03:04:05", state: "stopped", nativeName: "web" });
    await adapter.mutateLifecycle("start", snapshot);
    fake.state = "running";
    await adapter.mutateLifecycle("stop", snapshot);
    fake.state = "offline";
    await adapter.mutateLifecycle("delete", snapshot);
    expect(fake.calls.filter(call => call.method !== "GET")).toEqual([
      { method: "POST", path: "/linode/instances/42/boot", body: {} },
      { method: "POST", path: "/linode/instances/42/shutdown", body: {} },
      { method: "DELETE", path: "/linode/instances/42" },
    ]);
  });

  it("blocks creation-time reuse, cross-account mutation, and duplicate writes", async () => {
    const fake: LinodeFake = { state: "running", created: "2025-01-03T03:04:05", exists: true, id: 42, calls: [] };
    const adapter = linodeAdapter(fake);
    const snapshot: CloudLifecycleSnapshot = { ref, identity: "42:us-east:2025-01-02T03:04:05", state: "running", nativeName: "web" };
    await expect(adapter.mutateLifecycle("delete", snapshot)).rejects.toMatchObject({ code: "remote_identity_changed" });
    fake.created = "2025-01-02T03:04:05";
    await expect(adapter.mutateLifecycle("start", snapshot)).resolves.toEqual({ completed: true });
    await expect(adapter.mutateLifecycle("stop", { ...snapshot, ref: { ...ref, accountId: "other" } })).rejects.toMatchObject({ code: "remote_identity_changed" });
    expect(fake.calls.filter(call => call.method !== "GET")).toEqual([]);
  });

  it("observes exact valid 404 as deleted and rejects malformed references without reading", async () => {
    const fake: LinodeFake = { state: "offline", created: "2025-01-02T03:04:05", exists: false, id: 42, calls: [] };
    const adapter = linodeAdapter(fake);
    await expect(adapter.inspectLifecycle(ref)).resolves.toMatchObject({ identity: "42", state: "deleted" });
    const before = fake.calls.length;
    await expect(adapter.inspectLifecycle({ ...ref, instanceId: "42x" })).rejects.toMatchObject({ code: "remote_identity_changed" });
    expect(fake.calls).toHaveLength(before);
  });
});

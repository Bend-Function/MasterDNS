import { describe, expect, it } from "vitest";
import type { CloudStep, SlotRef } from "@masterdns/contracts";
import { LinodeCloudAdapter } from "./linode.js";
import { planLinodeCleanup, planLinodeRotation } from "./linode-rotation.js";

const old = "203.0.113.10", next = "203.0.113.20";
const slot: SlotRef = { accountId: "account", service: "linode", region: "us-east", instanceId: "42", interfaceId: "public", slotId: "slot", address: old, family: 4 };
function fake() {
  const state = { uuid: "customer-uuid", profileUsername: "not-account-id", scopes: "linodes:read_write ips:read_only events:read_only", ips: [old], helper: true,
    generation: "legacy_config", configs: 1, configId: 7, runLevel: "default", interfaces: [] as unknown[], shared: [] as unknown[], ranges: [] as unknown[], status: "running",
    events: [{ id: 10, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }], allocation: "ok", eventActor: "not-account-id", ipOwner: 42, reserved: false, rebootOutcome: "ok", releaseOutcome: "ok", denied: 0, writes: [] as Array<{ path: string; body: unknown }>, requests: [] as string[], pages: 1 };
  const ip = (address: string) => ({ address, type: "ipv4", public: true, linode_id: state.ipOwner, region: "us-east", reserved: state.reserved });
  const instance = (id = 42) => ({ id, label: "web", region: "us-east", status: state.status, interface_generation: state.generation });
  const config = (id = state.configId) => ({ id, helpers: { network: state.helper }, interfaces: state.interfaces, run_level: state.runLevel });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.linode.com");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(init?.redirect).toBe("manual");
    const path = url.pathname.replace("/v4", ""); state.requests.push(`${init?.method ?? "GET"} ${path}`);
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-Customer-UUID": state.uuid, "X-OAuth-Scopes": state.scopes } });
    const paged = (data: unknown[]) => respond({ data, page: Number(url.searchParams.get("page") ?? 1), pages: 1, results: data.length });
    if (init?.method && init.method !== "GET") {
      state.writes.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
      if (state.denied) return respond({ errors: [{ reason: state.denied === 400 ? "Additional IPv4 addresses require technical justification" : "Denied" }] }, state.denied);
      if (path.endsWith("/ips") && init.method === "POST") {
        if (state.allocation !== "nochange") state.ips.push(next);
        if (state.allocation === "two") state.ips.push("203.0.113.30");
        if (["timeout", "nochange", "two"].includes(state.allocation)) throw new Error("socket secret-token");
        if (state.allocation === "malformed") return respond({});
        if (state.allocation === "server") return respond({}, 503);
        return respond(ip(next));
      }
      if (path.endsWith("/reboot")) {
        if (state.rebootOutcome === "timeout") { state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }); throw new Error("lost reboot response"); }
        return respond({});
      }
      state.ips = state.ips.filter(address => !path.endsWith(address)); if (state.releaseOutcome === "timeout") throw new Error("lost delete response"); return respond({});
    }
    if (path === "/profile") return respond({ username: state.profileUsername });
    if (path === "/regions") return paged([{ id: "us-east" }]);
    if (path === "/linode/instances") { const page = Number(url.searchParams.get("page") ?? 1); return respond({ data: page === 1 && state.pages > 1 ? [] : [instance()], page, pages: state.pages, results: 1 }); }
    if (path === "/linode/instances/42") return respond(instance());
    if (path.endsWith("/configs")) return paged(Array.from({ length: state.configs }, (_, i) => config(state.configId + i)));
    if (path === "/linode/instances/42/ips") return respond({ ipv4: { public: state.ips.map(ip), private: [], shared: state.shared, reserved: [] }, ipv6: { slaac: { address: "2600:3c00::abcd", type: "ipv6", public: true, linode_id: 42, region: "us-east" }, link_local: { address: "fe80::1" }, global: state.ranges } });
    if (path === "/account/events") return paged(state.events.map(event => ({ username: state.eventActor, ...event })));
    if (path.startsWith("/networking/ips/")) return state.ips.includes(path.split("/").at(-1)!) ? respond(ip(path.split("/").at(-1)!)) : respond({}, 404);
    throw new Error(`Unexpected request ${path}`);
  };
  return { state, adapter: new LinodeCloudAdapter("account", { kind: "linode_token", token: "secret-token" }, { fetch: fetcher }), reconnect: () => new LinodeCloudAdapter("account", { kind: "linode_token", token: "secret-token" }, { fetch: fetcher }) };
}
function withArgs(step: CloudStep, args: Record<string, unknown>): CloudStep { return { ...step, arguments: { ...step.arguments, ...args } }; }
async function setup() { const f = fake(); const inventory = await f.adapter.inspect(slot); return { ...f, inventory, steps: planLinodeRotation(slot, inventory, { attemptId: "attempt", allowStop: true }) }; }

describe("Linode identity and inventory", () => {
  it("uses authenticated customer identity and lists geographic scopes separately", async () => { const { adapter } = fake(); expect(await adapter.verifyIdentity()).toEqual({ externalAccountId: "customer-uuid" }); expect(await adapter.listScopes()).toEqual(["us-east"]); });
  it("rejects missing or changed account identity", async () => { const { adapter, state } = fake(); await adapter.verifyIdentity(); state.uuid = "other"; await expect(adapter.inspect(slot)).rejects.toMatchObject({ code: "remote_identity_changed" }); const f = fake(); f.state.uuid = ""; await expect(f.adapter.verifyIdentity()).rejects.toMatchObject({ code: "remote_identity_changed" }); });
  it("preserves empty pages and validates cursor region context", async () => { const { adapter, state } = fake(); state.pages = 2; const first = await adapter.discover("us-east"); expect(first.items).toEqual([]); expect(first.cursor).toBeTruthy(); const last = await adapter.discover("us-east", first.cursor); expect(last.items).toHaveLength(1); expect(last.cursor).toBeUndefined(); await expect(adapter.discover("us-west", first.cursor)).rejects.toMatchObject({ code: "invalid_cursor" }); });
  it("discovers immutable IPv6 and distinguishes new interfaces", async () => { const { adapter, state } = fake(); state.generation = "linode"; const inventory = await adapter.inspect(slot); expect(inventory.metadata?.interfaceGeneration).toBe("linode"); expect(inventory.interfaces[0]?.addresses.map(a => a.address)).toEqual([old, "2600:3c00::abcd"]); expect(adapter.capabilities({ ...slot, interfaceId: inventory.interfaces[0]!.id, family: 6, address: "2600:3c00::abcd" }, inventory)).toMatchObject({ available: false, reason: "linode_slaac_ipv6_immutable" }); expect(adapter.capabilities({ ...slot, interfaceId: inventory.interfaces[0]!.id }, inventory)).toMatchObject({ available: false, reason: "linode_new_interfaces_unsupported" }); });
});

describe("Linode conditional rotation", () => {
  it("requires explicit reboot permission before allocation", async () => { const { adapter, state, inventory } = await setup(); expect(adapter.capabilities(slot, inventory)).toMatchObject({ available: true, requiresStop: true }); expect(() => planLinodeRotation(slot, inventory, { attemptId: "attempt", allowStop: false })).toThrow(); expect(state.writes).toEqual([]); });
  it.each(["helper", "configs", "runLevel", "interfaces", "shared", "ranges"])("rejects unsafe %s configuration", async key => { const f = fake(); Object.assign(f.state, { [key]: ({ helper: false, configs: 2, runLevel: "single", interfaces: [{ purpose: "vpc" }], shared: [{ address: old }], ranges: [{ prefix: "2600::/64" }] } as Record<string, unknown>)[key] }); const inventory = await f.adapter.inspect(slot); expect(f.adapter.capabilities(slot, inventory).available).toBe(false); });
  it("keeps reserved IPv4 lifecycle unsupported", async () => { const f = fake(); f.state.reserved = true; const inventory = await f.adapter.inspect(slot); expect(f.adapter.capabilities(slot, inventory)).toMatchObject({ available: false, reason: "linode_reserved_ipv4_lifecycle_unsupported" }); });
  it("requires a saved dispatch actor before planning", async () => { const f = fake(); const inventory = await f.adapter.inspect(slot); delete inventory.metadata!.authenticatedUsername; expect(f.adapter.capabilities(slot, inventory)).toMatchObject({ available: false, reason: "linode_event_observation_required" }); });
  it("requires complete token write/event scopes but accepts wildcard", async () => { const f = fake(); f.state.scopes = "linodes:read_only"; expect(f.adapter.capabilities(slot, await f.adapter.inspect(slot)).available).toBe(false); f.state.scopes = "*"; expect(f.adapter.capabilities(slot, await f.adapter.inspect(slot)).available).toBe(true); });
  it("allocates exactly once, waits for reboot event, then exposes the known candidate", async () => { const { adapter, state, steps } = await setup(); expect(steps.map(s => s.action)).toEqual(["linode.ipv4.allocate", "linode.instance.reboot"]); const allocation = await adapter.execute(steps[0]!); expect(allocation.candidateAddress).toBe(next); expect(state.writes[0]).toEqual({ path: "/linode/instances/42/ips", body: { type: "ipv4", public: true } }); expect(await adapter.observeDetails(withArgs(steps[0]!, { receipt: allocation }))).toMatchObject({ status: "applied", candidateAddress: next }); const rebootStep = withArgs(steps[1]!, { candidateReceipt: allocation }); const reboot = await adapter.execute(rebootStep); expect(state.writes[1]).toEqual({ path: "/linode/instances/42/reboot", body: { config_id: 7 } }); expect(await adapter.observeDetails(withArgs(rebootStep, { receipt: reboot }))).toMatchObject({ status: "pending" }); state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }); expect(await adapter.observeDetails(withArgs(rebootStep, { receipt: reboot }))).toMatchObject({ status: "applied", candidateAddress: next, operationId: "11" }); expect(state.ips).toContain(old); });
  it("returns normalized candidate address metadata in the applied terminal receipt", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!);
    const reboot = withArgs(steps[1]!, { candidateReceipt: allocation }); const receipt = await adapter.execute(reboot);
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" });
    const result = await adapter.observeDetails(withArgs(reboot, { receipt }));
    const inventory = await adapter.inspect(slot); const candidate = inventory.interfaces[0]!.addresses.find(ip => ip.address === next)!;
    expect(result).toMatchObject({ status: "applied", candidateAddress: candidate.address, allocationId: candidate.allocationId, resourceId: candidate.resourceId,
      after: { addressMetadata: candidate.metadata, attemptId: "attempt", externalAccountId: "customer-uuid", instanceId: "42", region: "us-east", configId: 7, rebootRequested: true, eventStatus: "finished" } });
    expect(result.after?.addressMetadata).toEqual(candidate.metadata);
    expect(result.after?.privateAddress).toBe(candidate.privateAddress);
  });
  it.each(["timeout", "nochange", "two", "malformed", "server"])("keeps %s allocation ambiguous without repeating or inferring ownership", async mode => { const { adapter, state, steps } = await setup(); state.allocation = mode; await expect(adapter.execute(steps[0]!)).rejects.toBeDefined(); expect(await adapter.observeDetails(withArgs(steps[0]!, { previousExecution: true }))).toMatchObject({ status: "ambiguous" }); await expect(adapter.execute(withArgs(steps[0]!, { previousExecution: true }))).rejects.toMatchObject({ code: "resource_ownership_ambiguous" }); expect(state.writes).toHaveLength(1); });
  it("observes the original event watermark after lost reboot response", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!); state.rebootOutcome = "timeout";
    const reboot = withArgs(steps[1]!, { candidateReceipt: allocation }); await expect(adapter.execute(reboot)).rejects.toMatchObject({ code: "temporary_cloud_error", retryable: false });
    expect(await adapter.observeDetails(withArgs(reboot, { previousExecution: true }))).toMatchObject({ status: "applied", operationId: "11" });
    await adapter.execute(withArgs(reboot, { previousExecution: true })); expect(state.writes).toHaveLength(2);
  });
  it("rejects multiple matching events and failed events", async () => { const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!); const step = withArgs(steps[1]!, { candidateReceipt: allocation }); state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "failed" }); await expect(adapter.observeDetails(step)).rejects.toMatchObject({ code: "cloud_operation_failed" }); state.events.push({ ...state.events[1]!, id: 12 }); expect(await adapter.observeDetails(step)).toMatchObject({ status: "ambiguous" }); });
  it("ignores a reboot for another Linode", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!);
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 43 }, status: "finished" });
    expect(await adapter.observeDetails(withArgs(steps[1]!, { candidateReceipt: allocation }))).toMatchObject({ status: "pending" });
  });
  it("keeps started events pending and rejects a changed persisted event ID", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!);
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "started" });
    const reboot = withArgs(steps[1]!, { candidateReceipt: allocation }); const receipt = await adapter.observeDetails(reboot);
    expect(receipt).toMatchObject({ status: "pending", operationId: "11" }); state.events[1] = { ...state.events[1]!, id: 12, status: "finished" };
    expect(await adapter.observeDetails(withArgs(reboot, { receipt }))).toMatchObject({ status: "ambiguous" });
  });
  it("preserves the original watermark across pending observations", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!);
    state.events.push({ id: 15, action: "linode_snapshot", entity: { type: "linode", id: 42 }, status: "finished" });
    const result = await adapter.observeDetails(withArgs(steps[1]!, { candidateReceipt: allocation, previousExecution: true }));
    expect(result).toMatchObject({ status: "pending", before: { eventWatermark: 10 } });
  });
  it("observes the original actor after same-account read-only credential rotation", async () => {
    const { adapter, state, steps, reconnect } = await setup(); const allocation = await adapter.execute(steps[0]!);
    const reboot = withArgs(steps[1]!, { candidateReceipt: allocation }); const receipt = await adapter.execute(reboot);
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" });
    state.profileUsername = "new-reader"; state.scopes = "linodes:read_only ips:read_only events:read_only"; const reader = reconnect();
    expect(await reader.observeDetails(withArgs(reboot, { receipt, previousExecution: true }))).toMatchObject({ status: "applied", operationId: "11", candidateAddress: next });
    await expect(reader.execute(reboot)).rejects.toMatchObject({ code: "remote_identity_changed" }); expect(state.writes).toHaveLength(2);
  });
  it("rejects an unknown reboot actor", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!);
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }); state.eventActor = "other-user";
    expect(await adapter.observeDetails(withArgs(steps[1]!, { candidateReceipt: allocation, previousExecution: true }))).toMatchObject({ status: "ambiguous" });
  });
  it("refuses receipt identity mismatch and newly reused assignment", async () => {
    const { adapter, state, steps } = await setup(); const receipt = await adapter.execute(steps[0]!);
    expect(await adapter.observeDetails(withArgs(steps[0]!, { receipt: { ...receipt, after: { ...receipt.after, attemptId: "other" } } }))).toMatchObject({ status: "ambiguous" });
    state.ipOwner = 43;
    await expect(adapter.observeDetails(withArgs(steps[0]!, { receipt }))).rejects.toMatchObject({ code: "remote_identity_changed" });
  });
  it("rejects a changed configuration ID before reboot", async () => {
    const { adapter, state, steps } = await setup(); const allocation = await adapter.execute(steps[0]!); state.configId = 8;
    await expect(adapter.execute(withArgs(steps[1]!, { candidateReceipt: allocation }))).rejects.toMatchObject({ code: "remote_identity_changed" }); expect(state.writes).toHaveLength(1);
  });
  it("revalidates helper before writes", async () => { const { adapter, state, steps } = await setup(); state.helper = false; await expect(adapter.execute(steps[0]!)).rejects.toMatchObject({ code: "rotation_unsupported" }); expect(state.writes).toHaveLength(0); });
  it.each([[400, "quota_exceeded"], [403, "permission_denied"]])("normalizes explicit %s failure", async (status, code) => { const { adapter, state, steps } = await setup(); state.denied = Number(status); await expect(adapter.execute(steps[0]!)).rejects.toMatchObject({ code, retryable: false }); });
});

describe("Linode cleanup", () => {
  async function cleanupSetup() { const f = await setup(); const allocation = await f.adapter.execute(f.steps[0]!); const original = f.inventory.interfaces[0]!.addresses[0]!; const options = { attemptId: "attempt", allowStop: true, releaseAuthorized: true, publishedAddress: next, ownershipSnapshot: { accountId: slot.accountId, instanceId: slot.instanceId, interfaceId: slot.interfaceId, allocationId: original.allocationId!, resourceId: original.resourceId!, address: old } }; return { ...f, allocation, options }; }
  it("plans independent release and reboot actions and requires reboot permission", async () => { const { inventory, options } = await cleanupSetup(); expect(planLinodeCleanup(slot, inventory, options).map(s => s.action)).toEqual(["linode.ipv4.release", "linode.instance.reboot"]); expect(() => planLinodeCleanup(slot, inventory, { ...options, allowStop: false })).toThrow(); });
  it("releases only old IP and completes only after a separate cleanup reboot", async () => { const { adapter, state, inventory, options, allocation } = await cleanupSetup(); const steps = planLinodeCleanup(slot, inventory, options); state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }); const release = await adapter.execute(withArgs(steps[0]!, { candidateReceipt: allocation })); expect(state.ips).toEqual([next]); const reboot = withArgs(steps[1]!, { candidateReceipt: allocation, priorReceipts: [{ action: "linode.ipv4.release", receipt: release }] }); await adapter.execute(reboot); expect(await adapter.observeDetails(reboot)).toMatchObject({ status: "pending" }); state.events.push({ id: 12, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }); expect(await adapter.observeDetails(reboot)).toMatchObject({ status: "applied", candidateAddress: next, operationId: "12" }); });
  it("keeps the original cleanup identity on reboot receipts", async () => {
    const { adapter, state, inventory, options, allocation } = await cleanupSetup(); const steps = planLinodeCleanup(slot, inventory, options);
    const releaseStep = withArgs(steps[0]!, { candidateReceipt: allocation }); const released = await adapter.execute(releaseStep);
    const release = await adapter.observeDetails(withArgs(releaseStep, { receipt: released }));
    const reboot = withArgs(steps[1]!, { candidateReceipt: allocation, priorReceipts: [{ action: "linode.ipv4.release", receipt: release }] });
    const receipt = await adapter.execute(reboot);
    expect(receipt).toMatchObject({ allocationId: release.allocationId, resourceId: release.resourceId, remoteId: old });
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" });
    expect(await adapter.observeDetails(withArgs(reboot, { receipt }))).toMatchObject({ status: "applied", allocationId: release.allocationId, resourceId: release.resourceId, remoteId: old, candidateAddress: next, operationId: "11" });
  });
  it("persists a fresh cleanup watermark when the release response was lost", async () => {
    const { adapter, state, inventory, options, allocation } = await cleanupSetup(); const steps = planLinodeCleanup(slot, inventory, options);
    state.events.push({ id: 11, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished" }); state.releaseOutcome = "timeout";
    await expect(adapter.execute(withArgs(steps[0]!, { candidateReceipt: allocation }))).rejects.toMatchObject({ code: "temporary_cloud_error", retryable: false });
    const release = await adapter.observeDetails(withArgs(steps[0]!, { candidateReceipt: allocation, previousExecution: true }));
    expect(release).toMatchObject({ status: "applied", before: { eventWatermark: 11 } });
    const reboot = withArgs(steps[1]!, { candidateReceipt: allocation, priorReceipts: [{ action: "linode.ipv4.release", receipt: release }] });
    expect(await adapter.observeDetails(reboot)).toMatchObject({ status: "pending" });
    expect(state.writes).toHaveLength(2);
  });
  it("refuses cleanup reboot without the applied release receipt", async () => {
    const { adapter, state, inventory, options, allocation } = await cleanupSetup(); const steps = planLinodeCleanup(slot, inventory, options); state.ips = [next];
    await expect(adapter.execute(withArgs(steps[1]!, { candidateReceipt: allocation }))).rejects.toMatchObject({ code: "resource_ownership_ambiguous" }); expect(state.writes).toHaveLength(1);
  });
  it.each(["unauthorized", "current", "snapshot", "last", "candidate"])("refuses unsafe cleanup: %s", async mode => { const f = await cleanupSetup(); const steps = planLinodeCleanup(slot, f.inventory, f.options); const args: Record<string, unknown> = { candidateReceipt: f.allocation }; if (mode === "unauthorized") args.releaseAuthorized = false; if (mode === "current") args.publishedAddress = old; if (mode === "snapshot") args.ownershipSnapshot = { ...f.options.ownershipSnapshot, instanceId: "other" }; if (mode === "last") f.state.ips = [old]; if (mode === "candidate") args.candidateReceipt = { ...f.allocation, candidateAddress: "203.0.113.99" }; await expect(f.adapter.execute(withArgs(steps[0]!, args))).rejects.toBeDefined(); expect(f.state.writes).toHaveLength(1); });
});

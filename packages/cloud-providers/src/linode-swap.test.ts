import { describe, expect, it } from "vitest";
import type { CloudStep, SlotRef } from "@masterdns/contracts";
import { LinodeCloudAdapter } from "./linode.js";
import { planCloudRotation, planCloudRotationCleanup } from "./rotation-plan.js";
import type { CloudStepResult } from "./provider.js";

const old = "203.0.113.10", next = "203.0.113.20";
const slot: SlotRef = { accountId: "account", service: "linode", region: "us-east", instanceId: "42", interfaceId: "public", slotId: "slot", address: old, family: 4 };
const options = { attemptId: "swap-attempt", allowStop: true, allowTemporaryInstance: true, linodeIpv4Strategy: "instance_swap" as const, linodeSwapPlan: "g6-nanode-1" };
const withArgs = (step: CloudStep, args: Record<string, unknown>): CloudStep => ({ ...step, arguments: { ...step.arguments, ...args } });
type Instance = { id: number; label: string; region: string; status: string; created: string; type: string; tags: string[]; interface_generation: string; ipv4: string[]; backups?: { enabled: boolean; available: boolean; last_successful: string | null } };
type Event = { id: number; action: string; entity: { id: number; type: string }; status: string; username: string };
function fake() {
  const state = {
    uuid: "customer-uuid", username: "operator", scopes: "linodes:read_write ips:read_write events:read_only volumes:read_only",
    target: { id: 42, label: "production", region: "us-east", status: "running", created: "2025-01-01T00:00:00", type: "g6-standard-2", tags: [], interface_generation: "legacy_config", ipv4: [old] } as Instance,
    donor: undefined as Instance | undefined,
    donorDisks: [] as unknown[], donorConfigs: [] as unknown[], donorVolumes: [] as unknown[], shared: [] as unknown[], reserved: false,
    donorBackups: { automatic: [] as unknown[], snapshot: { current: null as unknown, in_progress: null as unknown } }, backupsOutcome: "ok",
    configId: 7, networkHelper: true, ipReady: true, outcome: "ok", deleted: false, events: [] as Event[], vpc: [] as unknown[], interfaceId: null as number | null, nat: null as unknown,
    writes: [] as Array<{ path: string; method: string; body: Record<string, unknown> }>, reads: [] as string[],
  };
  const ip = (address: string, instance: Instance) => ({ address, type: "ipv4", public: true, region: instance.region, linode_id: instance.id, reserved: state.reserved, interface_id: state.interfaceId, vpc_nat_1_1: state.nat });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v4", ""), method = init?.method ?? "GET";
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "X-Customer-UUID": state.uuid, "X-OAuth-Scopes": state.scopes } });
    const paged = (data: unknown[]) => response({ data, page: 1, pages: 1, results: data.length });
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      state.writes.push({ path, method, body });
      if (path === "/linode/instances" && method === "POST") {
        state.donor = { id: 99, label: String(body.label), region: String(body.region), status: "offline", created: "2026-10-04T00:00:00", type: String(body.type), tags: body.tags as string[], interface_generation: String(body.interface_generation), ipv4: state.ipReady ? [next] : [] };
        if (state.outcome === "create-timeout") throw new Error("lost create response");
        return response(state.donor);
      }
      if (path === "/networking/ips/assign" && method === "POST") {
        if (state.outcome !== "swap-nochange") {
          state.target.ipv4 = [next];
          if (state.outcome !== "swap-partial") state.donor!.ipv4 = [old];
        }
        if (state.outcome === "swap-timeout" || state.outcome === "swap-nochange") throw new Error("lost assignment response");
        return response({});
      }
      if (path === "/linode/instances/99" && method === "DELETE") {
        if (state.outcome !== "delete-nochange") state.deleted = true;
        if (state.outcome.startsWith("delete-")) throw new Error("lost delete response");
        return response({});
      }
      const command = path.split("/").at(-1)!;
      if (["reboot", "shutdown", "boot"].includes(command) && path.startsWith("/linode/instances/42/")) {
        state.target.status = command === "shutdown" ? "offline" : "running";
        state.events.push({ id: 10 + state.events.length, action: `linode_${command}`, entity: { type: "linode", id: 42 }, status: "finished", username: state.username });
        if (state.outcome === "power-timeout") throw new Error("lost power response");
        return response({});
      }
      throw new Error(`Unexpected write ${method} ${path}`);
    }
    state.reads.push(path);
    if (path === "/profile") return response({ username: state.username });
    if (path === "/account/events") return paged(state.events);
    if (path.startsWith("/networking/ips/")) {
      const address = path.split("/").at(-1)!;
      const owner = [state.target, ...(!state.deleted && state.donor ? [state.donor] : [])].find(instance => instance.ipv4.includes(address));
      return owner ? response(ip(address, owner)) : response({}, 404);
    }
    const id = Number(path.split("/")[3]);
    const instance = id === 42 ? state.target : id === 99 && !state.deleted ? state.donor : undefined;
    if (!instance) return response({}, 404);
    if (path === `/linode/instances/${id}`) return response(instance);
    if (path.endsWith("/ips")) return response({ ipv4: { public: instance.ipv4.map(address => ip(address, instance)), private: [], shared: state.shared, reserved: [], vpc: id === 99 ? state.vpc : [] }, ipv6: { global: [] } });
    if (path.endsWith("/configs")) return paged(id === 42 ? [{ id: state.configId, helpers: { network: state.networkHelper }, run_level: "default", interfaces: [] }] : state.donorConfigs);
    if (path.endsWith("/disks")) return paged(id === 42 ? [{ id: 5 }] : state.donorDisks);
    if (path.endsWith("/volumes")) return paged(id === 42 ? [{ id: 6 }] : state.donorVolumes);
    if (path.endsWith("/backups")) return state.backupsOutcome === "denied" ? response({}, 403) : response(state.backupsOutcome === "malformed" ? {} : state.donorBackups);
    throw new Error(`Unexpected read ${path}`);
  };
  return { state, adapter: new LinodeCloudAdapter("account", { kind: "linode_token", token: "offline-test" }, { fetch: fetcher }) };
}
async function setup(mode: "reboot" | "stop_start" = "reboot") {
  const f = fake(), inventory = await f.adapter.inspect(slot);
  const steps = planCloudRotation(slot, inventory, { ...options, linodeRestartMode: mode });
  return { ...f, inventory, steps };
}
async function allocated(mode: "reboot" | "stop_start" = "reboot") {
  const f = await setup(mode);
  const created = await f.adapter.execute(f.steps[0]!);
  const allocation = await f.adapter.observeDetails(withArgs(f.steps[0]!, { receipt: created }));
  const swapStep = withArgs(f.steps[1]!, { candidateReceipt: allocation, priorReceipts: [{ action: "linode.swap.allocate", receipt: allocation }] });
  return { ...f, allocation, swapStep };
}
async function swapped(mode: "reboot" | "stop_start" = "reboot") {
  const f = await allocated(mode);
  const receipt = await f.adapter.execute(f.swapStep);
  const swap = await f.adapter.observeDetails(withArgs(f.swapStep, { receipt }));
  return { ...f, swap };
}
function cleanup(f: Awaited<ReturnType<typeof swapped>>, receipt: CloudStepResult = f.swap, publishedAddress = next) {
  return planCloudRotationCleanup(slot, f.inventory, { ...options, attemptId: "cleanup-attempt", releaseAuthorized: true, publishedAddress, linodeSwapReceipt: receipt,
    ownershipSnapshot: { accountId: "account", instanceId: "42", interfaceId: "public", address: old, allocationId: old, resourceId: `/linode/instances/42/ips/${old}` } })[0]!;
}

describe("Linode temporary instance swap", () => {
  it.each(["reboot", "stop_start"] as const)("creates an empty offline donor and completes the %s flow with durable ownership", async mode => {
    const f = await swapped(mode);
    expect(f.steps.map(step => step.action)).toEqual(mode === "reboot"
      ? ["linode.swap.allocate", "linode.ipv4.swap", "linode.instance.reboot"]
      : ["linode.swap.allocate", "linode.ipv4.swap", "linode.instance.stop", "linode.instance.start"]);
    expect(f.state.writes[0]).toMatchObject({ path: "/linode/instances", body: { region: "us-east", type: "g6-nanode-1", booted: false, interface_generation: "legacy_config" } });
    expect(Object.keys(f.state.writes[0]!.body).sort()).toEqual(["backups_enabled", "booted", "interface_generation", "label", "region", "tags", "type"]);
    expect(f.state.writes[0]!.body.backups_enabled).toBe(false);
    expect(f.state.donor!.label).toMatch(/^masterdns-swap-/);
    expect(f.state.donor!.tags).toContain(f.state.donor!.label);
    expect(f.state.writes[1]).toEqual({ path: "/networking/ips/assign", method: "POST", body: { region: "us-east", assignments: [{ address: old, linode_id: 99 }, { address: next, linode_id: 42 }] } });
    expect(f.swap).toMatchObject({ status: "applied", candidateAddress: next, allocationId: next, resourceId: `/linode/instances/42/ips/${next}`, after: { swapVerified: true, temporaryInstance: { id: "99", targetInstanceId: "42", originalAddress: old, candidateAddress: next, accountId: "account", externalAccountId: "customer-uuid", attemptId: "swap-attempt" } } });
    const priorReceipts = [{ action: "linode.swap.allocate", receipt: f.allocation }, { action: "linode.ipv4.swap", receipt: f.swap }];
    for (const planned of f.steps.slice(2)) {
      const step = withArgs(planned, { candidateReceipt: f.allocation, priorReceipts });
      const receipt = await f.adapter.execute(step);
      expect(receipt.after).toMatchObject({ swapVerified: true, temporaryInstance: f.swap.after!.temporaryInstance });
      const observed = await f.adapter.observeDetails(withArgs(step, { receipt }));
      expect(observed).toMatchObject({ status: "applied", candidateAddress: next, after: { swapVerified: true, temporaryInstance: f.swap.after!.temporaryInstance } });
      priorReceipts.push({ action: step.action, receipt: observed });
    }
    const step = cleanup(f);
    expect(step.action).toBe("linode.swap.delete");
    const receipt = await f.adapter.execute(step);
    expect(await f.adapter.observeDetails(withArgs(step, { receipt }))).toMatchObject({ status: "applied", allocationId: old });
    expect(f.state.writes.filter(write => write.method === "DELETE")).toEqual([{ path: "/linode/instances/99", method: "DELETE", body: {} }]);
    expect(f.state.target.id).toBe(42);
  });
  it("persists the returned donor ID while its address is still provisioning", async () => {
    const f = await setup(); f.state.ipReady = false;
    const receipt = await f.adapter.execute(f.steps[0]!);
    expect(receipt.after).toMatchObject({ temporaryInstance: { id: "99" } });
    expect(await f.adapter.observeDetails(withArgs(f.steps[0]!, { receipt }))).toMatchObject({ status: "pending" });
    f.state.donor!.ipv4 = [next];
    expect(await f.adapter.observeDetails(withArgs(f.steps[0]!, { receipt }))).toMatchObject({ status: "applied", candidateAddress: next });
    expect(f.state.writes).toHaveLength(1);
  });
  it("waits for deletion to finish without treating the deleting donor as reusable", async () => {
    const f = await swapped(), step = cleanup(f);
    const receipt = await f.adapter.execute(step);
    f.state.deleted = false; f.state.donor!.status = "deleting"; f.state.donor!.ipv4 = [];
    expect(await f.adapter.observeDetails(withArgs(step, { receipt }))).toMatchObject({ status: "pending" });
    await expect(f.adapter.execute(withArgs(step, { receipt }))).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    f.state.deleted = true;
    expect(await f.adapter.observeDetails(withArgs(step, { receipt }))).toMatchObject({ status: "applied" });
    expect(f.state.writes).toHaveLength(3);
  });
  it("accepts the same plan identifier syntax as the saved policy", async () => {
    const f = await setup();
    const steps = planCloudRotation(slot, f.inventory, { ...options, linodeSwapPlan: "Plan_With-Uppercase_2" });
    await f.adapter.execute(steps[0]!);
    expect(f.state.donor!.type).toBe("Plan_With-Uppercase_2");
  });
  it("uses the default donor type and gives different attempts different ownership labels", async () => {
    const first = await setup();
    await first.adapter.execute(planCloudRotation(slot, first.inventory, { allowStop: true, allowTemporaryInstance: true, linodeIpv4Strategy: "instance_swap", attemptId: "first" })[0]!);
    const second = await setup();
    await second.adapter.execute(planCloudRotation(slot, second.inventory, { ...options, attemptId: "second" })[0]!);
    expect(first.state.donor!.type).toBe("g6-nanode-1");
    expect(first.state.donor!.label).not.toBe(second.state.donor!.label);
  });
  it("never adopts inventory or repeats an uncertain create without a returned identity", async () => {
    const f = await setup(); f.state.outcome = "create-timeout";
    await expect(f.adapter.execute(f.steps[0]!)).rejects.toMatchObject({ code: "temporary_cloud_error", retryable: false });
    const retry = withArgs(f.steps[0]!, { previousExecution: true });
    expect(await f.adapter.observeDetails(retry)).toMatchObject({ status: "ambiguous" });
    await expect(f.adapter.execute(retry)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    expect(f.state.writes).toHaveLength(1);
    expect(f.state.writes[0]!.path).toBe("/linode/instances");
  });
  it.each(["swap-timeout", "swap-nochange", "swap-partial"])("observes %s without replaying the assignment", async outcome => {
    const f = await allocated(); f.state.outcome = outcome;
    let receipt: CloudStepResult | undefined;
    if (outcome === "swap-partial") receipt = await f.adapter.execute(f.swapStep);
    else await expect(f.adapter.execute(f.swapStep)).rejects.toMatchObject({ code: "temporary_cloud_error" });
    const recovered = withArgs(f.swapStep, { previousExecution: true, ...(receipt ? { receipt } : {}) });
    const observed = await f.adapter.observeDetails(recovered);
    expect(observed.status).toBe(outcome === "swap-timeout" ? "applied" : outcome === "swap-nochange" ? "pending" : "ambiguous");
    if (outcome === "swap-timeout") await f.adapter.execute(recovered);
    else await expect(f.adapter.execute(recovered)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    expect(f.state.writes).toHaveLength(2);
  });
  it.each(["reboot", "stop_start"] as const)("recovers lost %s power responses with matching events and no repeated writes", async mode => {
    const f = await swapped(mode); f.state.outcome = "power-timeout";
    const priorReceipts = [{ action: "linode.ipv4.swap", receipt: f.swap }];
    for (const planned of f.steps.slice(2)) {
      const step = withArgs(planned, { candidateReceipt: f.allocation, priorReceipts });
      await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: "temporary_cloud_error" });
      const recovered = withArgs(step, { previousExecution: true });
      const receipt = await f.adapter.observeDetails(recovered);
      expect(receipt).toMatchObject({ status: "applied", after: { swapVerified: true } });
      await f.adapter.execute(recovered);
      priorReceipts.push({ action: step.action, receipt });
    }
    expect(f.state.writes).toHaveLength(mode === "reboot" ? 3 : 4);
  });
  it.each(["wrong-actor", "multiple", "pending", "failed", "wrong-state", "old-event"])("does not confirm power for %s event evidence", async change => {
    const f = await swapped();
    const step = withArgs(f.steps[2]!, { priorReceipts: [{ action: "linode.ipv4.swap", receipt: f.swap }] });
    const receipt = await f.adapter.execute(step);
    if (change === "wrong-actor") f.state.events[0]!.username = "other-actor";
    if (change === "multiple") f.state.events.push({ ...f.state.events[0]!, id: 11 });
    if (change === "pending") f.state.events[0]!.status = "scheduled";
    if (change === "failed") f.state.events[0]!.status = "failed";
    if (change === "wrong-state") f.state.target.status = "rebooting";
    if (change === "old-event") receipt.before!.eventWatermark = 10;
    if (change === "failed") await expect(f.adapter.observeDetails(withArgs(step, { receipt }))).rejects.toMatchObject({ code: "cloud_operation_failed" });
    else expect(await f.adapter.observeDetails(withArgs(step, { receipt }))).toMatchObject({ status: ["wrong-actor", "multiple"].includes(change) ? "ambiguous" : "pending" });
    expect(f.state.writes).toHaveLength(3);
  });
  it("requires a completed shutdown receipt before booting", async () => {
    const f = await swapped("stop_start"); f.state.target.status = "offline";
    const start = withArgs(f.steps[3]!, { priorReceipts: [{ action: "linode.ipv4.swap", receipt: f.swap }] });
    await expect(f.adapter.execute(start)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    expect(f.state.writes).toHaveLength(2);
  });
  it.each(["temporary", "stop", "scope", "account", "actor", "config", "target-created", "donor-reassigned"])("blocks power if fresh %s checks fail after the swap", async change => {
    const f = await swapped();
    let step = withArgs(f.steps[2]!, { priorReceipts: [{ action: "linode.ipv4.swap", receipt: f.swap }] });
    if (change === "temporary") step = withArgs(step, { allowTemporaryInstance: false });
    if (change === "stop") step = withArgs(step, { allowStop: false });
    if (change === "scope") f.state.scopes = "linodes:read_only ips:read_only events:read_only";
    if (change === "account") f.state.uuid = "other-account";
    if (change === "actor") f.state.username = "other-actor";
    if (change === "config") f.state.configId = 8;
    if (change === "target-created") f.state.target.created = "2026-10-04T00:00:00";
    if (change === "donor-reassigned") f.state.donor!.ipv4 = ["203.0.113.30"];
    await expect(f.adapter.execute(step)).rejects.toThrow();
    expect(f.state.writes).toHaveLength(2);
  });
  it.each(["label", "created", "type", "region", "tags", "disks", "configs", "volumes", "running", "missing-state", "reassigned", "extra-ip"])("refuses to delete a donor whose %s no longer matches", async change => {
    const f = await swapped(), step = cleanup(f);
    if (["label", "created", "type", "region"].includes(change)) Object.assign(f.state.donor!, { [change]: "foreign" });
    if (change === "tags") f.state.donor!.tags = [];
    if (change === "disks") f.state.donorDisks = [{ id: 1 }];
    if (change === "configs") f.state.donorConfigs = [{ id: 1 }];
    if (change === "volumes") f.state.donorVolumes = [{ id: 1 }];
    if (change === "running") f.state.donor!.status = "running";
    if (change === "missing-state") Reflect.deleteProperty(f.state.donor!, "status");
    if (change === "reassigned") f.state.donor!.ipv4 = ["203.0.113.30"];
    if (change === "extra-ip") f.state.donor!.ipv4.push("203.0.113.30");
    await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    expect(f.state.writes).toHaveLength(2);
  });
  it.each(["automatic", "snapshot", "in-progress", "available", "history", "malformed", "denied"])("retains an empty helper when backup protection reports %s", async change => {
    const f = await swapped(), step = cleanup(f);
    if (change === "automatic") f.state.donorBackups.automatic = [{ id: 700, status: "successful" }];
    if (change === "snapshot") f.state.donorBackups.snapshot.current = { id: 701, status: "successful" };
    if (change === "in-progress") f.state.donorBackups.snapshot.in_progress = { id: 702, status: "pending" };
    if (change === "available" || change === "history") f.state.donor!.backups = { enabled: true, available: change === "available", last_successful: change === "history" ? "2026-10-04T01:00:00" : null };
    if (change === "malformed" || change === "denied") f.state.backupsOutcome = change;
    await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: change === "denied" ? "permission_denied" : "resource_ownership_ambiguous" });
    expect(f.state.deleted).toBe(false);
    expect(f.state.writes).toHaveLength(2);
  });
  it("can clean a helper with backups enabled but no backup data or history", async () => {
    const f = await swapped();
    f.state.donor!.backups = { enabled: true, available: false, last_successful: null };
    await f.adapter.execute(cleanup(f));
    expect(f.state.deleted).toBe(true);
    expect(f.state.reads).toContain("/linode/instances/99/backups");
  });
  it("requires an applied swap proof and refuses the original instance as donor", async () => {
    const f = await swapped();
    expect(() => cleanup(f, f.allocation)).toThrow();
    const forged = structuredClone(f.swap);
    (forged.after!.temporaryInstance as Record<string, unknown>).id = "42";
    expect(() => cleanup(f, forged)).toThrow();
    expect(f.state.writes).toHaveLength(2);
  });
  it.each(["temporary", "stop", "scope", "account", "actor", "config", "reserved", "shared"])("blocks new writes when fresh %s authorization or ownership changes", async change => {
    const f = await allocated();
    let step = f.swapStep;
    if (change === "temporary") step = withArgs(step, { allowTemporaryInstance: false });
    if (change === "stop") step = withArgs(step, { allowStop: false });
    if (change === "scope") f.state.scopes = "linodes:read_write ips:read_only events:read_only";
    if (change === "account") f.state.uuid = "other-account";
    if (change === "actor") f.state.username = "different-operator";
    if (change === "config") f.state.configId = 8;
    if (change === "reserved") f.state.reserved = true;
    if (change === "shared") f.state.shared = [{ address: next }];
    await expect(f.adapter.execute(step)).rejects.toThrow();
    expect(f.state.writes).toHaveLength(1);
  });
  it("refuses cleanup if its temporary-instance grant was revoked", async () => {
    const f = await swapped();
    await expect(f.adapter.execute(withArgs(cleanup(f), { allowTemporaryInstance: false }))).rejects.toThrow();
    expect(f.state.writes).toHaveLength(2);
  });
  it.each(["delete-timeout", "delete-nochange"])("observes %s without replaying a donor delete", async outcome => {
    const f = await swapped(); f.state.outcome = outcome; const step = cleanup(f);
    await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: "temporary_cloud_error" });
    const recovered = withArgs(step, { previousExecution: true });
    expect(await f.adapter.observeDetails(recovered)).toMatchObject({ status: outcome === "delete-timeout" ? "applied" : "pending" });
    if (outcome === "delete-timeout") await f.adapter.execute(recovered);
    else await expect(f.adapter.execute(recovered)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    expect(f.state.writes).toHaveLength(3);
  });
  it("cleans an older donor after the original receives a newer replacement", async () => {
    const f = await swapped(); f.state.target.ipv4 = ["203.0.113.30"];
    const step = cleanup(f, f.swap, "203.0.113.30");
    await f.adapter.execute(step);
    expect(f.state.deleted).toBe(true);
    expect(f.state.target.ipv4).toEqual(["203.0.113.30"]);
  });
  it("keeps the original donor plan identity when the saved policy plan changes", async () => {
    const f = await swapped();
    await f.adapter.execute(withArgs(cleanup(f), { linodeSwapPlan: "g6-standard-4" }));
    expect(f.state.deleted).toBe(true);
  });
  it.each(["vpc", "interface", "nat"])("retains a helper when %s networking is observed", async change => {
    const f = await swapped(), step = cleanup(f);
    if (change === "vpc") f.state.vpc = [{ vpc_id: 1 }];
    if (change === "interface") f.state.interfaceId = 12;
    if (change === "nat") f.state.nat = { address: "10.0.0.1", vpc_id: 1 };
    await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous" });
    expect(f.state.writes).toHaveLength(2);
  });
});

import { createHash } from "node:crypto";
import type { CloudStep, SlotRef } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import { linodeCapabilities, linodeIpResource, publicLinodeAddress } from "./linode-capabilities.js";
import type { LinodeCloudAdapter, LinodeIp } from "./linode.js";
import type { CloudInventory, CloudObservation, CloudStepResult } from "./provider.js";
import { makeRotationStep, rotationArguments } from "./rotation-step.js";
import type { CleanupPlanOptions, LinodeSwapOptions, RotationAction, RotationStepArguments } from "./rotation-step.js";

type TemporaryInstance = {
  id: string; label: string; created: string; region: string; attemptId: string; targetInstanceId: string;
  originalAddress: string; candidateAddress?: string; type: string; accountId: string; externalAccountId: string;
};
type Instance = { id?: number; label?: string; created?: string; region?: string; type?: string; status?: string; tags?: string[]; interface_generation?: string; ipv4?: string[]; image?: string | null; has_user_data?: boolean; backups?: { available?: boolean; last_successful?: string | null } };
type Network = { ipv4?: { public?: LinodeIp[]; private?: unknown[]; shared?: unknown[]; reserved?: unknown[]; vpc?: unknown[] }; ipv6?: { global?: unknown[]; vpc?: unknown[] } };
const defaultPlan = "g6-nanode-1";
const planId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const powerActions = new Set(["linode.instance.reboot", "linode.instance.stop", "linode.instance.start"]);
const ambiguous = () => new CloudError("resource_ownership_ambiguous", false);
const validId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const validCreated = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
const ipv4 = (inventory: CloudInventory) => inventory.interfaces.find(i => i.id === "public")?.addresses.filter(ip => ip.family === 4).map(ip => ip.address) ?? [];
function sameAddresses(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && new Set(left).size === left.length && [...left].sort().every((address, index) => address === sortedRight[index]);
}
function labelFor(accountId: string, targetId: string, attemptId: string): string {
  return `masterdns-swap-${createHash("sha256").update(JSON.stringify([accountId, targetId, attemptId])).digest("hex").slice(0, 32)}`;
}
function requireGrant(args: Pick<RotationStepArguments, "allowTemporaryInstance" | "allowStop" | "linodeSwapPlan">): void {
  if (args.allowTemporaryInstance !== true) throw new CloudError("cleanup_not_authorized", false, undefined, "linode_temporary_instance_permission_required");
  if (args.allowStop !== true) throw new CloudError("rotation_unsupported", false, undefined, "linode_reboot_permission_required");
  if (!planId.test(args.linodeSwapPlan ?? defaultPlan)) throw new CloudError("invalid_rotation_step", false);
}
function permissions(scopes: unknown, write: boolean): void {
  if (!Array.isArray(scopes) || (!scopes.includes("*") && !["linodes", "ips", "events"].every(scope => scopes.includes(`${scope}:read_write`) || ((!write || scope === "events") && scopes.includes(`${scope}:read_only`))))) {
    throw new CloudError("rotation_unsupported", false, undefined, "linode_permissions_required");
  }
}
function capability(slot: SlotRef, inventory: CloudInventory, write: boolean): void {
  const result = linodeCapabilities(slot, { ...inventory, state: "running" }, write ? "write" : "read");
  if (!result.available) throw new CloudError("rotation_unsupported", false, undefined, result.reason);
  permissions(inventory.metadata?.permissionScopes, write);
  if (!validCreated(inventory.metadata?.instanceCreated)) throw new CloudError("remote_identity_changed", false);
  if (inventory.metadata?.reservedIpv4Count !== 0 || inventory.interfaces.flatMap(i => i.addresses).some(ip => ip.family === 4 && ip.metadata?.reserved === true)) throw ambiguous();
}
export function planLinodeSwap(slot: SlotRef, inventory: CloudInventory, options: LinodeSwapOptions & { allowStop: boolean; attemptId: string; linodeRestartMode?: "reboot" | "stop_start" }): CloudStep[] {
  requireGrant(options);
  capability(slot, inventory, true);
  if (inventory.state !== "running") throw new CloudError("rotation_unsupported", false, undefined, "linode_not_running");
  const args: RotationStepArguments = { slot, before: inventory, phase: "rotation", ...options, linodeIpv4Strategy: "instance_swap", linodeSwapPlan: options.linodeSwapPlan ?? defaultPlan };
  const actions: RotationAction[] = ["linode.swap.allocate", "linode.ipv4.swap", ...(options.linodeRestartMode === "stop_start" ? ["linode.instance.stop", "linode.instance.start"] as const : ["linode.instance.reboot"] as const)];
  return actions.map((action, index) => makeRotationStep(action, args, index));
}
export function planLinodeSwapCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
  const args: RotationStepArguments = { slot, before: inventory, phase: "post_publish_cleanup", ...options, linodeIpv4Strategy: "instance_swap" };
  requireGrant(args);
  capability(slot, inventory, false);
  cleanupProof(args);
  return [makeRotationStep("linode.swap.delete", args, 0)];
}
function validate(step: CloudStep, adapter: LinodeCloudAdapter): RotationStepArguments {
  const args = rotationArguments(step);
  if (args.linodeIpv4Strategy !== "instance_swap" || args.slot.accountId !== adapter.accountId || args.slot.service !== "linode" || args.slot.family !== 4 || args.slot.interfaceId !== "public"
    || !validId(args.slot.instanceId) || !["reboot", "stop_start"].includes(args.linodeRestartMode ?? "reboot")
    || !(powerActions.has(step.action) || ["linode.swap.allocate", "linode.ipv4.swap", "linode.swap.delete"].includes(step.action))
    || (step.action === "linode.swap.delete" ? args.phase !== "post_publish_cleanup" : args.phase !== "rotation")
    || (step.action === "linode.instance.reboot" && args.linodeRestartMode === "stop_start")
    || (["linode.instance.stop", "linode.instance.start"].includes(step.action) && args.linodeRestartMode !== "stop_start")) throw new CloudError("invalid_rotation_step", false);
  requireGrant(args);
  capability(args.slot, args.before, false);
  return args;
}
function snapshot(inventory: CloudInventory): Record<string, unknown> {
  return { externalAccountId: inventory.metadata?.externalAccountId, instanceId: inventory.ref.instanceId, region: inventory.ref.region,
    instanceCreated: inventory.metadata?.instanceCreated, configId: inventory.metadata?.configId, eventWatermark: inventory.metadata?.eventWatermark, ipv4: ipv4(inventory) };
}
async function target(args: RotationStepArguments, adapter: LinodeCloudAdapter, write: boolean): Promise<CloudInventory> {
  // Refresh the profile too: a cached actor must not authorize a later cloud write.
  await adapter.verifyIdentity();
  const current = await adapter.inspect(args.slot);
  if (current.metadata?.externalAccountId !== args.before.metadata?.externalAccountId || current.metadata?.configId !== args.before.metadata?.configId
    || current.metadata?.instanceCreated !== args.before.metadata?.instanceCreated
    || (write && current.metadata?.authenticatedUsername !== args.before.metadata?.authenticatedUsername)) throw new CloudError("remote_identity_changed", false);
  return current;
}
function proof(args: RotationStepArguments, receipt: CloudStepResult | undefined, applied = false, cleanup = false): TemporaryInstance {
  const value = receipt?.after?.temporaryInstance;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw ambiguous();
  const p = value as TemporaryInstance;
  if (!validId(p.id) || p.id === args.slot.instanceId || !validCreated(p.created) || typeof p.attemptId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?$/.test(p.attemptId)
    || (!cleanup && p.attemptId !== args.attemptId) || p.accountId !== args.slot.accountId || p.targetInstanceId !== args.slot.instanceId || p.region !== args.slot.region
    || p.externalAccountId !== args.before.metadata?.externalAccountId || p.originalAddress !== args.slot.address
    || p.label !== labelFor(p.accountId, p.targetInstanceId, p.attemptId) || typeof p.type !== "string" || !planId.test(p.type)
    || (!cleanup && p.type !== (args.linodeSwapPlan ?? defaultPlan))
    || receipt?.after?.attemptId !== p.attemptId || receipt.after.externalAccountId !== p.externalAccountId || receipt.after.instanceId !== p.targetInstanceId
    || receipt.after.region !== p.region || receipt.after.configId !== args.before.metadata?.configId || receipt.after.instanceCreated !== args.before.metadata?.instanceCreated
    || (applied && receipt.after.swapVerified !== true)) throw ambiguous();
  if (p.candidateAddress !== undefined && (!publicLinodeAddress(p.candidateAddress, 4) || ipv4(args.before).includes(p.candidateAddress)
    || receipt.candidateAddress !== p.candidateAddress || receipt.allocationId !== p.candidateAddress || receipt.resourceId !== linodeIpResource(p.targetInstanceId, p.candidateAddress))) throw ambiguous();
  if (applied && !p.candidateAddress) throw ambiguous();
  return p;
}
function allocationReceipt(args: RotationStepArguments): CloudStepResult | undefined {
  return args.priorReceipts?.find(item => item.action === "linode.swap.allocate")?.receipt ?? args.candidateReceipt;
}
function swapReceipt(args: RotationStepArguments): CloudStepResult {
  const receipt = args.priorReceipts?.find(item => item.action === "linode.ipv4.swap")?.receipt;
  proof(args, receipt, true);
  return receipt!;
}
function cleanupProof(args: RotationStepArguments): TemporaryInstance {
  if (args.phase !== "post_publish_cleanup" || args.releaseAuthorized !== true || !args.publishedAddress || !publicLinodeAddress(args.publishedAddress, 4) || args.publishedAddress === args.slot.address) throw new CloudError("cleanup_not_authorized", false);
  const ownership = args.ownershipSnapshot;
  if (!ownership || ownership.accountId !== args.slot.accountId || ownership.instanceId !== args.slot.instanceId || ownership.interfaceId !== "public"
    || ownership.address !== args.slot.address || ownership.allocationId !== args.slot.address || ownership.resourceId !== linodeIpResource(args.slot.instanceId, args.slot.address)) throw ambiguous();
  return proof(args, args.linodeSwapReceipt, true, true);
}
async function exactIp(adapter: LinodeCloudAdapter, address: string): Promise<LinodeIp | undefined> {
  try { return await adapter.http.request<LinodeIp>(`/networking/ips/${encodeURIComponent(address)}`); }
  catch (error) { if (error instanceof CloudError && error.code === "resource_not_found") return undefined; throw error; }
}
function assigned(ip: LinodeIp | undefined, id: string, region: string, address: string): boolean {
  return !!ip && ip.address === address && ip.type === "ipv4" && ip.public === true && ip.linode_id === Number(id) && ip.region === region && ip.reserved !== true
    && ip.interface_id == null && ip.vpc_nat_1_1 == null && (ip.assigned_entity == null || ip.assigned_entity.type === "linode" && ip.assigned_entity.id === Number(id));
}
async function donor(adapter: LinodeCloudAdapter, p: TemporaryInstance, pendingState?: "provisioning" | "deleting"): Promise<{ instance: Instance; addresses: string[] } | undefined> {
  const root = `/linode/instances/${p.id}`;
  let instance: Instance;
  try { instance = await adapter.http.request<Instance>(root); }
  catch (error) { if (error instanceof CloudError && error.code === "resource_not_found") return undefined; throw error; }
  if (String(instance.id) !== p.id || instance.region !== p.region || instance.label !== p.label || instance.created !== p.created || instance.type !== p.type
    || instance.interface_generation !== "legacy_config" || !Array.isArray(instance.tags) || instance.tags.length !== 1 || instance.tags[0] !== p.label
    || (instance.status !== "offline" && (!pendingState || instance.status !== pendingState)) || instance.image != null || instance.has_user_data === true) throw ambiguous();
  // During a known lifecycle transition the subresources may not exist yet/anymore.
  // Only observation allows these states; mutation always requires a fully verified offline donor.
  if (pendingState && instance.status === pendingState) return { instance, addresses: [] };
  const configs = await adapter.http.all(`${root}/configs`);
  const disks = await adapter.http.all(`${root}/disks`);
  const volumes = await adapter.http.all(`${root}/volumes`);
  if (configs.length || disks.length || volumes.length) throw ambiguous();
  const backups = await adapter.http.request<{ automatic?: unknown[]; snapshot?: { current?: unknown; in_progress?: unknown } }>(`${root}/backups`);
  if (!Array.isArray(backups.automatic) || backups.automatic.length || backups.snapshot?.current !== null || backups.snapshot?.in_progress !== null
    || instance.backups?.available === true || !!instance.backups?.last_successful) throw ambiguous();
  const network = await adapter.http.request<Network>(`${root}/ips`);
  if (!Array.isArray(network.ipv4?.public) || ![network.ipv4.private, network.ipv4.shared, network.ipv4.reserved, network.ipv6?.global].every(list => Array.isArray(list) && list.length === 0)) throw ambiguous();
  if (![network.ipv4.vpc, network.ipv6?.vpc].every(list => list === undefined || Array.isArray(list) && list.length === 0)) throw ambiguous();
  const addresses = network.ipv4.public.map(ip => {
    if (!ip.address || !publicLinodeAddress(ip.address, 4) || !assigned(ip, p.id, p.region, ip.address)) throw ambiguous();
    return ip.address;
  });
  if (addresses.length > 1 || !Array.isArray(instance.ipv4) || !sameAddresses(instance.ipv4, addresses)) throw ambiguous();
  return { instance, addresses };
}
function result(args: RotationStepArguments, current: CloudInventory, p: TemporaryInstance, verified = false): CloudStepResult {
  return { remoteId: p.id, ...(p.candidateAddress ? { candidateAddress: p.candidateAddress, candidateRepeated: (args.failedCandidates ?? []).includes(p.candidateAddress), allocationId: p.candidateAddress, resourceId: linodeIpResource(args.slot.instanceId, p.candidateAddress) } : {}),
    before: snapshot(current), after: { ...snapshot(current), attemptId: p.attemptId, temporaryInstance: p, ...(verified ? { swapVerified: true } : {}) } };
}
async function pairState(args: RotationStepArguments, adapter: LinodeCloudAdapter, current: CloudInventory, p: TemporaryInstance): Promise<"before" | "after" | "ambiguous"> {
  if (!p.candidateAddress) throw ambiguous();
  const helper = await donor(adapter, p);
  if (!helper) throw ambiguous();
  const original = await exactIp(adapter, p.originalAddress), candidate = await exactIp(adapter, p.candidateAddress);
  const beforeAddresses = ipv4(args.before), afterAddresses = beforeAddresses.map(address => address === p.originalAddress ? p.candidateAddress! : address);
  if (sameAddresses(ipv4(current), beforeAddresses) && sameAddresses(helper.addresses, [p.candidateAddress])
    && assigned(original, p.targetInstanceId, p.region, p.originalAddress) && assigned(candidate, p.id, p.region, p.candidateAddress)) return "before";
  if (sameAddresses(ipv4(current), afterAddresses) && sameAddresses(helper.addresses, [p.originalAddress])
    && assigned(original, p.id, p.region, p.originalAddress) && assigned(candidate, p.targetInstanceId, p.region, p.candidateAddress)) return "after";
  return "ambiguous";
}
function shutdown(args: RotationStepArguments): CloudStepResult {
  const receipt = args.priorReceipts?.find(item => item.action === "linode.instance.stop")?.receipt;
  proof(args, receipt, true);
  if (!validId(receipt?.operationId) || !["finished", "completed"].includes(String(receipt?.after?.eventStatus)) || receipt?.after?.powerState !== "offline") throw ambiguous();
  return receipt!;
}
function watermark(args: RotationStepArguments, action: string): number {
  const value = args.receipt?.before?.eventWatermark ?? (action === "linode.instance.start" ? Number(shutdown(args).operationId) : swapReceipt(args).before?.eventWatermark);
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw ambiguous();
  return Number(value);
}
async function published(args: RotationStepArguments, adapter: LinodeCloudAdapter, current: CloudInventory, write: boolean): Promise<void> {
  const address = args.publishedAddress!;
  capability({ ...args.slot, address }, current, write);
  if (!ipv4(current).includes(address) || ipv4(current).includes(args.slot.address) || !assigned(await exactIp(adapter, address), args.slot.instanceId, args.slot.region, address)) throw ambiguous();
}

export async function executeLinodeSwap(step: CloudStep, adapter: LinodeCloudAdapter): Promise<CloudStepResult> {
  const args = validate(step, adapter);
  if (args.previousExecution || args.receipt) {
    const observed = await observeLinodeSwap(step, adapter);
    if (observed.status === "applied") return observed;
    throw ambiguous();
  }
  const current = await target(args, adapter, true);
  if (step.action === "linode.swap.delete") {
    const p = cleanupProof(args);
    await published(args, adapter, current, true);
    const helper = await donor(adapter, p);
    if (!helper || !sameAddresses(helper.addresses, [p.originalAddress]) || !assigned(await exactIp(adapter, p.originalAddress), p.id, p.region, p.originalAddress)) throw ambiguous();
    permissions(adapter.http.permissionScopes, true);
    await adapter.http.request(`/linode/instances/${p.id}`, { method: "DELETE" });
    const receipt = result(args, current, p, true);
    return { ...receipt, allocationId: p.originalAddress, resourceId: linodeIpResource(p.targetInstanceId, p.originalAddress), after: { ...receipt.after, deleteRequested: true } };
  }
  if (current.state !== (step.action === "linode.instance.start" ? "offline" : "running")) throw new CloudError("rotation_unsupported", false, undefined, "linode_unexpected_power_state");
  if (step.action === "linode.swap.allocate") {
    capability(args.slot, current, true);
    if (!sameAddresses(ipv4(current), ipv4(args.before)) || !assigned(await exactIp(adapter, args.slot.address), args.slot.instanceId, args.slot.region, args.slot.address)) throw ambiguous();
    permissions(adapter.http.permissionScopes, true);
    const label = labelFor(args.slot.accountId, args.slot.instanceId, args.attemptId), type = args.linodeSwapPlan ?? defaultPlan;
    const created = await adapter.http.request<Instance>("/linode/instances", { method: "POST", body: { region: args.slot.region, type, label, tags: [label], booted: false, backups_enabled: false, interface_generation: "legacy_config" } });
    if (!validId(String(created.id)) || String(created.id) === args.slot.instanceId || !validCreated(created.created) || created.label !== label || created.region !== args.slot.region || created.type !== type) throw ambiguous();
    const p: TemporaryInstance = { id: String(created.id), label, created: created.created, region: args.slot.region, attemptId: args.attemptId, targetInstanceId: args.slot.instanceId,
      originalAddress: args.slot.address, type, accountId: args.slot.accountId, externalAccountId: String(current.metadata!.externalAccountId) };
    // Persist the create response before further network reads, even when IPv4 provisioning is delayed.
    return result(args, current, p);
  }
  const receipt = step.action === "linode.ipv4.swap" ? allocationReceipt(args) : swapReceipt(args);
  const p = proof(args, receipt, step.action !== "linode.ipv4.swap");
  const expected = step.action === "linode.ipv4.swap" ? "before" : "after";
  if (await pairState(args, adapter, current, p) !== expected) throw ambiguous();
  capability({ ...args.slot, address: expected === "before" ? p.originalAddress : p.candidateAddress! }, current, true);
  permissions(adapter.http.permissionScopes, true);
  if (step.action === "linode.ipv4.swap") {
    await adapter.http.request("/networking/ips/assign", { method: "POST", body: { region: p.region, assignments: [{ address: p.originalAddress, linode_id: Number(p.id) }, { address: p.candidateAddress, linode_id: Number(p.targetInstanceId) }] } });
    return result(args, current, p);
  }
  const afterId = watermark(args, step.action);
  if (current.metadata?.eventWatermark !== afterId) throw ambiguous();
  if (step.action === "linode.instance.start") shutdown(args);
  const command = step.action === "linode.instance.stop" ? "shutdown" : step.action === "linode.instance.start" ? "boot" : "reboot";
  await adapter.http.request(`/linode/instances/${args.slot.instanceId}/${command}`, { method: "POST", body: command === "shutdown" ? {} : { config_id: current.metadata!.configId } });
  const powerReceipt = result(args, current, p, true);
  return { ...powerReceipt, after: { ...powerReceipt.after, powerActionRequested: command } };
}

export async function observeLinodeSwap(step: CloudStep, adapter: LinodeCloudAdapter): Promise<CloudObservation> {
  const args = validate(step, adapter), current = await target(args, adapter, false);
  const base: CloudStepResult = { ...args.receipt };
  try {
    if (step.action === "linode.swap.allocate") {
      // An inventory difference or a matching label cannot replace a returned create identity.
      if (!args.receipt) return { ...base, status: "ambiguous" };
      const p = proof(args, args.receipt);
      capability(args.slot, current, false);
      if (!sameAddresses(ipv4(current), ipv4(args.before))) throw ambiguous();
      const helper = await donor(adapter, p, "provisioning");
      if (!helper) throw ambiguous();
      if (!helper.addresses.length || helper.instance.status === "provisioning") return { ...base, status: "pending" };
      const address = helper.addresses[0]!;
      if (ipv4(args.before).includes(address) || p.candidateAddress && p.candidateAddress !== address || !assigned(await exactIp(adapter, address), p.id, p.region, address)) throw ambiguous();
      return { ...result(args, current, { ...p, candidateAddress: address }), status: "applied" };
    }
    if (step.action === "linode.swap.delete") {
      const p = cleanupProof(args);
      await published(args, adapter, current, false);
      const helper = await donor(adapter, p, "deleting"), old = await exactIp(adapter, p.originalAddress);
      const deleted = { ...result(args, current, p, true), allocationId: p.originalAddress, resourceId: linodeIpResource(p.targetInstanceId, p.originalAddress) };
      if (!helper) return { ...deleted, after: { ...deleted.after, deleted: !old }, status: old ? "ambiguous" : "applied" };
      if (helper.instance.status === "deleting") return { ...deleted, status: "pending" };
      if (!sameAddresses(helper.addresses, [p.originalAddress]) || !assigned(old, p.id, p.region, p.originalAddress)) throw ambiguous();
      return { ...deleted, status: "pending" };
    }
    const p = proof(args, step.action === "linode.ipv4.swap" ? allocationReceipt(args) : swapReceipt(args), step.action !== "linode.ipv4.swap");
    const state = await pairState(args, adapter, current, p);
    if (state === "ambiguous") throw ambiguous();
    capability({ ...args.slot, address: state === "before" ? p.originalAddress : p.candidateAddress! }, current, false);
    if (step.action === "linode.ipv4.swap") return { ...result(args, current, p, state === "after"), status: state === "after" ? "applied" : "pending" };
    if (state !== "after") throw ambiguous();
    const afterId = watermark(args, step.action), action = step.action === "linode.instance.stop" ? "linode_shutdown" : step.action === "linode.instance.start" ? "linode_boot" : "linode_reboot";
    const receipt = result(args, current, p, true);
    receipt.before = { ...receipt.before, eventWatermark: afterId };
    const events = (await adapter.events(args.slot.instanceId)).filter(event => event.id > afterId && event.action === action && event.entity?.type === "linode" && event.entity.id === Number(args.slot.instanceId));
    if (!events.length) return { ...receipt, status: "pending" };
    if (events.length !== 1) throw ambiguous();
    const event = events[0]!;
    if (event.username !== args.before.metadata?.authenticatedUsername || args.receipt?.operationId && args.receipt.operationId !== String(event.id)) throw ambiguous();
    if (event.status === "failed") throw new CloudError("cloud_operation_failed", false, undefined, `linode_${action}_failed`);
    const desired = step.action === "linode.instance.stop" ? "offline" : "running";
    return { ...receipt, operationId: String(event.id), after: { ...receipt.after, eventStatus: event.status, powerState: current.state }, status: ["finished", "completed"].includes(event.status ?? "") && current.state === desired ? "applied" : "pending" };
  } catch (error) {
    if (error instanceof CloudError && error.code === "resource_ownership_ambiguous") return { ...base, status: "ambiguous" };
    throw error;
  }
}

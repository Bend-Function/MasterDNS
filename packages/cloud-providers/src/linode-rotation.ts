import type { CloudStep, SlotRef } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import { linodeCapabilities, linodeIpResource, publicLinodeAddress } from "./linode.js";
import type { LinodeCloudAdapter, LinodeIp } from "./linode.js";
import type { CloudInventory, CloudObservation, CloudStepResult } from "./provider.js";
import { makeRotationStep, rotationArguments } from "./rotation-plan.js";
import type { CleanupPlanOptions, RotationStepArguments } from "./rotation-plan.js";

const actions = new Set(["linode.ipv4.allocate", "linode.instance.reboot", "linode.ipv4.release"]);
function requireCapability(slot: SlotRef, inventory: CloudInventory, allowStop?: boolean) {
  const capability = linodeCapabilities(slot, inventory);
  if (!capability.available) throw new CloudError("rotation_unsupported", false, undefined, capability.reason);
  if (allowStop !== true) throw new CloudError("rotation_unsupported", false, undefined, "linode_reboot_permission_required");
}
export function planLinodeRotation(slot: SlotRef, inventory: CloudInventory, options: { allowStop: boolean; attemptId: string }): CloudStep[] {
  requireCapability(slot, inventory, options.allowStop);
  const args: RotationStepArguments = { slot, before: inventory, phase: "rotation", ...options };
  const steps = [makeRotationStep("linode.ipv4.allocate", args, 0), makeRotationStep("linode.instance.reboot", args, 1)];
  rotationArguments(steps[0]!); return steps;
}
export function planLinodeCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
  requireCapability(slot, inventory, options.allowStop);
  const args: RotationStepArguments = { slot, before: inventory, phase: "post_publish_cleanup", ...options };
  assertCleanup(args);
  const steps = [makeRotationStep("linode.ipv4.release", args, 0), makeRotationStep("linode.instance.reboot", args, 1)];
  rotationArguments(steps[0]!); return steps;
}
function validate(step: CloudStep, adapter: LinodeCloudAdapter): RotationStepArguments {
  const args = rotationArguments(step);
  if (!actions.has(step.action) || args.slot.accountId !== adapter.accountId || args.slot.service !== "linode" || args.slot.family !== 4 || args.slot.interfaceId !== "public"
    || (step.action === "linode.ipv4.allocate" && args.phase !== "rotation") || (step.action === "linode.ipv4.release" && args.phase !== "post_publish_cleanup")) throw new CloudError("invalid_rotation_step", false);
  requireCapability(args.slot, args.before, args.allowStop);
  return args;
}
function assertCleanup(args: RotationStepArguments): void {
  const { slot, before, ownershipSnapshot: proof } = args;
  if (args.phase !== "post_publish_cleanup" || args.releaseAuthorized !== true || args.allowStop !== true || !args.publishedAddress || args.publishedAddress === slot.address || !publicLinodeAddress(args.publishedAddress, 4)) throw new CloudError("cleanup_not_authorized", false);
  const original = before.interfaces.find(i => i.id === slot.interfaceId)?.addresses.find(ip => ip.address === slot.address && ip.family === 4);
  if (!proof || proof.accountId !== slot.accountId || proof.instanceId !== slot.instanceId || proof.interfaceId !== slot.interfaceId || proof.address !== slot.address
    || proof.allocationId !== slot.address || original?.allocationId !== proof.allocationId || proof.resourceId !== linodeIpResource(slot.instanceId, slot.address) || original.resourceId !== proof.resourceId) throw new CloudError("resource_ownership_ambiguous", false);
}
function ipv4(inventory: CloudInventory): string[] { return inventory.interfaces.find(i => i.id === "public")?.addresses.filter(a => a.family === 4).map(a => a.address) ?? []; }
function snapshot(inventory: CloudInventory): Record<string, unknown> {
  return { externalAccountId: inventory.metadata?.externalAccountId, instanceId: inventory.ref.instanceId, region: inventory.ref.region,
    configId: inventory.metadata?.configId, eventWatermark: inventory.metadata?.eventWatermark, ipv4: ipv4(inventory) };
}
function identity(args: RotationStepArguments, inventory: CloudInventory): void {
  if (inventory.metadata?.externalAccountId !== args.before.metadata?.externalAccountId || inventory.metadata?.authenticatedUsername !== args.before.metadata?.authenticatedUsername
    || inventory.metadata?.configId !== args.before.metadata?.configId) throw new CloudError("remote_identity_changed", false);
}
function candidateReceipt(args: RotationStepArguments): CloudStepResult | undefined {
  return args.candidateReceipt ?? args.priorReceipts?.find(item => item.action === "linode.ipv4.allocate")?.receipt;
}
function verifyReceipt(args: RotationStepArguments, receipt: CloudStepResult | undefined): string {
  const address = receipt?.candidateAddress;
  if (!address || !publicLinodeAddress(address, 4) || receipt?.allocationId !== address || receipt.resourceId !== linodeIpResource(args.slot.instanceId, address)
    || receipt.after?.externalAccountId !== args.before.metadata?.externalAccountId || receipt.after?.instanceId !== args.slot.instanceId || receipt.after?.region !== args.slot.region
    || receipt.after?.configId !== args.before.metadata?.configId || receipt.after?.attemptId !== args.attemptId || address === args.slot.address
    || args.before.interfaces.flatMap(i => i.addresses).some(ip => ip.address === address)) throw new CloudError("resource_ownership_ambiguous", false);
  return address;
}
async function exactIp(adapter: LinodeCloudAdapter, address: string): Promise<LinodeIp | undefined> {
  try { return await adapter.http.request<LinodeIp>(`/networking/ips/${encodeURIComponent(address)}`); }
  catch (error) { if (error instanceof CloudError && error.code === "resource_not_found") return undefined; throw error; }
}
function verifyAssigned(args: RotationStepArguments, ip: LinodeIp | undefined, address: string): void {
  if (!ip || ip.address !== address || ip.type !== "ipv4" || ip.public !== true || ip.linode_id !== Number(args.slot.instanceId) || ip.region !== args.slot.region) throw new CloudError("resource_ownership_ambiguous", false);
}
async function verifyCandidate(args: RotationStepArguments, adapter: LinodeCloudAdapter, inventory: CloudInventory, receipt = candidateReceipt(args)): Promise<CloudStepResult> {
  const address = verifyReceipt(args, receipt);
  verifyAssigned(args, await exactIp(adapter, address), address);
  if (!ipv4(inventory).includes(address)) throw new CloudError("resource_ownership_ambiguous", false);
  return { ...receipt, candidateAddress: address, candidateRepeated: (args.failedCandidates ?? []).includes(address) };
}
function currentCapability(args: RotationStepArguments, inventory: CloudInventory, selected = args.slot.address): void {
  // During observation an in-progress reboot can report rebooting. Configuration and permission checks still apply.
  const current = { ...inventory, state: "running" };
  requireCapability({ ...args.slot, address: selected }, current, args.allowStop);
  identity(args, inventory);
}
function releaseReceipt(args: RotationStepArguments): CloudStepResult | undefined { return args.priorReceipts?.find(item => item.action === "linode.ipv4.release")?.receipt; }
function verifyReleaseReceipt(args: RotationStepArguments): CloudStepResult {
  const receipt = releaseReceipt(args);
  if (!receipt || receipt.allocationId !== args.slot.address || receipt.resourceId !== linodeIpResource(args.slot.instanceId, args.slot.address)
    || receipt.after?.released !== true || receipt.after?.externalAccountId !== args.before.metadata?.externalAccountId || receipt.after?.instanceId !== args.slot.instanceId
    || receipt.after?.region !== args.slot.region || receipt.after?.attemptId !== args.attemptId || !Number.isSafeInteger(receipt.before?.eventWatermark)) throw new CloudError("resource_ownership_ambiguous", false);
  return receipt;
}
function watermark(args: RotationStepArguments): number {
  const source = args.receipt?.before?.eventWatermark ?? (args.phase === "post_publish_cleanup" ? verifyReleaseReceipt(args).before?.eventWatermark : candidateReceipt(args)?.before?.eventWatermark ?? args.before.metadata?.eventWatermark);
  if (!Number.isSafeInteger(source) || Number(source) < 0) throw new CloudError("resource_ownership_ambiguous", false);
  return Number(source);
}

export async function executeLinodeRotation(step: CloudStep, adapter: LinodeCloudAdapter): Promise<CloudStepResult> {
  const args = validate(step, adapter);
  if (args.previousExecution || args.receipt) {
    const observation = await observeLinodeRotation(step, adapter);
    if (observation.status === "applied") return observation;
    throw new CloudError("resource_ownership_ambiguous", false);
  }
  const current = await adapter.inspect(args.slot);
  identity(args, current);
  if (current.state !== "running") throw new CloudError("rotation_unsupported", false, undefined, "linode_not_running");
  const before = snapshot(current);
  if (step.action === "linode.ipv4.allocate") {
    currentCapability(args, current);
    if (JSON.stringify(ipv4(current).sort()) !== JSON.stringify(ipv4(args.before).sort())) throw new CloudError("resource_ownership_ambiguous", false);
    verifyAssigned(args, await exactIp(adapter, args.slot.address), args.slot.address);
    const ip = await adapter.http.request<LinodeIp>(`/linode/instances/${args.slot.instanceId}/ips`, { method: "POST", body: { type: "ipv4", public: true } });
    if (!ip.address || !publicLinodeAddress(ip.address, 4) || ipv4(current).includes(ip.address)) throw new CloudError("resource_ownership_ambiguous", false);
    verifyAssigned(args, ip, ip.address);
    return { remoteId: ip.address, allocationId: ip.address, resourceId: linodeIpResource(args.slot.instanceId, ip.address), candidateAddress: ip.address,
      candidateRepeated: (args.failedCandidates ?? []).includes(ip.address), before, after: { ...snapshot(current), attemptId: args.attemptId } };
  }
  if (args.phase === "post_publish_cleanup") assertCleanup(args);
  const candidate = await verifyCandidate(args, adapter, current);
  if (args.phase === "post_publish_cleanup" && candidate.candidateAddress !== args.publishedAddress) throw new CloudError("cleanup_not_authorized", false);
  currentCapability(args, current, args.phase === "post_publish_cleanup" ? args.publishedAddress! : args.slot.address);
  if (step.action === "linode.ipv4.release") {
    if (ipv4(current).length < 2 || !ipv4(current).includes(args.slot.address)) throw new CloudError("resource_ownership_ambiguous", false);
    verifyAssigned(args, await exactIp(adapter, args.slot.address), args.slot.address);
    await adapter.http.request(`/linode/instances/${args.slot.instanceId}/ips/${encodeURIComponent(args.slot.address)}`, { method: "DELETE" });
    return { remoteId: args.slot.address, allocationId: args.slot.address, resourceId: linodeIpResource(args.slot.instanceId, args.slot.address), before,
      after: { ...snapshot(current), attemptId: args.attemptId, released: true } };
  }
  if (args.phase === "post_publish_cleanup") {
    verifyReleaseReceipt(args);
    if (ipv4(current).includes(args.slot.address) || await exactIp(adapter, args.slot.address)) throw new CloudError("resource_ownership_ambiguous", false);
  } else verifyAssigned(args, await exactIp(adapter, args.slot.address), args.slot.address);
  // The before inventory and prior allocation/release receipt already retain a watermark if this response is lost.
  watermark(args);
  await adapter.http.request(`/linode/instances/${args.slot.instanceId}/reboot`, { method: "POST", body: { config_id: current.metadata!.configId } });
  return { remoteId: args.slot.instanceId, before, after: { ...snapshot(current), attemptId: args.attemptId, rebootRequested: true } };
}

export async function observeLinodeRotation(step: CloudStep, adapter: LinodeCloudAdapter): Promise<CloudObservation> {
  const args = validate(step, adapter);
  const current = await adapter.inspect(args.slot);
  identity(args, current);
  const base: CloudStepResult = { ...args.receipt, before: args.receipt?.before ?? snapshot(current), after: { ...args.receipt?.after, ...snapshot(current) } };
  try {
    if (step.action === "linode.ipv4.allocate") {
      // Inventory differences have no exclusive attempt attribution; even no change cannot justify another POST.
      if (!args.receipt) return { ...base, status: "ambiguous" };
      currentCapability(args, current);
      const candidate = await verifyCandidate(args, adapter, current, args.receipt);
      return { ...base, ...candidate, status: "applied" };
    }
    if (args.phase === "post_publish_cleanup") assertCleanup(args);
    const candidate = await verifyCandidate(args, adapter, current);
    if (args.phase === "post_publish_cleanup" && candidate.candidateAddress !== args.publishedAddress) return { ...base, status: "ambiguous" };
    currentCapability(args, current, args.phase === "post_publish_cleanup" ? args.publishedAddress! : args.slot.address);
    if (step.action === "linode.ipv4.release") {
      const ip = await exactIp(adapter, args.slot.address);
      if (ip) { verifyAssigned(args, ip, args.slot.address); return { ...base, status: "pending" }; }
      if (ipv4(current).includes(args.slot.address)) return { ...base, status: "ambiguous" };
      // Fresh watermark is persisted even when DELETE's response was lost, so the earlier rotation reboot cannot satisfy cleanup.
      return { remoteId: args.slot.address, allocationId: args.slot.address, resourceId: linodeIpResource(args.slot.instanceId, args.slot.address), before: snapshot(current),
        after: { ...snapshot(current), attemptId: args.attemptId, released: true }, status: "applied" };
    }
    if (args.phase === "post_publish_cleanup") {
      verifyReleaseReceipt(args);
      if (ipv4(current).includes(args.slot.address) || await exactIp(adapter, args.slot.address)) return { ...base, status: "ambiguous" };
    }
    const afterId = watermark(args);
    base.before = { ...base.before, eventWatermark: afterId };
    const events = (await adapter.events(args.slot.instanceId)).filter(event => event.id > afterId && event.action === "linode_reboot" && event.entity?.type === "linode" && event.entity.id === Number(args.slot.instanceId));
    if (events.length === 0) return { ...base, status: "pending" };
    if (events.length !== 1) return { ...base, status: "ambiguous" };
    const event = events[0]!;
    if (event.username !== args.before.metadata?.authenticatedUsername || (args.receipt?.operationId && args.receipt.operationId !== String(event.id))) return { ...base, status: "ambiguous" };
    if (event.status === "failed") throw new CloudError("cloud_operation_failed", false, undefined, "linode_reboot_failed");
    const result = { ...base, operationId: String(event.id), before: { ...base.before, eventWatermark: afterId }, after: { ...base.after, eventStatus: event.status } };
    if (!["finished", "completed"].includes(event.status ?? "") || current.state !== "running") return { ...result, status: "pending" };
    const address = current.interfaces.find(i => i.id === args.slot.interfaceId)!.addresses.find(ip => ip.family === 4 && ip.address === candidate.candidateAddress)!;
    return { ...result, candidateAddress: candidate.candidateAddress!, candidateRepeated: candidate.candidateRepeated ?? false, allocationId: candidate.allocationId!, resourceId: candidate.resourceId!,
      after: { ...result.after, attemptId: args.attemptId, addressMetadata: address.metadata ?? {}, ...(address.privateAddress === undefined ? {} : { privateAddress: address.privateAddress }) }, status: "applied" };
  } catch (error) {
    if (error instanceof CloudError && error.code === "resource_ownership_ambiguous") return { ...base, status: "ambiguous" };
    throw error;
  }
}

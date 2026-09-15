import {
  AllocateStaticIpCommand, AttachStaticIpCommand, DetachStaticIpCommand, GetInstanceCommand,
  GetOperationCommand, GetStaticIpCommand, ReleaseStaticIpCommand, SetIpAddressTypeCommand,
} from "@aws-sdk/client-lightsail";
import type { Instance, Operation, StaticIp } from "@aws-sdk/client-lightsail";
import type { CloudStep } from "@masterdns/contracts";

import { assertCleanup } from "./ec2-rotation.js";
import { CloudError, normalizeAwsError } from "./errors.js";
import type { AwsSend, CloudObservation, CloudStepResult } from "./provider.js";
import { hasCleanupOwnership, rotationResourceName } from "./resource-ownership.js";
import { rotationArguments } from "./rotation-plan.js";

const actions = new Set(["lightsail.static-ip.allocate", "lightsail.static-ip.detach", "lightsail.static-ip.attach", "lightsail.static-ip.release", "lightsail.ipv6.disable", "lightsail.ipv6.enable"]);

function validate(step: CloudStep, accountId: string) {
  const args = rotationArguments(step);
  if (!actions.has(step.action) || args.slot.accountId !== accountId || args.slot.service !== "lightsail" || !args.before.nativeName) throw new CloudError("invalid_rotation_step", false);
  return args;
}

async function readInstance(step: CloudStep, send: AwsSend): Promise<Instance> {
  const args = rotationArguments(step);
  const response = await send(new GetInstanceCommand({ instanceName: args.before.nativeName! }));
  const instance = response.instance as Instance | undefined;
  if (!instance || instance.arn !== args.slot.instanceId || instance.name !== args.before.nativeName) throw new CloudError("remote_identity_changed", false);
  return instance;
}

function snapshot(instance: Instance): Record<string, unknown> {
  return { arn: instance.arn, name: instance.name, state: instance.state?.name, ipAddressType: instance.ipAddressType, ipv4: instance.publicIpAddress, ipv6: instance.ipv6Addresses ?? [] };
}

function candidate(step: CloudStep, address?: string): CloudStepResult {
  if (!address) return {};
  const { slot, failedCandidates = [] } = rotationArguments(step);
  return { candidateAddress: address, candidateRepeated: address === slot.address || failedCandidates.includes(address) };
}

async function readStaticIp(name: string, send: AwsSend): Promise<StaticIp | undefined> {
  try {
    const response = await send(new GetStaticIpCommand({ staticIpName: name }));
    if (response.staticIp && response.staticIp.name !== name) throw new CloudError("resource_ownership_ambiguous", false);
    return response.staticIp;
  } catch (error) {
    if ((error as { name?: string }).name === "NotFoundException") return undefined;
    throw error;
  }
}

function originalAddress(step: CloudStep) {
  const { before, slot } = rotationArguments(step);
  const address = before.interfaces.find(i => i.id === slot.interfaceId)?.addresses.find(a => a.address === slot.address && a.family === 4);
  if (!address) throw new CloudError("invalid_rotation_step", false);
  return address;
}

function originalName(step: CloudStep): string {
  const name = originalAddress(step).allocationId;
  if (!name) throw new CloudError("invalid_rotation_step", false);
  return name;
}

function verifyAttachment(step: CloudStep, ip: StaticIp) {
  if (ip.attachedTo !== undefined && ip.attachedTo !== rotationArguments(step).before.nativeName) throw new CloudError("resource_ownership_ambiguous", false);
}

function verifyOriginal(step: CloudStep, ip: StaticIp): void {
  const original = originalAddress(step);
  const { receipt, ownershipSnapshot } = rotationArguments(step);
  if (!original.resourceId || ip.arn !== original.resourceId || ip.ipAddress !== original.address
    || (!step.action.endsWith("attach") && receipt?.resourceId && receipt.resourceId !== ip.arn)
    || (ownershipSnapshot?.resourceId && ownershipSnapshot.resourceId !== ip.arn)) throw new CloudError("resource_ownership_ambiguous", false);
  verifyAttachment(step, ip);
}

function verifyCandidate(step: CloudStep, ip: StaticIp, allowFirstObservation = false): CloudStepResult {
  const args = rotationArguments(step);
  const expected = step.action.endsWith("allocate") ? args.receipt : args.candidateReceipt;
  if (!ip.arn || !ip.ipAddress || !expected || ((!expected.resourceId || !expected.candidateAddress) && !allowFirstObservation)
    || (expected.resourceId && expected.resourceId !== ip.arn)
    || expected.allocationId !== ip.name
    || (expected.candidateAddress && expected.candidateAddress !== ip.ipAddress)
    || (step.action.endsWith("attach") && args.receipt?.resourceId && args.receipt.resourceId !== ip.arn)) throw new CloudError("resource_ownership_ambiguous", false);
  verifyAttachment(step, ip);
  return { remoteId: ip.name!, allocationId: ip.name!, resourceId: ip.arn, ...candidate(step, ip.ipAddress) };
}

function operationResult(operations: Operation[] = []): CloudStepResult {
  const ids = operations.flatMap(op => op.id ? [op.id] : []);
  if (!ids.length || ids.length !== operations.length) throw new CloudError("resource_ownership_ambiguous", false);
  return { ...(ids[0] ? { operationId: ids[0], operationIds: ids } : {}), after: { operations: operations.map(op => ({ id: op.id, status: op.status, resourceName: op.resourceName, operationType: op.operationType })) } };
}

export async function executeLightsailRotation(step: CloudStep, accountId: string, send: AwsSend): Promise<CloudStepResult> {
  const args = validate(step, accountId);
  if (args.previousExecution) {
    const result = await observeLightsailRotation(step, accountId, send);
    if (result.status === "applied") return result;
    throw new CloudError("resource_ownership_ambiguous", false);
  }
  const instance = await readInstance(step, send);
  if (instance.ipAddressType === "ipv6") throw new CloudError("rotation_unsupported", false, undefined, "lightsail_ipv6_only");
  const before = snapshot(instance);
  if (step.action.startsWith("lightsail.ipv6")) {
    if (args.slot.family !== 6 || (step.action.endsWith("disable") && (instance.ipAddressType !== "dualstack" || !instance.ipv6Addresses?.includes(args.slot.address)))) throw new CloudError("remote_identity_changed", false);
    if (step.action.endsWith("enable") && (instance.ipAddressType !== "ipv4" || instance.ipv6Addresses?.length)) throw new CloudError("remote_identity_changed", false);
    const response = await send(new SetIpAddressTypeCommand({ resourceName: instance.name!, resourceType: "Instance", ipAddressType: step.action.endsWith("disable") ? "ipv4" : "dualstack" }));
    return { remoteId: args.slot.instanceId, before, ...operationResult(response.operations) };
  }
  const name = rotationResourceName(step);
  if (args.slot.family !== 4) throw new CloudError("invalid_rotation_step", false);
  if (step.action === "lightsail.static-ip.allocate") {
    const original = originalAddress(step);
    if (!original.allocationId && (instance.isStaticIp !== false || instance.publicIpAddress !== args.slot.address)) throw new CloudError("remote_identity_changed", false);
    const existing = await readStaticIp(name, send);
    if (existing) {
      return { ...verifyCandidate(step, existing), before, after: { staticIp: existing } };
    }
    const response = await send(new AllocateStaticIpCommand({ staticIpName: name }));
    return { remoteId: name, allocationId: name, before, ...operationResult(response.operations) };
  }
  if (step.action === "lightsail.static-ip.detach") {
    const oldName = originalName(step);
    const old = await readStaticIp(oldName, send);
    if (!old || old.ipAddress !== args.slot.address) throw new CloudError("resource_ownership_ambiguous", false);
    verifyOriginal(step, old);
    const replacement = await readStaticIp(name, send);
    if (!replacement) throw new CloudError("resource_ownership_ambiguous", false);
    verifyCandidate(step, replacement);
    if (!old.attachedTo) return { remoteId: oldName, resourceId: old.arn!, before, after: { detached: true } };
    if (instance.publicIpAddress !== args.slot.address) throw new CloudError("remote_identity_changed", false);
    const response = await send(new DetachStaticIpCommand({ staticIpName: oldName }));
    return { remoteId: oldName, resourceId: old.arn!, before, ...operationResult(response.operations) };
  }
  if (step.action === "lightsail.static-ip.attach") {
    const replacement = await readStaticIp(name, send);
    if (!replacement) throw new CloudError("resource_ownership_ambiguous", false);
    const identity = verifyCandidate(step, replacement);
    if (replacement.attachedTo === instance.name && replacement.ipAddress === instance.publicIpAddress) return { ...identity, before, after: { staticIp: replacement } };
    if (instance.isStaticIp !== false) throw new CloudError("remote_identity_changed", false);
    const original = originalAddress(step);
    if (original.allocationId) {
      const old = await readStaticIp(original.allocationId, send);
      if (old) verifyOriginal(step, old);
      if (old?.attachedTo) throw new CloudError("resource_ownership_ambiguous", false);
    } else if (instance.publicIpAddress !== args.slot.address) throw new CloudError("remote_identity_changed", false);
    const response = await send(new AttachStaticIpCommand({ instanceName: instance.name!, staticIpName: name }));
    return { ...identity, before, ...operationResult(response.operations) };
  }
  assertCleanup(step);
  const oldName = originalName(step);
  const ownerStep = { ...step, arguments: { ...step.arguments, attemptId: args.ownershipAttemptId } };
  const old = await readStaticIp(oldName, send);
  if (!old || old.attachedTo || old.ipAddress !== args.slot.address || instance.publicIpAddress !== args.publishedAddress) throw new CloudError("resource_ownership_ambiguous", false);
  verifyOriginal(step, old);
  if (!(hasCleanupOwnership(step, { allocationId: old.name!, address: old.ipAddress!, ...(old.arn ? { resourceId: old.arn } : {}) }) || (args.ownershipAttemptId && oldName === rotationResourceName(ownerStep)))) throw new CloudError("resource_ownership_ambiguous", false);
  const response = await send(new ReleaseStaticIpCommand({ staticIpName: oldName }));
  return { remoteId: oldName, allocationId: oldName, resourceId: old.arn!, before, ...operationResult(response.operations) };
}

async function operationStatus(step: CloudStep, send: AwsSend): Promise<"ready" | "pending" | "ambiguous"> {
  const { receipt, before } = rotationArguments(step);
  const ids = receipt?.operationIds ?? (receipt?.operationId ? [receipt.operationId] : []);
  for (const id of ids) {
    const response = await send(new GetOperationCommand({ operationId: id }));
    const op = response.operation as Operation | undefined;
    if (!op || op.id !== id) return "ambiguous";
    if (op.resourceName && ![before.nativeName, rotationResourceName(step), ...(step.action.includes("static-ip") ? [originalAddress(step).allocationId] : [])].includes(op.resourceName)) return "ambiguous";
    if (op.status === "Failed") {
      const error = normalizeAwsError({ name: op.errorCode });
      throw error.code === "unknown_cloud_error" ? new CloudError("cloud_operation_failed", false) : error;
    }
    if (op.status !== "Succeeded" && op.status !== "Completed") return "pending";
  }
  return "ready";
}

export async function observeLightsailRotation(step: CloudStep, accountId: string, send: AwsSend): Promise<CloudObservation> {
  const args = validate(step, accountId);
  const instance = await readInstance(step, send);
  const base: CloudStepResult = { ...args.receipt, before: args.receipt?.before ?? { inventory: args.before }, after: snapshot(instance) };
  const status = await operationStatus(step, send);
  if (step.action.startsWith("lightsail.ipv6")) {
    if (status !== "ready") return { ...base, status };
    if (instance.ipAddressType === "ipv6") return { ...base, status: "ambiguous" };
    if (step.action.endsWith("disable")) return { ...base, status: instance.ipAddressType === "ipv4" && !instance.ipv6Addresses?.length ? "applied" : "pending" };
    const addresses = instance.ipv6Addresses ?? [];
    if (addresses.length > 1) return { ...base, status: "ambiguous" };
    return { ...base, ...candidate(step, addresses[0]), status: instance.ipAddressType === "dualstack" && addresses.length === 1 ? "applied" : "pending" };
  }
  const oldAction = step.action.endsWith("detach") || step.action.endsWith("release");
  const name = oldAction ? originalName(step) : rotationResourceName(step);
  let ip: StaticIp | undefined;
  let identity: CloudStepResult = {};
  try {
    ip = await readStaticIp(name, send);
    if (ip) {
      if (oldAction) verifyOriginal(step, ip);
      else identity = verifyCandidate(step, ip, step.action.endsWith("allocate") && Boolean(args.receipt?.operationId || args.receipt?.operationIds?.length));
    }
    if (step.action.endsWith("detach")) {
      const replacement = await readStaticIp(rotationResourceName(step), send);
      if (!replacement) return { ...base, status: "ambiguous" };
      verifyCandidate(step, replacement);
    }
  } catch (error) {
    if (error instanceof CloudError && error.code === "resource_ownership_ambiguous") return { ...base, status: "ambiguous" };
    throw error;
  }
  const result = { ...base, ...identity, ...(oldAction && ip?.arn ? { resourceId: ip.arn } : {}) };
  if (status !== "ready") return { ...result, status };
  if (step.action.endsWith("release")) return { ...result, status: ip ? "pending" : "applied" };
  if (step.action.endsWith("detach")) return { ...result, status: !ip ? "ambiguous" : ip.attachedTo ? "pending" : "applied" };
  if (!ip) return { ...result, status: args.receipt ? "pending" : "ambiguous" };
  if (step.action.endsWith("allocate")) return { ...result, status: "applied" };
  return { ...result, status: ip.attachedTo === instance.name && ip.ipAddress === instance.publicIpAddress ? "applied" : "pending" };
}

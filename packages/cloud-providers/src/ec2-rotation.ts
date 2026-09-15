import {
  AllocateAddressCommand, AssociateAddressCommand, AssignIpv6AddressesCommand,
  DescribeAddressesCommand, DescribeNetworkInterfacesCommand,
  ModifyNetworkInterfaceAttributeCommand, ReleaseAddressCommand, UnassignIpv6AddressesCommand,
} from "@aws-sdk/client-ec2";
import type { Address, NetworkInterface } from "@aws-sdk/client-ec2";
import type { CloudStep } from "@masterdns/contracts";

import { CloudError } from "./errors.js";
import type { AwsSend, CloudObservation, CloudStepResult } from "./provider.js";
import { hasCleanupOwnership, ownsRotationAddress, rotationTags } from "./resource-ownership.js";
import { rotationArguments } from "./rotation-plan.js";

const actions = new Set(["ec2.auto-ipv4.disable", "ec2.auto-ipv4.enable", "ec2.eip.allocate", "ec2.eip.associate", "ec2.eip.release", "ec2.ipv6.assign", "ec2.ipv6.unassign"]);

function validate(step: CloudStep, accountId: string) {
  const args = rotationArguments(step);
  if (!actions.has(step.action) || args.slot.accountId !== accountId || args.slot.service !== "ec2") throw new CloudError("invalid_rotation_step", false);
  return args;
}

async function readInterface(step: CloudStep, send: AwsSend): Promise<NetworkInterface> {
  const { slot } = rotationArguments(step);
  const response = await send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [slot.interfaceId] }));
  const eni = response.NetworkInterfaces?.find((n: NetworkInterface) => n.NetworkInterfaceId === slot.interfaceId) as NetworkInterface | undefined;
  if (!eni || eni.Attachment?.InstanceId !== slot.instanceId) throw new CloudError("remote_identity_changed", false);
  if (step.action.startsWith("ec2.auto-ipv4") && (eni.Attachment.DeviceIndex !== 0 || (eni.Attachment.NetworkCardIndex ?? 0) !== 0)) throw new CloudError("remote_identity_changed", false);
  return eni;
}

function originalAddress(step: CloudStep) {
  const { slot, before } = rotationArguments(step);
  const address = before.interfaces.find(i => i.id === slot.interfaceId)?.addresses.find(a => a.address === slot.address && a.family === slot.family);
  if (!address) throw new CloudError("invalid_rotation_step", false);
  return address;
}


function targetPrivateAddress(step: CloudStep, eni: NetworkInterface): string | undefined {
  const selected = originalAddress(step);
  return selected.privateAddress ?? (selected.primary ? eni.PrivateIpAddresses?.find(a => a.Primary)?.PrivateIpAddress : undefined);
}

function snapshot(eni: NetworkInterface): Record<string, unknown> {
  return { interfaceId: eni.NetworkInterfaceId, attachment: eni.Attachment, ipv4: eni.PrivateIpAddresses ?? [], ipv6: eni.Ipv6Addresses ?? [] };
}

function candidate(step: CloudStep, address?: string): CloudStepResult {
  if (!address) return {};
  const { slot, failedCandidates = [] } = rotationArguments(step);
  return { candidateAddress: address, candidateRepeated: address === slot.address || failedCandidates.includes(address) };
}

async function attemptAddress(step: CloudStep, send: AwsSend): Promise<Address | undefined> {
  const response = await send(new DescribeAddressesCommand({ Filters: rotationTags(step).map(tag => ({ Name: `tag:${tag.Key}`, Values: [tag.Value] })) }));
  const addresses: Address[] = response.Addresses ?? [];
  if (addresses.length > 1 || (addresses[0] && !ownsRotationAddress(step, addresses[0]))) throw new CloudError("resource_ownership_ambiguous", false);
  return addresses[0];
}

function allocationResult(step: CloudStep, address: Address): CloudStepResult {
  if (!address.AllocationId || !address.PublicIp) throw new CloudError("resource_ownership_ambiguous", false);
  return { remoteId: address.AllocationId, allocationId: address.AllocationId, ...candidate(step, address.PublicIp) };
}

export async function executeEc2Rotation(step: CloudStep, accountId: string, send: AwsSend): Promise<CloudStepResult> {
  const args = validate(step, accountId);
  if (args.previousExecution) {
    const result = await observeEc2Rotation(step, accountId, send);
    if (result.status === "applied") return result;
    throw new CloudError("resource_ownership_ambiguous", false);
  }
  const eni = await readInterface(step, send);
  const before = snapshot(eni);
  const selected = originalAddress(step);
  const privateAddress = eni.PrivateIpAddresses?.find(a => a.Association?.PublicIp === args.slot.address);
  if (step.action === "ec2.auto-ipv4.disable" || step.action === "ec2.auto-ipv4.enable") {
    if (args.slot.family !== 4 || selected.allocationId || !selected.primary) throw new CloudError("invalid_rotation_step", false);
    const primary = eni.PrivateIpAddresses?.find(a => a.Primary);
    if (!primary || primary.Association?.AllocationId || (step.action.endsWith("disable") && primary.Association?.PublicIp !== args.slot.address)) throw new CloudError("remote_identity_changed", false);
    if (step.action.endsWith("enable") && primary.Association?.PublicIp) throw new CloudError("remote_identity_changed", false);
    const response = await send(new ModifyNetworkInterfaceAttributeCommand({ NetworkInterfaceId: args.slot.interfaceId, AssociatePublicIpAddress: step.action.endsWith("enable") }));
    return { remoteId: args.slot.interfaceId, before, after: { accepted: response.Return ?? true } };
  }
  if (step.action === "ec2.eip.allocate") {
    if (args.slot.family !== 4 || !selected.allocationId) throw new CloudError("invalid_rotation_step", false);
    const existing = await attemptAddress(step, send);
    if (existing) return { ...allocationResult(step, existing), before, after: { address: existing } };
    const response = await send(new AllocateAddressCommand({ Domain: "vpc", TagSpecifications: [{ ResourceType: "elastic-ip", Tags: rotationTags(step) }] }));
    return { ...allocationResult(step, response), before, after: { allocationId: response.AllocationId, publicIp: response.PublicIp } };
  }
  if (step.action === "ec2.eip.associate") {
    if (args.slot.family !== 4 || !selected.allocationId) throw new CloudError("invalid_rotation_step", false);
    const address = await attemptAddress(step, send);
    if (!address?.AllocationId) throw new CloudError("resource_ownership_ambiguous", false);
    if (address.NetworkInterfaceId === args.slot.interfaceId) {
      if (address.PrivateIpAddress !== targetPrivateAddress(step, eni)) throw new CloudError("resource_ownership_ambiguous", false);
      const associated = eni.PrivateIpAddresses?.find(a => a.PrivateIpAddress === address.PrivateIpAddress && a.Association?.PublicIp === address.PublicIp);
      if (!associated) throw new CloudError("resource_ownership_ambiguous", false);
      return { ...allocationResult(step, address), before, after: before };
    }
    if (!privateAddress?.PrivateIpAddress || privateAddress.PrivateIpAddress !== targetPrivateAddress(step, eni) || (privateAddress.Association?.AllocationId && privateAddress.Association.AllocationId !== selected.allocationId)) throw new CloudError("remote_identity_changed", false);
    const response = await send(new AssociateAddressCommand({ AllocationId: address.AllocationId, NetworkInterfaceId: args.slot.interfaceId, PrivateIpAddress: privateAddress.PrivateIpAddress, AllowReassociation: false }));
    return { ...allocationResult(step, address), remoteId: response.AssociationId, before, after: { associationId: response.AssociationId } };
  }
  if (step.action === "ec2.ipv6.assign") {
    if (args.slot.family !== 6 || selected.primary || !eni.Ipv6Addresses?.some(a => a.Ipv6Address === args.slot.address && !a.IsPrimaryIpv6)) throw new CloudError("rotation_unsupported", false, undefined, "primary_ipv6_immutable_or_address_changed");
    const response = await send(new AssignIpv6AddressesCommand({ NetworkInterfaceId: args.slot.interfaceId, Ipv6AddressCount: 1 }));
    const addresses: string[] = response.AssignedIpv6Addresses ?? [];
    if (addresses.length !== 1) throw new CloudError("resource_ownership_ambiguous", false);
    return { remoteId: args.slot.interfaceId, ...candidate(step, addresses[0]), before, after: { assignedIpv6Addresses: addresses } };
  }
  assertCleanup(step);
  if (step.action === "ec2.ipv6.unassign") {
    if (args.slot.family !== 6 || selected.primary) throw new CloudError("invalid_rotation_step", false);
    const old = eni.Ipv6Addresses?.find(a => a.Ipv6Address === args.slot.address);
    if (old?.IsPrimaryIpv6) throw new CloudError("rotation_unsupported", false, undefined, "primary_ipv6_immutable");
    if (!eni.Ipv6Addresses?.some(a => a.Ipv6Address === args.publishedAddress)) throw new CloudError("remote_identity_changed", false);
    if (old) await send(new UnassignIpv6AddressesCommand({ NetworkInterfaceId: args.slot.interfaceId, Ipv6Addresses: [args.slot.address] }));
    return { remoteId: args.slot.interfaceId, before, after: { unassignedIpv6Addresses: [args.slot.address] } };
  }
  if (!selected.allocationId) throw new CloudError("invalid_rotation_step", false);
  if (!eni.PrivateIpAddresses?.some(a => a.PrivateIpAddress === targetPrivateAddress(step, eni) && a.Association?.PublicIp === args.publishedAddress)) throw new CloudError("remote_identity_changed", false);
  const ownerStep = { ...step, arguments: { ...step.arguments, attemptId: args.ownershipAttemptId } };
  const response = await send(new DescribeAddressesCommand({ AllocationIds: [selected.allocationId] }));
  const old = response.Addresses?.[0] as Address | undefined;
  // The opt-in alone never authorizes releasing a foreign or attached allocation.
  if (!old || old.AllocationId !== selected.allocationId || old.PublicIp !== args.slot.address || old.AssociationId || old.NetworkInterfaceId || !(hasCleanupOwnership(step, { allocationId: old.AllocationId!, address: old.PublicIp! }) || (args.ownershipAttemptId && ownsRotationAddress(ownerStep, old)))) throw new CloudError("resource_ownership_ambiguous", false);
  await send(new ReleaseAddressCommand({ AllocationId: selected.allocationId }));
  return { remoteId: selected.allocationId, allocationId: selected.allocationId, before, after: { released: true } };
}

export function assertCleanup(step: CloudStep): void {
  const args = rotationArguments(step);
  if (args.phase !== "post_publish_cleanup" || args.releaseAuthorized !== true || !args.publishedAddress || args.publishedAddress === args.slot.address) throw new CloudError("cleanup_not_authorized", false);
}

export async function observeEc2Rotation(step: CloudStep, accountId: string, send: AwsSend): Promise<CloudObservation> {
  const args = validate(step, accountId);
  const eni = await readInterface(step, send);
  const base: CloudStepResult = { ...args.receipt, before: args.receipt?.before ?? { inventory: args.before }, after: snapshot(eni) };
  if (step.action.startsWith("ec2.auto-ipv4")) {
    const primary = eni.PrivateIpAddresses?.find(a => a.Primary);
    if (!primary || primary.Association?.AllocationId) return { ...base, status: "ambiguous" };
    const address = primary.Association?.PublicIp;
    return step.action.endsWith("disable")
      ? { ...base, status: address ? "pending" : "applied" }
      : { ...base, ...candidate(step, address), status: address ? "applied" : "pending" };
  }
  if (step.action === "ec2.ipv6.assign") {
    const address = args.receipt?.candidateAddress;
    if (!address) return { ...base, status: "ambiguous" };
    return { ...base, ...candidate(step, address), status: eni.Ipv6Addresses?.some(a => a.Ipv6Address === address) ? "applied" : "pending" };
  }
  if (step.action === "ec2.ipv6.unassign") return { ...base, status: eni.Ipv6Addresses?.some(a => a.Ipv6Address === args.slot.address) ? "pending" : "applied" };
  if (step.action === "ec2.eip.release") {
    const selected = originalAddress(step);
    try {
      const response = await send(new DescribeAddressesCommand({ AllocationIds: [selected.allocationId!] }));
      return { ...base, status: response.Addresses?.length ? "pending" : "applied" };
    } catch (error) {
      if ((error as { name?: string }).name === "InvalidAllocationID.NotFound") return { ...base, status: "applied" };
      throw error;
    }
  }
  let address: Address | undefined;
  try { address = await attemptAddress(step, send); }
  catch (error) {
    if (error instanceof CloudError && error.code === "resource_ownership_ambiguous") return { ...base, status: "ambiguous" };
    throw error;
  }
  if (!address?.AllocationId) return { ...base, status: args.receipt ? "pending" : "ambiguous" };
  if (args.receipt?.allocationId && args.receipt.allocationId !== address.AllocationId) return { ...base, status: "ambiguous" };
  const result = { ...base, ...allocationResult(step, address) };
  if (step.action === "ec2.eip.allocate") return { ...result, status: "applied" };
  if (address.NetworkInterfaceId === args.slot.interfaceId && address.PrivateIpAddress !== targetPrivateAddress(step, eni)) return { ...result, status: "ambiguous" };
  const attached = address.NetworkInterfaceId === args.slot.interfaceId && eni.PrivateIpAddresses?.some(a => a.PrivateIpAddress === address.PrivateIpAddress && a.Association?.PublicIp === address.PublicIp);
  return { ...result, status: attached ? "applied" : "pending" };
}

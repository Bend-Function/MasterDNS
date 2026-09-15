import type { Address } from "@aws-sdk/client-ec2";
import type { CloudStep } from "@masterdns/contracts";

import { rotationArguments } from "./rotation-plan.js";

export function rotationTags(step: CloudStep): Array<{ Key: string; Value: string }> {
  const { slot, attemptId } = rotationArguments(step);
  return [
    { Key: "masterdns:attempt", Value: attemptId },
    { Key: "masterdns:account", Value: slot.accountId },
    { Key: "masterdns:instance", Value: slot.instanceId },
    { Key: "masterdns:slot", Value: slot.slotId },
  ];
}

export function rotationResourceName(step: CloudStep): string {
  return `masterdns-${rotationArguments(step).attemptId}`;
}

export function ownsRotationAddress(step: CloudStep, address: Address): boolean {
  const { slot } = rotationArguments(step);
  return rotationTags(step).every(expected => address.Tags?.some(tag => tag.Key === expected.Key && tag.Value === expected.Value))
    && (address.InstanceId === undefined || address.InstanceId === slot.instanceId)
    && (address.NetworkInterfaceId === undefined || address.NetworkInterfaceId === slot.interfaceId);
}

export function hasCleanupOwnership(step: CloudStep, resource: { allocationId?: string; address?: string; resourceId?: string }): boolean {
  const { slot, before, ownershipSnapshot: proof } = rotationArguments(step);
  const original = before.interfaces.find(i => i.id === slot.interfaceId)?.addresses.find(a => a.address === slot.address && a.family === slot.family);
  if (!proof || !original) return false;
  return proof.accountId === slot.accountId && proof.instanceId === slot.instanceId && proof.interfaceId === slot.interfaceId
    && proof.address === slot.address && proof.address === resource.address
    && proof.allocationId === original.allocationId && proof.allocationId === resource.allocationId
    && (slot.service === "ec2" || (typeof proof.resourceId === "string" && proof.resourceId.length > 0 && proof.resourceId === original.resourceId && proof.resourceId === resource.resourceId));
}

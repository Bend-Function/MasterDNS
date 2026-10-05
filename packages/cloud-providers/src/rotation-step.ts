import { cloudServiceIds, type CloudStep, type SlotRef } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import type { CloudInventory, CloudStepResult } from "./provider.js";

export type RotationAction =
  | "ec2.auto-ipv4.disable" | "ec2.auto-ipv4.enable"
  | "ec2.eip.allocate" | "ec2.eip.associate" | "ec2.eip.release"
  | "ec2.ipv6.assign" | "ec2.ipv6.unassign"
  | "lightsail.static-ip.allocate" | "lightsail.static-ip.detach" | "lightsail.static-ip.attach" | "lightsail.static-ip.release"
  | "lightsail.ipv6.disable" | "lightsail.ipv6.enable"
  | "azure.public-ip.allocate" | "azure.public-ip.associate" | "azure.public-ip.delete"
  | "linode.ipv4.allocate" | "linode.instance.reboot" | "linode.instance.stop" | "linode.instance.start" | "linode.ipv4.release"
  | "linode.swap.allocate" | "linode.ipv4.swap" | "linode.swap.delete";

export type LinodeSwapOptions = {
  linodeIpv4Strategy?: "additional_ipv4" | "instance_swap";
  linodeSwapPlan?: string;
  allowTemporaryInstance?: boolean;
};

/** Trusted server-side evidence captured while the original allocation belonged to this slot. */
export type CleanupOwnershipSnapshot = {
  accountId: string;
  instanceId: string;
  interfaceId: string;
  allocationId: string;
  address: string;
  resourceId?: string;
};

export type RotationStepArguments = LinodeSwapOptions & {
  slot: SlotRef;
  attemptId: string;
  before: CloudInventory;
  phase: "rotation" | "post_publish_cleanup";
  receipt?: CloudStepResult;
  /** Persisted applied allocation observation, carried into subsequent provider steps. */
  candidateReceipt?: CloudStepResult;
  /** Trusted receipts from earlier persisted applied steps, in execution order. */
  priorReceipts?: Array<{ action: string; receipt: CloudStepResult }>;
  allowStop?: boolean;
  linodeRestartMode?: "reboot" | "stop_start";
  /** Set on recovery of a previously dispatched step; never blindly reissue uncertain writes. */
  previousExecution?: boolean;
  failedCandidates?: string[];
  /** Only cleanup steps may use this explicit, freshly rechecked authorization. */
  releaseAuthorized?: boolean;
  publishedAddress?: string;
  ownershipAttemptId?: string;
  ownershipSnapshot?: CleanupOwnershipSnapshot;
  /** Fresh selected replacement topology, independent of the old resource attempt. */
  publishedInventory?: CloudInventory;
  publishedReceipt?: CloudStepResult;
  publishedAttemptId?: string;
  /** Immutable applied allocation receipt for a system-owned cleanup resource. */
  cleanupReceipt?: CloudStepResult;
  /** Applied IP swap ownership proof for the exact temporary instance being deleted. */
  linodeSwapReceipt?: CloudStepResult;
};

export function rotationArguments(step: CloudStep): RotationStepArguments {
  const a = step.arguments as unknown as RotationStepArguments;
  if (!a.slot || !a.before || typeof a.attemptId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?$/.test(a.attemptId)) {
    throw new CloudError("invalid_rotation_step", false);
  }
  if (![a.slot.accountId, a.slot.instanceId, a.slot.region, a.slot.slotId, a.slot.interfaceId, a.slot.address].every(value => typeof value === "string" && value.length > 0)
    || !cloudServiceIds.includes(a.slot.service) || ![4, 6].includes(a.slot.family)
    || !["rotation", "post_publish_cleanup"].includes(a.phase) || !Array.isArray(a.before.interfaces)) throw new CloudError("invalid_rotation_step", false);
  if (a.slot.accountId !== a.before.ref?.accountId || a.slot.instanceId !== a.before.ref?.instanceId || a.slot.region !== a.before.ref?.region || a.slot.service !== a.before.ref?.service) {
    throw new CloudError("invalid_rotation_step", false);
  }
  return a;
}

export function makeRotationStep(action: RotationAction, args: RotationStepArguments, index: number): CloudStep {
  const step: CloudStep = {
    id: `${args.attemptId}:${index}:${action}`,
    action,
    resourceKey: JSON.stringify([args.slot.accountId, args.slot.service, args.slot.region, args.slot.instanceId, args.slot.interfaceId, args.slot.slotId]),
    arguments: structuredClone(args) as unknown as Record<string, unknown>,
    destructive: !action.endsWith("allocate") && action !== "ec2.ipv6.assign",
  };
  rotationArguments(step);
  return step;
}

/** Build only after DNS publication, fresh release authorization and trusted ownership evidence. */
export type CleanupPlanOptions = LinodeSwapOptions & {
  attemptId: string;
  releaseAuthorized: boolean;
  publishedAddress: string;
  ownershipAttemptId?: string;
  ownershipSnapshot?: CleanupOwnershipSnapshot;
  /** Fresh selected replacement topology, independent of the old resource attempt. */
  publishedInventory?: CloudInventory;
  publishedReceipt?: CloudStepResult;
  publishedAttemptId?: string;
  /** Immutable applied allocation receipt for a system-owned cleanup resource. */
  cleanupReceipt?: CloudStepResult;
  linodeSwapReceipt?: CloudStepResult;
  allowStop?: boolean;
  linodeRestartMode?: "reboot" | "stop_start";
};


export type RotationPlanOptions = LinodeSwapOptions & { allowStop: boolean; attemptId: string; linodeRestartMode?: "reboot" | "stop_start" };

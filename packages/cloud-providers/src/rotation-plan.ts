import type { CloudStep, SlotRef } from "@masterdns/contracts";

import { evaluateCapabilities } from "./capabilities.js";
import { CloudError } from "./errors.js";
import type { CloudInventory, CloudStepResult } from "./provider.js";

export type RotationAction =
  | "ec2.auto-ipv4.disable" | "ec2.auto-ipv4.enable"
  | "ec2.eip.allocate" | "ec2.eip.associate" | "ec2.eip.release"
  | "ec2.ipv6.assign" | "ec2.ipv6.unassign"
  | "lightsail.static-ip.allocate" | "lightsail.static-ip.detach" | "lightsail.static-ip.attach" | "lightsail.static-ip.release"
  | "lightsail.ipv6.disable" | "lightsail.ipv6.enable"
  | "azure.public-ip.allocate" | "azure.public-ip.associate" | "azure.public-ip.delete"
  | "linode.ipv4.allocate" | "linode.instance.reboot" | "linode.ipv4.release";

/** Trusted server-side evidence captured while the original allocation belonged to this slot. */
export type CleanupOwnershipSnapshot = {
  accountId: string;
  instanceId: string;
  interfaceId: string;
  allocationId: string;
  address: string;
  resourceId?: string;
};

export type RotationStepArguments = {
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
  /** Set on recovery of a previously dispatched step; never blindly reissue uncertain writes. */
  previousExecution?: boolean;
  failedCandidates?: string[];
  /** Only cleanup steps may use this explicit, freshly rechecked authorization. */
  releaseAuthorized?: boolean;
  publishedAddress?: string;
  ownershipAttemptId?: string;
  ownershipSnapshot?: CleanupOwnershipSnapshot;
};

export function rotationArguments(step: CloudStep): RotationStepArguments {
  const a = step.arguments as unknown as RotationStepArguments;
  if (!a.slot || !a.before || typeof a.attemptId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?$/.test(a.attemptId)) {
    throw new CloudError("invalid_rotation_step", false);
  }
  if (![a.slot.accountId, a.slot.instanceId, a.slot.region, a.slot.slotId, a.slot.interfaceId, a.slot.address].every(value => typeof value === "string" && value.length > 0)
    || !["ec2", "lightsail", "azure_vm", "linode"].includes(a.slot.service) || ![4, 6].includes(a.slot.family)
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

export function planCloudRotation(slot: SlotRef, inventory: CloudInventory, options: { allowStop: boolean; attemptId: string }): CloudStep[] {
  const capability = evaluateCapabilities(slot, inventory);
  if (!capability.available) throw new CloudError("rotation_unsupported", false, undefined, capability.reason);
  if (capability.requiresStop && !options.allowStop) throw new CloudError("rotation_unsupported", false, undefined, "stop_not_authorized");
  const address = inventory.interfaces.find(i => i.id === slot.interfaceId)!.addresses.find(a => a.address === slot.address && a.family === slot.family)!;
  let actions: RotationAction[];
  if (slot.service === "ec2") {
    actions = slot.family === 6 ? ["ec2.ipv6.assign"]
      : address.allocationId ? ["ec2.eip.allocate", "ec2.eip.associate"]
        : ["ec2.auto-ipv4.disable", "ec2.auto-ipv4.enable"];
  } else {
    if (!inventory.nativeName) throw new CloudError("rotation_unsupported", false, undefined, "native_name_missing");
    if (slot.family === 6) actions = ["lightsail.ipv6.disable", "lightsail.ipv6.enable"];
    else if (address.allocationId) actions = ["lightsail.static-ip.allocate", "lightsail.static-ip.detach", "lightsail.static-ip.attach"];
    else actions = ["lightsail.static-ip.allocate", "lightsail.static-ip.attach"];
  }
  const args: RotationStepArguments = { slot, attemptId: options.attemptId, before: inventory, phase: "rotation" };
  const steps = actions.map((action, index) => makeRotationStep(action, args, index));
  rotationArguments(steps[0]!);
  return steps;
}

/** Build only after DNS publication, fresh release authorization and trusted ownership evidence. */
export type CleanupPlanOptions = {
  attemptId: string;
  releaseAuthorized: boolean;
  publishedAddress: string;
  ownershipAttemptId?: string;
  ownershipSnapshot?: CleanupOwnershipSnapshot;
  allowStop?: boolean;
};

export function planCloudRotationCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
  if (!options.releaseAuthorized || !options.publishedAddress || options.publishedAddress === slot.address) throw new CloudError("cleanup_not_authorized", false);
  // Validate the original slot against its persisted pre-rotation inventory.
  planCloudRotation(slot, inventory, { allowStop: false, attemptId: options.attemptId });
  const selected = inventory.interfaces.find(i => i.id === slot.interfaceId)!.addresses.find(a => a.address === slot.address && a.family === slot.family)!;
  let action: RotationAction;
  if (slot.service === "ec2" && slot.family === 6) action = "ec2.ipv6.unassign";
  else if (selected.allocationId) {
    if (!options.ownershipAttemptId && !options.ownershipSnapshot) throw new CloudError("resource_ownership_ambiguous", false);
    action = slot.service === "ec2" ? "ec2.eip.release" : "lightsail.static-ip.release";
  } else throw new CloudError("rotation_unsupported", false, undefined, "no_releasable_resource");
  const step = makeRotationStep(action, { slot, before: inventory, phase: "post_publish_cleanup", ...options }, 0);
  rotationArguments(step);
  return [step];
}

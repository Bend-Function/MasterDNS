import type { CloudStep, SlotRef } from "@masterdns/contracts";
import type { CloudInventory } from "./provider.js";
import { awsCapabilities } from "./aws-capabilities.js";
import { CloudError } from "./errors.js";
import { makeRotationStep, rotationArguments, type LinodeSwapOptions, type RotationAction, type RotationStepArguments, type CleanupPlanOptions } from "./rotation-step.js";

export function planAwsRotation(slot: SlotRef, inventory: CloudInventory, options: LinodeSwapOptions & { allowStop: boolean; attemptId: string; linodeRestartMode?: "reboot" | "stop_start" }): CloudStep[] {
  const capability = awsCapabilities(slot, inventory);
  if (!capability.available) throw new CloudError("rotation_unsupported", false, undefined, capability.reason);
  if (capability.requiresStop && !options.allowStop) throw new CloudError("rotation_unsupported", false, undefined, "stop_not_authorized");
  const address = inventory.interfaces.find(i => i.id === slot.interfaceId)!.addresses.find(a => a.address === slot.address && a.family === slot.family)!;
  let actions: RotationAction[];
  if (slot.service === "ec2") {
    actions = slot.family === 6 ? ["ec2.ipv6.assign"]
      : address.allocationId ? ["ec2.eip.allocate", "ec2.eip.associate"]
        : ["ec2.auto-ipv4.disable", "ec2.auto-ipv4.enable"];
  } else if (slot.service === "lightsail") {
    if (!inventory.nativeName) throw new CloudError("rotation_unsupported", false, undefined, "native_name_missing");
    if (slot.family === 6) actions = ["lightsail.ipv6.disable", "lightsail.ipv6.enable"];
    else if (address.allocationId) actions = ["lightsail.static-ip.allocate", "lightsail.static-ip.detach", "lightsail.static-ip.attach"];
    else actions = ["lightsail.static-ip.allocate", "lightsail.static-ip.attach"];
  }
  else throw new CloudError("rotation_unsupported", false, undefined, "service_unavailable");
  const args: RotationStepArguments = { slot, attemptId: options.attemptId, before: inventory, phase: "rotation" };
  const steps = actions.map((action, index) => makeRotationStep(action, args, index));
  rotationArguments(steps[0]!);
  return steps;
}

export function planAwsRotationCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
  if (slot.service !== "ec2" && slot.service !== "lightsail") throw new CloudError("rotation_unsupported", false, undefined, "service_unavailable");
  if (!options.releaseAuthorized || !options.publishedAddress || options.publishedAddress === slot.address) throw new CloudError("cleanup_not_authorized", false);
  // Validate the original slot against its persisted pre-rotation inventory.
  planAwsRotation(slot, inventory, { allowStop: false, attemptId: options.attemptId });
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

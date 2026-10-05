import type { CloudStep, SlotRef } from "@masterdns/contracts";
import type { CloudInventory } from "./provider.js";
import type { RotationPlanOptions, CleanupPlanOptions } from "./rotation-step.js";
import { cloudServiceRegistry } from "./registry.js";

export * from "./rotation-step.js";
export function planCloudRotation(slot: SlotRef, inventory: CloudInventory, options: RotationPlanOptions): CloudStep[] {
  return cloudServiceRegistry.planRotation(slot, inventory, options);
}
export function planCloudRotationCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
  return cloudServiceRegistry.planCleanup(slot, inventory, options);
}

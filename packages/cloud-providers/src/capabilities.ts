import type { SlotRef } from "@masterdns/contracts";
import type { Capability, CloudInventory } from "./provider.js";
import { cloudServiceRegistry } from "./registry.js";

export function evaluateCapabilities(slot: SlotRef, inventory: CloudInventory): Capability {
  return cloudServiceRegistry.evaluateCapabilities(slot, inventory);
}

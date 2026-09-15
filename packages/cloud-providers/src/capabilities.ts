import type { SlotRef } from "@masterdns/contracts";

import type { Capability, CloudInventory } from "./provider.js";

const unavailable = (reason: string): Capability => ({
  available: false,
  reason,
  permission: "unverified",
  requiresStop: false,
  releasesOldAddress: false,
  canRestoreOldAddress: false,
});

export function evaluateCapabilities(slot: SlotRef, inventory: CloudInventory): Capability {
  const ref = inventory.ref;
  if (slot.accountId !== ref.accountId || slot.service !== ref.service || slot.region !== ref.region || slot.instanceId !== ref.instanceId) {
    return unavailable("inventory_mismatch");
  }
  const networkInterface = inventory.interfaces.find((candidate) => candidate.id === slot.interfaceId);
  if (networkInterface === undefined) return unavailable("interface_not_found");
  const address = networkInterface.addresses.find((candidate) => candidate.address === slot.address && candidate.family === slot.family);
  if (address === undefined) return unavailable("address_not_found");
  if (inventory.ref.service === "lightsail" && inventory.ipv6Only) return unavailable("lightsail_ipv6_only");
  if (inventory.ref.service === "ec2" && networkInterface.deviceIndex !== 0) {
    return unavailable("secondary_interface_unsupported");
  }
  if (slot.family === 6 && address.primary) {
    return unavailable("primary_ipv6_immutable");
  }
  return {
    available: true,
    permission: "unverified",
    requiresStop: false,
    releasesOldAddress: false,
    canRestoreOldAddress: false,
  };
}

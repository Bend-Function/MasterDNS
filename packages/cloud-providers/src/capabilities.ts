import { isIP } from "node:net";
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
  if (isIP(slot.address) !== slot.family) return unavailable("invalid_address");
  if (slot.family === 4) {
    const [first = 0, second = 0] = slot.address.split(".").map(Number);
    if (first === 10 || first === 127 || first === 0 || first >= 224 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127)) return unavailable("private_ipv4_unsupported");
    if (ref.service === "ec2" && !address.allocationId && !address.primary) return unavailable("secondary_interface_unsupported");
    if (ref.service === "ec2" && address.allocationId && !address.primary && !address.privateAddress) return unavailable("private_address_unknown");
  }
  if (inventory.ref.service === "lightsail" && inventory.ipv6Only === undefined) return unavailable("lightsail_address_type_unknown");
  if (inventory.ref.service === "lightsail" && inventory.ipv6Only) return unavailable("lightsail_ipv6_only");
  if (inventory.ref.service === "ec2" && slot.family === 4 && !address.allocationId && networkInterface.deviceIndex !== 0) {
    return unavailable("secondary_interface_unsupported");
  }
  if (inventory.ref.service === "ec2" && slot.family === 6 && address.primary) {
    return unavailable("primary_ipv6_immutable");
  }
  return {
    available: true,
    permission: "unverified",
    requiresStop: false,
    releasesOldAddress: (slot.family === 4 && !address.allocationId) || (ref.service === "lightsail" && slot.family === 6),
    canRestoreOldAddress: false,
  };
}

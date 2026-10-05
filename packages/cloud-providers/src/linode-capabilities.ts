import { isIP } from "node:net";
import type { CloudRef, SlotRef } from "@masterdns/contracts";
import type { Capability, CloudInventory } from "./provider.js";
const no = (reason: string): Capability => ({ available: false, reason, permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false });
export function publicLinodeAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false;
  if (family === 6) return /^[23]/i.test(address);
  const [a = 0, b = 0] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
}
export function linodeIpResource(instanceId: string, address: string): string { return `/linode/instances/${instanceId}/ips/${address}`; }
export function linodeCapabilities(slot: SlotRef, inventory: CloudInventory, permission: "read" | "write" = "write"): Capability {
  const ref = inventory.ref;
  if (slot.service !== "linode" || ref.service !== "linode" || ["accountId", "instanceId", "region"].some(key => slot[key as keyof CloudRef] !== ref[key as keyof CloudRef])) return no("inventory_mismatch");
  const ni = inventory.interfaces.find(i => i.id === slot.interfaceId);
  if (!ni) return no("interface_not_found");
  const ip = ni.addresses.find(ip => ip.address === slot.address && ip.family === slot.family);
  if (!ip || !publicLinodeAddress(slot.address, slot.family)) return no("address_not_found");
  if (slot.family === 6) return no("linode_slaac_ipv6_immutable");
  if (ip.metadata?.reserved === true) return no("linode_reserved_ipv4_lifecycle_unsupported");
  const m = inventory.metadata ?? {};
  if (m.interfaceGeneration !== "legacy_config") return no("linode_new_interfaces_unsupported");
  if (slot.interfaceId !== "public") return no("interface_not_found");
  if (inventory.state !== "running") return no("linode_not_running");
  if (m.configCount !== 1 || !Number.isSafeInteger(m.configId)) return no("linode_boot_config_ambiguous");
  if (m.networkHelper !== true) return no("linode_network_helper_required");
  if (m.runLevel !== "default") return no("linode_boot_mode_unsupported");
  if (m.simplePublicInterface !== true) return no("linode_public_config_required");
  if (m.advancedNetworking !== false) return no("linode_advanced_networking_unsupported");
  if (!Number.isSafeInteger(m.eventWatermark) || Number(m.eventWatermark) < 0 || typeof m.externalAccountId !== "string" || !m.externalAccountId
    || typeof m.authenticatedUsername !== "string" || !m.authenticatedUsername) return no("linode_event_observation_required");
  const scopes = Array.isArray(m.permissionScopes) ? m.permissionScopes : [];
  if (!scopes.includes("*") && ![permission === "write" ? "linodes:read_write" : "linodes:read_only", "ips:read_only", "events:read_only"].every(scope => scopes.includes(scope) || scopes.includes(scope.replace("read_only", "read_write")))) return no("linode_permissions_required");
  if (ip.allocationId !== slot.address || ip.resourceId !== linodeIpResource(slot.instanceId, slot.address)) return no("linode_address_ownership_unknown");
  return { available: true, permission: "unverified", requiresStop: true, releasesOldAddress: false, canRestoreOldAddress: false };
}


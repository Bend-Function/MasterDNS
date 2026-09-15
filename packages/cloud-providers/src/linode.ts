import { isIP } from "node:net";
import type { CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import { LinodeHttp } from "./linode-http.js";
import { executeLinodeRotation, observeLinodeRotation } from "./linode-rotation.js";
import type { Capability, CloudAdapter, CloudAddress, CloudInventory, CloudPage, LinodeCredentials } from "./provider.js";

export type LinodeIp = { address?: string; type?: string; public?: boolean; linode_id?: number; region?: string; reserved?: boolean };
export type LinodeEvent = { id: number; action?: string; entity?: { type?: string; id?: number }; status?: string; username?: string };
type LinodeInstance = { id: number; label?: string; region?: string; status?: string; interface_generation?: string };
type LinodeConfig = { id?: number; helpers?: { network?: boolean }; run_level?: string; interfaces?: Array<{ purpose?: string; primary?: boolean; ipv4?: unknown; ip_ranges?: unknown[]; subnet_id?: unknown; vpc_id?: unknown }> | null };
type LinodeIps = { ipv4?: { public?: LinodeIp[]; shared?: unknown[]; reserved?: LinodeIp[] }; ipv6?: { slaac?: LinodeIp; global?: unknown[] } };
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

export class LinodeCloudAdapter implements CloudAdapter {
  readonly http: LinodeHttp;
  private username?: string;
  constructor(readonly accountId: string, credentials: LinodeCredentials, dependencies: { fetch?: typeof fetch } = {}) {
    if (credentials.kind !== "linode_token" || !credentials.token.trim()) throw new CloudError("invalid_credentials", false);
    this.http = new LinodeHttp(credentials.token, dependencies.fetch);
  }
  async verifyIdentity(): Promise<{ externalAccountId: string }> {
    const profile = await this.http.request<{ username?: string }>("/profile");
    if (typeof profile.username !== "string" || !profile.username) throw new CloudError("remote_identity_changed", false);
    if (this.username !== undefined && this.username !== profile.username) throw new CloudError("remote_identity_changed", false);
    this.username = profile.username;
    return { externalAccountId: this.http.externalAccountId! };
  }
  async listScopes(): Promise<string[]> {
    const regions = await this.http.all<{ id?: string }>("/regions");
    if (regions.some(r => typeof r.id !== "string" || !/^[a-z0-9-]+$/.test(r.id))) throw new CloudError("unknown_cloud_error", false);
    return regions.map(r => r.id!);
  }
  private validateRef(ref: CloudRef) {
    if (ref.accountId !== this.accountId || ref.service !== "linode" || !/^[1-9][0-9]*$/.test(ref.instanceId) || !Number.isSafeInteger(Number(ref.instanceId)) || !/^[a-z0-9-]+$/.test(ref.region)) throw new CloudError("remote_identity_changed", false);
  }
  async discover(region: string, cursor?: string): Promise<CloudPage> {
    if (!/^[a-z0-9-]+$/.test(region)) throw new CloudError("invalid_cursor", false);
    if (!this.username) await this.verifyIdentity();
    let page = 1;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { accountId?: string; externalAccountId?: string; region?: string; page?: number };
        if (value.accountId !== this.accountId || value.externalAccountId !== this.http.externalAccountId || value.region !== region || !Number.isSafeInteger(value.page) || value.page! < 2) throw new Error();
        page = value.page!;
      } catch { throw new CloudError("invalid_cursor", false); }
    }
    const result = await this.http.page<LinodeInstance>("/linode/instances", page, { region });
    const items: CloudInventory[] = [];
    for (const instance of result.data) {
      if (instance.region !== region || !Number.isSafeInteger(instance.id) || instance.id < 1) throw new CloudError("remote_identity_changed", false);
      items.push(await this.inspect({ accountId: this.accountId, service: "linode", region, instanceId: String(instance.id) }));
    }
    return { items, ...(page < result.pages ? { cursor: Buffer.from(JSON.stringify({ accountId: this.accountId, externalAccountId: this.http.externalAccountId, region, page: page + 1 })).toString("base64url") } : {}) };
  }
  async events(instanceId: string): Promise<LinodeEvent[]> {
    const events = await this.http.all<LinodeEvent>("/account/events", { "entity.id": Number(instanceId), "entity.type": "linode" });
    if (events.some(e => !Number.isSafeInteger(e.id) || e.id < 1) || new Set(events.map(e => e.id)).size !== events.length) throw new CloudError("unknown_cloud_error", false, undefined, "linode_invalid_events");
    return events;
  }
  async inspect(ref: CloudRef): Promise<CloudInventory> {
    this.validateRef(ref);
    if (!this.username) await this.verifyIdentity();
    const instance = await this.http.request<LinodeInstance>(`/linode/instances/${ref.instanceId}`);
    if (String(instance.id) !== ref.instanceId || instance.region !== ref.region) throw new CloudError("remote_identity_changed", false);
    const ips = await this.http.request<LinodeIps>(`/linode/instances/${ref.instanceId}/ips`);
    if (!Array.isArray(ips.ipv4?.public)) throw new CloudError("unknown_cloud_error", false, undefined, "linode_invalid_network_inventory");
    const addresses: CloudAddress[] = [];
    for (const ip of ips.ipv4.public) {
      if (ip.linode_id !== Number(ref.instanceId) || ip.region !== ref.region) throw new CloudError("remote_identity_changed", false);
      if (typeof ip.address !== "string" || ip.type !== "ipv4" || ip.public !== true || !publicLinodeAddress(ip.address, 4)) continue;
      addresses.push({ address: ip.address, family: 4, primary: addresses.length === 0, allocationId: ip.address, resourceId: linodeIpResource(ref.instanceId, ip.address), metadata: { linodeId: ip.linode_id, region: ip.region, reserved: ip.reserved === true } });
    }
    const slaac = ips.ipv6?.slaac;
    if (slaac?.address && publicLinodeAddress(slaac.address.split("/")[0]!, 6)) {
      if ((slaac.linode_id !== undefined && slaac.linode_id !== Number(ref.instanceId)) || (slaac.region !== undefined && slaac.region !== ref.region)) throw new CloudError("remote_identity_changed", false);
      addresses.push({ address: slaac.address.split("/")[0]!, family: 6, primary: true, metadata: { kind: "slaac", immutable: true } });
    }
    const legacy = instance.interface_generation === "legacy_config";
    let config: LinodeConfig | undefined, configCount = 0, eventWatermark: number | undefined;
    if (legacy) {
      const configs = await this.http.all<LinodeConfig>(`/linode/instances/${ref.instanceId}/configs`);
      configCount = configs.length; config = configs.length === 1 ? configs[0] : undefined;
      try { eventWatermark = Math.max(0, ...(await this.events(ref.instanceId)).map(e => e.id)); }
      catch (error) { if (!(error instanceof CloudError && error.code === "permission_denied")) throw error; }
    }
    const ifaces = config?.interfaces;
    const simplePublicInterface = Array.isArray(ifaces) && (ifaces.length === 0 || (ifaces.length === 1 && ifaces[0]?.purpose === "public" && !ifaces[0].subnet_id && !ifaces[0].vpc_id && !ifaces[0].ipv4 && !ifaces[0].ip_ranges?.length));
    const metadata = { externalAccountId: this.http.externalAccountId!, authenticatedUsername: this.username!, permissionScopes: this.http.permissionScopes, interfaceGeneration: instance.interface_generation ?? "unknown", configCount,
      ...(config?.id === undefined ? {} : { configId: config.id }), networkHelper: config?.helpers?.network === true, runLevel: config?.run_level ?? "unknown", simplePublicInterface,
      advancedNetworking: !Array.isArray(ips.ipv4.shared) || ips.ipv4.shared.length > 0 || !Array.isArray(ips.ipv6?.global) || ips.ipv6.global.length > 0,
      ...(eventWatermark === undefined ? {} : { eventWatermark }) };
    return { ref: { ...ref }, name: instance.label ?? ref.instanceId, state: instance.status ?? "unknown", metadata,
      interfaces: [{ id: legacy ? "public" : "linode-public", deviceIndex: 0, metadata: { interfaceGeneration: metadata.interfaceGeneration, ...(config?.id === undefined ? {} : { configId: config.id }) }, addresses }] };
  }
  capabilities(slot: SlotRef, inventory: CloudInventory): Capability { return linodeCapabilities(slot, inventory); }
  execute(step: CloudStep) { return executeLinodeRotation(step, this); }
  async observe(step: CloudStep) { return (await this.observeDetails(step)).status; }
  observeDetails(step: CloudStep) { return observeLinodeRotation(step, this); }
}

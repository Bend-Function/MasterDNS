import { linodeCapabilities, linodeIpResource, publicLinodeAddress } from "./linode-capabilities.js";
export { linodeCapabilities, linodeIpResource, publicLinodeAddress } from "./linode-capabilities.js";
import type { CloudLifecycleAction, CloudLifecycleReceipt, CloudLifecycleSnapshot, CloudPowerState, CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import { assertLifecycleAction, assertLifecycleSnapshot, lifecycleNoWrite, sameLifecycleRef } from "./lifecycle.js";
import { monthlyTrafficResult, trafficNumber } from "./monthly-traffic.js";
import { LinodeHttp } from "./linode-http.js";
import { executeLinodeRotation, observeLinodeRotation } from "./linode-rotation.js";
import type { Capability, CloudAdapter, CloudAddress, CloudInventory, CloudPage, LinodeCredentials } from "./provider.js";
import { createCloudFetch } from "./proxy.js";

export type LinodeIp = { address?: string; type?: string; public?: boolean; linode_id?: number; region?: string; reserved?: boolean; interface_id?: number | null; vpc_nat_1_1?: unknown; assigned_entity?: { id?: number; type?: string } | null };
export type LinodeEvent = { id: number; action?: string; entity?: { type?: string; id?: number }; status?: string; username?: string };
type LinodeInstance = { id: number; label?: string; region?: string; status?: string; created?: string; interface_generation?: string };
type LinodeConfig = { id?: number; helpers?: { network?: boolean }; run_level?: string; interfaces?: Array<{ purpose?: string; primary?: boolean; ipv4?: unknown; ip_ranges?: unknown[]; subnet_id?: unknown; vpc_id?: unknown }> | null };
type LinodeIps = { ipv4?: { public?: LinodeIp[]; shared?: unknown[]; reserved?: LinodeIp[] }; ipv6?: { slaac?: LinodeIp; global?: unknown[] } };
export class LinodeCloudAdapter implements CloudAdapter {
  readonly http: LinodeHttp;
  private username?: string;
  constructor(readonly accountId: string, credentials: LinodeCredentials, dependencies: { fetch?: typeof fetch } = {}) {
    if (credentials.kind !== "linode_token" || !credentials.token.trim()) throw new CloudError("invalid_credentials", false);
    const proxyFetch = createCloudFetch(credentials.proxyUrl);
    this.http = new LinodeHttp(credentials.token, dependencies.fetch ?? proxyFetch);
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
  async monthlyTraffic(ref: CloudRef, now = new Date()) {
    this.validateRef(ref);
    const root = `/linode/instances/${ref.instanceId}/transfer`;
    const usage = await this.http.request<{ bytes_in?: number; bytes_out?: number }>(`${root}/${now.getUTCFullYear()}/${now.getUTCMonth() + 1}`);
    // This quota is a contribution to the shared transfer pool, not an isolated VM limit.
    let gigabytes: number | null = null;
    try {
      const quota = await this.http.request<{ quota?: number }>(root);
      gigabytes = trafficNumber(quota.quota);
    } catch (error) {
      if (!(error instanceof CloudError) || !["permission_denied", "rate_limited", "temporary_cloud_error"].includes(error.code)) throw error;
    }
    return monthlyTrafficResult("linode", now, trafficNumber(usage.bytes_in), trafficNumber(usage.bytes_out), gigabytes === null ? null : { gigabytes, scope: "account_pool" });
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
      ...(typeof instance.created === "string" ? { instanceCreated: instance.created } : {}),
      reservedIpv4Count: Array.isArray(ips.ipv4.reserved) ? ips.ipv4.reserved.length : undefined,
      ...(config?.id === undefined ? {} : { configId: config.id }), networkHelper: config?.helpers?.network === true, runLevel: config?.run_level ?? "unknown", simplePublicInterface,
      advancedNetworking: !Array.isArray(ips.ipv4.shared) || ips.ipv4.shared.length > 0 || !Array.isArray(ips.ipv6?.global) || ips.ipv6.global.length > 0,
      ...(eventWatermark === undefined ? {} : { eventWatermark }) };
    return { ref: { ...ref }, name: instance.label ?? ref.instanceId, state: instance.status ?? "unknown", metadata,
      interfaces: [{ id: legacy ? "public" : "linode-public", deviceIndex: 0, metadata: { interfaceGeneration: metadata.interfaceGeneration, ...(config?.id === undefined ? {} : { configId: config.id }) }, addresses }] };
  }
  async inspectLifecycle(ref: CloudRef): Promise<CloudLifecycleSnapshot> {
    this.validateRef(ref);
    let instance: LinodeInstance;
    try {
      instance = await this.http.request<LinodeInstance>(`/linode/instances/${ref.instanceId}`);
    } catch (error) {
      if (error instanceof CloudError && error.code === "resource_not_found") return { ref, identity: ref.instanceId, state: "deleted" };
      throw error;
    }
    if (String(instance.id) !== ref.instanceId || instance.region !== ref.region) throw new CloudError("remote_identity_changed", false);
    if (typeof instance.created !== "string" || !instance.created || !Number.isFinite(Date.parse(instance.created))) throw new CloudError("remote_identity_changed", false);
    return { ref, identity: linodeLifecycleIdentity(instance), state: linodeLifecycleState(instance.status),
      ...(typeof instance.label === "string" && instance.label ? { nativeName: instance.label } : {}),
    };
  }
  async mutateLifecycle(action: CloudLifecycleAction, snapshot: CloudLifecycleSnapshot): Promise<CloudLifecycleReceipt> {
    assertLifecycleAction(action);
    assertLifecycleSnapshot(snapshot, this.accountId, "linode");
    this.validateRef(snapshot.ref);
    const current = await this.inspectLifecycle(snapshot.ref);
    if (!sameLifecycleRef(current.ref, snapshot.ref)
      || (current.state !== "deleted" && current.identity !== snapshot.identity)) throw new CloudError("remote_identity_changed", false);
    const noWrite = lifecycleNoWrite(action, current.state);
    if (noWrite !== undefined) return noWrite;
    const root = `/linode/instances/${snapshot.ref.instanceId}`;
    if (action === "start") await this.http.request(`${root}/boot`, { method: "POST", body: {} });
    else if (action === "stop") await this.http.request(`${root}/shutdown`, { method: "POST", body: {} });
    else await this.http.request(root, { method: "DELETE" });
    return {};
  }
  capabilities(slot: SlotRef, inventory: CloudInventory): Capability { return linodeCapabilities(slot, inventory); }
  execute(step: CloudStep) { return executeLinodeRotation(step, this); }
  async observe(step: CloudStep) { return (await this.observeDetails(step)).status; }
  observeDetails(step: CloudStep) { return observeLinodeRotation(step, this); }
}

function linodeLifecycleIdentity(instance: LinodeInstance): string {
  return `${instance.id}:${instance.region}:${instance.created}`;
}

function linodeLifecycleState(value: unknown): CloudPowerState {
  if (value === "running") return "running";
  if (value === "offline") return "stopped";
  if (value === "booting" || value === "provisioning") return "starting";
  if (value === "shutting_down") return "stopping";
  if (value === "deleting") return "deleting";
  return "unknown";
}

import { isIP } from 'node:net';
import type { CloudRef, CloudStep, SlotRef } from '@masterdns/contracts';
import { AzureHttp, COMPUTE_API, NETWORK_API, RESOURCE_API, equalArmId } from './azure-http.js';
import { executeAzureStep, observeAzureStep } from './azure-rotation.js';
import { CloudError } from './errors.js';
import type { AzureCredentials, Capability, CloudAdapter, CloudInventory, CloudObservation, CloudPage, CloudStepResult } from './provider.js';
// Raw ARM objects are kept local. Only explicit support evidence enters persisted inventory.
export type AzureResource = Record<string, any>;
export type AzureSlotEvidence = {
    nicId: string;
    ipConfigurationId: string;
    subnetId?: string;
    supported: boolean;
    reason?: string;
    privateAddress?: string;
    primary?: boolean;
    privateAllocationMethod?: string;
    allocationId?: string;
};
export type AzureRead = {
    inventory: CloudInventory;
    vm: AzureResource;
    nics: Map<string, AzureResource>;
    pips: Map<string, AzureResource>;
    subnets: Map<string, AzureResource>;
};
const unavailable = (reason: string): Capability => ({ available: false, reason, permission: 'unverified', requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false });
export function azureCapabilities(slot: SlotRef, inventory: CloudInventory): Capability {
    if (slot.service !== 'azure_vm' || inventory.ref.service !== slot.service || slot.accountId !== inventory.ref.accountId || slot.region !== inventory.ref.region || !equalArmId(slot.instanceId, inventory.ref.instanceId))
        return unavailable('inventory_mismatch');
    const selected = inventory.interfaces.find(i => equalArmId(i.id, slot.interfaceId));
    const address = selected?.addresses.find(a => a.address === slot.address && a.family === slot.family);
    if (!selected || !address || isIP(slot.address) !== slot.family || !address.allocationId)
        return unavailable('address_not_found');
    if (inventory.state !== 'running' || inventory.metadata?.supported !== true || selected.metadata?.supported !== true || address.metadata?.supported !== true)
        return unavailable(String(selected.metadata?.reason ?? address.metadata?.reason ?? inventory.metadata?.reason ?? 'unsupported_topology'));
    return { available: true, permission: 'unverified', requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false };
}
const ownKeys = (value: AzureResource | undefined, allowed: string[]): boolean => !!value && Object.keys(value).every(k => allowed.includes(k));
const empty = (value: unknown): boolean => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
export function pipSupported(pip: AzureResource, family: 4 | 6): boolean {
    const p = pip.properties ?? {};
    return pip.sku?.name === 'Standard' && pip.sku?.tier === 'Regional' && p.publicIPAllocationMethod === 'Static' && p.publicIPAddressVersion === `IPv${family}` && p.provisioningState === 'Succeeded'
        && ownKeys(pip, ['id', 'name', 'type', 'etag', 'location', 'tags', 'zones', 'sku', 'properties'])
        && ownKeys(p, ['provisioningState', 'resourceGuid', 'ipAddress', 'publicIPAllocationMethod', 'publicIPAddressVersion', 'ipConfiguration', 'idleTimeoutInMinutes', 'ddosSettings', 'deleteOption', 'ipTags'])
        && empty(p.ipTags) && (p.deleteOption === undefined || ['Detach', 'Delete'].includes(p.deleteOption))
        && (p.ddosSettings === undefined || ownKeys(p.ddosSettings, ['protectionMode', 'ddosProtectionPlan']))
        && (pip.zones === undefined || Array.isArray(pip.zones) && pip.zones.every((z: unknown) => typeof z === 'string'));
}
/** Normalized public-IP evidence; an unbound allocation must not imply NIC ownership. */
export function azurePublicIpMetadata(pip: AzureResource, supported: boolean, ipConfigurationId?: string, reason = 'public_ip_topology_unsupported'): Record<string, unknown> {
    return {
        supported, ...(!supported ? { reason } : {}), sku: pip.sku, zones: pip.zones ?? [],
        allocationMethod: pip.properties.publicIPAllocationMethod,
        ...(pip.properties.resourceGuid === undefined ? {} : { resourceGuid: pip.properties.resourceGuid }),
        ...(ipConfigurationId === undefined ? {} : { ipConfigurationId }),
    };
}
export function nicSupported(nic: AzureResource, allowUpdating = false): boolean {
    const p = nic.properties ?? {};
    return (p.provisioningState === 'Succeeded' || allowUpdating && p.provisioningState === 'Updating')
        && ownKeys(nic, ['id', 'name', 'type', 'etag', 'location', 'tags', 'properties'])
        && ownKeys(p, ['provisioningState', 'resourceGuid', 'macAddress', 'virtualMachine', 'primary', 'ipConfigurations', 'networkSecurityGroup', 'dnsSettings', 'enableAcceleratedNetworking', 'enableIPForwarding', 'disableTcpStateTracking', 'hostedWorkloads', 'dscpConfiguration', 'nicType', 'vnetEncryptionSupported'])
        && empty(p.hostedWorkloads) && !p.dscpConfiguration && (p.nicType === undefined || p.nicType === 'Standard')
        && (p.dnsSettings === undefined || ownKeys(p.dnsSettings, ['dnsServers', 'appliedDnsServers', 'internalDnsNameLabel', 'internalFqdn', 'internalDomainNameSuffix']))
        && Array.isArray(p.ipConfigurations) && p.ipConfigurations.some((c: AzureResource) => c.properties?.privateIPAddressVersion === 'IPv4')
        && p.ipConfigurations.every((c: AzureResource) => ownKeys(c, ['id', 'name', 'type', 'etag', 'properties']) && ownKeys(c.properties, ['provisioningState', 'primary', 'privateIPAddress', 'privateIPAllocationMethod', 'privateIPAddressVersion', 'subnet', 'publicIPAddress', 'loadBalancerBackendAddressPools', 'loadBalancerInboundNatRules', 'applicationGatewayBackendAddressPools', 'gatewayLoadBalancer', 'applicationSecurityGroups'])
            && empty(c.properties.loadBalancerBackendAddressPools) && empty(c.properties.loadBalancerInboundNatRules) && empty(c.properties.applicationGatewayBackendAddressPools) && !c.properties.gatewayLoadBalancer);
}
export class AzureCloudAdapter implements CloudAdapter {
    readonly http: AzureHttp;
    constructor(readonly accountId: string, credentials: AzureCredentials, dependencies: {
        fetch?: typeof fetch;
    } = {}) { this.http = new AzureHttp(credentials, dependencies.fetch); }
    async verifyIdentity(): Promise<{
        externalAccountId: string;
    }> {
        const result = await this.http.request(`/subscriptions/${this.http.credentials.subscriptionId}?api-version=${RESOURCE_API}`);
        if (!equalArmId(result.body.subscriptionId, this.http.credentials.subscriptionId) || !equalArmId(result.body.tenantId, this.http.credentials.tenantId) || result.body.state !== 'Enabled')
            throw new CloudError('remote_identity_changed', false);
        return { externalAccountId: result.body.subscriptionId };
    }
    async listScopes(): Promise<string[]> {
        const result = await this.http.request(`/subscriptions/${this.http.credentials.subscriptionId}/locations?api-version=${RESOURCE_API}`);
        if (!Array.isArray(result.body.value))
            throw new CloudError('temporary_cloud_error', true);
        return result.body.value.map((l: AzureResource) => l.name).filter((name: unknown): name is string => typeof name === 'string');
    }
    async discover(region: string, cursor?: string): Promise<CloudPage> {
        if (!/^[a-z0-9]{1,64}$/.test(region))
            throw new CloudError('invalid_cursor', false);
        const root = `/subscriptions/${this.http.credentials.subscriptionId}/providers/Microsoft.Compute/virtualMachines`;
        let path = `${root}?api-version=${COMPUTE_API}`;
        let seen: string[] = [];
        if (cursor) {
            try {
                const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
                if (cursor.length > 1500000 || decoded.region !== region || decoded.subscription !== this.http.credentials.subscriptionId || !Array.isArray(decoded.seen) || decoded.seen.length >= 100 || !decoded.seen.every((p: unknown) => typeof p === 'string'))
                    throw Error();
                path = decoded.next;
                seen = decoded.seen;
                this.pageUrl(path, root);
                if (seen.includes(path))
                    throw Error();
            }
            catch {
                throw new CloudError('invalid_cursor', false);
            }
        }
        const response = await this.http.request(path);
        if (!Array.isArray(response.body.value) || response.body.value.length > 1000)
            throw new CloudError('temporary_cloud_error', true);
        const items: CloudInventory[] = [];
        for (const vm of response.body.value)
            if (typeof vm.location === 'string' && vm.location.toLowerCase() === region)
                items.push(await this.inspect({ accountId: this.accountId, service: 'azure_vm', region, instanceId: vm.id }));
        let next: string | undefined;
        if (response.body.nextLink !== undefined) {
            next = this.pageUrl(response.body.nextLink, root);
            seen.push(path);
            if (seen.includes(next) || seen.length >= 100)
                throw new CloudError('invalid_cursor', false);
        }
        return { items, ...(next ? { cursor: Buffer.from(JSON.stringify({ region, subscription: this.http.credentials.subscriptionId, next, seen })).toString('base64url') } : {}) };
    }
    private pageUrl(value: unknown, root: string): string {
        try {
            if (typeof value !== 'string' || value.length > 16384)
                throw Error();
            const url = this.http.url(value);
            if (url.pathname.toLowerCase() !== root.toLowerCase() || url.searchParams.get('api-version') !== COMPUTE_API)
                throw Error();
            return url.href;
        }
        catch {
            throw new CloudError('invalid_cursor', false);
        }
    }
    async inspect(ref: CloudRef): Promise<CloudInventory> { return (await this.read(ref)).inventory; }
    async read(ref: CloudRef, allowNicUpdating = false): Promise<AzureRead> {
        if (ref.accountId !== this.accountId || ref.service !== 'azure_vm')
            throw new CloudError('resource_ownership_ambiguous', false);
        const vmId = this.http.resourceId(ref.instanceId, 'Microsoft.Compute', 'virtualMachines');
        const vm = (await this.http.getResource(vmId, COMPUTE_API)).body;
        if (!equalArmId(vm.id, vmId) || vm.location?.toLowerCase() !== ref.region)
            throw new CloudError('remote_identity_changed', false);
        const view = (await this.http.getResource(`${vmId}/instanceView`, COMPUTE_API)).body;
        const state = Array.isArray(view.statuses) ? String(view.statuses.find((s: AzureResource) => typeof s.code === 'string' && s.code.startsWith('PowerState/'))?.code ?? 'unknown').replace('PowerState/', '') : 'unknown';
        const vmSupported = state === 'running' && vm.properties?.provisioningState === 'Succeeded' && !vm.properties?.virtualMachineScaleSet;
        const inventory: CloudInventory = { ref: { ...ref, instanceId: vm.id }, nativeName: vm.name, name: vm.name ?? vm.id, state, metadata: { supported: vmSupported, ...(!vmSupported ? { reason: 'vm_topology_or_state_unsupported' } : {}) }, interfaces: [] };
        const nics = new Map<string, AzureResource>(), pips = new Map<string, AzureResource>(), subnets = new Map<string, AzureResource>();
        const refs = vm.properties?.networkProfile?.networkInterfaces;
        if (!Array.isArray(refs) || refs.length > 64)
            throw new CloudError('resource_ownership_ambiguous', false);
        for (const nicRef of refs) {
            const id = this.http.resourceId(nicRef.id, 'Microsoft.Network', 'networkInterfaces');
            const nic = (await this.http.getResource(id)).body;
            nics.set(id.toLowerCase(), nic);
            if (!equalArmId(nic.id, id))
                throw new CloudError('resource_ownership_ambiguous', false);
            const supported = vmSupported && nicSupported(nic, allowNicUpdating) && equalArmId(nic.properties?.virtualMachine?.id, vm.id) && nic.location?.toLowerCase() === ref.region;
            if (!Array.isArray(nic.properties?.ipConfigurations) || nic.properties.ipConfigurations.length > 256)
                throw new CloudError('resource_ownership_ambiguous', false);
            for (const configuration of nic.properties.ipConfigurations) {
                const configId = configuration.id;
                const cp = configuration.properties ?? {};
                if (typeof configId !== 'string' || !configId.toLowerCase().startsWith(`${id}/ipConfigurations/`.toLowerCase()) || configId.slice(id.length + 18).includes('/'))
                    throw new CloudError('resource_ownership_ambiguous', false);
                const family = cp.privateIPAddressVersion === 'IPv4' ? 4 : cp.privateIPAddressVersion === 'IPv6' ? 6 : undefined;
                let subnet: AzureResource | undefined;
                if (cp.subnet?.id) {
                    const sid = this.http.resourceId(cp.subnet.id, 'Microsoft.Network', 'virtualNetworks');
                    subnet = subnets.get(sid.toLowerCase());
                    if (!subnet) {
                        subnet = (await this.http.getResource(sid)).body;
                        subnets.set(sid.toLowerCase(), subnet);
                    }
                    if (!equalArmId(subnet.id, sid))
                        throw new CloudError('resource_ownership_ambiguous', false);
                }
                const supportedSlot = supported && !!subnet && !subnet.properties?.natGateway && subnet.properties?.provisioningState === 'Succeeded' && family !== undefined && isIP(cp.privateIPAddress) === family && ['Static', 'Dynamic'].includes(cp.privateIPAllocationMethod) && !(family === 6 && cp.primary === true);
                const metadata: AzureSlotEvidence = { nicId: id, ipConfigurationId: configId, subnetId: cp.subnet?.id, supported: supportedSlot, ...(!supportedSlot ? { reason: 'nic_topology_or_ownership_unsupported' } : {}), privateAddress: cp.privateIPAddress, primary: cp.primary === true, privateAllocationMethod: cp.privateIPAllocationMethod, allocationId: cp.publicIPAddress?.id };
                const iface: CloudInventory['interfaces'][number] = { id: configId, metadata, addresses: [] };
                if (cp.publicIPAddress?.id) {
                    const pid = this.http.resourceId(cp.publicIPAddress.id, 'Microsoft.Network', 'publicIPAddresses');
                    const pip = (await this.http.getResource(pid)).body;
                    pips.set(pid.toLowerCase(), pip);
                    if (!equalArmId(pip.id, pid))
                        throw new CloudError('resource_ownership_ambiguous', false);
                    const actualFamily = isIP(pip.properties?.ipAddress);
                    const pipOk = family !== undefined && actualFamily === family && pipSupported(pip, family) && equalArmId(pip.properties.ipConfiguration?.id, configId) && pip.location?.toLowerCase() === ref.region;
                    if (actualFamily === 4 || actualFamily === 6)
                        iface.addresses.push({ address: pip.properties.ipAddress, family: actualFamily, primary: cp.primary === true, allocationId: pid, resourceId: pid, privateAddress: cp.privateIPAddress, metadata: azurePublicIpMetadata(pip, pipOk, configId) });
                }
                inventory.interfaces.push(iface);
            }
        }
        return { inventory, vm, nics, pips, subnets };
    }
    capabilities(slot: SlotRef, inventory: CloudInventory): Capability { return azureCapabilities(slot, inventory); }
    async execute(step: CloudStep): Promise<CloudStepResult> { return executeAzureStep(this, step); }
    async observe(step: CloudStep) { return (await this.observeDetails(step)).status; }
    async observeDetails(step: CloudStep): Promise<CloudObservation> { return observeAzureStep(this, step); }
}

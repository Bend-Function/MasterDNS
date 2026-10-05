import { isIP } from "node:net";
import type { SlotRef } from "@masterdns/contracts";
import type { Capability, CloudInventory } from "./provider.js";
import type { AzureResource } from "./azure.js";
import { equalArmId } from "./azure-http.js";
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

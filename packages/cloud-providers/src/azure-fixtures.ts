import type { SlotRef } from '@masterdns/contracts';
import { AzureCloudAdapter } from './azure.js';
export const credentials = { kind: 'azure_service_principal' as const, tenantId: 'tenant-1', subscriptionId: 'subscription-1', clientId: 'client-1', clientSecret: 'secret' };
const base = '/subscriptions/subscription-1/resourceGroups/group/providers/';
export const vmId = `${base}Microsoft.Compute/virtualMachines/vm`;
export const nicId = `${base}Microsoft.Network/networkInterfaces/nic`;
export const configId = `${nicId}/ipConfigurations/selected`;
export const pipId = `${base}Microsoft.Network/publicIPAddresses/old`;
export const subnetId = `${base}Microsoft.Network/virtualNetworks/vnet/subnets/subnet`;
export function fixture(family: 4 | 6 = 4) {
    const publicAddress = family === 4 ? '20.30.40.50' : '2603:1010::10';
    const privateAddress = family === 4 ? '10.0.0.5' : 'fd00::5';
    const resources: Record<string, any> = {
        [vmId]: { id: vmId, name: 'vm', location: 'eastus', properties: { provisioningState: 'Succeeded', networkProfile: { networkInterfaces: [{ id: nicId }] } } },
        [`${vmId}/instanceView`]: { statuses: [{ code: 'PowerState/running' }] },
        [nicId]: { id: nicId, name: 'nic', location: 'eastus', etag: 'etag-one', tags: { keep: 'this' }, properties: { provisioningState: 'Succeeded', virtualMachine: { id: vmId }, enableIPForwarding: false, enableAcceleratedNetworking: true, networkSecurityGroup: { id: `${base}Microsoft.Network/networkSecurityGroups/nsg` }, dnsSettings: { dnsServers: ['10.0.0.9'], appliedDnsServers: ['10.0.0.9'] }, ipConfigurations: [{ id: configId, name: 'selected', properties: { provisioningState: 'Succeeded', primary: family === 4, privateIPAddress: privateAddress, privateIPAllocationMethod: 'Static', privateIPAddressVersion: `IPv${family}`, subnet: { id: subnetId }, publicIPAddress: { id: pipId } } }, { id: `${nicId}/ipConfigurations/sibling`, name: 'sibling', properties: { primary: family === 6, privateIPAddress: '10.0.0.6', privateIPAddressVersion: 'IPv4', privateIPAllocationMethod: 'Static', subnet: { id: subnetId } } }] } },
        [pipId]: { id: pipId, name: 'old', location: 'eastus', sku: { name: 'Standard', tier: 'Regional' }, zones: ['1'], properties: { provisioningState: 'Succeeded', publicIPAllocationMethod: 'Static', publicIPAddressVersion: `IPv${family}`, ipAddress: publicAddress, resourceGuid: 'original-resource-generation', ipConfiguration: { id: configId }, ...(family === 4 ? { idleTimeoutInMinutes: 4 } : {}) } },
        [subnetId]: { id: subnetId, properties: { provisioningState: 'Succeeded' } }
    };
    const writes: Array<{
        url: string;
        method: string;
        body: any;
    }> = [];
    const requests: string[] = [];
    let listPages: any[] = [{ value: [resources[vmId]] }];
    let mutationResponse: ((url: string, method: string, body: any) => Response | undefined) | undefined;
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.href);
        const response = (body: any, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
        if (url.hostname === 'login.microsoftonline.com')
            return response({ access_token: 'token', expires_in: 3600 });
        if (url.pathname === '/subscriptions/subscription-1')
            return response({ subscriptionId: 'subscription-1', tenantId: 'tenant-1', state: 'Enabled' });
        if (url.pathname.endsWith('/locations'))
            return response({ value: [{ name: 'eastus' }, { name: 'westus' }] });
        if (url.pathname === '/subscriptions/subscription-1/providers/Microsoft.Compute/virtualMachines')
            return response(listPages.shift() ?? { value: [] });
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            writes.push({ url: url.pathname, method, body });
            const override = mutationResponse?.(url.pathname, method, body);
            if (override)
                return override;
            if (method === 'DELETE') {
                delete resources[url.pathname];
                return new Response(null, { status: 204 });
            }
            if (url.pathname === nicId) {
                const previous = resources[nicId].properties.ipConfigurations[0].properties.publicIPAddress.id;
                const next = body.properties.ipConfigurations[0].properties.publicIPAddress.id;
                delete resources[previous].properties.ipConfiguration;
                resources[next].properties.ipConfiguration = { id: configId };
                resources[nicId] = { ...body, id: nicId, properties: { ...body.properties, provisioningState: 'Succeeded', virtualMachine: { id: vmId } } };
            }
            else
                resources[url.pathname] = { ...body, id: url.pathname, properties: { ...body.properties, ipAddress: family === 4 ? '20.30.40.51' : '2603:1010::11', provisioningState: 'Succeeded' } };
            return response(resources[url.pathname]);
        }
        return resources[url.pathname] ? response(resources[url.pathname]) : response({ error: { code: 'NotFound' } }, 404);
    };
    const adapter = new AzureCloudAdapter('account', credentials, { fetch: fetcher });
    const slot: SlotRef = { accountId: 'account', service: 'azure_vm', region: 'eastus', instanceId: vmId, interfaceId: configId, slotId: 'slot', address: publicAddress, family };
    return { adapter, slot, resources, writes, requests, fetcher, setPages: (pages: any[]) => { listPages = pages; }, setMutation: (f: typeof mutationResponse) => { mutationResponse = f; } };
}

import { describe, expect, it } from 'vitest';
import { AzureCloudAdapter, azureCapabilities } from './azure.js';
import { fixture, credentials, vmId, nicId, configId, pipId, subnetId } from './azure-fixtures.js';
describe('Azure discovery and capability', () => {
    it('verifies configured subscription and tenant and lists regions', async () => {
        const f = fixture();
        expect(await f.adapter.verifyIdentity()).toEqual({ externalAccountId: 'subscription-1' });
        expect(await f.adapter.listScopes()).toEqual(['eastus', 'westus']);
        const bad = new AzureCloudAdapter('account', { ...credentials, tenantId: 'other' }, { fetch: f.fetcher });
        await expect(bad.verifyIdentity()).rejects.toMatchObject({ code: 'remote_identity_changed' });
    });
    it('continues a regional discovery through empty pages and binds cursor region', async () => {
        const f = fixture();
        f.setPages([{ value: [{ ...f.resources[vmId], location: 'westus' }], nextLink: 'https://management.azure.com/subscriptions/subscription-1/providers/Microsoft.Compute/virtualMachines?api-version=2025-04-01&skiptoken=2' }, { value: [f.resources[vmId]] }]);
        const first = await f.adapter.discover('eastus');
        expect(first.items).toEqual([]);
        expect(first.cursor).toBeTruthy();
        await expect(f.adapter.discover('westus', first.cursor)).rejects.toMatchObject({ code: 'invalid_cursor' });
        const second = await f.adapter.discover('eastus', first.cursor);
        expect(second.items[0]!.interfaces[0]!.id).toBe(configId);
        expect(second.cursor).toBeUndefined();
    });
    it('rejects hostile or repeated pagination links', async () => {
        const f = fixture();
        f.setPages([{ value: [], nextLink: 'https://evil.test/steal' }]);
        await expect(f.adapter.discover('eastus')).rejects.toMatchObject({ code: 'invalid_cursor' });
    });
    it.each([4, 6] as const)('normalizes exact configuration and supports existing Standard IPv%s', async (family) => {
        const f = fixture(family);
        const inventory = await f.adapter.inspect(f.slot);
        expect(inventory.interfaces[0]!.metadata).toMatchObject({ nicId, ipConfigurationId: configId });
        expect(inventory.interfaces[0]!.addresses[0]).toMatchObject({ address: f.slot.address, family, allocationId: pipId, resourceId: pipId });
        expect(azureCapabilities(f.slot, inventory)).toMatchObject({ available: true, permission: 'unverified', requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false });
    });
    it.each(['nat', 'vmss', 'basic', 'dns', 'lb', 'unknown', 'ownership', 'unknownPower'])('keeps %s topology monitorable but unavailable', async (topology) => {
        const f = fixture();
        if (topology === 'nat')
            f.resources[subnetId].properties.natGateway = { id: 'nat' };
        if (topology === 'vmss')
            f.resources[vmId].properties.virtualMachineScaleSet = { id: 'scale' };
        if (topology === 'basic')
            f.resources[pipId].sku.name = 'Basic';
        if (topology === 'dns')
            f.resources[pipId].properties.dnsSettings = { domainNameLabel: 'keep' };
        if (topology === 'lb')
            f.resources[nicId].properties.ipConfigurations[0].properties.loadBalancerBackendAddressPools = [{ id: 'lb' }];
        if (topology === 'unknown')
            f.resources[nicId].properties.futureMutableSetting = true;
        if (topology === 'ownership')
            f.resources[nicId].properties.virtualMachine.id = 'other';
        if (topology === 'unknownPower')
            f.resources[`${vmId}/instanceView`].statuses = [];
        const inventory = await f.adapter.inspect(f.slot);
        expect(inventory.interfaces[0]!.addresses[0]!.address).toBe(f.slot.address);
        expect(azureCapabilities(f.slot, inventory).available).toBe(false);
    });
    it('rejects missing private allocation evidence and primary IPv6 configurations', async () => {
        const missing = fixture();
        delete missing.resources[nicId].properties.ipConfigurations[0].properties.privateIPAllocationMethod;
        expect(azureCapabilities(missing.slot, await missing.adapter.inspect(missing.slot)).available).toBe(false);
        const primary = fixture(6);
        primary.resources[nicId].properties.ipConfigurations[0].properties.primary = true;
        expect(azureCapabilities(primary.slot, await primary.adapter.inspect(primary.slot)).available).toBe(false);
    });
    it('does not silently hide unreadable linked resources', async () => { const f = fixture(); delete f.resources[pipId]; await expect(f.adapter.inspect(f.slot)).rejects.toMatchObject({ code: 'resource_not_found' }); });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, credentials, vmId, nicId, configId, pipId } from './azure-fixtures.js';
import { planAzureRotation, planAzureCleanup } from './azure-rotation.js';
import { AzureCloudAdapter } from './azure.js';
import type { CloudStepResult } from './provider.js';
const prepare = async (f = fixture()) => { const before = await f.adapter.inspect(f.slot); const steps = planAzureRotation(f.slot, before, { attemptId: 'attempt-1', allowStop: false }); return { ...f, before, steps }; };
const withCandidate = (step: any, receipt: CloudStepResult) => ({ ...step, arguments: { ...step.arguments, candidateReceipt: receipt } });
describe('Azure exact-resource rotation', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each([4, 6] as const)('allocates Standard IPv%s, preserves siblings and private addresses, observes binding, then explicitly deletes old PIP', async (family) => {
        const f = await prepare(fixture(family));
        const original = structuredClone(f.resources[nicId]);
        expect(f.steps.map(s => s.action)).toEqual(['azure.public-ip.allocate', 'azure.public-ip.associate']);
        const candidate = await f.adapter.execute(f.steps[0]!);
        expect(candidate.allocationId).toBeTruthy();
        const put = f.writes[0]!;
        expect(put.body).toMatchObject({ location: 'eastus', sku: { name: 'Standard', tier: 'Regional' }, zones: ['1'], properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: `IPv${family}` } });
        expect(put.body.properties.ipAddress).toBeUndefined();
        expect(put.body.properties.ipConfiguration).toBeUndefined();
        expect(await f.adapter.observeDetails({ ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, receipt: candidate } })).toMatchObject({ status: 'applied', candidateAddress: family === 4 ? '20.30.40.51' : '2603:1010::11' });
        const step = withCandidate(f.steps[1], candidate);
        const association = await f.adapter.execute(step);
        expect(f.writes[1]!.url).toBe(nicId);
        expect(f.writes[1]!.body.properties.ipConfigurations[1]).toEqual(original.properties.ipConfigurations[1]);
        expect(f.writes[1]!.body.properties.ipConfigurations[0].properties).toMatchObject({ privateIPAddress: original.properties.ipConfigurations[0].properties.privateIPAddress, primary: family === 4, subnet: original.properties.ipConfigurations[0].properties.subnet, publicIPAddress: { id: candidate.allocationId } });
        expect(f.writes[1]!.body.properties.enableAcceleratedNetworking).toBe(true);
        expect(f.writes[1]!.body.properties.dnsSettings).toEqual({ dnsServers: ['10.0.0.9'] });
        const observed = await f.adapter.observeDetails({ ...step, arguments: { ...step.arguments, receipt: association } });
        expect(observed).toMatchObject({ status: 'applied', candidateAddress: candidate.candidateAddress });
        const installed = (await f.adapter.inspect(f.slot)).interfaces.find(i => i.id === configId)!.addresses[0]!;
        expect(observed.after?.addressMetadata).toEqual(installed.metadata);
        expect(observed.after?.privateAddress).toBe(installed.privateAddress);
        expect(f.resources[pipId]).toBeDefined();
        const cleanup = planAzureCleanup(f.slot, f.before, { attemptId: 'attempt-1', releaseAuthorized: true, publishedAddress: candidate.candidateAddress!, ownershipSnapshot: { accountId: 'account', instanceId: vmId, interfaceId: configId, allocationId: pipId, address: f.slot.address, resourceId: pipId } })[0]!;
        const deleteStep = withCandidate(cleanup, candidate);
        const deleted = await f.adapter.execute(deleteStep);
        expect(f.writes[2]).toMatchObject({ url: pipId, method: 'DELETE' });
        expect(await f.adapter.observeDetails({ ...deleteStep, arguments: { ...deleteStep.arguments, receipt: deleted } })).toMatchObject({ status: 'applied' });
    });
    it('preserves ordinary PIP settings and selects the exact NIC among multiple NICs', async () => {
        const raw = fixture();
        raw.resources[pipId].properties.ipTags = [];
        raw.resources[pipId].properties.deleteOption = 'Detach';
        raw.resources[pipId].properties.ddosSettings = { protectionMode: 'VirtualNetworkInherited' };
        const otherId = nicId + '-other';
        raw.resources[otherId] = structuredClone(raw.resources[nicId]);
        raw.resources[otherId].id = otherId;
        raw.resources[otherId].properties.ipConfigurations = [{ id: otherId + '/ipConfigurations/private', name: 'private', properties: { ...raw.resources[nicId].properties.ipConfigurations[1].properties } }];
        raw.resources[vmId].properties.networkProfile.networkInterfaces.unshift({ id: otherId });
        const otherBefore = structuredClone(raw.resources[otherId]);
        const f = await prepare(raw);
        const candidate = await f.adapter.execute(f.steps[0]!);
        expect(f.writes[0]!.body.properties).toMatchObject({ idleTimeoutInMinutes: 4, deleteOption: 'Detach', ddosSettings: { protectionMode: 'VirtualNetworkInherited' } });
        await f.adapter.execute(withCandidate(f.steps[1], candidate));
        expect(f.writes[1]!.url).toBe(nicId);
        expect(f.resources[otherId]).toEqual(otherBefore);
    });
    it.each([4, 6] as const)('preserves independent metadata for an allocated but unattached IPv%s candidate', async family => {
        const f = await prepare(fixture(family));
        const initial = await f.adapter.execute(f.steps[0]!);
        f.resources[initial.allocationId!].properties.resourceGuid = 'allocated-candidate-generation';
        const step = { ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, receipt: initial, previousExecution: true } };
        const observation = await f.adapter.observeDetails(step);
        expect(observation.status).toBe('applied');
        expect(observation.after?.addressMetadata).toEqual({ supported: false, reason: 'public_ip_unattached', sku: { name: 'Standard', tier: 'Regional' }, zones: ['1'], allocationMethod: 'Static', resourceGuid: 'allocated-candidate-generation' });
        expect(observation.after?.privateAddress).toBe(f.resources[nicId].properties.ipConfigurations[0].properties.privateIPAddress);
        expect(observation.after?.addressMetadata).not.toHaveProperty('ipConfigurationId');
        expect(observation.after?.pollAfter).toBe(initial.after?.pollAfter);
        const recovered = await f.adapter.execute(step);
        expect(recovered.after?.addressMetadata).toEqual(observation.after?.addressMetadata);
        expect(f.resources[nicId].properties.ipConfigurations[0].properties.publicIPAddress.id).toBe(pipId);
        expect(f.writes).toHaveLength(1);
        f.resources[initial.allocationId!].properties.ipConfiguration = { id: configId };
        expect(await f.adapter.observeDetails(step)).toMatchObject({ status: 'ambiguous' });
    });
    it('recovers an allocated candidate after a lost response without a second PUT', async () => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        const recovered = await f.adapter.execute({ ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, previousExecution: true } });
        expect(recovered.allocationId).toBe(candidate.allocationId);
        expect(f.writes).toHaveLength(1);
    });
    it('preserves uncertainty after dispatch when the candidate is absent', async () => {
        const f = await prepare();
        const step = { ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, previousExecution: true } };
        expect(await f.adapter.observeDetails(step)).toMatchObject({ status: 'ambiguous' });
        await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(f.writes).toEqual([]);
    });
    it('refuses deterministic candidate tag collisions instead of overwriting', async () => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        f.resources[candidate.allocationId!].tags['masterdns-attempt'] = 'other';
        await expect(f.adapter.execute(f.steps[0]!)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(f.writes).toHaveLength(1);
    });
    it.each(['private', 'oldAddress', 'vm', 'candidateOwner', 'receipt'])('refuses stale %s evidence before NIC PUT', async (stale) => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        if (stale === 'private')
            f.resources[nicId].properties.ipConfigurations[0].properties.privateIPAddress = '10.0.0.99';
        if (stale === 'oldAddress')
            f.resources[pipId].properties.ipAddress = '20.30.40.90';
        if (stale === 'vm')
            f.resources[nicId].properties.virtualMachine.id = 'another-vm';
        if (stale === 'candidateOwner')
            f.resources[candidate.allocationId!].properties.ipConfiguration = { id: 'other' };
        if (stale === 'receipt')
            candidate.allocationId = pipId;
        await expect(f.adapter.execute(withCandidate(f.steps[1], candidate))).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(f.writes).toHaveLength(1);
    });
    it('tracks async header priority and retry interval but independently checks resource success', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
        const f = await prepare();
        const operation = `https://management.azure.com/subscriptions/subscription-1/providers/Microsoft.Network/locations/eastus/operations/${'a'.repeat(4100)}`;
        f.setMutation(() => new Response('{}', { status: 202, headers: { 'azure-asyncoperation': operation, location: 'https://evil.test/ignored', 'retry-after': '3' } }));
        const receipt = await f.adapter.execute(f.steps[0]!);
        expect(receipt.operationId).toBe(operation);
        expect(receipt.after).toMatchObject({ operationKind: 'azure-asyncoperation', retryAfterMs: 3000 });
        f.resources[new URL(operation).pathname] = { status: 'InProgress' };
        const step = { ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, receipt, previousExecution: true } };
        expect(await f.adapter.observeDetails(step)).toMatchObject({ status: 'pending' });
        expect(f.requests.filter(url => url === operation)).toEqual([]);
        clock.mockReturnValue(103001);
        f.resources[new URL(operation).pathname] = { status: 'Succeeded' };
        expect(await f.adapter.observeDetails(step)).toMatchObject({ status: 'ambiguous' });
        f.resources[new URL(operation).pathname] = { status: 'Failed', error: { message: 'secret' } };
        await expect(f.adapter.observeDetails(step)).rejects.toMatchObject({ code: 'cloud_operation_failed' });
    });
    it('rejects hostile async URLs and never repeats uncertain NIC writes', async () => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        f.setMutation(() => new Response('{}', { status: 202, headers: { 'azure-asyncoperation': 'https://evil.test/operation' } }));
        await expect(f.adapter.execute(withCandidate(f.steps[1], candidate))).rejects.toMatchObject({ code: 'temporary_cloud_error', retryable: false, reason: 'azure_write_outcome_unknown' });
        const recovered = withCandidate(f.steps[1], candidate);
        recovered.arguments.previousExecution = true;
        expect(await f.adapter.observeDetails(recovered)).toMatchObject({ status: 'pending' });
        await expect(f.adapter.execute(recovered)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(f.writes).toHaveLength(2);
    });
    it('recovers completed NIC association with a lost receipt without another PUT', async () => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        const step = withCandidate(f.steps[1], candidate);
        await f.adapter.execute(step);
        const recovered = await f.adapter.execute({ ...step, arguments: { ...step.arguments, previousExecution: true } });
        expect(recovered.candidateAddress).toBe(candidate.candidateAddress);
        expect(f.writes).toHaveLength(2);
    });
    it.each([4, 6] as const)('keeps an in-flight IPv%s NIC association observable before Azure exposes the write', async family => {
        const f = await prepare(fixture(family));
        const candidate = await f.adapter.execute(f.steps[0]!);
        const step = withCandidate(f.steps[1], candidate);
        let signalEntered!: () => void, finish!: () => void;
        const entered = new Promise<void>(resolve => { signalEntered = resolve; });
        const complete = new Promise<void>(resolve => { finish = resolve; });
        let puts = 0;
        const slow = new AzureCloudAdapter('account', credentials, { fetch: async (input, init) => {
            if (new URL(String(input)).pathname === nicId && init?.method === 'PUT') {
                puts++;
                signalEntered();
                await complete;
                await f.fetcher(input, init);
                throw new TypeError('lost response');
            }
            return f.fetcher(input, init);
        } });
        const execution = slow.execute(step).catch(error => error);
        await entered;
        const recovering = { ...step, arguments: { ...step.arguments, previousExecution: true } };
        try {
            expect(await f.adapter.observeDetails(recovering)).toMatchObject({ status: 'pending' });
            await expect(slow.execute(recovering)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
            expect(puts).toBe(1);
        } finally {
            finish();
            await execution;
        }
        expect(await f.adapter.observeDetails(recovering)).toMatchObject({ status: 'applied', candidateAddress: candidate.candidateAddress });
        expect(await slow.execute(recovering)).toMatchObject({ candidateAddress: candidate.candidateAddress });
        expect(f.resources[pipId].properties.ipConfiguration).toBeUndefined();
        expect(puts).toBe(1);
        expect(f.writes).toHaveLength(2);
    });
    it.each(['old detached', 'candidate bound', 'candidate generation', 'candidate address', 'topology', 'missing receipt'] as const)('keeps %s evidence ambiguous while the original NIC binding remains visible', async conflict => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        const step = withCandidate(f.steps[1], candidate);
        step.arguments.previousExecution = true;
        if (conflict === 'old detached') delete f.resources[pipId].properties.ipConfiguration;
        if (conflict === 'candidate bound') f.resources[candidate.allocationId!].properties.ipConfiguration = { id: configId };
        if (conflict === 'candidate generation') f.resources[candidate.allocationId!].properties.resourceGuid = 'recreated';
        if (conflict === 'candidate address') f.resources[candidate.allocationId!].properties.ipAddress = '20.30.40.99';
        if (conflict === 'topology') f.resources[nicId].properties.ipConfigurations[0].properties.privateIPAddress = '10.0.0.99';
        if (conflict === 'missing receipt') delete step.arguments.candidateReceipt;
        expect(await f.adapter.observeDetails(step)).toMatchObject({ status: 'ambiguous' });
        await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(f.writes).toHaveLength(1);
    });
    it('observes async deletion through Location and confirms actual 404', async () => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        await f.adapter.execute(withCandidate(f.steps[1], candidate));
        const operation = 'https://management.azure.com/subscriptions/subscription-1/providers/Microsoft.Network/locations/eastus/operationResults/delete-1';
        f.setMutation((_url, method) => method === 'DELETE' ? new Response('{}', { status: 202, headers: { location: operation } }) : undefined);
        const cleanup = planAzureCleanup(f.slot, f.before, { attemptId: 'attempt-1', releaseAuthorized: true, publishedAddress: candidate.candidateAddress!, ownershipSnapshot: { accountId: 'account', instanceId: vmId, interfaceId: configId, allocationId: pipId, address: f.slot.address } })[0]!;
        const step = withCandidate(cleanup, candidate);
        const receipt = await f.adapter.execute(step);
        expect(receipt.after?.operationKind).toBe('location');
        const observing = { ...step, arguments: { ...step.arguments, receipt, previousExecution: true } };
        f.resources[new URL(operation).pathname] = { status: 'Succeeded' };
        expect(await f.adapter.observeDetails(observing)).toMatchObject({ status: 'pending' });
        delete f.resources[pipId];
        expect(await f.adapter.observeDetails(observing)).toMatchObject({ status: 'applied' });
        expect(f.writes).toHaveLength(3);
    });
    it.each(['location', 'azure-asyncoperation'] as const)('handles empty HTTP 204 polling for %s while checking actual deletion', async operationKind => {
        const raw = fixture();
        const operation = 'https://management.azure.com/subscriptions/subscription-1/providers/Microsoft.Network/locations/eastus/operationResults/delete-204';
        const adapter = new AzureCloudAdapter('account', credentials, {
            fetch: async (input, init) => String(input) === operation ? new Response(null, { status: 204 }) : raw.fetcher(input, init),
        });
        const f = await prepare({ ...raw, adapter });
        const candidate = await f.adapter.execute(f.steps[0]!);
        await f.adapter.execute(withCandidate(f.steps[1], candidate));
        f.setMutation((_url, method) => method === 'DELETE' ? new Response('{}', { status: 202, headers: { [operationKind]: operation } }) : undefined);
        const cleanup = planAzureCleanup(f.slot, f.before, { attemptId: 'attempt-1', releaseAuthorized: true, publishedAddress: candidate.candidateAddress!, ownershipSnapshot: { accountId: 'account', instanceId: vmId, interfaceId: configId, allocationId: pipId, address: f.slot.address } })[0]!;
        const step = withCandidate(cleanup, candidate);
        const receipt = await f.adapter.execute(step);
        const observing = { ...step, arguments: { ...step.arguments, receipt, previousExecution: true } };
        expect(await f.adapter.observeDetails(observing)).toMatchObject({ status: 'pending' });
        delete f.resources[pipId];
        expect(await f.adapter.observeDetails(observing)).toMatchObject({ status: operationKind === 'location' ? 'applied' : 'pending' });
        expect(f.writes).toHaveLength(3);
    });
    it('requires trusted snapshot, publication and explicit cleanup authorization', async () => {
        const f = await prepare();
        expect(() => planAzureCleanup(f.slot, f.before, { attemptId: 'attempt-1', releaseAuthorized: true, publishedAddress: '20.30.40.51' })).toThrow('resource_ownership_ambiguous');
        expect(() => planAzureCleanup(f.slot, f.before, { attemptId: 'attempt-1', releaseAuthorized: false, publishedAddress: '20.30.40.51' })).toThrow('cleanup_not_authorized');
    });
    it.each(['attached', 'reused', 'resourceRecreated'])('refuses cleanup when old PIP is %s', async (kind) => {
        const f = await prepare();
        const candidate = await f.adapter.execute(f.steps[0]!);
        await f.adapter.execute(withCandidate(f.steps[1], candidate));
        if (kind === 'attached')
            f.resources[pipId].properties.ipConfiguration = { id: 'different-config' };
        else if (kind === 'resourceRecreated')
            f.resources[pipId].properties.resourceGuid = 'different-resource-generation';
        else
            f.resources[pipId].properties.ipAddress = '20.30.40.90';
        const step = planAzureCleanup(f.slot, f.before, { attemptId: 'attempt-1', releaseAuthorized: true, publishedAddress: candidate.candidateAddress!, ownershipSnapshot: { accountId: 'account', instanceId: vmId, interfaceId: configId, allocationId: pipId, address: f.slot.address } })[0]!;
        await expect(f.adapter.execute(withCandidate(step, candidate))).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(f.writes).toHaveLength(2);
    });
});

it.each(['missing receipt GUID', 'missing remote GUID', 'recreated GUID'] as const)('rejects association with %s without another NIC write', async fault => {
    const f = await prepare();
    const allocation = await f.adapter.execute(f.steps[0]!);
    const applied = await f.adapter.observeDetails({ ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, receipt: allocation } });
    if (fault === 'missing receipt GUID') delete (applied.after!.addressMetadata as Record<string, unknown>).resourceGuid;
    else f.resources[allocation.allocationId!].properties.resourceGuid = fault === 'missing remote GUID' ? undefined : 'recreated';
    const step = withCandidate(f.steps[1], applied);
    await expect(f.adapter.execute(step)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
    expect(await f.adapter.observeDetails({ ...step, arguments: { ...step.arguments, previousExecution: true } })).toMatchObject({ status: 'ambiguous' });
    expect(f.writes).toHaveLength(1);
});

it.each(['owner', 'topology', 'generation', 'tags'] as const)('keeps %s conflicts ambiguous while the NIC is Updating', async conflict => {
    const f = await prepare();
    const allocation = await f.adapter.execute(f.steps[0]!);
    const applied = await f.adapter.observeDetails({ ...f.steps[0]!, arguments: { ...f.steps[0]!.arguments, receipt: allocation } });
    const step = withCandidate(f.steps[1], applied);
    await f.adapter.execute(step);
    f.resources[nicId].properties.provisioningState = 'Updating';
    if (conflict === 'owner') f.resources[nicId].properties.virtualMachine.id = vmId + '-foreign';
    if (conflict === 'topology') f.resources[nicId].properties.ipConfigurations[0].properties.loadBalancerBackendAddressPools = [{ id: 'foreign-pool' }];
    if (conflict === 'generation') f.resources[allocation.allocationId!].properties.resourceGuid = 'recreated';
    if (conflict === 'tags') { f.resources[allocation.allocationId!].tags['masterdns-attempt'] = 'foreign'; f.resources[allocation.allocationId!].properties.provisioningState = 'Updating'; }
    expect(await f.adapter.observeDetails({ ...step, arguments: { ...step.arguments, previousExecution: true } })).toMatchObject({ status: 'ambiguous' });
    expect(f.writes.filter(write => write.url === nicId)).toHaveLength(1);
});

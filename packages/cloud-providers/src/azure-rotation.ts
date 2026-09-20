import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { CloudStep, SlotRef } from '@masterdns/contracts';
import { azureCapabilities, azurePublicIpMetadata, nicSupported, pipSupported, type AzureCloudAdapter, type AzureRead, type AzureResource, type AzureSlotEvidence } from './azure.js';
import { NETWORK_API, equalArmId, retryAfter, type AzureResponse } from './azure-http.js';
import { CloudError } from './errors.js';
import type { CloudInventory, CloudObservation, CloudStepResult } from './provider.js';
import { makeRotationStep, rotationArguments, type CleanupPlanOptions, type RotationStepArguments } from './rotation-plan.js';
const ambiguous = (): never => { throw new CloudError('resource_ownership_ambiguous', false); };
const selected = (a: RotationStepArguments) => a.before.interfaces.find(i => equalArmId(i.id, a.slot.interfaceId));
function originalId(a: RotationStepArguments): string {
    const id = selected(a)?.addresses.find(v => v.address === a.slot.address && v.family === a.slot.family)?.allocationId;
    return id ?? ambiguous();
}
function candidateId(a: RotationStepArguments): string {
    const old = originalId(a);
    const position = old.toLowerCase().lastIndexOf('/publicipaddresses/');
    if (position < 0)
        return ambiguous();
    // A resource-name digest gives bounded deterministic identity for uncertain PUT recovery.
    const key = createHash('sha256').update(JSON.stringify([a.slot.accountId, a.slot.instanceId.toLowerCase(), a.slot.interfaceId.toLowerCase(), a.slot.slotId, a.attemptId])).digest('hex').slice(0, 32);
    return `${old.slice(0, position)}/publicIPAddresses/masterdns-${key}`;
}
function tags(a: RotationStepArguments): Record<string, string> {
    const value = { 'masterdns-attempt': a.attemptId, 'masterdns-account': a.slot.accountId, 'masterdns-slot': a.slot.slotId };
    if (Object.values(value).some(v => v.length > 256))
        return ambiguous();
    return value;
}
export function planAzureRotation(slot: SlotRef, inventory: CloudInventory, options: {
    allowStop: boolean;
    attemptId: string;
}): CloudStep[] {
    const capability = azureCapabilities(slot, inventory);
    if (!capability.available)
        throw new CloudError('rotation_unsupported', false, undefined, capability.reason);
    const args: RotationStepArguments = { slot, before: inventory, attemptId: options.attemptId, phase: 'rotation', allowStop: options.allowStop };
    return (['azure.public-ip.allocate', 'azure.public-ip.associate'] as const).map((action, index) => {
        const step = makeRotationStep(action, args, index);
        rotationArguments(step);
        step.arguments.azureCandidateId = candidateId(args);
        return step;
    });
}
export function planAzureCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
    if (!options.releaseAuthorized || !options.publishedAddress || options.publishedAddress === slot.address || isIP(options.publishedAddress) !== slot.family)
        throw new CloudError('cleanup_not_authorized', false);
    if (!options.publishedInventory) planAzureRotation(slot, inventory, { allowStop: false, attemptId: options.attemptId });
    const args: RotationStepArguments = { slot, before: inventory, ...options, phase: 'post_publish_cleanup' };
    validateSnapshot(args);
    if (args.publishedInventory) publishedAddress(args);
    const step = makeRotationStep('azure.public-ip.delete', args, 0);
    step.arguments.azureCandidateId = candidateId(args);
    return [step];
}
function validateSnapshot(a: RotationStepArguments): void {
    const s = a.ownershipSnapshot;
    if (!s || s.accountId !== a.slot.accountId || !equalArmId(s.instanceId, a.slot.instanceId) || !equalArmId(s.interfaceId, a.slot.interfaceId) || !equalArmId(s.allocationId, originalId(a)) || s.address !== a.slot.address || (s.resourceId !== undefined && !equalArmId(s.resourceId, originalId(a))))
        ambiguous();
}
function argumentsFor(adapter: AzureCloudAdapter, step: CloudStep): RotationStepArguments {
    const a = rotationArguments(step);
    if (a.slot.service !== 'azure_vm' || a.slot.accountId !== adapter.accountId || !['azure.public-ip.allocate', 'azure.public-ip.associate', 'azure.public-ip.delete'].includes(step.action))
        throw new CloudError('invalid_rotation_step', false);
    if (!(a.phase === 'post_publish_cleanup' && a.publishedInventory) && !azureCapabilities(a.slot, a.before).available)
        ambiguous();
    adapter.http.resourceId(originalId(a), 'Microsoft.Network', 'publicIPAddresses');
    adapter.http.resourceId(candidateId(a), 'Microsoft.Network', 'publicIPAddresses');
    if (step.arguments.azureCandidateId !== undefined && !equalArmId(step.arguments.azureCandidateId, candidateId(a)))
        ambiguous();
    if (step.action === 'azure.public-ip.delete') {
        if (a.phase !== 'post_publish_cleanup' || !a.releaseAuthorized || isIP(a.publishedAddress ?? '') !== a.slot.family || a.publishedAddress === a.slot.address)
            throw new CloudError('cleanup_not_authorized', false);
        validateSnapshot(a);
        if (a.publishedInventory) publishedAddress(a);
    }
    else if (a.phase !== 'rotation')
        throw new CloudError('invalid_rotation_step', false);
    return a;
}
/** Cleanup owns the old allocation independently of whichever later attempt is published. */
function publishedAddress(a: RotationStepArguments) {
    const inventory = a.publishedInventory ?? ambiguous();
    const slot = { ...a.slot, address: a.publishedAddress ?? '' };
    if (!azureCapabilities(slot, inventory).available) return ambiguous();
    const address = inventory.interfaces.find(i => equalArmId(i.id, slot.interfaceId))?.addresses.find(ip => ip.address === slot.address && ip.family === slot.family);
    if (!address?.allocationId || !equalArmId(address.resourceId, address.allocationId) || equalArmId(address.allocationId, originalId(a))) return ambiguous();
    if (a.publishedReceipt && (a.publishedReceipt.candidateAddress !== address.address || !equalArmId(a.publishedReceipt.allocationId, address.allocationId) || !equalArmId(a.publishedReceipt.resourceId, address.resourceId))) return ambiguous();
    return address;
}
function cleanupOwnership(a: RotationStepArguments, old: AzureResource): void {
    checkOld(a, old);
    if (old.properties.ipConfiguration) ambiguous();
    if (a.ownershipAttemptId && (!equalArmId(old.id, candidateId({ ...a, attemptId: a.ownershipAttemptId })) || !Object.entries(tags({ ...a, attemptId: a.ownershipAttemptId })).every(([key, value]) => old.tags?.[key] === value))) ambiguous();
    const proof = a.cleanupReceipt;
    if (proof && (proof.candidateAddress !== a.slot.address || !equalArmId(proof.allocationId, originalId(a)) || !equalArmId(proof.resourceId, originalId(a)))) ambiguous();
    const metadata = proof?.after?.addressMetadata as Record<string, unknown> | undefined;
    if (metadata?.resourceGuid !== undefined && old.properties.resourceGuid !== metadata.resourceGuid) ambiguous();
}
function validateCandidateReceipt(a: RotationStepArguments): CloudStepResult {
    const receipt = a.candidateReceipt;
    if (!receipt || !equalArmId(receipt.allocationId, candidateId(a)) || !equalArmId(receipt.resourceId, candidateId(a)) || isIP(receipt.candidateAddress ?? '') !== a.slot.family || receipt.candidateAddress === a.slot.address)
        return ambiguous();
    // A deterministic ARM name and matching tags do not identify a resource generation.
    const generation = (receipt.after?.addressMetadata as Record<string, unknown> | undefined)?.resourceGuid;
    if (typeof generation !== 'string' || !generation) return ambiguous();
    return receipt;
}
function template(a: RotationStepArguments, old: AzureResource): AzureResource {
    const p = old.properties;
    return { location: old.location, sku: { name: 'Standard', tier: 'Regional' }, ...(old.zones ? { zones: old.zones } : {}), tags: tags(a), properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: `IPv${a.slot.family}`, ...(p.idleTimeoutInMinutes !== undefined ? { idleTimeoutInMinutes: p.idleTimeoutInMinutes } : {}), ...(p.ddosSettings !== undefined ? { ddosSettings: p.ddosSettings } : {}), ...(p.deleteOption !== undefined ? { deleteOption: p.deleteOption } : {}) } };
}
function sameJson(a: unknown, b: unknown): boolean {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
        return sameJson(ak, bk) && ak.every(k => sameJson((a as AzureResource)[k], (b as AzureResource)[k]));
    }
    return false;
}
function checkCandidateIdentity(a: RotationStepArguments, candidate: AzureResource): void {
    if (!equalArmId(candidate.id, candidateId(a)) || candidate.location?.toLowerCase() !== a.slot.region || !Object.entries(tags(a)).every(([k, v]) => candidate.tags?.[k] === v))
        ambiguous();
    if (a.candidateReceipt) {
        const trusted = validateCandidateReceipt(a);
        if (candidate.properties.resourceGuid !== (trusted.after!.addressMetadata as Record<string, unknown>).resourceGuid || candidate.properties.ipAddress !== trusted.candidateAddress) ambiguous();
    }
    if (candidate.properties.ipConfiguration && !equalArmId(candidate.properties.ipConfiguration.id, a.slot.interfaceId))
        ambiguous();
}
function checkCandidate(a: RotationStepArguments, candidate: AzureResource, old?: AzureResource): void {
    checkCandidateIdentity(a, candidate);
    if (!pipSupported(candidate, a.slot.family) || isIP(candidate.properties.ipAddress) !== a.slot.family || candidate.properties.ipAddress === a.slot.address)
        ambiguous();
    if (old) {
        const expected = template(a, old);
        if (!sameJson(candidate.zones ?? [], expected.zones ?? []) || !sameJson(candidate.properties.ddosSettings, expected.properties.ddosSettings) || candidate.properties.idleTimeoutInMinutes !== expected.properties.idleTimeoutInMinutes || candidate.properties.deleteOption !== expected.properties.deleteOption)
            ambiguous();
    }
}
function checkOld(a: RotationStepArguments, old: AzureResource): void {
    if (!equalArmId(old.id, originalId(a)) || old.properties?.ipAddress !== a.slot.address || !pipSupported(old, a.slot.family) || old.location?.toLowerCase() !== a.slot.region)
        ambiguous();
    const original = selected(a)!.addresses.find(v => v.address === a.slot.address && v.family === a.slot.family)!;
    if (!sameJson(old.zones ?? [], original.metadata?.zones ?? []) || !sameJson(old.sku, original.metadata?.sku) || (original.metadata?.resourceGuid !== undefined && old.properties.resourceGuid !== original.metadata.resourceGuid))
        ambiguous();
}
async function context(adapter: AzureCloudAdapter, a: RotationStepArguments, observation = false): Promise<{
    read: AzureRead;
    nic: AzureResource;
    configuration: AzureResource;
    binding: string;
}> {
    const read = await adapter.read(a.slot, observation);
    const current = read.inventory.interfaces.find(i => equalArmId(i.id, a.slot.interfaceId));
    const before = selected(a);
    if (read.inventory.metadata?.supported !== true || !current || current.metadata?.supported !== true || !before?.metadata)
        ambiguous();
    const keys = ['nicId', 'ipConfigurationId', 'subnetId', 'privateAddress', 'primary', 'privateAllocationMethod'] as const;
    for (const key of keys) {
        const left = before!.metadata![key], right = current!.metadata![key];
        if (key.endsWith('Id') ? !equalArmId(left, right) : left !== right)
            ambiguous();
    }
    const evidence = current!.metadata as AzureSlotEvidence;
    const nic = read.nics.get(evidence.nicId.toLowerCase()) ?? ambiguous();
    const configuration = nic.properties.ipConfigurations.find((c: AzureResource) => equalArmId(c.id, a.slot.interfaceId)) ?? ambiguous();
    const binding = configuration.properties.publicIPAddress?.id;
    if (a.phase === 'post_publish_cleanup' && a.publishedInventory) {
        const published = publishedAddress(a);
        const installed = current!.addresses.find(address => address.address === a.publishedAddress && address.family === a.slot.family);
        if (!equalArmId(binding, published.allocationId) || !installed || !equalArmId(installed.allocationId, published.allocationId) ||
            (published.metadata?.resourceGuid !== undefined && installed.metadata?.resourceGuid !== published.metadata.resourceGuid)) ambiguous();
    } else if (!equalArmId(binding, originalId(a)) && !equalArmId(binding, candidateId(a))) ambiguous();
    return { read, nic, configuration, binding };
}
function writableNic(nic: AzureResource, configurationId: string, newId: string): AzureResource {
    if (!nicSupported(nic))
        return ambiguous();
    const p = nic.properties;
    const properties: AzureResource = { ipConfigurations: p.ipConfigurations.map((c: AzureResource) => {
            const copied = structuredClone(c);
            delete copied.etag;
            delete copied.type;
            delete copied.properties.provisioningState;
            if (equalArmId(c.id, configurationId))
                copied.properties.publicIPAddress = { id: newId };
            return copied;
        }) };
    for (const key of ['networkSecurityGroup', 'enableAcceleratedNetworking', 'enableIPForwarding', 'disableTcpStateTracking'])
        if (p[key] !== undefined)
            properties[key] = structuredClone(p[key]);
    if (p.dnsSettings) {
        properties.dnsSettings = {};
        for (const key of ['dnsServers', 'internalDnsNameLabel'])
            if (p.dnsSettings[key] !== undefined)
                properties.dnsSettings[key] = structuredClone(p.dnsSettings[key]);
    }
    return { location: nic.location, ...(nic.tags ? { tags: structuredClone(nic.tags) } : {}), properties };
}
function operationUrl(adapter: AzureCloudAdapter, value: string): string {
    const url = adapter.http.url(value);
    if (value.length > 16384 || !/\/providers\/Microsoft\.Network\/(?:locations\/[^/]+\/(?:operations|operationResults)\/[^/]+|.*\/operationResults\/[^/]+)$/i.test(url.pathname))
        return ambiguous();
    return url.href;
}
function receipt(adapter: AzureCloudAdapter, a: RotationStepArguments, response?: AzureResponse): CloudStepResult {
    const async = response?.headers.get('azure-asyncoperation');
    const location = response?.headers.get('location');
    const operation = async ?? location;
    let operationId: string | undefined;
    if (operation) {
        try { operationId = operationUrl(adapter, operation); }
        catch { throw new CloudError('temporary_cloud_error', false, undefined, 'azure_write_outcome_unknown'); }
    }
    return { allocationId: candidateId(a), resourceId: candidateId(a), ...(operationId ? { operationId } : {}), before: { allocationId: originalId(a), address: a.slot.address, interfaceId: a.slot.interfaceId }, after: { ...(operation ? { operationKind: async ? 'azure-asyncoperation' : 'location' } : {}), ...(response ? { retryAfterMs: retryAfter(response.headers), pollAfter: Date.now() + (retryAfter(response.headers) ?? 0) } : {}) } };
}
async function poll(adapter: AzureCloudAdapter, a: RotationStepArguments): Promise<{
    status: 'ready' | 'pending';
    after?: Record<string, unknown>;
}> {
    if (!a.receipt?.operationId)
        return { status: 'ready' };
    if (typeof a.receipt.after?.pollAfter === 'number' && a.receipt.after.pollAfter > Date.now())
        return { status: 'pending', after: a.receipt.after };
    const response = await adapter.http.request(operationUrl(adapter, a.receipt.operationId), 'GET', undefined, true);
    const interval = retryAfter(response.headers);
    const after = { ...a.receipt.after, retryAfterMs: interval, pollAfter: Date.now() + (interval ?? 0) };
    if (response.status === 404)
        return { status: 'pending', after };
    const status = String(response.body.status ?? response.body.properties?.provisioningState ?? '');
    if (['Failed', 'Canceled', 'Cancelled'].includes(status))
        throw new CloudError('cloud_operation_failed', false);
    if (status === 'Succeeded')
        return { status: 'ready' };
    if (a.receipt.after?.operationKind === 'location' && (response.status === 200 || response.status === 204) && status === '')
        return { status: 'ready' };
    return { status: 'pending', after };
}
export async function executeAzureStep(adapter: AzureCloudAdapter, step: CloudStep): Promise<CloudStepResult> {
    const a = argumentsFor(adapter, step);
    if (a.previousExecution) {
        const observation = await observeAzureStep(adapter, step);
        if (observation.status === 'applied')
            return observation;
        return ambiguous();
    }
    const current = await context(adapter, a);
    if (step.action === 'azure.public-ip.delete' && a.publishedInventory) {
        const response = await adapter.http.getResource(originalId(a), NETWORK_API, true);
        if (response.status !== 404) cleanupOwnership(a, response.body);
        const result = response.status === 404 ? undefined : await adapter.http.request(`${originalId(a)}?api-version=${NETWORK_API}`, 'DELETE');
        return { ...receipt(adapter, a, result), allocationId: originalId(a), resourceId: originalId(a), candidateAddress: a.publishedAddress! };
    }
    const oldResponse = await adapter.http.getResource(originalId(a), NETWORK_API, step.action === 'azure.public-ip.delete');
    const old = oldResponse.status === 404 ? undefined : oldResponse.body;
    if (old)
        checkOld(a, old);
    if (step.action === 'azure.public-ip.allocate') {
        if (!old || !equalArmId(current.binding, originalId(a)) || !equalArmId(old.properties.ipConfiguration?.id, a.slot.interfaceId))
            return ambiguous();
        const existing = await adapter.http.getResource(candidateId(a), NETWORK_API, true);
        if (existing.status !== 404) {
            checkCandidate(a, existing.body, old);
            return { ...receipt(adapter, a), candidateAddress: existing.body.properties.ipAddress, after: { addressMetadata: azurePublicIpMetadata(existing.body, false, undefined, 'public_ip_unattached') } };
        }
        const result = await adapter.http.request(`${candidateId(a)}?api-version=${NETWORK_API}`, 'PUT', template(a, old));
        const resultReceipt = receipt(adapter, a, result);
        if (result.body.properties?.provisioningState === 'Succeeded') {
            checkCandidate(a, result.body, old);
            resultReceipt.candidateAddress = result.body.properties.ipAddress;
            resultReceipt.after = { ...resultReceipt.after, addressMetadata: azurePublicIpMetadata(result.body, false, undefined, 'public_ip_unattached') };
        }
        return resultReceipt;
    }
    const persisted = validateCandidateReceipt(a);
    const candidate = (await adapter.http.getResource(candidateId(a))).body;
    checkCandidate(a, candidate, old);
    if (candidate.properties.ipAddress !== persisted.candidateAddress)
        return ambiguous();
    if (step.action === 'azure.public-ip.associate') {
        if (!old)
            return ambiguous();
        if (equalArmId(current.binding, candidateId(a))) {
            const observed = await observeAzureStep(adapter, step);
            if (observed.status === 'applied')
                return observed;
            return ambiguous();
        }
        if (!equalArmId(old.properties.ipConfiguration?.id, a.slot.interfaceId) || candidate.properties.ipConfiguration)
            return ambiguous();
        // Azure documents a full NIC PUT but no conditional If-Match contract. This fresh check cannot exclude external edits after GET.
        const result = await adapter.http.request(`${current.nic.id}?api-version=${NETWORK_API}`, 'PUT', writableNic(current.nic, a.slot.interfaceId, candidateId(a)));
        return { ...receipt(adapter, a, result), candidateAddress: candidate.properties.ipAddress };
    }
    if (!equalArmId(current.binding, candidateId(a)) || !equalArmId(candidate.properties.ipConfiguration?.id, a.slot.interfaceId) || candidate.properties.ipAddress !== a.publishedAddress || old?.properties.ipConfiguration)
        return ambiguous();
    if (!old)
        return { allocationId: originalId(a), resourceId: originalId(a), candidateAddress: candidate.properties.ipAddress };
    const result = await adapter.http.request(`${originalId(a)}?api-version=${NETWORK_API}`, 'DELETE');
    return { ...receipt(adapter, a, result), allocationId: originalId(a), resourceId: originalId(a), candidateAddress: candidate.properties.ipAddress };
}
export async function observeAzureStep(adapter: AzureCloudAdapter, step: CloudStep): Promise<CloudObservation> {
    const a = argumentsFor(adapter, step);
    try {
        const operation = await poll(adapter, a);
        if (operation.status === 'pending')
            return { ...a.receipt, ...(operation.after ? { after: operation.after } : {}), status: 'pending' };
        const current = await context(adapter, a, true);
        if (step.action === 'azure.public-ip.delete' && a.publishedInventory) {
            const response = await adapter.http.getResource(originalId(a), NETWORK_API, true);
            if (response.status !== 404) cleanupOwnership(a, response.body);
            return { ...a.receipt, allocationId: originalId(a), resourceId: originalId(a), candidateAddress: a.publishedAddress!, status: response.status === 404 ? 'applied' : 'pending' };
        }
        const oldResponse = await adapter.http.getResource(originalId(a), NETWORK_API, true);
        const old = oldResponse.status === 404 ? undefined : oldResponse.body;
        if (old)
            checkOld(a, old);
        const candidateResponse = await adapter.http.getResource(candidateId(a), NETWORK_API, true);
        if (candidateResponse.status === 404)
            return { ...a.receipt, status: (a.previousExecution || a.receipt) ? 'ambiguous' : 'not_applied' };
        const candidate = candidateResponse.body;
        // Check pinned identity even when provisioning has not converged.
        checkCandidateIdentity(a, candidate);
        if (['Updating', 'Creating', 'Deleting'].includes(candidate.properties?.provisioningState))
            return { ...a.receipt, status: 'pending' };
        checkCandidate(a, candidate, old);
        // NIC Updating is normal after a lost PUT response. All identity/topology
        // checks above still apply, but no binding is installed until Succeeded.
        if (current.nic.properties.provisioningState === 'Updating')
            return { ...a.receipt, status: 'pending' };
        if (step.action === 'azure.public-ip.allocate') {
            if (!old)
                return { ...a.receipt, status: 'ambiguous' };
            const bound = equalArmId(candidate.properties.ipConfiguration?.id, a.slot.interfaceId);
            if (bound !== equalArmId(current.binding, candidateId(a)) || (bound && old.properties.ipConfiguration))
                return { ...a.receipt, status: 'ambiguous' };
            const baseReceipt = receipt(adapter, a);
            return {
                ...baseReceipt, ...a.receipt, candidateAddress: candidate.properties.ipAddress, status: 'applied',
                after: {
                    ...baseReceipt.after, ...a.receipt?.after,
                    addressMetadata: azurePublicIpMetadata(candidate, bound, bound ? candidate.properties.ipConfiguration.id : undefined, 'public_ip_unattached'),
                    privateAddress: current.configuration.properties.privateIPAddress,
                },
            };
        }
        const persisted = validateCandidateReceipt(a);
        if (candidate.properties.ipAddress !== persisted.candidateAddress)
            return { ...a.receipt, status: 'ambiguous' };
        // A dispatched NIC PUT can still expose the original binding before Updating.
        // Keep observing this proven pre-write state; execution recovery never redispatches.
        if (step.action === 'azure.public-ip.associate' && equalArmId(current.binding, originalId(a)) &&
            old && equalArmId(old.properties.ipConfiguration?.id, a.slot.interfaceId) && !candidate.properties.ipConfiguration)
            return { ...a.receipt, status: 'pending' };
        if (!equalArmId(current.binding, candidateId(a)) || !equalArmId(candidate.properties.ipConfiguration?.id, a.slot.interfaceId))
            return { ...a.receipt, status: 'ambiguous' };
        if (step.action === 'azure.public-ip.delete') {
            if (candidate.properties.ipAddress !== a.publishedAddress)
                return { ...a.receipt, status: 'ambiguous' };
            if (old?.properties.ipConfiguration)
                return { ...a.receipt, status: 'ambiguous' };
            return { ...a.receipt, allocationId: originalId(a), resourceId: originalId(a), candidateAddress: candidate.properties.ipAddress, status: old ? 'pending' : 'applied' };
        }
        if (!old || old.properties.ipConfiguration)
            return { ...a.receipt, status: 'ambiguous' };
        const installed = current.read.inventory.interfaces.find(i => equalArmId(i.id, a.slot.interfaceId))?.addresses.find(address => address.address === candidate.properties.ipAddress && address.family === a.slot.family);
        if (!installed || !equalArmId(installed.allocationId, candidateId(a)))
            return { ...a.receipt, status: 'ambiguous' };
        const baseReceipt = receipt(adapter, a);
        return {
            ...baseReceipt, ...a.receipt, candidateAddress: candidate.properties.ipAddress, status: 'applied',
            after: { ...baseReceipt.after, ...a.receipt?.after, addressMetadata: structuredClone(installed.metadata ?? {}), ...(installed.privateAddress === undefined ? {} : { privateAddress: installed.privateAddress }) },
        };
    }
    catch (error) {
        if (error instanceof CloudError && error.code === 'resource_ownership_ambiguous')
            return { ...a.receipt, status: 'ambiguous' };
        if (error instanceof CloudError && ['resource_not_found', 'temporary_cloud_error', 'rate_limited', 'permission_denied'].includes(error.code))
            return { ...a.receipt, status: 'pending' };
        throw error;
    }
}

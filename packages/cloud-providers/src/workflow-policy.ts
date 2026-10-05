import type { SlotRef } from "@masterdns/contracts";
import type { CloudAddress, CloudInventory, CloudStepResult } from "./provider.js";

type StoredAddress = { address: string; remoteAllocationId: string | null; origin: string; metadata: Record<string, unknown> };
type CleanupResource = { address: string; allocationId: string | null; resourceId: string | null; origin: string; ownershipAttemptId: string | null; snapshot: Record<string, unknown> };
type AllocationIdentity = { allocationId: string | null; resourceId: string | null; resourceGuid: string | null };

/** Pure service differences. Transactions, grants and version checks belong to consumers. */
export interface CloudWorkflowPolicy {
  readonly preserveAllocationIdentity: boolean;
  inventoryAddressRole(metadata: Record<string, unknown> | undefined): string | undefined;
  candidateAddressMetadata(receipt: CloudStepResult): Record<string, unknown>;
  publicationAddressMatches(stored: StoredAddress, observed: CloudAddress): boolean;
  cleanupAttachedAddressAllowed(slot: SlotRef, oldAddress: string, publishedAddress: string, live: CloudInventory): boolean;
  reconstructCleanupCandidate(slot: SlotRef, addresses: CloudAddress[], resource: Pick<CleanupResource, "address" | "allocationId" | "resourceId">, receipt: CloudStepResult): CloudAddress[];
  cleanupResourceIdentity(resource: CleanupResource): string | undefined;
  cleanupNeedsOwnershipSnapshot(origin: string): boolean;
  cleanupCanReleaseWithoutAllocation(family: number): boolean;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function candidateAddressMetadata(receipt: CloudStepResult): Record<string, unknown> {
  return { providerMetadata: record(receipt.after?.addressMetadata) ?? {},
    ...(typeof receipt.after?.privateAddress === "string" ? { privateAddress: receipt.after.privateAddress } : {}),
    ...(receipt.resourceId ? { resourceId: receipt.resourceId } : {}) };
}
function publicationAddressMatches(stored: StoredAddress, observed: CloudAddress): boolean {
  const metadata = stored.metadata;
  const providerMetadata = record(metadata.providerMetadata);
  const identity = metadata.allocationIdentity as AllocationIdentity | undefined;
  return observed.address === stored.address && (!stored.remoteAllocationId || observed.allocationId === stored.remoteAllocationId) &&
    (!metadata.resourceId || observed.resourceId === metadata.resourceId) &&
    (!providerMetadata?.resourceGuid || observed.metadata?.resourceGuid === providerMetadata.resourceGuid) &&
    (!identity || observed.allocationId === identity.allocationId && observed.resourceId === identity.resourceId && observed.metadata?.resourceGuid === identity.resourceGuid);
}
function reconstructCleanupCandidate(inherit: boolean, keepOtherAddresses: boolean): CloudWorkflowPolicy["reconstructCleanupCandidate"] {
  return (slot, addresses, resource, receipt) => {
    const previous = inherit ? addresses.find(address => address.family === slot.family) : undefined;
    return [...addresses.filter(address => keepOtherAddresses ? address.address !== resource.address : address.family !== slot.family), {
      ...previous,
      ...(receipt.after?.addressMetadata && typeof receipt.after.addressMetadata === "object" ? { metadata: receipt.after.addressMetadata as Record<string, unknown> } : {}),
      ...(typeof receipt.after?.privateAddress === "string" ? { privateAddress: receipt.after.privateAddress } : {}),
      address: resource.address, family: slot.family, primary: slot.family === 4,
      ...(resource.allocationId ? { allocationId: resource.allocationId } : {}),
      ...(resource.resourceId ? { resourceId: resource.resourceId } : {}),
    }];
  };
}
function cleanupResourceIdentity(resource: CleanupResource): string | undefined {
  const slot = resource.snapshot.slot as SlotRef | undefined;
  if (!slot || resource.origin !== "system" || !resource.ownershipAttemptId || !resource.allocationId || !resource.resourceId) return;
  const ownership = resource.snapshot.ownership as { metadata?: Record<string, unknown> } | undefined;
  const receipt = resource.snapshot.receipt as CloudStepResult | undefined;
  const receiptMetadata = record(receipt?.after?.addressMetadata);
  const guid = ownership?.metadata?.resourceGuid ?? receiptMetadata?.resourceGuid ?? null;
  return JSON.stringify([slot.accountId, slot.service, slot.region, slot.instanceId, slot.interfaceId, resource.address, resource.allocationId, resource.resourceId, resource.ownershipAttemptId, guid]);
}
const defaultPolicy: CloudWorkflowPolicy = {
  preserveAllocationIdentity: false,
  inventoryAddressRole: () => undefined,
  candidateAddressMetadata,
  publicationAddressMatches,
  cleanupAttachedAddressAllowed: (_slot, address, _published, live) => !live.interfaces.some(iface => iface.addresses.some(candidate => candidate.address === address)),
  reconstructCleanupCandidate: reconstructCleanupCandidate(false, false),
  cleanupResourceIdentity: () => undefined,
  cleanupNeedsOwnershipSnapshot: origin => origin === "user",
  cleanupCanReleaseWithoutAllocation: () => false,
};
const awsPolicy: CloudWorkflowPolicy = {
  ...defaultPolicy,
  inventoryAddressRole: metadata => metadata?.awsAddressScope === "public" || metadata?.awsAddressScope === "private" ? metadata.awsAddressScope : undefined,
  reconstructCleanupCandidate: reconstructCleanupCandidate(true, false),
};
export const ec2WorkflowPolicy: CloudWorkflowPolicy = {
  ...awsPolicy,
  cleanupAttachedAddressAllowed: (slot, address, _published, live) => {
    const attached = live.interfaces.flatMap(i => i.addresses.map(a => ({ i, a }))).find(item => item.a.address === address);
    return !attached || slot.family === 6 && attached.i.id === slot.interfaceId && !attached.a.primary;
  },
  cleanupCanReleaseWithoutAllocation: family => family === 6,
};
export const lightsailWorkflowPolicy: CloudWorkflowPolicy = { ...awsPolicy };
export const azureWorkflowPolicy: CloudWorkflowPolicy = {
  ...defaultPolicy,
  preserveAllocationIdentity: true,
  candidateAddressMetadata: receipt => {
    const resourceGuid = record(receipt.after?.addressMetadata)?.resourceGuid;
    return { ...candidateAddressMetadata(receipt), allocationIdentity: {
      allocationId: receipt.allocationId ?? null, resourceId: receipt.resourceId ?? null,
      resourceGuid: typeof resourceGuid === "string" && resourceGuid ? resourceGuid : null,
    } };
  },
  publicationAddressMatches: (stored, observed) => {
    const identity = stored.metadata.allocationIdentity as AllocationIdentity | undefined;
    if ((identity || stored.origin === "system") && !(identity ? identity.resourceGuid : record(stored.metadata.providerMetadata)?.resourceGuid)) return false;
    return publicationAddressMatches(stored, observed);
  },
  cleanupResourceIdentity,
  cleanupNeedsOwnershipSnapshot: () => true,
};
export const linodeWorkflowPolicy: CloudWorkflowPolicy = {
  ...defaultPolicy,
  reconstructCleanupCandidate: reconstructCleanupCandidate(false, true),
  cleanupAttachedAddressAllowed: (slot, address, published, live) => {
    const attached = live.interfaces.flatMap(i => i.addresses.map(a => ({ i, a }))).find(item => item.a.address === address);
    return !attached || slot.family === 4 && attached.i.id === slot.interfaceId && attached.i.addresses.some(a => a.family === 4 && a.address === published && a.address !== address);
  },
  cleanupResourceIdentity,
  cleanupNeedsOwnershipSnapshot: () => true,
};

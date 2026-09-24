import { demoNow, demoUser } from "./demo";
import type { CloudInstanceControlView } from "@masterdns/contracts/cloud-lifecycle";
import type { AddressSlot, CloudAccount, CloudInstanceDetail, CloudInstanceRow, CloudScope, CloudTargetSummary } from "./cloud-types";

export const demoCloudAccounts: CloudAccount[] = [{ id: "cloud-account-1", ownerUserId: demoUser.id, provider: "aws", name: "AWS Production", proxyProfileId: "demo-proxy-1", credentialHint: "AccessKey ...2K9Q", enabled: true, regions: ["ap-southeast-2", "us-west-2"], externalAccountId: "123456789012", createdAt: demoNow, updatedAt: demoNow }];
export const demoCloudScopes: CloudScope[] = [
  { id: "scope-1", accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", generation: 4, lastStartedAt: demoNow, lastCompletedAt: demoNow, lastError: null, createdAt: demoNow, updatedAt: demoNow },
  { id: "scope-2", accountId: "cloud-account-1", service: "lightsail", region: "us-west-2", generation: 3, lastStartedAt: demoNow, lastCompletedAt: demoNow, lastError: "AccessDenied: lightsail:GetInstances", createdAt: demoNow, updatedAt: demoNow },
];
export const demoCloudInstances: CloudInstanceRow[] = [{
  account: demoCloudAccounts[0]!,
  instance: { id: "cloud-instance-1", accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", externalId: "i-0a12bc34de56f7890", name: "edge-auckland-01", state: "running", metadata: { present: true, availabilityZone: "ap-southeast-2a" }, scanGeneration: 4, lastSeenAt: demoNow, createdAt: demoNow, updatedAt: demoNow },
  authorization: { instanceId: "cloud-instance-1", revision: 3, managed: true, allowIpv4Rotation: true, allowIpv6Rotation: false, allowStopStart: false, allowDelete: false, allowReleaseAddress: false, updatedAt: demoNow },
  inScope: true,
  addresses: [{ id: "address-v4", interfaceId: "interface-1", family: "4", address: "203.0.113.18", kind: "host", origin: "user" }, { id: "address-v6", interfaceId: "interface-1", family: "6", address: "2001:db8::18", kind: "host", origin: "user" }],
}];
export const demoCloudTarget: CloudTargetSummary = {
  account: { id: "cloud-account-1", name: "AWS Production", provider: "aws" },
  instance: { id: "cloud-instance-1", name: "edge-auckland-01", externalId: "i-0a12bc34de56f7890", service: "ec2", region: "ap-southeast-2" },
  slot: { id: "slot-v4", name: "public-v4", family: "4", currentVersion: 2, candidateVersion: 0 },
  currentAddress: { id: "address-v4", address: "203.0.113.18" }, candidateAddress: null,
};
export const demoCloudSlots: AddressSlot[] = [
  { cloudTarget: demoCloudTarget, slot: { id: "slot-v4", interfaceId: "interface-1", family: "4", name: "public-v4", currentAddressId: "address-v4", currentVersion: 2 }, currentAddress: { id: "address-v4", interfaceId: "interface-1", family: "4", address: "203.0.113.18", kind: "host", origin: "user" }, ref: { accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", instanceId: "i-0a12bc34de56f7890", interfaceId: "eni-0123", slotId: "slot-v4", address: "203.0.113.18", family: 4 }, capability: { available: true, permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false }, inScope: true },
  { cloudTarget: { ...demoCloudTarget, slot: { id: "slot-v6", name: "public-v6", family: "6", currentVersion: 1, candidateVersion: 0 }, currentAddress: { id: "address-v6", address: "2001:db8::18" } }, slot: { id: "slot-v6", interfaceId: "interface-1", family: "6", name: "public-v6", currentAddressId: "address-v6", currentVersion: 1 }, currentAddress: { id: "address-v6", interfaceId: "interface-1", family: "6", address: "2001:db8::18", kind: "host", origin: "user" }, ref: { accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", instanceId: "i-0a12bc34de56f7890", interfaceId: "eni-0123", slotId: "slot-v6", address: "2001:db8::18", family: 6 }, capability: { available: false, reason: "primary_ipv6_immutable", permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false }, inScope: true },
];
export const demoCloudInstanceDetail: CloudInstanceDetail = { ...demoCloudInstances[0]!, interfaces: [{ id: "interface-1", instanceId: "cloud-instance-1", externalId: "eni-0123", name: "Primary network interface", metadata: { deviceIndex: 0 }, scanGeneration: 4, lastSeenAt: demoNow }], addresses: demoCloudSlots.map((entry) => entry.currentAddress!).filter(Boolean) };
export const demoCloudControlView: CloudInstanceControlView = {
  policy: { instanceId: "cloud-instance-1", revision: 0, enabled: false, thresholdBytes: null, direction: "total", checkIntervalSeconds: 3_600, month: null, lastUsageBytes: null, lastCheckedAt: null, lastError: null, triggeredAt: null },
  operations: [],
  blocked: false,
  blockReason: null,
  powerHold: null,
};

import { demoNow, demoUser } from "./demo";
import type { AddressSlot, CloudAccount, CloudInstanceDetail, CloudInstanceRow, CloudScope } from "./cloud-types";

export const demoCloudAccounts: CloudAccount[] = [{ id: "cloud-account-1", ownerUserId: demoUser.id, provider: "aws", name: "AWS Production", credentialHint: "AccessKey ...2K9Q", enabled: true, regions: ["ap-southeast-2", "us-west-2"], externalAccountId: "123456789012", createdAt: demoNow, updatedAt: demoNow }];
export const demoCloudScopes: CloudScope[] = [
  { id: "scope-1", accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", generation: 4, lastStartedAt: demoNow, lastCompletedAt: demoNow, lastError: null, createdAt: demoNow, updatedAt: demoNow },
  { id: "scope-2", accountId: "cloud-account-1", service: "lightsail", region: "us-west-2", generation: 3, lastStartedAt: demoNow, lastCompletedAt: demoNow, lastError: "AccessDenied: lightsail:GetInstances", createdAt: demoNow, updatedAt: demoNow },
];
export const demoCloudInstances: CloudInstanceRow[] = [{
  account: demoCloudAccounts[0]!,
  instance: { id: "cloud-instance-1", accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", externalId: "i-0a12bc34de56f7890", name: "edge-auckland-01", state: "running", metadata: { present: true, availabilityZone: "ap-southeast-2a" }, scanGeneration: 4, lastSeenAt: demoNow, createdAt: demoNow, updatedAt: demoNow },
  authorization: { instanceId: "cloud-instance-1", revision: 3, managed: true, allowIpv4Rotation: false, allowIpv6Rotation: false, allowStopStart: false, allowReleaseAddress: false, updatedAt: demoNow },
  inScope: true,
  addresses: [{ id: "address-v4", interfaceId: "interface-1", family: "4", address: "203.0.113.18", kind: "host", origin: "user" }, { id: "address-v6", interfaceId: "interface-1", family: "6", address: "2001:db8::18", kind: "host", origin: "user" }],
}];
export const demoCloudSlots: AddressSlot[] = [
  { slot: { id: "slot-v4", interfaceId: "interface-1", family: "4", name: "public-v4", currentAddressId: "address-v4", currentVersion: 2 }, currentAddress: { id: "address-v4", interfaceId: "interface-1", family: "4", address: "203.0.113.18", kind: "host", origin: "user" }, ref: { accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", instanceId: "i-0a12bc34de56f7890", interfaceId: "eni-0123", slotId: "slot-v4", address: "203.0.113.18", family: 4 }, capability: { available: true, permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false }, inScope: true },
  { slot: { id: "slot-v6", interfaceId: "interface-1", family: "6", name: "public-v6", currentAddressId: "address-v6", currentVersion: 1 }, currentAddress: { id: "address-v6", interfaceId: "interface-1", family: "6", address: "2001:db8::18", kind: "host", origin: "user" }, ref: { accountId: "cloud-account-1", service: "ec2", region: "ap-southeast-2", instanceId: "i-0a12bc34de56f7890", interfaceId: "eni-0123", slotId: "slot-v6", address: "2001:db8::18", family: 6 }, capability: { available: false, reason: "primary_ipv6_immutable", permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false }, inScope: true },
];
export const demoCloudInstanceDetail: CloudInstanceDetail = { ...demoCloudInstances[0]!, interfaces: [{ id: "interface-1", instanceId: "cloud-instance-1", externalId: "eni-0123", name: "Primary network interface", metadata: { deviceIndex: 0 }, scanGeneration: 4, lastSeenAt: demoNow }], addresses: demoCloudSlots.map((entry) => entry.currentAddress!).filter(Boolean) };

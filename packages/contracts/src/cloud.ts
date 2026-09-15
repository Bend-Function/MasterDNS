export type CloudProvider = "aws" | "azure" | "linode";
export type CloudService = "ec2" | "lightsail" | "azure_vm" | "linode";

export const cloudProviderServices: Record<CloudProvider, readonly CloudService[]> = {
  aws: ["ec2", "lightsail"], azure: ["azure_vm"], linode: ["linode"],
};
export function cloudServiceProvider(service: CloudService): CloudProvider {
  switch (service) {
    case "ec2": case "lightsail": return "aws";
    case "azure_vm": return "azure";
    case "linode": return "linode";
    default: throw new Error("unsupported_cloud_service");
  }
}
/** Canonical provider scope identifiers, never URLs or wildcard scopes. */
export function validCloudRegion(provider: CloudProvider, region: string): boolean {
  if (region.length < 1 || region.length > 80) return false;
  switch (provider) {
    case "aws": return /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region);
    case "azure": return /^[a-z][a-z0-9]*$/.test(region);
    case "linode": return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(region);
    default: return false;
  }
}

export type AddressFamily = 4 | 6;

export type CloudRef = {
  accountId: string;
  service: CloudService;
  region: string;
  instanceId: string;
};

export type SlotRef = CloudRef & {
  slotId: string;
  interfaceId: string;
  address: string;
  family: AddressFamily;
};

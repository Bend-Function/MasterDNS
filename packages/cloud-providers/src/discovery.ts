import type { Instance as Ec2Instance, InstanceNetworkInterface, NetworkInterface } from "@aws-sdk/client-ec2";
import type { Instance as LightsailInstance, StaticIp } from "@aws-sdk/client-lightsail";

import type { CloudAddress, CloudInventory } from "./provider.js";

export function encodeCursor(service: "ec2" | "lightsail", token?: string): string | undefined {
  return token === undefined ? undefined : `${service}:${token}`;
}

export function decodeCursor(service: "ec2" | "lightsail", cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  const prefix = `${service}:`;
  if (!cursor.startsWith(prefix) || cursor.length === prefix.length) throw new Error("invalid_cursor");
  return cursor.slice(prefix.length);
}

function ec2Addresses(networkInterface: InstanceNetworkInterface | NetworkInterface): CloudAddress[] {
  const addresses: CloudAddress[] = [];
  for (const address of networkInterface.PrivateIpAddresses ?? []) {
    if (address.PrivateIpAddress !== undefined) {
      addresses.push({ address: address.PrivateIpAddress, family: 4, primary: address.Primary ?? false });
    }
    if (address.Association?.PublicIp !== undefined) {
      const association = address.Association as typeof address.Association & { AllocationId?: string };
      const publicAddress: CloudAddress = {
        address: address.Association.PublicIp,
        family: 4,
        primary: address.Primary ?? false,
      };
      if (association.AllocationId !== undefined) publicAddress.allocationId = association.AllocationId;
      addresses.push(publicAddress);
    }
  }
  for (const address of networkInterface.Ipv6Addresses ?? []) {
    if (address.Ipv6Address !== undefined) {
      addresses.push({ address: address.Ipv6Address, family: 6, primary: address.IsPrimaryIpv6 ?? false });
    }
  }
  return addresses;
}

export function mapEc2Instance(
  accountId: string,
  region: string,
  instance: Ec2Instance,
  authoritativeInterfaces?: NetworkInterface[],
): CloudInventory | undefined {
  if (instance.InstanceId === undefined) return undefined;
  const source = authoritativeInterfaces ?? instance.NetworkInterfaces ?? [];
  const name = instance.Tags?.find((tag) => tag.Key === "Name")?.Value ?? instance.InstanceId;
  const interfaces = source.flatMap((networkInterface) => {
    if (networkInterface.NetworkInterfaceId === undefined) return [];
    const mapped: CloudInventory["interfaces"][number] = {
      id: networkInterface.NetworkInterfaceId,
      addresses: ec2Addresses(networkInterface),
    };
    if (networkInterface.Attachment?.DeviceIndex !== undefined) mapped.deviceIndex = networkInterface.Attachment.DeviceIndex;
    return [mapped];
  });
  return {
    ref: { accountId, service: "ec2", region, instanceId: instance.InstanceId },
    name,
    state: instance.State?.Name ?? "unknown",
    interfaces,
  };
}

export function mapLightsailInstance(
  accountId: string,
  region: string,
  instance: LightsailInstance,
  staticIps: StaticIp[],
): CloudInventory | undefined {
  if (instance.arn === undefined || instance.name === undefined) return undefined;
  const addresses: CloudAddress[] = [];
  if (instance.privateIpAddress !== undefined) {
    addresses.push({ address: instance.privateIpAddress, family: 4, primary: true });
  }
  if (instance.publicIpAddress !== undefined) {
    const address: CloudAddress = { address: instance.publicIpAddress, family: 4, primary: true };
    const allocationId = staticIps.find((staticIp) => staticIp.attachedTo === instance.name && staticIp.ipAddress === instance.publicIpAddress)?.name;
    if (allocationId !== undefined) address.allocationId = allocationId;
    addresses.push(address);
  }
  for (const address of instance.ipv6Addresses ?? []) {
    addresses.push({ address, family: 6, primary: true });
  }
  return {
    ref: { accountId, service: "lightsail", region, instanceId: instance.arn },
    nativeName: instance.name,
    name: instance.name,
    state: instance.state?.name ?? "unknown",
    ipv6Only: instance.ipAddressType === "ipv6",
    interfaces: [{ id: "primary", addresses }],
  };
}

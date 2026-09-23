import { z } from "zod";
import type { CloudService } from "./cloud.js";

export const cloudRotationLimitPolicySchema = z.object({ utilizationPercent: z.number().int().min(1).max(100), enabled: z.boolean().optional() }).strict();
export type CloudRotationLimitRule = {
  id: string; name: string; scope: "region" | "global"; operations: string[];
  kind: "token_bucket" | "sliding_window"; officialCapacity: number; capacity: number;
  officialRefillPerSecond: number | null; refillPerSecond: number | null; windowSeconds: number | null;
};
export type CloudRotationLimitUsage = { ruleId: string; region: string | null; used: number; remaining: number; retryAt: string | null };
export type CloudRotationLimitStatus = { enabled?: boolean; service: CloudService; utilizationPercent: number; effectivePercent: number; rules: CloudRotationLimitRule[]; usage: CloudRotationLimitUsage[] };

const actions: Record<CloudService, Record<string, string>> = {
  ec2: {
    "ec2.auto-ipv4.disable": "ModifyNetworkInterfaceAttribute", "ec2.auto-ipv4.enable": "ModifyNetworkInterfaceAttribute",
    "ec2.eip.allocate": "AllocateAddress", "ec2.eip.associate": "AssociateAddress", "ec2.eip.release": "ReleaseAddress",
    "ec2.ipv6.assign": "AssignIpv6Addresses", "ec2.ipv6.unassign": "UnassignIpv6Addresses",
    "ec2.instance.start": "StartInstances", "ec2.instance.stop": "StopInstances", "ec2.instance.delete": "TerminateInstances",
  },
  lightsail: {
    "lightsail.static-ip.allocate": "AllocateStaticIp", "lightsail.static-ip.detach": "DetachStaticIp",
    "lightsail.static-ip.attach": "AttachStaticIp", "lightsail.static-ip.release": "ReleaseStaticIp",
    "lightsail.ipv6.disable": "SetIpAddressType", "lightsail.ipv6.enable": "SetIpAddressType",
    "lightsail.instance.start": "StartInstance", "lightsail.instance.stop": "StopInstance", "lightsail.instance.delete": "DeleteInstance",
  },
  azure_vm: { "azure.public-ip.allocate": "PublicIPAddresses.CreateOrUpdate", "azure.public-ip.associate": "NetworkInterfaces.CreateOrUpdate", "azure.public-ip.delete": "PublicIPAddresses.Delete", "azure_vm.instance.start": "VirtualMachines.Start", "azure_vm.instance.stop": "VirtualMachines.Deallocate", "azure_vm.instance.delete": "VirtualMachines.Delete" },
  linode: { "linode.ipv4.allocate": "InstanceIP.Allocate", "linode.instance.reboot": "Instance.Reboot", "linode.ipv4.release": "InstanceIP.Delete", "linode.instance.start": "Instance.Boot", "linode.instance.stop": "Instance.Shutdown", "linode.instance.delete": "Instance.Delete" },
};
export function cloudRotationOperation(service: CloudService, action: string): string {
  const operation = Object.hasOwn(actions[service] ?? {}, action) ? actions[service][action] : undefined;
  if (!operation) throw new Error("unsupported_rotation_action");
  return operation;
}
export function cloudRotationLimitRules(service: CloudService, utilizationPercent = 80): CloudRotationLimitRule[] {
  cloudRotationLimitPolicySchema.parse({ utilizationPercent });
  const percent = utilizationPercent / 100;
  const bucket = (id: string, operations: string[], capacity: number, refill: number): CloudRotationLimitRule => ({ id, name: id, operations, scope: "region", kind: "token_bucket", officialCapacity: capacity, capacity: Math.max(1, Math.floor(capacity * percent)), officialRefillPerSecond: refill, refillPerSecond: refill * percent, windowSeconds: null });
  const window = (id: string, operations: string[], capacity: number, seconds: number, scope: "region" | "global"): CloudRotationLimitRule => ({ id, name: id, operations, scope, kind: "sliding_window", officialCapacity: capacity, capacity: Math.max(1, Math.floor(capacity * percent)), officialRefillPerSecond: null, refillPerSecond: null, windowSeconds: seconds });
  const operations = [...new Set(Object.values(actions[service] ?? {}))];
  switch (service) {
    case "ec2": return operations.map(operation => bucket(`ec2.${operation}`, [operation], operation === "StartInstances" ? 5 : ["ModifyNetworkInterfaceAttribute", "AssignIpv6Addresses", "TerminateInstances"].includes(operation) ? 100 : 50, operation === "StartInstances" ? 2 : 5));
    case "lightsail": {
      const staticOperations = operations.filter(operation => ["AllocateStaticIp", "AttachStaticIp", "DetachStaticIp", "ReleaseStaticIp"].includes(operation));
      return [...operations.map(operation => bucket(`lightsail.${operation}`, [operation], ["StartInstance", "StopInstance", "DeleteInstance"].includes(operation) ? 20 : 1, ["StartInstance", "StopInstance"].includes(operation) ? 10 : 1)), window("lightsail.static-ip.hour", staticOperations, 50, 3600, "global"), window("lightsail.static-ip.day", staticOperations, 500, 86400, "global")];
    }
    case "azure_vm": return [bucket("azure.arm.writes", operations.filter(operation => !operation.endsWith(".Delete")), 200, 10), bucket("azure.arm.deletes", operations.filter(operation => operation.endsWith(".Delete")), 200, 10), window("azure.network.mutations", operations.filter(operation => !operation.startsWith("VirtualMachines.")), 1000, 300, "region")];
    case "linode": return [window("linode.mutations", operations, 1600, 60, "global")];
    default: throw new Error("unsupported_cloud_service");
  }
}
export function cloudRotationRulesForAction(service: CloudService, action: string, utilizationPercent = 80): CloudRotationLimitRule[] {
  const operation = cloudRotationOperation(service, action);
  return cloudRotationLimitRules(service, utilizationPercent).filter(rule => rule.operations.includes(operation));
}

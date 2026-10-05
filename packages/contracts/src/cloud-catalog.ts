import type { CloudCredentialKind } from "./cloud-credentials.js";

export const cloudServiceDefinitions = {
  ec2: { provider: "aws", label: "Amazon EC2", supportedRotationTriggers: ["health", "manual", "scheduled"] },
  lightsail: { provider: "aws", label: "Amazon Lightsail", supportedRotationTriggers: ["health", "manual", "scheduled"] },
  azure_vm: { provider: "azure", label: "Azure Virtual Machine", supportedRotationTriggers: ["health", "scheduled"] },
  linode: { provider: "linode", label: "Linode", supportedRotationTriggers: ["health", "manual", "scheduled"] },
} as const;
export type CloudService = keyof typeof cloudServiceDefinitions;
export const cloudServiceIds = Object.freeze(Object.keys(cloudServiceDefinitions) as [CloudService, ...CloudService[]]);
const servicesFor = (provider: (typeof cloudServiceDefinitions)[CloudService]["provider"]): readonly CloudService[] => cloudServiceIds.filter(service => cloudServiceDefinitions[service].provider === provider);

export const cloudProviderDefinitions = {
  aws: { label: "AWS", services: servicesFor("aws"), regionExample: "ap-southeast-2, us-west-2", regionPattern: /^[a-z]{2}(?:-[a-z]+)+-\d+$/, credentialKinds: ["access_key", "role"], credentialNotice: "" },
  azure: { label: "Microsoft Azure", services: servicesFor("azure"), regionExample: "australiaeast, westus2", regionPattern: /^[a-z][a-z0-9]*$/, credentialKinds: ["azure_service_principal"], credentialNotice: "使用 Service Principal；凭证验证不代表拥有 NIC、公网 IP 写入权限或足够配额。" },
  linode: { label: "Linode / Akamai Cloud", services: servicesFor("linode"), regionExample: "us-east, ap-south", regionPattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, credentialKinds: ["linode_token"], credentialNotice: "清单和轮换取决于 Token 的有效权限。额外 IPv4 需支持团队批准配额并产生费用；轮换及释放后的清理均需要重启授权。" },
} as const satisfies Record<(typeof cloudServiceDefinitions)[CloudService]["provider"], { label: string; services: readonly CloudService[]; regionExample: string; regionPattern: RegExp; credentialKinds: readonly CloudCredentialKind[]; credentialNotice: string }>;
export type CloudProvider = keyof typeof cloudProviderDefinitions;
export const cloudProviderIds = Object.freeze(Object.keys(cloudProviderDefinitions) as [CloudProvider, ...CloudProvider[]]);
export const cloudProviderServices = Object.fromEntries(cloudProviderIds.map(provider => [provider, cloudProviderDefinitions[provider].services])) as Record<CloudProvider, readonly CloudService[]>;

export function cloudServiceProvider(service: CloudService): CloudProvider {
  if (!Object.hasOwn(cloudServiceDefinitions, service)) throw new Error("unsupported_cloud_service");
  return cloudServiceDefinitions[service].provider;
}
/** Canonical provider scope identifiers, never URLs or wildcard scopes. */
export function validCloudRegion(provider: CloudProvider, region: string): boolean {
  return Object.hasOwn(cloudProviderDefinitions, provider) && region.length >= 1 && region.length <= 80 && cloudProviderDefinitions[provider].regionPattern.test(region);
}
export function credentialsMatchProvider(provider: CloudProvider, credentials: { kind: string }): boolean {
  return Object.hasOwn(cloudProviderDefinitions, provider) && (cloudProviderDefinitions[provider].credentialKinds as readonly string[]).includes(credentials.kind);
}

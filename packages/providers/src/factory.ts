import { AliyunDnsAdapter } from "./aliyun.js";
import { CloudflareDnsAdapter } from "./cloudflare.js";
import type { DnsProviderAdapter, ProviderCredentials } from "./provider.js";

export function createProviderAdapter(credentials: ProviderCredentials): DnsProviderAdapter {
  if (credentials.provider === "cloudflare") return new CloudflareDnsAdapter(credentials.apiToken);
  return new AliyunDnsAdapter(credentials);
}

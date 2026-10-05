import { describe, expect, it } from "vitest";
import * as cloud from "./cloud.js";

describe("browser-safe cloud catalog boundaries", () => {
  it("resolves registered services to their providers and rejects prototype names", () => {
    for (const [service, provider] of [["ec2", "aws"], ["lightsail", "aws"], ["azure_vm", "azure"], ["linode", "linode"]] as const) {
      expect(cloud.cloudServiceProvider(service)).toBe(provider);
      expect(cloud.cloudProviderServices[provider]).toContain(service);
    }
    for (const service of ["unknown", "constructor", "toString", "__proto__"]) expect(() => cloud.cloudServiceProvider(service as cloud.CloudService)).toThrow("unsupported_cloud_service");
  });
  it("rejects unknown providers and cross-provider credential kinds", () => {
    expect(cloud.credentialsMatchProvider).toBeTypeOf("function");
    for (const [provider, kind] of [["aws", "access_key"], ["aws", "role"], ["azure", "azure_service_principal"], ["linode", "linode_token"]] as const) {
      expect(cloud.credentialsMatchProvider(provider, { kind })).toBe(true);
    }
    for (const provider of ["aws", "azure", "constructor", "unknown"]) expect(cloud.credentialsMatchProvider(provider as cloud.CloudProvider, { kind: "linode_token" })).toBe(false);
    expect(cloud.credentialsMatchProvider("aws", { kind: "constructor" })).toBe(false);
  });
  it("shares strict credential validation without accepting internal proxy augmentation", () => {
    expect(cloud.cloudCredentialsSchema).toBeDefined();
    const credentials = { kind: "access_key", accessKeyId: "  AKIATESTONLY  ", secretAccessKey: "fake-secret-for-unit-tests" };
    expect(cloud.cloudCredentialsSchema.parse(credentials)).toEqual({ ...credentials, accessKeyId: "AKIATESTONLY" });
    for (const extra of [{ proxyUrl: "socks5://example.invalid:1080" }, { token: "hidden-other-provider" }]) expect(cloud.cloudCredentialsSchema.safeParse({ ...credentials, ...extra }).success).toBe(false);
    expect(cloud.cloudCredentialsSchema.safeParse({ kind: "role" }).success).toBe(true);
    expect(cloud.cloudCredentialsSchema.safeParse({ kind: "role", roleArn: "https://example.invalid" }).success).toBe(false);
    expect(cloud.cloudCredentialsSchema.safeParse({ kind: "linode_token", token: "" }).success).toBe(false);
  });
  it("enforces provider-specific bounded region scopes", () => {
    for (const [provider, region] of [["aws", "us-gov-west-1"], ["azure", "australiaeast"], ["linode", "ap-south"]] as const) expect(cloud.validCloudRegion(provider, region)).toBe(true);
    for (const [provider, region] of [["aws", "westus2"], ["azure", "us-east-1"], ["linode", "https://example.invalid"], ["constructor", "us-east-1"], ["aws", "a".repeat(81)], ["azure", ""]] as const) expect(cloud.validCloudRegion(provider as cloud.CloudProvider, region)).toBe(false);
  });
});

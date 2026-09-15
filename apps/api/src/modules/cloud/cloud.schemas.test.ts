import { describe, expect, it } from "vitest";
import { createCloudAccountSchema, cloudRegionsSchema } from "./cloud.schemas.js";

const azure = { kind: "azure_service_principal", tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", clientId: "33333333-3333-4333-8333-333333333333", clientSecret: "test-secret" };
describe("cloud account provider contracts", () => {
  it("accepts bounded provider scopes and matching Azure/Linode credentials", () => {
    expect(createCloudAccountSchema.safeParse({ name: "Azure", provider: "azure", regions: ["australiaeast"], credentials: azure }).success).toBe(true);
    expect(createCloudAccountSchema.safeParse({ name: "Linode", provider: "linode", regions: ["ap-south"], credentials: { kind: "linode_token", token: "test-token" } }).success).toBe(true);
    expect(cloudRegionsSchema.safeParse(["australiaeast", "ap-south"]).success).toBe(true);
  });
  it("rejects credentials for another provider and invalid or unbounded scopes", () => {
    for (const provider of ["aws", "azure"]) expect(createCloudAccountSchema.safeParse({ name: "Mismatch", provider, credentials: { kind: "linode_token", token: "test-token" } }).success).toBe(false);
    expect(createCloudAccountSchema.safeParse({ name: "AWS", provider: "aws", regions: ["australiaeast"], credentials: { kind: "role" } }).success).toBe(false);
    expect(createCloudAccountSchema.safeParse({ name: "Azure", provider: "azure", regions: ["us-east-1"], credentials: azure }).success).toBe(false);
    for (const regions of [["*"], ["https://example.com"], ["a".repeat(81)], ["ap-south", "ap-south"]]) expect(cloudRegionsSchema.safeParse(regions).success).toBe(false);
  });
  it("retains AWS credentials and strict AWS scopes", () => {
    expect(createCloudAccountSchema.safeParse({ name: "AWS", provider: "aws", regions: ["us-east-1", "us-gov-west-1"], credentials: { kind: "role" } }).success).toBe(true);
  });
});

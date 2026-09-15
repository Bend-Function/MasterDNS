import { describe, expect, it } from "vitest";
import { credentialPayload, credentialUpdatePayload, emptyCredentialDraft, resetCredentialDraft, validateAccountProvider, parseCloudRegions } from "./cloud-credentials";

const azure = {
  ...emptyCredentialDraft("azure"),
  tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333", clientSecret: "azure-secret",
};
describe("provider credential forms", () => {
  it("builds Azure credentials without hidden AWS or Linode fields", () => {
    expect(credentialPayload({ ...azure, accessKeyId: "AKIAOLDSECRET", secretAccessKey: "old-secret-must-not-leak", token: "old-token" })).toEqual({
      kind: "azure_service_principal", tenantId: azure.tenantId, subscriptionId: azure.subscriptionId, clientId: azure.clientId, clientSecret: "azure-secret",
    });
  });
  it("preserves Linode on token replacement and rejects target provider mismatch", () => {
    const draft = { ...emptyCredentialDraft("linode"), token: "new-token", clientSecret: "hidden-azure" };
    expect(credentialUpdatePayload("linode", draft)).toEqual({ credentials: { kind: "linode_token", token: "new-token" } });
    expect(() => credentialUpdatePayload("azure", draft)).toThrow(/provider/i);
    expect(() => validateAccountProvider("azure", { provider: "aws" })).toThrow(/provider/i);
  });
  it("clears every field on provider switch, close, and session reset", () => {
    const dirty = { ...azure, accessKeyId: "old-key", secretAccessKey: "old-secret", sessionToken: "old-session", externalId: "old-external", roleArn: "old-role", token: "old-token" };
    for (const provider of ["aws", "azure", "linode"] as const) {
      const clean = resetCredentialDraft(dirty, provider);
      expect(clean.provider).toBe(provider);
      expect(Object.entries(clean).filter(([key]) => !["provider", "awsKind"].includes(key)).every(([, value]) => value === "")).toBe(true);
      expect(() => credentialPayload(clean)).toThrow();
    }
  });
  it("validates credential fields and provider-specific regions before submission", () => {
    expect(() => credentialPayload({ ...azure, tenantId: "not-a-uuid" })).toThrow();
    expect(() => credentialPayload({ ...emptyCredentialDraft("linode"), token: "" })).toThrow();
    expect(parseCloudRegions("azure", "australiaeast, australiaeast\nwestus2")).toEqual(["australiaeast", "westus2"]);
    expect(() => parseCloudRegions("azure", "ap-southeast-2")).toThrow();
    expect(parseCloudRegions("linode", "us-east")).toEqual(["us-east"]);
  });
});

import { validCloudRegion, type CloudProvider } from "@masterdns/contracts/cloud";
import { z } from "zod";

export type CredentialDraft = {
  provider: CloudProvider; awsKind: "access_key" | "role";
  accessKeyId: string; secretAccessKey: string; sessionToken: string; roleArn: string; externalId: string;
  tenantId: string; subscriptionId: string; clientId: string; clientSecret: string; token: string;
};
export function emptyCredentialDraft(provider: CloudProvider = "aws"): CredentialDraft {
  return { provider, awsKind: "access_key", accessKeyId: "", secretAccessKey: "", sessionToken: "", roleArn: "", externalId: "", tenantId: "", subscriptionId: "", clientId: "", clientSecret: "", token: "" };
}
export function resetCredentialDraft(draft: CredentialDraft, provider = draft.provider): CredentialDraft { return emptyCredentialDraft(provider); }

// Browser-only validation mirrors the API credential boundary, without importing server adapters.
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("access_key"), accessKeyId: z.string().trim().min(8).max(128), secretAccessKey: z.string().min(16).max(256), sessionToken: z.string().min(1).max(8192).optional() }).strict(),
  z.object({ kind: z.literal("role"), roleArn: z.string().regex(/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/.+$/).max(2048).optional(), externalId: z.string().min(1).max(1224).optional() }).strict(),
  z.object({ kind: z.literal("azure_service_principal"), tenantId: z.string().uuid(), subscriptionId: z.string().uuid(), clientId: z.string().uuid(), clientSecret: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal("linode_token"), token: z.string().min(1).max(8192) }).strict(),
]);
export function credentialPayload(draft: CredentialDraft) {
  let value: unknown;
  switch (draft.provider) {
    case "azure": value = { kind: "azure_service_principal", tenantId: draft.tenantId.trim(), subscriptionId: draft.subscriptionId.trim(), clientId: draft.clientId.trim(), clientSecret: draft.clientSecret }; break;
    case "linode": value = { kind: "linode_token", token: draft.token }; break;
    case "aws": value = draft.awsKind === "role"
      ? { kind: "role", ...(draft.roleArn ? { roleArn: draft.roleArn } : {}), ...(draft.externalId ? { externalId: draft.externalId } : {}) }
      : { kind: "access_key", accessKeyId: draft.accessKeyId, secretAccessKey: draft.secretAccessKey, ...(draft.sessionToken ? { sessionToken: draft.sessionToken } : {}) }; break;
    default: throw new Error("未知云 Provider");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`请检查凭证字段：${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join("、")}`);
  return result.data;
}
export function validateAccountProvider(provider: CloudProvider, account: { provider: CloudProvider }) {
  if (account.provider !== provider) throw new Error("Cloud provider 不匹配，请重新加载账号后重试");
}
export function credentialUpdatePayload(provider: CloudProvider, draft: CredentialDraft) {
  validateAccountProvider(provider, draft);
  return { credentials: credentialPayload(draft) };
}
export function parseCloudRegions(provider: CloudProvider, value: string): string[] {
  const regions = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  if (regions.length > 100 || regions.some((region) => !validCloudRegion(provider, region))) throw new Error("区域标识与所选云 Provider 不匹配");
  return regions;
}

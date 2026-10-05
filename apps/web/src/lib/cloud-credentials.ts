import { cloudCredentialDefinitions, cloudCredentialsSchema, cloudProviderDefinitions, credentialsMatchProvider, validCloudRegion, type CloudCredentialField, type CloudCredentialKind, type CloudProvider } from "@masterdns/contracts/cloud";

export type CredentialDraft = { provider: CloudProvider; credentialKind: CloudCredentialKind } & Record<CloudCredentialField, string>;
export function emptyCredentialDraft(provider: CloudProvider = "aws"): CredentialDraft {
  const fields = Object.fromEntries(Object.values(cloudCredentialDefinitions).flatMap(definition => definition.fields.map(field => [field.key, ""]))) as Record<CloudCredentialField, string>;
  if (!Object.hasOwn(cloudProviderDefinitions, provider)) throw new Error("未知云 Provider");
  return { ...fields, provider, credentialKind: cloudProviderDefinitions[provider].credentialKinds[0] };
}
export function resetCredentialDraft(draft: CredentialDraft, provider = draft.provider): CredentialDraft { return emptyCredentialDraft(provider); }

export function credentialDraftKind(draft: CredentialDraft): CloudCredentialKind {
  if (!Object.hasOwn(cloudProviderDefinitions, draft.provider)) throw new Error("未知云 Provider");
  const kind = draft.credentialKind;
  if (!credentialsMatchProvider(draft.provider, { kind })) throw new Error("未知凭证类型");
  return kind;
}
export function credentialPayload(draft: CredentialDraft) {
  const kind = credentialDraftKind(draft);
  const value: Record<string, string> = { kind };
  for (const field of cloudCredentialDefinitions[kind].fields) {
    const input = draft[field.key];
    if (field.optional && !input) continue;
    value[field.key] = field.trim ? input.trim() : input;
  }
  const result = cloudCredentialsSchema.safeParse(value);
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
  if (!Object.hasOwn(cloudProviderDefinitions, provider) || regions.length > 100 || regions.some((region) => !validCloudRegion(provider, region))) throw new Error("区域标识与所选云 Provider 不匹配");
  return regions;
}

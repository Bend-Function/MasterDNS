"use client";

import type { CredentialDraft } from "../lib/cloud-credentials";
import { Field } from "./ui";

export function CloudCredentialFields({ draft, setDraft, admin, disabled, changeKind }: { draft: CredentialDraft; setDraft: (value: CredentialDraft) => void; admin: boolean; disabled: boolean; changeKind: (value: CredentialDraft["awsKind"]) => void }) {
  const field = (key: Exclude<keyof CredentialDraft, "provider" | "awsKind">, label: string, secret = false, required = true) => <Field key={key} label={label}><input name={key} type={secret ? "password" : "text"} autoComplete="off" value={draft[key]} disabled={disabled} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} required={required} /></Field>;
  if (draft.provider === "azure") return <>{field("tenantId", "Tenant ID")}{field("subscriptionId", "Subscription ID")}{field("clientId", "Client ID (Application ID)")}{field("clientSecret", "Client Secret", true)}<p className="muted span-2">使用 Service Principal；凭证验证不代表拥有 NIC、公网 IP 写入权限或足够配额。</p></>;
  if (draft.provider === "linode") return <>{field("token", "Personal Access Token", true)}<p className="muted span-2">清单和轮换取决于 Token 的有效权限。额外 IPv4 需支持团队批准配额并产生费用；轮换及释放后的清理均需要重启授权。</p></>;
  return <>{admin && <Field label="凭证来源"><select name="awsKind" value={draft.awsKind} disabled={disabled} onChange={(event) => changeKind(event.target.value as CredentialDraft["awsKind"])}><option value="access_key">专用 IAM AccessKey</option><option value="role">部署环境身份 / AssumeRole</option></select></Field>}{draft.awsKind === "access_key" ? <>{field("accessKeyId", "AccessKey ID")}{field("secretAccessKey", "Secret AccessKey", true)}{field("sessionToken", "Session Token（可选）", true, false)}</> : <>{field("roleArn", "Role ARN（可选）", false, false)}{field("externalId", "External ID（可选）", true, false)}</>}</>;
}

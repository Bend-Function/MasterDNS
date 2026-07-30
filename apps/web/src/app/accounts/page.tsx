"use client";

import { KeyRound, Pause, Play, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, jsonBody, relativeTime, UI_PREVIEW } from "../../lib/api";
import { demoAccounts } from "../../lib/demo";
import type { ProviderAccount } from "../../lib/types";

export default function AccountsPage() {
  const { data, setData, loading, error, reload } = useResource<ProviderAccount[]>("/v1/provider-accounts", demoAccounts);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<"cloudflare" | "aliyun">("cloudflare");
  const [name, setName] = useState(""); const [apiToken, setApiToken] = useState(""); const [accessKeyId, setAccessKeyId] = useState(""); const [accessKeySecret, setAccessKeySecret] = useState("");
  const [saving, setSaving] = useState(false); const [formError, setFormError] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ProviderAccount | null>(null);
  const [rotateToken, setRotateToken] = useState("");
  const [rotateAccessKeyId, setRotateAccessKeyId] = useState("");
  const [rotateAccessKeySecret, setRotateAccessKeySecret] = useState("");
  const create = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setFormError(null); try { const body = provider === "cloudflare" ? { provider, name, apiToken } : { provider, name, accessKeyId, accessKeySecret }; if (!UI_PREVIEW) { await api("/v1/provider-accounts", { method: "POST", ...jsonBody(body) }); await reload(); } else setData([...(data ?? []), { id: `preview-${Date.now()}`, ownerUserId: "demo-admin", provider, name, credentialHint: provider === "cloudflare" ? "API Token" : `AccessKey ...${accessKeyId.slice(-4)}`, status: "active", errorCode: null, lastVerifiedAt: new Date().toISOString(), lastSyncedAt: null, createdAt: new Date().toISOString() }]); setOpen(false); setApiToken(""); setAccessKeySecret(""); } catch (value) { setFormError(value instanceof Error ? value.message : "云账号验证失败"); } finally { setSaving(false); } };
  const sync = async (id: string) => { if (!UI_PREVIEW) await api(`/v1/provider-accounts/${id}/sync`, { method: "POST" }); await reload(); };
  const toggle = async (account: ProviderAccount) => { if (!UI_PREVIEW) await api(`/v1/provider-accounts/${account.id}/status`, { method: "PATCH", ...jsonBody({ status: account.status === "active" ? "disabled" : "active" }) }); else setData((data ?? []).map((item) => item.id === account.id ? { ...item, status: item.status === "active" ? "disabled" : "active" } : item)); await reload(); };
  const rotate = async (event: FormEvent) => {
    event.preventDefault();
    if (!rotateTarget) return;
    setSaving(true);
    setFormError(null);
    try {
      const body = rotateTarget.provider === "cloudflare"
        ? { provider: "cloudflare", apiToken: rotateToken }
        : { provider: "aliyun", accessKeyId: rotateAccessKeyId, accessKeySecret: rotateAccessKeySecret };
      if (!UI_PREVIEW) await api(`/v1/provider-accounts/${rotateTarget.id}/credentials`, { method: "PATCH", ...jsonBody(body) });
      await reload();
      setRotateTarget(null);
      setRotateToken("");
      setRotateAccessKeySecret("");
    } catch (value) {
      setFormError(value instanceof Error ? value.message : "凭证轮换失败");
    } finally {
      setSaving(false);
    }
  };
  return <ConsoleLayout><PageHeader title="云账号" description="凭证加密保存，验证通过后同步 Zone 与记录" actions={<Button icon={<Plus size={15} />} onClick={() => setOpen(true)}>接入云账号</Button>} />
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : data?.length === 0 ? <div className="surface"><EmptyState title="尚未接入云账号" action={<Button onClick={() => setOpen(true)}>接入账号</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>账号</th><th>Provider</th><th>凭证</th><th>状态</th><th>最近验证</th><th>最近同步</th><th aria-label="操作" /></tr></thead><tbody>{data?.map((account) => <tr key={account.id}><td><div className="table-primary"><strong>{account.name}</strong><small>{account.ownerUsername ?? "当前用户"}</small></div></td><td><span className={`provider-mark ${account.provider === "cloudflare" ? "provider-cf" : "provider-ali"}`}>{account.provider === "cloudflare" ? "CF" : "ALI"}</span></td><td><span className="mono"><KeyRound size={12} /> {account.credentialHint}</span></td><td><StatusBadge value={account.status} />{account.errorCode && <div className="muted">{account.errorCode}</div>}</td><td className="muted">{relativeTime(account.lastVerifiedAt)}</td><td className="muted">{relativeTime(account.lastSyncedAt)}</td><td><div className="row-actions"><IconButton label="轮换凭证" onClick={() => { setRotateTarget(account); setFormError(null); }}><KeyRound size={15} /></IconButton><IconButton label="同步账号" onClick={() => void sync(account.id)}><RefreshCw size={15} /></IconButton><IconButton label={account.status === "active" ? "停用账号" : "启用账号"} onClick={() => void toggle(account)}>{account.status === "active" ? <Pause size={15} /> : <Play size={15} />}</IconButton></div></td></tr>)}</tbody></table></div>}
    <Dialog open={open} title="接入云账号" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>取消</Button><Button type="submit" form="account-form" disabled={saving}>{saving ? "正在验证" : "验证并接入"}</Button></>}><form id="account-form" className="field-grid" onSubmit={create}><div className="span-2 segmented"><button type="button" className={provider === "cloudflare" ? "active" : ""} onClick={() => setProvider("cloudflare")}>Cloudflare</button><button type="button" className={provider === "aliyun" ? "active" : ""} onClick={() => setProvider("aliyun")}>阿里云 DNS</button></div><Field label="显示名称"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field>{provider === "cloudflare" ? <Field label="API Token"><input type="password" autoComplete="off" value={apiToken} onChange={(event) => setApiToken(event.target.value)} required /></Field> : <><Field label="AccessKey ID"><input autoComplete="off" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required /></Field><Field label="AccessKey Secret"><input type="password" autoComplete="off" value={accessKeySecret} onChange={(event) => setAccessKeySecret(event.target.value)} required /></Field></>}{formError && <div className="login-error span-2">{formError}</div>}</form></Dialog>
    <Dialog open={rotateTarget !== null} title={`轮换 ${rotateTarget?.name ?? "云账号"} 凭证`} onClose={() => setRotateTarget(null)} footer={<><Button variant="secondary" onClick={() => setRotateTarget(null)}>取消</Button><Button type="submit" form="rotate-account-form" disabled={saving}>{saving ? "正在验证" : "验证并轮换"}</Button></>}><form id="rotate-account-form" className="field-grid" onSubmit={rotate}>{rotateTarget?.provider === "cloudflare" ? <Field label="新 API Token"><input type="password" autoComplete="off" value={rotateToken} onChange={(event) => setRotateToken(event.target.value)} required /></Field> : <><Field label="新 AccessKey ID"><input autoComplete="off" value={rotateAccessKeyId} onChange={(event) => setRotateAccessKeyId(event.target.value)} required /></Field><Field label="新 AccessKey Secret"><input type="password" autoComplete="off" value={rotateAccessKeySecret} onChange={(event) => setRotateAccessKeySecret(event.target.value)} required /></Field></>}{formError && <div className="login-error span-2">{formError}</div>}</form></Dialog>
  </ConsoleLayout>;
}

"use client";

import { KeyRound, Pause, Play, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoCloudAccounts, demoCloudScopes } from "../../lib/cloud-demo";
import type { CloudAccount, CloudScope } from "../../lib/cloud-types";
import { submitCloudIntent } from "../../lib/cloud-ui";
import { demoUser } from "../../lib/demo";
import { createIntentKey } from "../../lib/intent-key";
import type { User } from "../../lib/types";

type CredentialKind = "access_key" | "role";

export default function CloudAccountsPage() {
  const resource = useResource<CloudAccount[]>("/v1/cloud-accounts", demoCloudAccounts);
  const { data, setData, loading, error, reload } = resource;
  const [me, setMe] = useState<User>(demoUser);
  const [users, setUsers] = useState<User[]>([demoUser]);
  const [scopes, setScopes] = useState<Record<string, CloudScope[]>>({ "cloud-account-1": demoCloudScopes });
  const [open, setOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<CloudAccount | null>(null);
  const [regionsTarget, setRegionsTarget] = useState<CloudAccount | null>(null);
  const [name, setName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [regions, setRegions] = useState("");
  const [credentialKind, setCredentialKind] = useState<CredentialKind>("access_key");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [externalId, setExternalId] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const createIntent = useRef(createIntentKey());

  useEffect(() => {
    if (UI_PREVIEW) return;
    api<User>("/v1/auth/me").then((user) => {
      setMe(user);
      setOwnerUserId(user.id);
      if (user.role === "admin") api<User[]>("/v1/users").then(setUsers).catch(() => undefined);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (UI_PREVIEW || !data) return;
    Promise.all(data.map(async (account) => [account.id, await api<CloudScope[]>(`/v1/cloud-accounts/${account.id}/scopes`)] as const))
      .then((entries) => setScopes(Object.fromEntries(entries))).catch(() => undefined);
  }, [data]);

  const credentials = () => credentialKind === "role"
    ? { kind: "role" as const, ...(roleArn ? { roleArn } : {}), ...(externalId ? { externalId } : {}) }
    : { kind: "access_key" as const, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  const clearSecrets = () => { setAccessKeyId(""); setSecretAccessKey(""); setSessionToken(""); setRoleArn(""); setExternalId(""); };
  const closeCreate = () => { setOpen(false); setFormError(null); clearSecrets(); };
  const closeRotate = () => { setRotateTarget(null); setFormError(null); clearSecrets(); };
  const openCreate = () => { createIntent.current.reset(); setCredentialKind("access_key"); setOwnerUserId(me.id); setFormError(null); setOpen(true); };

  const create = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setFormError(null);
    const selectedRegions = parseRegions(regions);
    const body = { provider: "aws", name, ...(me.role === "admin" && ownerUserId ? { ownerUserId } : {}), ...(selectedRegions.length ? { regions: selectedRegions } : {}), credentials: credentials() };
    try {
      if (!UI_PREVIEW) await submitCloudIntent(createIntent.current, (key) => api("/v1/cloud-accounts", { method: "POST", headers: { "idempotency-key": key }, ...jsonBody(body) }));
      else setData([...(data ?? []), { id: `preview-${Date.now()}`, ownerUserId: ownerUserId || me.id, provider: "aws", name, credentialHint: credentialKind === "role" ? "Deployment identity" : `AccessKey ...${accessKeyId.slice(-4)}`, enabled: true, regions: selectedRegions.length ? selectedRegions : null, externalAccountId: "123456789012", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
      if (!UI_PREVIEW) await reload(); setName(""); setRegions(""); closeCreate();
    } catch (value) { setFormError(message(value, "AWS 账号验证失败")); }
    finally { setSaving(false); }
  };

  const rotate = async (event: FormEvent) => {
    event.preventDefault(); if (!rotateTarget) return; setSaving(true); setFormError(null);
    try { if (!UI_PREVIEW) { await api(`/v1/cloud-accounts/${rotateTarget.id}/credentials`, { method: "PATCH", ...jsonBody({ credentials: credentials() }) }); await reload(); } closeRotate(); }
    catch (value) { setFormError(message(value, "凭证轮换失败")); }
    finally { setSaving(false); }
  };

  const updateRegions = async (event: FormEvent) => {
    event.preventDefault(); if (!regionsTarget) return; setSaving(true); setFormError(null);
    const value = parseRegions(regions);
    try { if (!UI_PREVIEW) { await api(`/v1/cloud-accounts/${regionsTarget.id}/regions`, { method: "PATCH", ...jsonBody({ regions: value.length ? value : null }) }); await reload(); } else setData((data ?? []).map((item) => item.id === regionsTarget.id ? { ...item, regions: value.length ? value : null } : item)); setRegionsTarget(null); }
    catch (errorValue) { setFormError(message(errorValue, "区域范围更新失败")); }
    finally { setSaving(false); }
  };

  const mutate = async (account: CloudAccount, action: "sync" | "status") => {
    setBusyId(account.id); setFormError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/cloud-accounts/${account.id}/${action}`, { method: action === "sync" ? "POST" : "PATCH", ...(action === "status" ? jsonBody({ enabled: !account.enabled }) : {}) });
      else if (action === "status") setData((data ?? []).map((item) => item.id === account.id ? { ...item, enabled: !item.enabled } : item));
      if (!UI_PREVIEW) await reload();
    } catch (value) { setFormError(message(value, action === "sync" ? "同步入队失败" : "账号状态更新失败")); }
    finally { setBusyId(null); }
  };

  return <ConsoleLayout><PageHeader title="云计算账号" description="AWS 清单与凭证独立于 DNS Provider 账号" actions={<Button icon={<Plus size={15} />} onClick={openCreate}>接入 AWS</Button>} />
    {formError && !open && !rotateTarget && !regionsTarget && <div className="inline-error" role="alert">{formError}</div>}
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : data?.length === 0 ? <div className="surface"><EmptyState title="尚未接入云计算账号" action={<Button onClick={openCreate}>接入 AWS</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>账号</th><th>AWS ID</th><th>区域范围</th><th>清单状态</th><th>凭证</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{data?.map((account) => {
      const accountScopes = scopes[account.id] ?? []; const failed = accountScopes.filter((scope) => scope.lastError);
      return <tr key={account.id}><td><div className="table-primary"><strong>{account.name}</strong><small>{me.role === "admin" ? users.find((user) => user.id === account.ownerUserId)?.username ?? account.ownerUserId : "当前用户"}</small></div></td><td className="mono">{account.externalAccountId ?? "待验证"}</td><td>{account.regions?.join(", ") ?? "所有已启用区域"}</td><td><div className="table-primary"><strong>{failed.length ? `${failed.length} 个区域异常` : accountScopes.length ? "同步完整" : "等待首次同步"}</strong><small>{failed[0]?.lastError ?? (accountScopes[0]?.lastCompletedAt ? `完成 ${accountScopes.length} 个范围` : "尚无扫描结果")}</small></div></td><td className="muted"><KeyRound size={12} /> {account.credentialHint ?? "已配置"}</td><td><StatusBadge value={account.enabled ? "active" : "disabled"} /></td><td><div className="row-actions"><IconButton label="编辑区域范围" onClick={() => { setRegions(account.regions?.join(", ") ?? ""); setRegionsTarget(account); setFormError(null); }}><SlidersHorizontal size={15} /></IconButton><IconButton label="轮换凭证" onClick={() => { setCredentialKind("access_key"); clearSecrets(); setRotateTarget(account); setFormError(null); }}><KeyRound size={15} /></IconButton><IconButton label="同步云清单" disabled={busyId === account.id || !account.enabled} onClick={() => void mutate(account, "sync")}><RefreshCw size={15} /></IconButton><IconButton label={account.enabled ? "停用账号" : "启用账号"} disabled={busyId === account.id} onClick={() => void mutate(account, "status")}>{account.enabled ? <Pause size={15} /> : <Play size={15} />}</IconButton></div></td></tr>;
    })}</tbody></table></div>}
    <Dialog open={open} title="接入 AWS 账号" onClose={closeCreate} footer={<><Button variant="secondary" onClick={closeCreate}>取消</Button><Button type="submit" form="cloud-account-form" disabled={saving}>{saving ? "正在验证" : "验证并接入"}</Button></>}><form id="cloud-account-form" className="field-grid" onSubmit={create}><Field label="显示名称"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field>{me.role === "admin" && <Field label="资源所有者"><select value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>{users.filter((user) => user.status === "active").map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></Field>}<Field label="区域范围（可选）" hint="逗号或换行分隔；留空扫描所有已启用区域"><textarea value={regions} onChange={(event) => setRegions(event.target.value)} placeholder="ap-southeast-2, us-west-2" /></Field>{me.role === "admin" && <Field label="凭证来源"><select value={credentialKind} onChange={(event) => setCredentialKind(event.target.value as CredentialKind)}><option value="access_key">专用 IAM AccessKey</option><option value="role">部署环境身份 / AssumeRole</option></select></Field>}<CredentialFields kind={credentialKind} accessKeyId={accessKeyId} secretAccessKey={secretAccessKey} sessionToken={sessionToken} roleArn={roleArn} externalId={externalId} setters={{ setAccessKeyId, setSecretAccessKey, setSessionToken, setRoleArn, setExternalId }} />{formError && <div className="login-error span-2" role="alert">{formError}</div>}</form></Dialog>
    <Dialog open={rotateTarget !== null} title="轮换 AWS 凭证" onClose={closeRotate} footer={<><Button variant="secondary" onClick={closeRotate}>取消</Button><Button type="submit" form="cloud-rotate-form" disabled={saving}>{saving ? "正在验证" : "验证并轮换"}</Button></>}><form id="cloud-rotate-form" className="field-grid" onSubmit={rotate}>{me.role === "admin" && <Field label="凭证来源"><select value={credentialKind} onChange={(event) => setCredentialKind(event.target.value as CredentialKind)}><option value="access_key">专用 IAM AccessKey</option><option value="role">部署环境身份 / AssumeRole</option></select></Field>}<CredentialFields kind={credentialKind} accessKeyId={accessKeyId} secretAccessKey={secretAccessKey} sessionToken={sessionToken} roleArn={roleArn} externalId={externalId} setters={{ setAccessKeyId, setSecretAccessKey, setSessionToken, setRoleArn, setExternalId }} />{formError && <div className="login-error span-2" role="alert">{formError}</div>}</form></Dialog>
    <Dialog open={regionsTarget !== null} title="限制扫描区域" onClose={() => setRegionsTarget(null)} footer={<><Button variant="secondary" onClick={() => setRegionsTarget(null)}>取消</Button><Button type="submit" form="cloud-regions-form" disabled={saving}>保存范围</Button></>}><form id="cloud-regions-form" onSubmit={updateRegions}><Field label="区域范围" hint="留空恢复所有已启用区域"><textarea value={regions} onChange={(event) => setRegions(event.target.value)} placeholder="ap-southeast-2, us-west-2" /></Field>{formError && <div className="login-error" role="alert">{formError}</div>}</form></Dialog>
  </ConsoleLayout>;
}

function CredentialFields({ kind, accessKeyId, secretAccessKey, sessionToken, roleArn, externalId, setters }: { kind: CredentialKind; accessKeyId: string; secretAccessKey: string; sessionToken: string; roleArn: string; externalId: string; setters: Record<"setAccessKeyId" | "setSecretAccessKey" | "setSessionToken" | "setRoleArn" | "setExternalId", (value: string) => void> }) {
  return kind === "access_key" ? <><Field label="AccessKey ID"><input autoComplete="off" value={accessKeyId} onChange={(event) => setters.setAccessKeyId(event.target.value)} required /></Field><Field label="Secret AccessKey"><input type="password" autoComplete="off" value={secretAccessKey} onChange={(event) => setters.setSecretAccessKey(event.target.value)} required /></Field><Field label="Session Token（可选）"><textarea autoComplete="off" value={sessionToken} onChange={(event) => setters.setSessionToken(event.target.value)} /></Field></> : <><Field label="Role ARN（可选）"><input value={roleArn} onChange={(event) => setters.setRoleArn(event.target.value)} placeholder="arn:aws:iam::123456789012:role/MasterDNS" /></Field><Field label="External ID（可选）"><input type="password" autoComplete="off" value={externalId} onChange={(event) => setters.setExternalId(event.target.value)} /></Field></>;
}

const parseRegions = (value: string) => [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
const message = (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback;

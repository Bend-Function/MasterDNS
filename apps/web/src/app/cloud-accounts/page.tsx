"use client";

import { cloudProviderServices, type CloudProvider } from "@masterdns/contracts/cloud";
import { KeyRound, Pause, Play, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CloudCredentialFields } from "../../components/cloud-credential-fields";
import { ConsoleLayout } from "../../components/console-layout";
import { useSession } from "../../components/session-context";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoCloudAccounts, demoCloudScopes } from "../../lib/cloud-demo";
import type { CloudAccount, CloudScope } from "../../lib/cloud-types";
import { cloudErrorMessage, cloudProviderLabels, cloudScopeExamples, loadCloudScopes, submitCloudIntent } from "../../lib/cloud-ui";
import { demoUser } from "../../lib/demo";
import { createIntentKey } from "../../lib/intent-key";
import { credentialPayload, credentialUpdatePayload, emptyCredentialDraft, parseCloudRegions, resetCredentialDraft, validateAccountProvider, type CredentialDraft } from "../../lib/cloud-credentials";
import { createRequestGeneration } from "../../lib/session-state";
import type { User } from "../../lib/types";

export default function CloudAccountsPage() {
  const { user } = useSession();
  // A session/role change discards all drafts and invalidates pending mutations on unmount.
  return <CloudAccountsConsole key={`${user?.id ?? "anonymous"}:${user?.role ?? "none"}`} />;
}

function CloudAccountsConsole() {
  const { user: me } = useSession();
  const resource = useResource<CloudAccount[]>("/v1/cloud-accounts", demoCloudAccounts);
  const { data, setData, loading, error, reload } = resource;
  const [users, setUsers] = useState<User[]>(UI_PREVIEW ? [demoUser] : []);
  const [scopes, setScopes] = useState<Record<string, CloudScope[]>>({ "cloud-account-1": demoCloudScopes });
  const [scopeErrors, setScopeErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<CloudAccount | null>(null);
  const [regionsTarget, setRegionsTarget] = useState<CloudAccount | null>(null);
  const [name, setName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [regions, setRegions] = useState("");
  const [draft, setDraft] = useState(() => emptyCredentialDraft());
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const createIntent = useRef(createIntentKey());
  const mutations = useRef(createRequestGeneration());
  useEffect(() => { const pending = mutations.current; return () => { pending.invalidate(); }; }, []);

  useEffect(() => {
    let active = true;
    if (!UI_PREVIEW && me?.role === "admin") api<User[]>("/v1/users").then((value) => { if (active) setUsers(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [me]);

  useEffect(() => {
    if (UI_PREVIEW || !data) return;
    let active = true;
    loadCloudScopes(data, (accountId) => api<CloudScope[]>(`/v1/cloud-accounts/${accountId}/scopes`)).then((result) => {
      if (!active) return;
      setScopes(result.scopes); setScopeErrors(result.errors);
    });
    return () => { active = false; };
  }, [data]);

  const clearSecrets = () => setDraft((current) => resetCredentialDraft(current));
  const closeCreate = () => { mutations.current.invalidate(); setSaving(false); setOpen(false); setFormError(null); clearSecrets(); };
  const closeRotate = () => { mutations.current.invalidate(); setSaving(false); setRotateTarget(null); setFormError(null); clearSecrets(); };
  const openCreate = () => { if (!me) return; mutations.current.invalidate(); createIntent.current = createIntentKey(); setDraft(emptyCredentialDraft()); setName(""); setRegions(""); setOwnerUserId(me.id); setFormError(null); setOpen(true); };
  const changeProvider = (provider: CloudProvider) => { mutations.current.invalidate(); createIntent.current = createIntentKey(); setDraft((current) => resetCredentialDraft(current, provider)); setRegions(""); setFormError(null); };
  const changeKind = (awsKind: CredentialDraft["awsKind"]) => { setDraft((current) => ({ ...resetCredentialDraft(current), awsKind })); setFormError(null); };

  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!me || saving) return; setSaving(true); setFormError(null);
    const generation = mutations.current.current();
    const intent = createIntent.current;
    try {
      const selectedRegions = parseCloudRegions(draft.provider, regions);
      const body = { provider: draft.provider, name, ...(me.role === "admin" && ownerUserId ? { ownerUserId } : {}), ...(selectedRegions.length ? { regions: selectedRegions } : {}), credentials: credentialPayload(draft) };
      if (!UI_PREVIEW) await submitCloudIntent(intent, async (key) => {
        const account = await api<CloudAccount>("/v1/cloud-accounts", { method: "POST", headers: { "idempotency-key": key }, ...jsonBody(body) });
        validateAccountProvider(draft.provider, account);
        return account;
      });
      else setData([...(data ?? []), { id: `preview-${Date.now()}`, ownerUserId: ownerUserId || me.id, provider: draft.provider, name, credentialHint: "预览凭证", enabled: true, regions: selectedRegions.length ? selectedRegions : null, externalAccountId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
      if (!mutations.current.isCurrent(generation)) return;
      clearSecrets();
      if (!UI_PREVIEW) await reload();
      if (!mutations.current.isCurrent(generation)) return;
      setName(""); setRegions(""); closeCreate();
    } catch (value) { if (mutations.current.isCurrent(generation)) setFormError(message(value, "云账号验证失败")); }
    finally { if (mutations.current.isCurrent(generation)) setSaving(false); }
  };

  const rotate = async (event: FormEvent) => {
    event.preventDefault(); if (!rotateTarget || !me || saving) return; setSaving(true); setFormError(null);
    const generation = mutations.current.current();
    try {
      const body = credentialUpdatePayload(rotateTarget.provider, draft);
      if (!UI_PREVIEW) {
        const account = await api<CloudAccount>(`/v1/cloud-accounts/${rotateTarget.id}/credentials`, { method: "PATCH", ...jsonBody(body) });
        validateAccountProvider(rotateTarget.provider, account);
      }
      if (!mutations.current.isCurrent(generation)) return;
      clearSecrets();
      if (!UI_PREVIEW) await reload();
      if (mutations.current.isCurrent(generation)) closeRotate();
    } catch (value) { if (mutations.current.isCurrent(generation)) setFormError(message(value, "凭证轮换失败")); }
    finally { if (mutations.current.isCurrent(generation)) setSaving(false); }
  };

  const updateRegions = async (event: FormEvent) => {
    event.preventDefault(); if (!regionsTarget) return; setSaving(true); setFormError(null);
    try { const value = parseCloudRegions(regionsTarget.provider, regions); if (!UI_PREVIEW) { await api(`/v1/cloud-accounts/${regionsTarget.id}/regions`, { method: "PATCH", ...jsonBody({ regions: value.length ? value : null }) }); await reload(); } else setData((data ?? []).map((item) => item.id === regionsTarget.id ? { ...item, regions: value.length ? value : null } : item)); setRegionsTarget(null); }
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

  return <ConsoleLayout><PageHeader title="云计算账号" description="AWS、Azure 与 Linode 云资源清单和凭证，独立于 DNS Provider 账号" actions={<Button icon={<Plus size={15} />} onClick={openCreate}>接入云账号</Button>} />
    {formError && !open && !rotateTarget && !regionsTarget && <div className="inline-error" role="alert">{formError}</div>}
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : data?.length === 0 ? <div className="surface"><EmptyState title="尚未接入云计算账号" action={<Button onClick={openCreate}>接入云账号</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>账号</th><th>远端账号 ID</th><th>区域范围</th><th>清单状态</th><th>凭证</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{data?.map((account) => {
      const accountScopes = scopes[account.id] ?? []; const failed = accountScopes.filter((scope) => scope.lastError); const scopeError = scopeErrors[account.id];
      return <tr key={account.id}><td><div className="table-primary"><strong>{account.name}</strong><small>{cloudProviderLabels[account.provider]}</small><small>{me?.role === "admin" ? users.find((user) => user.id === account.ownerUserId)?.username ?? account.ownerUserId : "当前用户"}</small></div></td><td className="mono">{account.externalAccountId ?? "待验证"}</td><td>{account.regions?.join(", ") ?? "Provider 可见区域"}</td><td><div className="table-primary"><strong>{scopeError ? "范围状态加载失败" : failed.length ? `${failed.length} 个区域异常` : accountScopes.length ? "同步完整" : "等待首次同步"}</strong><small>{scopeError ?? failed[0]?.lastError ?? (accountScopes[0]?.lastCompletedAt ? `完成 ${accountScopes.length} 个范围` : "尚无扫描结果")}</small></div></td><td className="muted"><KeyRound size={12} /> {account.credentialHint ?? "已配置"}</td><td><StatusBadge value={account.enabled ? "active" : "disabled"} /></td><td><div className="row-actions"><IconButton label="编辑区域范围" onClick={() => { setRegions(account.regions?.join(", ") ?? ""); setRegionsTarget(account); setFormError(null); }}><SlidersHorizontal size={15} /></IconButton><IconButton label="轮换凭证" onClick={() => { mutations.current.invalidate(); setDraft(emptyCredentialDraft(account.provider)); setRotateTarget(account); setFormError(null); }}><KeyRound size={15} /></IconButton><IconButton label="同步云清单" disabled={busyId === account.id || !account.enabled} onClick={() => void mutate(account, "sync")}><RefreshCw size={15} /></IconButton><IconButton label={account.enabled ? "停用账号" : "启用账号"} disabled={busyId === account.id} onClick={() => void mutate(account, "status")}>{account.enabled ? <Pause size={15} /> : <Play size={15} />}</IconButton></div></td></tr>;
    })}</tbody></table></div>}
    <Dialog open={open} title="接入云账号" onClose={closeCreate} footer={<><Button variant="secondary" onClick={closeCreate}>取消</Button><Button type="submit" form="cloud-account-form" disabled={saving}>{saving ? "正在验证" : "验证并接入"}</Button></>}>
      <form id="cloud-account-form" className="field-grid" onSubmit={create}>
        <Field label="云 Provider"><select value={draft.provider} disabled={saving} onChange={(event) => changeProvider(event.target.value as CloudProvider)}>{(Object.keys(cloudProviderServices) as CloudProvider[]).map((provider) => <option key={provider} value={provider}>{cloudProviderLabels[provider]}</option>)}</select></Field>
        <Field label="显示名称"><input value={name} disabled={saving} onChange={(event) => setName(event.target.value)} required maxLength={120} /></Field>
        {me?.role === "admin" && <Field label="资源所有者"><select value={ownerUserId} disabled={saving} onChange={(event) => setOwnerUserId(event.target.value)}>{users.filter((user) => user.status === "active").map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></Field>}
        <Field label="区域范围（可选）" hint="逗号或换行分隔；留空扫描 Provider 可见区域"><textarea value={regions} disabled={saving} onChange={(event) => setRegions(event.target.value)} placeholder={cloudScopeExamples[draft.provider]} /></Field>
        <CloudCredentialFields draft={draft} setDraft={setDraft} admin={me?.role === "admin"} disabled={saving} changeKind={changeKind} />
        {formError && <div className="login-error span-2" role="alert">{formError}</div>}
      </form>
    </Dialog>
    <Dialog open={rotateTarget !== null} title={`轮换 ${cloudProviderLabels[rotateTarget?.provider ?? draft.provider]} 凭证`} onClose={closeRotate} footer={<><Button variant="secondary" onClick={closeRotate}>取消</Button><Button type="submit" form="cloud-rotate-form" disabled={saving}>{saving ? "正在验证" : "验证并轮换"}</Button></>}>
      <form id="cloud-rotate-form" className="field-grid" onSubmit={rotate}>
        <p className="muted span-2">更新 {rotateTarget?.name} 的凭证；Provider 与远端账号身份必须保持一致。</p>
        <CloudCredentialFields draft={draft} setDraft={setDraft} admin={me?.role === "admin"} disabled={saving} changeKind={changeKind} />
        {formError && <div className="login-error span-2" role="alert">{formError}</div>}
      </form>
    </Dialog>
    <Dialog open={regionsTarget !== null} title="限制扫描区域" onClose={() => setRegionsTarget(null)} footer={<><Button variant="secondary" onClick={() => setRegionsTarget(null)}>取消</Button><Button type="submit" form="cloud-regions-form" disabled={saving}>保存范围</Button></>}><form id="cloud-regions-form" onSubmit={updateRegions}><Field label="区域范围" hint="留空恢复 Provider 可见区域"><textarea value={regions} onChange={(event) => setRegions(event.target.value)} placeholder={cloudScopeExamples[regionsTarget?.provider ?? draft.provider]} /></Field>{formError && <div className="login-error" role="alert">{formError}</div>}</form></Dialog>
  </ConsoleLayout>;
}


const message = (value: unknown, fallback: string) => cloudErrorMessage(value, fallback);

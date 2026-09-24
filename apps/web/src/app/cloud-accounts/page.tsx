"use client";

import { cloudProviderServices, type CloudProvider, type CloudService } from "@masterdns/contracts/cloud";
import { cloudRotationLimitRules, type CloudRotationLimitStatus } from "@masterdns/contracts/cloud-rotation-limits";
import { Gauge, KeyRound, Pause, Play, Plus, RefreshCw, SlidersHorizontal, Network } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CloudCredentialFields } from "../../components/cloud-credential-fields";
import { LightsailIdleIps } from "../../components/lightsail-idle-ips";
import { CloudRotationLimits, parseRotationLimitPercent } from "../../components/cloud-rotation-limits";
import { ConsoleLayout } from "../../components/console-layout";
import { useSession } from "../../components/session-context";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoCloudAccounts, demoCloudScopes } from "../../lib/cloud-demo";
import type { CloudAccount, CloudScope } from "../../lib/cloud-types";
import { proxiesForOwner, type CloudProxyProfile } from "../../lib/cloud-proxy";
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
  const proxiesResource = useResource<CloudProxyProfile[]>("/v1/cloud-proxies", [{ id: "demo-proxy-1", ownerUserId: demoUser.id, name: "默认出口", endpoint: "socks5h://proxy.example.net:1080", assignedAccountIds: ["cloud-account-1"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
  const profiles = proxiesResource.data ?? [];
  const { data, setData, loading, error, reload } = resource;
  const [users, setUsers] = useState<User[]>(UI_PREVIEW ? [demoUser] : []);
  const [scopes, setScopes] = useState<Record<string, CloudScope[]>>({ "cloud-account-1": demoCloudScopes });
  const [scopeErrors, setScopeErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<CloudAccount | null>(null);
  const [regionsTarget, setRegionsTarget] = useState<CloudAccount | null>(null);
  const [proxyTarget, setProxyTarget] = useState<CloudAccount | null>(null);
  const [selectedProxyId, setSelectedProxyId] = useState("");
  const [idleIpTarget, setIdleIpTarget] = useState<CloudAccount | null>(null);
  const [limitTarget, setLimitTarget] = useState<CloudAccount | null>(null);
  const [limitService, setLimitService] = useState<CloudService>("ec2");
  const [limitStatus, setLimitStatus] = useState<CloudRotationLimitStatus | null>(null);
  const [limitPercent, setLimitPercent] = useState("80");
  const [limitEnabled, setLimitEnabled] = useState(true);
  const [limitLoading, setLimitLoading] = useState(false);
  const [name, setName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [regions, setRegions] = useState("");
  const [draft, setDraft] = useState(() => emptyCredentialDraft());
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const createIntent = useRef(createIntentKey());
  const mutations = useRef(createRequestGeneration());
  const limitRequests = useRef(createRequestGeneration());
  useEffect(() => { const pending = mutations.current; return () => { pending.invalidate(); }; }, []);

  useEffect(() => {
    if (UI_PREVIEW || !proxiesResource.data) return;
    let active = true;
    Promise.resolve().then(() => { if (active) void reload(); });
    return () => { active = false; };
  }, [proxiesResource.data, reload]);

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
  const closeRotationLimits = () => { limitRequests.current.invalidate(); setSaving(false); setLimitLoading(false); setLimitTarget(null); setLimitStatus(null); setFormError(null); };
  const openCreate = () => { if (!me) return; mutations.current.invalidate(); createIntent.current = createIntentKey(); setDraft(emptyCredentialDraft()); setName(""); setRegions(""); setOwnerUserId(me.id); setSelectedProxyId(""); setFormError(null); setOpen(true); };
  const changeProvider = (provider: CloudProvider) => { mutations.current.invalidate(); createIntent.current = createIntentKey(); setDraft((current) => resetCredentialDraft(current, provider)); setRegions(""); setFormError(null); };
  const changeKind = (awsKind: CredentialDraft["awsKind"]) => { setDraft((current) => ({ ...resetCredentialDraft(current), awsKind })); setFormError(null); };

  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!me || saving) return; setSaving(true); setFormError(null);
    const generation = mutations.current.current();
    const intent = createIntent.current;
    try {
      const selectedRegions = parseCloudRegions(draft.provider, regions);
      const body = { provider: draft.provider, name, ...(me.role === "admin" && ownerUserId ? { ownerUserId } : {}), ...(selectedRegions.length ? { regions: selectedRegions } : {}), proxyProfileId: selectedProxyId || null, credentials: credentialPayload(draft) };
      if (!UI_PREVIEW) await submitCloudIntent(intent, async (key) => {
        const account = await api<CloudAccount>("/v1/cloud-accounts", { method: "POST", headers: { "idempotency-key": key }, ...jsonBody(body) });
        validateAccountProvider(draft.provider, account);
        return account;
      });
      else setData([...(data ?? []), { id: `preview-${Date.now()}`, ownerUserId: ownerUserId || me.id, provider: draft.provider, name, proxyProfileId: selectedProxyId || null, credentialHint: "预览凭证", enabled: true, regions: selectedRegions.length ? selectedRegions : null, externalAccountId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
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

  const selectProxy = async (event: FormEvent) => {
    event.preventDefault(); if (!proxyTarget || saving) return;
    const target = proxyTarget;
    const token = mutations.current.current(); setSaving(true); setFormError(null);
    try {
      if (UI_PREVIEW) setData(current => (current ?? []).map(account => account.id === target.id ? { ...account, proxyProfileId: selectedProxyId || null } : account));
      else await api(`/v1/cloud-accounts/${target.id}/proxy-selection`, { method: "PATCH", ...jsonBody({ proxyId: selectedProxyId || null }) });
      if (!mutations.current.isCurrent(token)) return;
      if (!UI_PREVIEW) { await reload(); await proxiesResource.reload(); }
      if (mutations.current.isCurrent(token)) setProxyTarget(null);
    } catch (cause) { if (mutations.current.isCurrent(token)) setFormError(message(cause, "云账号代理选择失败")); }
    finally { if (mutations.current.isCurrent(token)) setSaving(false); }
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

  const loadRotationLimits = async (account: CloudAccount, service: CloudService) => {
    const request = limitRequests.current.invalidate(); setLimitLoading(true); setLimitStatus(null); setFormError(null);
    try {
      const value: CloudRotationLimitStatus = UI_PREVIEW
        ? { service, utilizationPercent: 80, effectivePercent: 80, rules: cloudRotationLimitRules(service), usage: [] }
        : await api<CloudRotationLimitStatus>(`/v1/cloud-accounts/${account.id}/rotation-limits/${service}`);
      if (!limitRequests.current.isCurrent(request)) return;
      setLimitStatus(value); setLimitPercent(String(value.utilizationPercent)); setLimitEnabled(value.enabled ?? true);
    } catch (value) { if (limitRequests.current.isCurrent(request)) setFormError(message(value, "换址限制加载失败")); }
    finally { if (limitRequests.current.isCurrent(request)) setLimitLoading(false); }
  };

  const openRotationLimits = (account: CloudAccount) => {
    const service = cloudProviderServices[account.provider][0]!;
    setLimitTarget(account); setLimitService(service); setLimitPercent("80"); setFormError(null);
    void loadRotationLimits(account, service);
  };

  const changeRotationLimitService = (service: CloudService) => {
    if (!limitTarget || service === limitService) return;
    setLimitService(service); setLimitPercent("80");
    void loadRotationLimits(limitTarget, service);
  };

  const updateRotationLimits = async (event: FormEvent) => {
    event.preventDefault();
    if (!limitTarget || saving) return;
    const utilizationPercent = parseRotationLimitPercent(limitPercent);
    if (utilizationPercent === null) { setFormError("使用比例必须是 1–100 的整数"); return; }
    const request = limitRequests.current.current(); setSaving(true); setFormError(null);
    try {
      const value: CloudRotationLimitStatus = UI_PREVIEW
        ? { enabled: limitEnabled, service: limitService, utilizationPercent, effectivePercent: utilizationPercent, rules: cloudRotationLimitRules(limitService, utilizationPercent), usage: limitStatus?.usage ?? [] }
        : await api<CloudRotationLimitStatus>(`/v1/cloud-accounts/${limitTarget.id}/rotation-limits/${limitService}`, { method: "PATCH", ...jsonBody({ utilizationPercent, enabled: limitEnabled }) });
      if (!limitRequests.current.isCurrent(request)) return;
      setLimitStatus(value); setLimitPercent(String(value.utilizationPercent)); setLimitEnabled(value.enabled ?? true);
    } catch (value) { if (limitRequests.current.isCurrent(request)) setFormError(message(value, "换址限制保存失败")); }
    finally { if (limitRequests.current.isCurrent(request)) setSaving(false); }
  };

  return <ConsoleLayout><PageHeader title="云计算账号" description="AWS、Azure 与 Linode 云资源清单和凭证，独立于 DNS Provider 账号" actions={<Button icon={<Plus size={15} />} onClick={openCreate}>接入云账号</Button>} />
    {formError && !open && !rotateTarget && !regionsTarget && !limitTarget && !proxyTarget && <div className="inline-error" role="alert">{formError}</div>}
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : data?.length === 0 ? <div className="surface"><EmptyState title="尚未接入云计算账号" action={<Button onClick={openCreate}>接入云账号</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>账号</th><th>远端账号 ID</th><th>区域范围</th><th>清单状态</th><th>代理</th><th>凭证</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{data?.map((account) => {
      const accountScopes = scopes[account.id] ?? []; const failed = accountScopes.filter((scope) => scope.lastError); const scopeError = scopeErrors[account.id];
      return <tr key={account.id}><td><div className="table-primary"><strong>{account.name}</strong><small>{cloudProviderLabels[account.provider]}</small><small>{me?.role === "admin" ? users.find((user) => user.id === account.ownerUserId)?.username ?? account.ownerUserId : "当前用户"}</small></div></td><td className="mono">{account.externalAccountId ?? "待验证"}</td><td>{account.regions?.join(", ") ?? "Provider 可见区域"}</td><td><div className="table-primary"><strong>{scopeError ? "范围状态加载失败" : failed.length ? `${failed.length} 个区域异常` : accountScopes.length ? "同步完整" : "等待首次同步"}</strong><small>{scopeError ?? failed[0]?.lastError ?? (accountScopes[0]?.lastCompletedAt ? `完成 ${accountScopes.length} 个范围` : "尚无扫描结果")}</small></div></td><td>{profiles.find(profile => profile.id === account.proxyProfileId)?.name ?? (account.proxyProfileId ? "已配置" : "直连")}</td><td className="muted"><KeyRound size={12} /> {account.credentialHint ?? "已配置"}</td><td><StatusBadge value={account.enabled ? "active" : "disabled"} /></td><td><div className="row-actions">{account.provider === "aws" && <Button variant="ghost" disabled={!account.externalAccountId || UI_PREVIEW} onClick={() => setIdleIpTarget(account)}>清理 Lightsail 闲置 IP</Button>}<IconButton label="换址限制" disabled={!account.externalAccountId} onClick={() => openRotationLimits(account)}><Gauge size={15} /></IconButton><IconButton label={`选择 ${account.name} 代理`} onClick={() => { mutations.current.invalidate(); setProxyTarget(account); setSelectedProxyId(account.proxyProfileId ?? ""); setFormError(null); }}><Network size={15} /></IconButton><IconButton label="编辑区域范围" onClick={() => { setRegions(account.regions?.join(", ") ?? ""); setRegionsTarget(account); setFormError(null); }}><SlidersHorizontal size={15} /></IconButton><IconButton label="轮换凭证" onClick={() => { mutations.current.invalidate(); setDraft(emptyCredentialDraft(account.provider)); setRotateTarget(account); setFormError(null); }}><KeyRound size={15} /></IconButton><IconButton label="同步云清单" disabled={busyId === account.id || !account.enabled} onClick={() => void mutate(account, "sync")}><RefreshCw size={15} /></IconButton><IconButton label={account.enabled ? "停用账号" : "启用账号"} disabled={busyId === account.id} onClick={() => void mutate(account, "status")}>{account.enabled ? <Pause size={15} /> : <Play size={15} />}</IconButton></div></td></tr>;
    })}</tbody></table></div>}
    <Dialog open={open} title="接入云账号" onClose={closeCreate} footer={<><Button variant="secondary" onClick={closeCreate}>取消</Button><Button type="submit" form="cloud-account-form" disabled={saving}>{saving ? "正在验证" : "验证并接入"}</Button></>}>
      <form id="cloud-account-form" className="field-grid" onSubmit={create}>
        <Field label="云 Provider"><select value={draft.provider} disabled={saving} onChange={(event) => changeProvider(event.target.value as CloudProvider)}>{(Object.keys(cloudProviderServices) as CloudProvider[]).map((provider) => <option key={provider} value={provider}>{cloudProviderLabels[provider]}</option>)}</select></Field>
        <Field label="显示名称"><input value={name} disabled={saving} onChange={(event) => setName(event.target.value)} required maxLength={120} /></Field>
        {me?.role === "admin" && <Field label="资源所有者"><select value={ownerUserId} disabled={saving} onChange={(event) => { setOwnerUserId(event.target.value); setSelectedProxyId(""); }}>{users.filter((user) => user.status === "active").map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></Field>}
        <Field label="SOCKS 代理" hint="可在独立代理页面创建多个配置，同一所有者可复用"><select value={selectedProxyId} disabled={saving || proxiesResource.loading || !!proxiesResource.error} onChange={event => setSelectedProxyId(event.target.value)}><option value="">直连</option>{proxiesForOwner(profiles, ownerUserId || me?.id || "").map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.endpoint}</option>)}</select></Field>
        {proxiesResource.error && <p className="login-error span-2" role="alert">代理列表加载失败，请刷新后再选择</p>}
        <p className="fieldset-note span-2">新增代理请前往 <Link href="/cloud-proxies">SOCKS 代理</Link> 页面。</p>
        <Field label="区域范围（可选）" hint="逗号或换行分隔；留空扫描 Provider 可见区域"><textarea value={regions} disabled={saving} onChange={(event) => setRegions(event.target.value)} placeholder={cloudScopeExamples[draft.provider]} /></Field>
        <CloudCredentialFields draft={draft} setDraft={setDraft} admin={me?.role === "admin"} disabled={saving} changeKind={changeKind} />
        {formError && <div className="login-error span-2" role="alert">{formError}</div>}
      </form>
    </Dialog>
    <Dialog open={proxyTarget !== null} title={`选择代理 · ${proxyTarget?.name ?? "云账号"}`} onClose={() => { if (!saving) { mutations.current.invalidate(); setProxyTarget(null); setFormError(null); } }} footer={<><Button variant="secondary" disabled={saving} onClick={() => setProxyTarget(null)}>取消</Button><Button type="submit" form="cloud-proxy-selection-form" disabled={saving || proxiesResource.loading || !!proxiesResource.error}>{saving ? "正在验证" : "验证并保存"}</Button></>}>
      <form id="cloud-proxy-selection-form" onSubmit={selectProxy}><Field label="云 API 出站代理" hint="保存时验证该路径仍连接同一远端云账号"><select value={selectedProxyId} disabled={saving || proxiesResource.loading || !!proxiesResource.error} onChange={event => setSelectedProxyId(event.target.value)}><option value="">直连</option>{proxiesForOwner(profiles, proxyTarget?.ownerUserId ?? "").map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.endpoint}</option>)}</select></Field><p className="fieldset-note">在 <Link href="/cloud-proxies">SOCKS 代理</Link> 页面添加或编辑代理。一个代理可供多个同所有者账号使用。</p>{proxiesResource.error && <p role="alert" className="login-error">代理列表加载失败，请刷新页面</p>}{formError && <p role="alert" className="login-error">{formError}</p>}</form>
    </Dialog>
    <Dialog open={rotateTarget !== null} title={`轮换 ${cloudProviderLabels[rotateTarget?.provider ?? draft.provider]} 凭证`} onClose={closeRotate} footer={<><Button variant="secondary" onClick={closeRotate}>取消</Button><Button type="submit" form="cloud-rotate-form" disabled={saving}>{saving ? "正在验证" : "验证并轮换"}</Button></>}>
      <form id="cloud-rotate-form" className="field-grid" onSubmit={rotate}>
        <p className="muted span-2">更新 {rotateTarget?.name} 的凭证；Provider 与远端账号身份必须保持一致。</p>
        <CloudCredentialFields draft={draft} setDraft={setDraft} admin={me?.role === "admin"} disabled={saving} changeKind={changeKind} />
        {formError && <div className="login-error span-2" role="alert">{formError}</div>}
      </form>
    </Dialog>
    <Dialog open={regionsTarget !== null} title="限制扫描区域" onClose={() => setRegionsTarget(null)} footer={<><Button variant="secondary" onClick={() => setRegionsTarget(null)}>取消</Button><Button type="submit" form="cloud-regions-form" disabled={saving}>保存范围</Button></>}><form id="cloud-regions-form" onSubmit={updateRegions}><Field label="区域范围" hint="留空恢复 Provider 可见区域"><textarea value={regions} onChange={(event) => setRegions(event.target.value)} placeholder={cloudScopeExamples[regionsTarget?.provider ?? draft.provider]} /></Field>{formError && <div className="login-error" role="alert">{formError}</div>}</form></Dialog>
    {idleIpTarget && <LightsailIdleIps key={idleIpTarget.id} account={idleIpTarget} onClose={() => setIdleIpTarget(null)} />}
    <Dialog open={limitTarget !== null} title={`换址限制 · ${limitTarget?.name ?? "云账号"}`} size="large" onClose={closeRotationLimits} footer={<><Button variant="secondary" disabled={saving} onClick={closeRotationLimits}>关闭</Button><Button type="submit" form="cloud-rotation-limits-form" disabled={saving || limitLoading || parseRotationLimitPercent(limitPercent) === null}>{saving ? "保存中" : "保存限制"}</Button></>}>
      <form id="cloud-rotation-limits-form" onSubmit={updateRotationLimits}>
        <CloudRotationLimits services={limitTarget ? cloudProviderServices[limitTarget.provider] : [limitService]} service={limitService} status={limitStatus} enabled={limitEnabled} onEnabledChange={setLimitEnabled} utilizationPercent={limitPercent} disabled={saving || limitLoading} onServiceChange={changeRotationLimitService} onUtilizationPercentChange={(value) => { setLimitPercent(value); setFormError(null); }} />
        {limitLoading && <LoadingState />}
        {formError && <div className="login-error" role="alert">{formError}</div>}
      </form>
    </Dialog>
  </ConsoleLayout>;
}


const message = (value: unknown, fallback: string) => cloudErrorMessage(value, fallback);

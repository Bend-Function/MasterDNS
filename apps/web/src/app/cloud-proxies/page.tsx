"use client";

import { Activity, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { useSession } from "../../components/session-context";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { api, jsonBody, UI_PREVIEW } from "../../lib/api";
import { parseProxyUrl, proxyErrorMessage, type CloudProxyCheckResult, type CloudProxyProfile } from "../../lib/cloud-proxy";
import { demoCloudAccounts } from "../../lib/cloud-demo";
import type { CloudAccount } from "../../lib/cloud-types";
import { createRequestGeneration } from "../../lib/session-state";
import type { User } from "../../lib/types";

const demoProfiles: CloudProxyProfile[] = [{ id: "demo-proxy-1", ownerUserId: demoCloudAccounts[0]!.ownerUserId, name: "默认出口", endpoint: "socks5h://proxy.example.net:1080", assignedAccountIds: [demoCloudAccounts[0]!.id], createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z" }];
const demoCheck: CloudProxyCheckResult = { ok: true, ip: "203.0.113.42", checkedAt: "2026-09-24T00:00:00Z", latencyMs: 186, error: null };

export default function CloudProxiesPage() {
  const { user } = useSession();
  return <CloudProxiesConsole key={`${user?.id ?? "anonymous"}:${user?.role ?? "none"}`} />;
}

function CloudProxiesConsole() {
  const { user } = useSession();
  const [profiles, setProfiles] = useState<CloudProxyProfile[] | null>(UI_PREVIEW ? demoProfiles : null);
  const [accounts, setAccounts] = useState<CloudAccount[]>(UI_PREVIEW ? demoCloudAccounts : []);
  const [users, setUsers] = useState<User[]>([]);
  const [checks, setChecks] = useState<Record<string, CloudProxyCheckResult>>({});
  const [draftCheck, setDraftCheck] = useState<CloudProxyCheckResult | null>(null);
  const [editor, setEditor] = useState<CloudProxyProfile | "new" | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CloudProxyProfile | null>(null);
  const [name, setName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const requests = useRef(createRequestGeneration());

  const load = useCallback(async () => {
    if (UI_PREVIEW) return;
    const token = requests.current.invalidate(); setLoading(true); setError(null);
    try {
      const [nextProfiles, nextAccounts, nextUsers] = await Promise.all([api<CloudProxyProfile[]>("/v1/cloud-proxies"), api<CloudAccount[]>("/v1/cloud-accounts"), user?.role === "admin" ? api<User[]>("/v1/users") : Promise.resolve([])]);
      if (requests.current.isCurrent(token)) { setProfiles(nextProfiles); setAccounts(nextAccounts); setUsers(nextUsers); }
    } catch (cause) { if (requests.current.isCurrent(token)) setError(cause instanceof Error ? cause.message : "代理加载失败"); }
    finally { if (requests.current.isCurrent(token)) setLoading(false); }
  }, [user]);
  useEffect(() => { const state = requests.current; let active = true; if (!UI_PREVIEW) Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; state.invalidate(); }; }, [load]);

  const closeEditor = () => { if (busy) return; requests.current.invalidate(); setEditor(null); setName(""); setProxyUrl(""); setDraftCheck(null); setFormError(null); };
  const openEditor = (profile: CloudProxyProfile | "new") => {
    requests.current.invalidate(); setEditor(profile); setName(profile === "new" ? "" : profile.name);
    setOwnerUserId(profile === "new" ? user?.id ?? "" : profile.ownerUserId);
    setProxyUrl(""); setDraftCheck(null); setFormError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!editor || busy) return;
    let candidate: string | undefined;
    try { if (proxyUrl.trim()) candidate = parseProxyUrl(proxyUrl).proxyUrl; if (editor === "new" && !candidate) throw new Error("请输入代理 URL"); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : "代理地址无效"); return; }
    setBusy(true); setFormError(null);
    const token = requests.current.current();
    try {
      if (UI_PREVIEW) {
        const profile: CloudProxyProfile = { id: editor === "new" ? `preview-${Date.now()}` : editor.id, ownerUserId, name: name.trim(), endpoint: candidate ? parseProxyUrl(candidate).sanitizedEndpoint : (editor === "new" ? "" : editor.endpoint), assignedAccountIds: editor === "new" ? [] : editor.assignedAccountIds, createdAt: editor === "new" ? new Date().toISOString() : editor.createdAt, updatedAt: new Date().toISOString() };
        setProfiles(current => editor === "new" ? [...(current ?? []), profile] : (current ?? []).map(item => item.id === editor.id ? profile : item));
      } else if (editor === "new") {
        await api("/v1/cloud-proxies", { method: "POST", ...jsonBody({ name: name.trim(), proxyUrl: candidate, ...(user?.role === "admin" ? { ownerUserId } : {}) }) });
      } else {
        await api(`/v1/cloud-proxies/${editor.id}`, { method: "PATCH", ...jsonBody({ name: name.trim(), ...(candidate ? { proxyUrl: candidate } : {}) }) });
      }
      if (!requests.current.isCurrent(token)) return;
      setBusy(false); closeEditor(); if (!UI_PREVIEW) await load();
    } catch (cause) { if (requests.current.isCurrent(token)) setFormError(proxyErrorMessage(cause, proxyUrl, "代理保存失败")); }
    finally { if (requests.current.isCurrent(token)) setBusy(false); }
  };

  const check = async (profile?: CloudProxyProfile) => {
    if (busy) return;
    let candidate: string | undefined;
    try { if (!profile) candidate = parseProxyUrl(proxyUrl).proxyUrl; }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : "代理地址无效"); return; }
    setBusy(true); setFormError(null);
    const token = requests.current.current();
    try {
      const result = UI_PREVIEW ? demoCheck : await api<CloudProxyCheckResult>(profile ? `/v1/cloud-proxies/${profile.id}/check` : "/v1/cloud-proxies/check", { method: "POST", ...jsonBody(profile ? {} : { proxyUrl: candidate }) });
      if (!requests.current.isCurrent(token)) return;
      if (profile) setChecks(current => ({ ...current, [profile.id]: result })); else setDraftCheck(result);
      if (!result.ok) setFormError("代理连通性检测失败");
    } catch (cause) { if (requests.current.isCurrent(token)) setFormError(proxyErrorMessage(cause, proxyUrl, "代理检测失败")); }
    finally { if (requests.current.isCurrent(token)) setBusy(false); }
  };

  const remove = async () => {
    if (!removeTarget || busy) return;
    setBusy(true); setFormError(null);
    const token = requests.current.current();
    try {
      if (UI_PREVIEW) setProfiles(current => (current ?? []).filter(profile => profile.id !== removeTarget.id));
      else await api(`/v1/cloud-proxies/${removeTarget.id}`, { method: "DELETE" });
      if (!requests.current.isCurrent(token)) return;
      setBusy(false); setRemoveTarget(null); if (!UI_PREVIEW) await load();
    } catch (cause) { if (requests.current.isCurrent(token)) setFormError(cause instanceof Error ? cause.message : "代理删除失败"); }
    finally { if (requests.current.isCurrent(token)) setBusy(false); }
  };

  const owners = [...new Set(users.filter(item => item.status === "active").map(item => item.id).concat(accounts.map(account => account.ownerUserId), user?.id ?? []))];
  const ownerLabel = (id: string) => users.find(item => item.id === id)?.username ?? id;
  return <ConsoleLayout>
    <PageHeader title="SOCKS 代理" description="创建多个代理出口，再在云计算账号中选择使用" actions={<><Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()} disabled={loading || busy}>刷新</Button><Button icon={<Plus size={14} />} onClick={() => openEditor("new")}>添加代理</Button></>} />
    <div className="inline-warning proxy-context">代理运行在 MasterDNS 服务端；localhost 指服务器或容器。推荐 socks5h 让代理端解析 DNS。出口 IP 仅在点击检测后读取，不查询位置。</div>
    {formError && !editor && !removeTarget && <div className="inline-error" role="alert">{formError}</div>}
    {error ? <div className="surface"><ErrorState message={error} onRetry={() => void load()} /></div> : loading && !profiles ? <div className="surface"><LoadingState /></div> : !profiles?.length ? <div className="surface"><EmptyState title="尚未配置 SOCKS 代理" action={<Button onClick={() => openEditor("new")}>添加代理</Button>} /></div> : <section className="surface"><header className="surface-header"><div><h2>代理列表</h2><p>可被同一所有者的多个云账号复用，密码不会回显</p></div></header><div className="table-wrap"><table className="proxy-table"><thead><tr><th>名称</th><th>端点</th><th>关联云账号</th><th>最近检测</th><th aria-label="操作" /></tr></thead><tbody>{profiles.map(profile => <tr key={profile.id}><td><div className="table-primary"><strong>{profile.name}</strong><small>{user?.role === "admin" ? `所有者 ${ownerLabel(profile.ownerUserId)}` : "当前用户"}</small></div></td><td className="mono">{profile.endpoint}</td><td>{profile.assignedAccountIds.length ? profile.assignedAccountIds.map(id => accounts.find(account => account.id === id)?.name ?? id).join("、") : "未使用"}</td><td>{checks[profile.id] ? <ProxyCheckSummary result={checks[profile.id]!} /> : <span className="muted">尚未主动检测</span>}</td><td><div className="row-actions"><Button variant="ghost" icon={<Activity size={14} />} disabled={busy} onClick={() => void check(profile)}>检测</Button><IconButton label={`编辑 ${profile.name}`} disabled={busy} onClick={() => openEditor(profile)}><Pencil size={15} /></IconButton><IconButton label={`删除 ${profile.name}`} disabled={busy || profile.assignedAccountIds.length > 0} onClick={() => { setRemoveTarget(profile); setFormError(null); }}><Trash2 size={15} /></IconButton></div></td></tr>)}</tbody></table></div><p className="fieldset-note">关联中的代理需先到 <Link href="/cloud-accounts">云计算账号</Link> 更换选择，才能删除。</p></section>}
    <Dialog open={editor !== null} title={editor === "new" ? "添加 SOCKS 代理" : `编辑 ${editor?.name ?? "代理"}`} onClose={closeEditor} footer={<><Button variant="secondary" disabled={busy} onClick={closeEditor}>取消</Button><Button variant="secondary" disabled={busy || !proxyUrl.trim()} onClick={() => void check()}>{busy ? "检测中" : "检测未保存代理"}</Button><Button type="submit" form="proxy-profile-form" disabled={busy}>{busy ? "保存中" : "保存代理"}</Button></>}>
      <form id="proxy-profile-form" className="field-grid" onSubmit={save}><Field label="代理名称"><input value={name} disabled={busy} maxLength={120} required onChange={event => setName(event.target.value)} /></Field>{user?.role === "admin" && editor === "new" && <Field label="所有者"><select value={ownerUserId} disabled={busy} onChange={event => setOwnerUserId(event.target.value)}>{owners.map(id => <option key={id} value={id}>{ownerLabel(id)}</option>)}</select></Field>}<Field label={editor === "new" ? "SOCKS URL" : "新 SOCKS URL（留空保持原配置）"} hint="支持 socks5:// 或 socks5h://；密码不会回显"><input type="password" autoComplete="new-password" value={proxyUrl} onChange={event => { setProxyUrl(event.target.value); setDraftCheck(null); }} placeholder="socks5h://user:password@proxy.example.com:1080" required={editor === "new"} /></Field>{draftCheck && <div className="span-2"><ProxyCheckSummary result={draftCheck} /></div>}{formError && <div className="login-error span-2" role="alert">{formError}</div>}</form>
    </Dialog>
    <Dialog open={removeTarget !== null} title="删除代理" onClose={() => { if (!busy) setRemoveTarget(null); }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setRemoveTarget(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void remove()}>删除代理</Button></>}><p>删除 {removeTarget?.name}？未被云账号使用的配置可删除。</p>{formError && <p role="alert" className="login-error">{formError}</p>}</Dialog>
  </ConsoleLayout>;
}

function ProxyCheckSummary({ result }: { result: CloudProxyCheckResult }) {
  return <div className="proxy-check-result"><StatusBadge value={result.ok ? "success" : "failed"} /><strong className="mono">{result.ip ?? "未返回出口 IP"}</strong><small>{result.latencyMs} ms · <RelativeTime value={result.checkedAt} />{result.error ? " · 检测失败" : ""}</small></div>;
}

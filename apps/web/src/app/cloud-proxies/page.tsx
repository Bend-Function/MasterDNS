"use client";

import { Activity, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { useSession } from "../../components/session-context";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { api, jsonBody, UI_PREVIEW } from "../../lib/api";
import type { CloudProxyCheckResult, CloudProxyStatus } from "../../lib/cloud-proxy";
import { parseProxyUrl, proxyErrorMessage } from "../../lib/cloud-proxy";
import { demoCloudAccounts } from "../../lib/cloud-demo";
import type { CloudAccount } from "../../lib/cloud-types";
import { cloudProviderLabels } from "../../lib/cloud-ui";
import { createRequestGeneration } from "../../lib/session-state";

const previewStatuses: Record<string, CloudProxyStatus> = { "cloud-account-1": { configured: true, endpoint: "socks5h://proxy.example.net:1080" } };
const previewCheck: CloudProxyCheckResult = { ok: true, ip: "203.0.113.42", checkedAt: "2026-09-24T00:00:00.000Z", latencyMs: 186, error: null };
type BusyRequest = { accountId: string; kind: "save" | "remove" | "check" };

export default function CloudProxiesPage() {
  const { user } = useSession();
  return <CloudProxiesConsole key={`${user?.id ?? "anonymous"}:${user?.role ?? "none"}`} />;
}

function CloudProxiesConsole() {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(UI_PREVIEW ? demoCloudAccounts : null);
  const [statuses, setStatuses] = useState<Record<string, CloudProxyStatus>>(UI_PREVIEW ? previewStatuses : {});
  const [checks, setChecks] = useState<Record<string, CloudProxyCheckResult>>({});
  const [draftCheck, setDraftCheck] = useState<CloudProxyCheckResult | null>(null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [editorTarget, setEditorTarget] = useState<CloudAccount | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CloudAccount | null>(null);
  const [proxyUrl, setProxyUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyRequest | null>(null);
  const busyRef = useRef<BusyRequest | null>(null);
  const loads = useRef(createRequestGeneration());
  const mutations = useRef(createRequestGeneration());

  const load = useCallback(async () => {
    if (UI_PREVIEW) { setAccounts(demoCloudAccounts); setStatuses(previewStatuses); setLoading(false); return; }
    const request = loads.current.invalidate();
    setLoading(true); setError(null);
    try {
      const nextAccounts = await api<CloudAccount[]>("/v1/cloud-accounts");
      const results = await Promise.allSettled(nextAccounts.map(async (account) => [account.id, await api<CloudProxyStatus>(`/v1/cloud-accounts/${account.id}/proxy`)] as const));
      if (!loads.current.isCurrent(request)) return;
      const nextStatuses: Record<string, CloudProxyStatus> = {};
      const nextErrors: Record<string, string> = {};
      results.forEach((result, index) => {
        const account = nextAccounts[index];
        if (!account) return;
        if (result.status === "fulfilled") nextStatuses[result.value[0]] = result.value[1];
        else nextErrors[account.id] = result.reason instanceof Error ? result.reason.message : "代理配置读取失败";
      });
      setAccounts(nextAccounts); setStatuses(nextStatuses); setStatusErrors(nextErrors);
    } catch (value) {
      if (loads.current.isCurrent(request)) setError(value instanceof Error ? value.message : "云账号加载失败");
    } finally {
      if (loads.current.isCurrent(request)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadState = loads.current; const mutationState = mutations.current;
    let active = true;
    if (!UI_PREVIEW) Promise.resolve().then(() => { if (active) void load(); });
    return () => { active = false; loadState.invalidate(); mutationState.invalidate(); busyRef.current = null; };
  }, [load]);

  const claim = (accountId: string, kind: BusyRequest["kind"]): boolean => {
    if (busyRef.current) return false;
    const request = { accountId, kind };
    busyRef.current = request; setBusy(request);
    return true;
  };
  const release = () => { busyRef.current = null; setBusy(null); };
  const closeEditor = () => {
    if (busyRef.current) return;
    mutations.current.invalidate(); setEditorTarget(null); setProxyUrl(""); setDraftCheck(null); setFormError(null);
  };
  const openEditor = (account: CloudAccount) => {
    mutations.current.invalidate(); setEditorTarget(account); setRemoveTarget(null); setProxyUrl(""); setDraftCheck(null); setFormError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editorTarget || !claim(editorTarget.id, "save")) return;
    const accountId = editorTarget.id;
    let parsed;
    try { parsed = parseProxyUrl(proxyUrl); }
    catch (value) { setFormError(value instanceof Error ? value.message : "代理地址无效"); release(); return; }
    const request = mutations.current.invalidate(); setFormError(null);
    try {
      const result = UI_PREVIEW ? { configured: true, endpoint: parsed.sanitizedEndpoint } : await api<CloudProxyStatus>(`/v1/cloud-accounts/${accountId}/proxy`, { method: "PATCH", ...jsonBody({ proxyUrl: parsed.proxyUrl }) });
      if (!mutations.current.isCurrent(request)) return;
      setStatuses((current) => ({ ...current, [accountId]: result }));
      release(); closeEditor();
    } catch (value) {
      if (mutations.current.isCurrent(request)) setFormError(proxyErrorMessage(value, proxyUrl, "代理配置保存失败"));
      release();
    }
  };

  const remove = async () => {
    if (!removeTarget || !claim(removeTarget.id, "remove")) return;
    const accountId = removeTarget.id;
    const request = mutations.current.invalidate(); setFormError(null);
    try {
      const result = UI_PREVIEW ? { configured: false, endpoint: null } : await api<CloudProxyStatus>(`/v1/cloud-accounts/${accountId}/proxy`, { method: "PATCH", ...jsonBody({ proxyUrl: null }) });
      if (!mutations.current.isCurrent(request)) return;
      setStatuses((current) => ({ ...current, [accountId]: result }));
      setChecks((current) => { const next = { ...current }; delete next[accountId]; return next; });
      setRemoveTarget(null);
    } catch (value) {
      if (mutations.current.isCurrent(request)) setFormError(value instanceof Error ? value.message : "代理移除失败");
    } finally { release(); }
  };

  const check = async (account: CloudAccount, draft?: string) => {
    if (!claim(account.id, "check")) return;
    let body: { proxyUrl?: string } = {};
    if (draft !== undefined) {
      try { body = { proxyUrl: parseProxyUrl(draft).proxyUrl }; }
      catch (value) { setFormError(value instanceof Error ? value.message : "代理地址无效"); release(); return; }
    }
    const request = mutations.current.invalidate(); setFormError(null);
    try {
      const result = UI_PREVIEW ? previewCheck : await api<CloudProxyCheckResult>(`/v1/cloud-accounts/${account.id}/proxy/check`, { method: "POST", ...jsonBody(body) });
      if (!mutations.current.isCurrent(request)) return;
      if (draft === undefined) setChecks((current) => ({ ...current, [account.id]: result }));
      else setDraftCheck(result);
      if (!result.ok) setFormError(proxyErrorMessage(new Error(result.error || "代理连通性检测失败"), draft ?? ""));
    } catch (value) {
      if (mutations.current.isCurrent(request)) setFormError(proxyErrorMessage(value, draft ?? "", "代理连通性检测失败"));
    } finally { release(); }
  };

  return <ConsoleLayout>
    <PageHeader title="SOCKS 代理" description="按云计算账号配置 API 出站代理；默认直连" actions={<Button variant="secondary" icon={<RefreshCw size={14} />} disabled={loading || busy !== null} onClick={() => void load()}>刷新</Button>} />
    <div className="inline-warning proxy-context">代理用于 MasterDNS 服务端访问云厂商 API。地址中的 localhost 指 MasterDNS 所在服务器或容器，不是当前浏览器所在电脑。优先使用 socks5h 让代理端解析 DNS。</div>
    {loading && !accounts ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void load()} /></div> : !accounts?.length ? <div className="surface"><EmptyState title="尚未接入云计算账号" /></div> : <section className="surface"><header className="surface-header"><div><h2>账号代理</h2><p>页面加载只读取配置状态；出口 IP 检测仅在点击后执行</p></div></header><div className="table-wrap"><table className="proxy-table"><thead><tr><th>云账号</th><th>代理状态</th><th>代理端点</th><th>最近检测</th><th aria-label="操作" /></tr></thead><tbody>{accounts.map((account) => {
      const status = statuses[account.id]; const checkResult = checks[account.id]; const rowBusy = busy !== null;
      return <tr key={account.id}><td><div className="table-primary"><strong>{account.name}</strong><small>{cloudProviderLabels[account.provider]} · {account.externalAccountId ?? "身份尚未同步"}</small></div></td><td>{statusErrors[account.id] ? <div className="table-primary"><StatusBadge value="error" /><small>{statusErrors[account.id]}</small></div> : <StatusBadge value={status?.configured ? "active" : "disabled"} />}</td><td className="mono">{status?.endpoint ?? "直连"}</td><td>{checkResult ? <ProxyCheckSummary result={checkResult} /> : <span className="muted">尚未主动检测</span>}</td><td><div className="row-actions"><Button variant="ghost" icon={<Activity size={14} />} disabled={rowBusy || !status?.configured} onClick={() => void check(account)}>检测</Button><IconButton label={`配置 ${account.name} 代理`} disabled={rowBusy} onClick={() => openEditor(account)}><Pencil size={15} /></IconButton><IconButton label={`移除 ${account.name} 代理`} disabled={rowBusy || !status?.configured} onClick={() => { setFormError(null); setRemoveTarget(account); }}><Trash2 size={15} /></IconButton></div></td></tr>;
    })}</tbody></table></div></section>}
    <Dialog open={editorTarget !== null} title={`配置 ${editorTarget?.name ?? "云账号"} API 代理`} onClose={closeEditor} footer={<><Button variant="secondary" disabled={busy !== null} onClick={closeEditor}>取消</Button><Button variant="secondary" disabled={busy !== null || proxyUrl.trim() === ""} onClick={() => editorTarget && void check(editorTarget, proxyUrl)}>{busy?.kind === "check" ? "检测中" : "检测未保存代理"}</Button><Button type="submit" form="cloud-proxy-form" disabled={busy !== null}>{busy?.kind === "save" ? "验证并保存中" : "保存代理"}</Button></>}>
      <form id="cloud-proxy-form" className="field-grid" onSubmit={save}><Field label="新代理 URL" hint="支持 socks5:// 与 socks5h://；用户名和密码不会回显"><input type="password" autoComplete="new-password" value={proxyUrl} onChange={(event) => { setProxyUrl(event.target.value); setDraftCheck(null); }} placeholder="socks5h://user:password@proxy.example.com:1080" required /></Field><p className="fieldset-note span-2">保存前会由服务端验证同一云账号身份。验证失败时保留当前输入，已保存的旧代理不会被覆盖。</p>{draftCheck && <div className="span-2"><ProxyCheckSummary result={draftCheck} /></div>}{formError && <div className="login-error span-2" role="alert">{formError}</div>}</form>
    </Dialog>
    <Dialog open={removeTarget !== null} title="恢复直连" onClose={() => { if (!busyRef.current) { setRemoveTarget(null); setFormError(null); } }} footer={<><Button variant="secondary" disabled={busy !== null} onClick={() => setRemoveTarget(null)}>取消</Button><Button variant="danger" disabled={busy !== null} onClick={() => void remove()}>{busy?.kind === "remove" ? "移除中" : "确认移除代理"}</Button></>}><p>移除 {removeTarget?.name} 的 SOCKS 代理后，MasterDNS 将从服务器或容器直接访问该云账号的 API。</p>{formError && <div className="login-error" role="alert">{formError}</div>}</Dialog>
  </ConsoleLayout>;
}

function ProxyCheckSummary({ result }: { result: CloudProxyCheckResult }) {
  return <div className="proxy-check-result"><StatusBadge value={result.ok ? "success" : "failed"} /><strong className="mono">{result.ip ?? "未返回出口 IP"}</strong><small>{result.latencyMs} ms · <RelativeTime value={result.checkedAt} />{result.error ? " · 检测失败" : ""}</small></div>;
}

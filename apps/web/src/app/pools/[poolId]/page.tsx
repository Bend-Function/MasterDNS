"use client";

import {
  Activity,
  ArrowLeft,
  Copy,
  Edit3,
  History,
  Link2,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Server,
  Settings2,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../../components/console-layout";
import { RelativeTime } from "../../../components/relative-time";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  LoadingState,
  MetricStrip,
  StatusBadge,
} from "../../../components/ui";
import { useResource } from "../../../hooks/use-resource";
import { api, formatDate, jsonBody, UI_PREVIEW } from "../../../lib/api";
import { demoPoolDetail, demoZones } from "../../../lib/demo";
import type { Binding, Endpoint, HealthCheck, Pool, PoolDetail, ZoneListRow } from "../../../lib/types";

type Tab = "nodes" | "bindings" | "checks" | "history";
type EndpointDraft = {
  name: string;
  addressMode: Endpoint["addressMode"];
  priority: number;
  lifecycle: string;
  ipv4: string;
  ipv6: string;
  forceApply: boolean;
};
type BindingDraft = {
  zoneId: string;
  fqdn: string;
  recordType: Binding["recordType"];
  ttl: number;
  originalEndpointId: string;
  takeoverExisting: boolean;
  proxied: boolean;
  aliLine: string;
  aliWeight: string;
  aliStatus: "Enable" | "Disable";
  forceApply: boolean;
};
type CheckDraft = {
  scope: "pool" | "endpoint" | "binding";
  scopeId: string;
  type: "http" | "tcp";
  protocol: "http" | "https";
  hostname: string;
  port: number;
  path: string;
  method: "GET" | "HEAD";
  headers: string;
  expectedStatusMin: number;
  expectedStatusMax: number;
  bodyContains: string;
  bodyPattern: string;
  followRedirects: boolean;
  verifyTls: boolean;
  timeoutMs: number;
};
type PoolDraft = {
  name: string;
  description: string;
  strategy: Pool["strategy"];
  selectionMode: string;
  recoveryMode: string;
  recoveryDelaySeconds: number;
  failureThreshold: number;
  successThreshold: number;
  checkIntervalSeconds: number;
  checkTimeoutMs: number;
  switchCooldownSeconds: number;
  allDownReminderSeconds: number;
};

const endpointInitial: EndpointDraft = {
  name: "",
  addressMode: "static",
  priority: 100,
  lifecycle: "enabled",
  ipv4: "",
  ipv6: "",
  forceApply: false,
};
const bindingInitial: BindingDraft = {
  zoneId: "",
  fqdn: "",
  recordType: "A",
  ttl: 60,
  originalEndpointId: "",
  takeoverExisting: false,
  proxied: false,
  aliLine: "default",
  aliWeight: "",
  aliStatus: "Enable",
  forceApply: false,
};
const checkInitial: CheckDraft = {
  scope: "pool",
  scopeId: "",
  type: "http",
  protocol: "https",
  hostname: "",
  port: 443,
  path: "/health",
  method: "GET",
  headers: "{}",
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  bodyContains: "",
  bodyPattern: "",
  followRedirects: true,
  verifyTls: true,
  timeoutMs: 3000,
};

export default function PoolDetailPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const router = useRouter();
  const { data, loading, error, reload } = useResource<PoolDetail>(`/v1/pools/${poolId}`, demoPoolDetail);
  const zones = useResource<ZoneListRow[]>("/v1/zones", demoZones);
  const [tab, setTab] = useState<Tab>("nodes");
  const [endpointEditor, setEndpointEditor] = useState<Endpoint | "new" | null>(null);
  const [bindingEditor, setBindingEditor] = useState<Binding | "new" | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentCommand, setAgentCommand] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(endpointInitial);
  const [bindingDraft, setBindingDraft] = useState<BindingDraft>(bindingInitial);
  const [checkDraft, setCheckDraft] = useState<CheckDraft>(checkInitial);
  const [poolDraft, setPoolDraft] = useState<PoolDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingEndpoint, setDeletingEndpoint] = useState<Endpoint | null>(null);
  const [deletingBinding, setDeletingBinding] = useState<Binding | null>(null);
  const [deletingCheck, setDeletingCheck] = useState<HealthCheck | null>(null);
  const [deletePoolOpen, setDeletePoolOpen] = useState(false);
  const [deletePoolName, setDeletePoolName] = useState("");
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const [restoreForce, setRestoreForce] = useState(false);

  const mutate = async (path: string, method = "POST", body?: unknown): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) await api(path, { method, ...(body !== undefined ? jsonBody(body) : {}) });
      await reload();
      return true;
    } catch (mutationError) {
      setActionError(mutationError instanceof Error ? mutationError.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openEndpointEditor = (endpoint?: Endpoint) => {
    setActionError(null);
    setEndpointEditor(endpoint ?? "new");
    setEndpointDraft(endpoint ? {
      name: endpoint.name,
      addressMode: endpoint.addressMode,
      priority: endpoint.priority,
      lifecycle: endpoint.lifecycle,
      ipv4: currentAddress(endpoint, "4"),
      ipv6: currentAddress(endpoint, "6"),
      forceApply: false,
    } : endpointInitial);
  };

  const saveEndpoint = async (event: FormEvent) => {
    event.preventDefault();
    const common = {
      name: endpointDraft.name,
      priority: endpointDraft.priority,
      lifecycle: endpointDraft.lifecycle,
    };
    const staticAddresses = endpointDraft.addressMode === "static"
      ? { ipv4: endpointDraft.ipv4 || null, ipv6: endpointDraft.ipv6 || null }
      : {};
    const success = endpointEditor === "new"
      ? await mutate(`/v1/pools/${poolId}/endpoints`, "POST", {
        ...common,
        addressMode: endpointDraft.addressMode,
        ...(endpointDraft.addressMode === "static" ? {
          ipv4: endpointDraft.ipv4 || undefined,
          ipv6: endpointDraft.ipv6 || undefined,
        } : {}),
      })
      : endpointEditor
        ? await mutate(`/v1/pools/${poolId}/endpoints/${endpointEditor.id}`, "PATCH", {
          ...common,
          ...staticAddresses,
          forceApply: endpointDraft.forceApply,
        })
        : false;
    if (success) setEndpointEditor(null);
  };

  const openBindingEditor = (binding?: Binding) => {
    setActionError(null);
    setBindingEditor(binding ?? "new");
    setBindingDraft(binding ? {
      zoneId: binding.zoneId,
      fqdn: binding.fqdn,
      recordType: binding.recordType,
      ttl: binding.ttl,
      originalEndpointId: binding.originalEndpointId ?? "",
      takeoverExisting: false,
      proxied: binding.providerMetadata.proxied === true,
      aliLine: typeof binding.providerMetadata.line === "string" ? binding.providerMetadata.line : "default",
      aliWeight: typeof binding.providerMetadata.weight === "number" ? String(binding.providerMetadata.weight) : "",
      aliStatus: String(binding.providerMetadata.status ?? "Enable").toLowerCase().startsWith("dis") ? "Disable" : "Enable",
      forceApply: false,
    } : bindingInitial);
  };

  const saveBinding = async (event: FormEvent) => {
    event.preventDefault();
    const provider = bindingProvider(bindingDraft.zoneId, zones.data, bindingEditor);
    const providerMetadata = buildProviderMetadata(provider, bindingDraft, bindingEditor === "new" ? {} : bindingEditor?.providerMetadata ?? {});
    const success = bindingEditor === "new"
      ? await mutate(`/v1/pools/${poolId}/bindings`, "POST", {
        zoneId: bindingDraft.zoneId,
        fqdn: bindingDraft.fqdn,
        recordType: bindingDraft.recordType,
        ttl: bindingDraft.ttl,
        providerMetadata,
        originalEndpointId: bindingDraft.originalEndpointId || undefined,
        takeoverExisting: bindingDraft.takeoverExisting,
      })
      : bindingEditor
        ? await mutate(`/v1/pools/${poolId}/bindings/${bindingEditor.id}`, "PATCH", {
          ttl: bindingDraft.ttl,
          providerMetadata,
          ...(bindingDraft.originalEndpointId ? { originalEndpointId: bindingDraft.originalEndpointId } : {}),
          forceApply: bindingDraft.forceApply,
        })
        : false;
    if (success) setBindingEditor(null);
  };

  const createCheck = async (event: FormEvent) => {
    event.preventDefault();
    let headers: Record<string, string> = {};
    if (checkDraft.type === "http") {
      try {
        const parsed = JSON.parse(checkDraft.headers) as unknown;
        if (!isStringRecord(parsed)) throw new Error("自定义请求头必须是字符串键值 JSON 对象");
        headers = parsed;
      } catch (parseError) {
        setActionError(parseError instanceof Error ? parseError.message : "自定义请求头 JSON 无效");
        return;
      }
    }
    const config = checkDraft.type === "tcp" ? {
      type: "tcp",
      port: checkDraft.port,
      timeoutMs: checkDraft.timeoutMs,
    } : {
      type: "http",
      protocol: checkDraft.protocol,
      port: checkDraft.port,
      hostname: checkDraft.hostname || undefined,
      path: checkDraft.path,
      method: checkDraft.method,
      headers,
      expectedStatusMin: checkDraft.expectedStatusMin,
      expectedStatusMax: checkDraft.expectedStatusMax,
      bodyContains: checkDraft.bodyContains || undefined,
      bodyPattern: checkDraft.bodyPattern || undefined,
      followRedirects: checkDraft.followRedirects,
      verifyTls: checkDraft.verifyTls,
      timeoutMs: checkDraft.timeoutMs,
    };
    const path = checkDraft.scope === "pool"
      ? `/v1/pools/${poolId}/checks`
      : checkDraft.scope === "endpoint"
        ? `/v1/pools/${poolId}/endpoints/${checkDraft.scopeId}/checks`
        : `/v1/pools/${poolId}/bindings/${checkDraft.scopeId}/checks`;
    if (await mutate(path, "POST", { config })) {
      setCheckOpen(false);
      setCheckDraft(checkInitial);
    }
  };

  const openSettings = (pool: Pool) => {
    setActionError(null);
    setPoolDraft(poolDraftFrom(pool));
    setSettingsOpen(true);
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (poolDraft && await mutate(`/v1/pools/${poolId}`, "PATCH", poolDraft)) setSettingsOpen(false);
  };

  const installAgent = async (endpoint: Endpoint) => {
    setActionError(null);
    if (UI_PREVIEW) {
      setAgentCommand("curl -fsSL 'https://dns.internal/api/v1/ddns/install.sh' | sudo sh -s -- install --url 'https://dns.internal' --token 'one-time-token'");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ command: string }>(`/v1/pools/${poolId}/endpoints/${endpoint.id}/ddns/install-token`, {
        method: "POST",
        ...jsonBody({ expiresInSeconds: 900 }),
      });
      setAgentCommand(result.command);
    } catch (installError) {
      setActionError(installError instanceof Error ? installError.message : "生成安装命令失败");
    } finally {
      setBusy(false);
    }
  };

  const restorePolicy = async () => {
    if (restoreVersion === null) return;
    if (await mutate(`/v1/pools/${poolId}/policy-versions/${restoreVersion}/restore`, "POST", { force: restoreForce })) {
      setRestoreVersion(null);
      setRestoreForce(false);
    }
  };

  const deletePool = async () => {
    if (!data || deletePoolName !== data.pool.name) return;
    setBusy(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/pools/${poolId}`, { method: "DELETE" });
      router.push("/pools");
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : "删除 Pool 失败");
      setDeletePoolOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <ConsoleLayout><LoadingState /></ConsoleLayout>;
  if (error || !data) return <ConsoleLayout><ErrorState message={error ?? "Pool 不存在"} onRetry={() => void reload()} /></ConsoleLayout>;

  const pool = data.pool;
  const unhealthy = data.endpoints.filter((endpoint) => endpoint.healthState === "unhealthy").length;
  const selectedProvider = bindingProvider(bindingDraft.zoneId, zones.data, bindingEditor);

  return <ConsoleLayout>
    <div className="detail-header">
      <div className="detail-title">
        <Link className="icon-button" href="/pools" aria-label="返回 IP Pool"><ArrowLeft size={17} /></Link>
        <div><h1>{pool.name}</h1><p>{strategyLabel(pool.strategy)} · Revision {pool.policyRevision}</p></div>
        <StatusBadge value={pool.enabled ? pool.state : "disabled"} />
      </div>
      <div className="detail-actions">
        <Button variant="secondary" icon={<Settings2 size={14} />} onClick={() => openSettings(pool)}>设置</Button>
        <Button variant="secondary" icon={pool.enabled ? <Pause size={14} /> : <Play size={14} />} disabled={busy} onClick={() => void mutate(`/v1/pools/${poolId}/${pool.enabled ? "pause" : "resume"}`)}>{pool.enabled ? "暂停" : "恢复"}</Button>
        <Button variant="secondary" icon={<RefreshCw size={14} />} disabled={busy} onClick={() => void mutate(`/v1/pools/${poolId}/reconcile`, "POST", { force: false })}>重新平衡</Button>
        <Button icon={<Plus size={14} />} onClick={() => openEndpointEditor()}>添加节点</Button>
      </div>
    </div>
    {actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <MetricStrip items={[
      { label: "节点", value: data.endpoints.length, detail: `${data.endpoints.filter((endpoint) => endpoint.healthState === "healthy").length} 个健康` },
      { label: "域名绑定", value: data.bindings.length, detail: `${new Set(data.bindings.map((binding) => binding.provider)).size} 个云厂商` },
      { label: "活动故障", value: unhealthy, detail: unhealthy ? "自动化正在接管" : "当前正常" },
      { label: "最近协调", value: <RelativeTime value={pool.lastReconciledAt} />, detail: `策略版本 ${pool.policyRevision}` },
    ]} />

    <nav className="tabs" aria-label="Pool 详情">
      <button className={tab === "nodes" ? "active" : ""} onClick={() => setTab("nodes")}><Server size={14} />节点</button>
      <button className={tab === "bindings" ? "active" : ""} onClick={() => setTab("bindings")}><Link2 size={14} />域名绑定</button>
      <button className={tab === "checks" ? "active" : ""} onClick={() => setTab("checks")}><Activity size={14} />健康检查</button>
      <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History size={14} />事件与策略</button>
    </nav>

    {tab === "nodes" && <section className="surface">
      <header className="surface-header"><div><h2>节点</h2><p>静态地址和 DDNS 动态地址</p></div><Button variant="secondary" icon={<Plus size={14} />} onClick={() => openEndpointEditor()}>添加</Button></header>
      {data.endpoints.length === 0 ? <EmptyState title="Pool 中没有节点" /> : <div className="table-wrap"><table>
        <thead><tr><th>节点</th><th>当前地址</th><th>模式</th><th>健康</th><th>连续结果</th><th>最近检查</th><th aria-label="操作" /></tr></thead>
        <tbody>{data.endpoints.map((endpoint) => <tr key={endpoint.id}>
          <td><div className="table-primary"><strong>{endpoint.name}</strong><small>优先级 {endpoint.priority} · {lifecycleLabel(endpoint.lifecycle)}</small></div></td>
          <td><div className="address-stack">{endpoint.addresses.filter((address) => address.state === "current").map((address) => <span className="mono" key={address.id}>IPv{address.family} {address.address}</span>)}{endpoint.addresses.some((address) => address.state === "candidate") && <span className="status status-warning">候选地址待验证</span>}</div></td>
          <td>{endpoint.addressMode === "ddns" ? <span><RadioTower size={13} /> DDNS</span> : "静态"}</td>
          <td><StatusBadge value={endpoint.healthState} /></td>
          <td><span className="muted">+{endpoint.consecutiveSuccesses} / -{endpoint.consecutiveFailures}</span></td>
          <td className="muted"><RelativeTime value={endpoint.lastCheckedAt} /></td>
          <td><div className="row-actions">
            <IconButton label="立即检查" disabled={busy} onClick={() => void mutate(`/v1/pools/${poolId}/endpoints/${endpoint.id}/check`)}><Activity size={15} /></IconButton>
            {endpoint.addressMode === "ddns" && <IconButton label="安装 DDNS Agent" disabled={busy} onClick={() => void installAgent(endpoint)}><RadioTower size={15} /></IconButton>}
            <IconButton label="编辑节点" onClick={() => openEndpointEditor(endpoint)}><Edit3 size={15} /></IconButton>
            <IconButton label="删除节点" onClick={() => setDeletingEndpoint(endpoint)}><Trash2 size={15} /></IconButton>
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}

    {tab === "bindings" && <section className="surface">
      <header className="surface-header"><div><h2>域名绑定</h2><p>可跨 Cloudflare 和阿里云分配</p></div><Button variant="secondary" icon={<Plus size={14} />} onClick={() => openBindingEditor()}>添加</Button></header>
      {data.bindings.length === 0 ? <EmptyState title="尚未绑定域名" /> : <div className="table-wrap"><table>
        <thead><tr><th>域名</th><th>Provider</th><th>原始节点</th><th>当前分配</th><th>状态</th><th>TTL</th><th aria-label="操作" /></tr></thead>
        <tbody>{data.bindings.map((binding) => <tr key={binding.id}>
          <td><div className="table-primary"><strong>{binding.fqdn}</strong><small>{binding.recordType}</small></div></td>
          <td><span className={`provider-mark ${binding.provider === "cloudflare" ? "provider-cf" : "provider-ali"}`}>{binding.provider === "cloudflare" ? "CF" : "ALI"}</span></td>
          <td>{endpointName(data.endpoints, binding.originalEndpointId)}</td>
          <td>{binding.assignments.filter((assignment) => assignment.applied).map((assignment) => endpointName(data.endpoints, assignment.endpointId)).join(", ") || "未发布"}</td>
          <td><StatusBadge value={binding.state} /></td>
          <td>{binding.ttl}s</td>
          <td><div className="row-actions"><IconButton label="编辑绑定" onClick={() => openBindingEditor(binding)}><Edit3 size={15} /></IconButton><IconButton label="删除绑定" onClick={() => setDeletingBinding(binding)}><Trash2 size={15} /></IconButton></div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}

    {tab === "checks" && <div className="content-grid">
      <section className="surface">
        <header className="surface-header"><div><h2>检查配置</h2><p>Pool 默认，可由节点或域名覆盖</p></div><Button variant="secondary" icon={<Plus size={14} />} onClick={() => { setCheckDraft(checkInitial); setCheckOpen(true); }}>添加</Button></header>
        {data.healthChecks.length === 0 ? <EmptyState title="未配置健康检查" /> : <div className="table-wrap"><table>
          <thead><tr><th>范围</th><th>Checker</th><th>目标</th><th>超时</th><th>状态</th><th aria-label="操作" /></tr></thead>
          <tbody>{data.healthChecks.map((check) => <tr key={check.id}>
            <td>{checkScopeLabel(check, data)}</td>
            <td>{check.checkerType.toUpperCase()}</td>
            <td className="mono">{checkTargetLabel(check)}</td>
            <td>{String(check.config.timeoutMs ?? pool.checkTimeoutMs)}ms</td>
            <td><StatusBadge value={check.enabled ? "active" : "disabled"} /></td>
            <td><IconButton label="删除健康检查" onClick={() => setDeletingCheck(check)}><Trash2 size={15} /></IconButton></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <aside className="surface"><header className="surface-header"><div><h2>最近结果</h2><p>最新 100 条探测</p></div></header><ul className="compact-list">{data.healthResults.slice(0, 12).map(({ result, endpointName: name }) => <li key={result.id}><div><strong>{name}</strong><small>{result.success ? `${result.latencyMs}ms` : result.errorCode ?? "失败"}</small></div><StatusBadge value={result.success ? "healthy" : "failed"} /></li>)}</ul></aside>
    </div>}

    {tab === "history" && <div className="content-grid">
      <section className="surface"><header className="surface-header"><div><h2>故障与调度事件</h2><p>健康证据与策略决定</p></div><ShieldAlert size={16} /></header><ul className="event-list">{data.events.map((event) => <li key={event.id}><strong>{event.eventType}</strong><span>{formatDate(event.createdAt)} · {JSON.stringify(event.evidence).slice(0, 160)}</span></li>)}</ul></section>
      <aside className="surface"><header className="surface-header"><div><h2>策略版本</h2><p>不可变配置历史</p></div></header><ul className="compact-list">{data.policyVersions.map((version) => <li key={version.id}><div><strong>Revision {version.version}</strong><small>{version.reason} · {formatDate(version.createdAt)}</small></div>{version.version === pool.policyRevision ? <StatusBadge value="active" /> : <IconButton label={`恢复 Revision ${version.version}`} onClick={() => setRestoreVersion(version.version)}><RotateCcw size={14} /></IconButton>}</li>)}</ul></aside>
    </div>}

    <Dialog open={endpointEditor !== null} title={endpointEditor === "new" ? "添加节点" : "编辑节点"} onClose={() => setEndpointEditor(null)} footer={<><Button variant="secondary" onClick={() => setEndpointEditor(null)}>取消</Button><Button type="submit" form="endpoint-form" disabled={busy}>{endpointEditor === "new" ? "添加节点" : "保存节点"}</Button></>}>
      <form id="endpoint-form" className="field-grid" onSubmit={saveEndpoint}>
        <Field label="节点名称"><input value={endpointDraft.name} onChange={(event) => setEndpointDraft({ ...endpointDraft, name: event.target.value })} required /></Field>
        <Field label="地址模式"><select value={endpointDraft.addressMode} disabled={endpointEditor !== "new"} onChange={(event) => setEndpointDraft({ ...endpointDraft, addressMode: event.target.value as Endpoint["addressMode"] })}><option value="static">静态地址</option><option value="ddns">DDNS Agent</option></select></Field>
        <Field label="优先级"><input type="number" min={0} value={endpointDraft.priority} onChange={(event) => setEndpointDraft({ ...endpointDraft, priority: Number(event.target.value) })} /></Field>
        <Field label="运行状态"><select value={endpointDraft.lifecycle} onChange={(event) => setEndpointDraft({ ...endpointDraft, lifecycle: event.target.value })}><option value="enabled">启用</option><option value="maintenance">维护</option><option value="draining">排空</option><option value="disabled">停用</option></select></Field>
        {endpointDraft.addressMode === "static" && <><Field label="IPv4"><input className="mono" placeholder="203.0.113.10" value={endpointDraft.ipv4} onChange={(event) => setEndpointDraft({ ...endpointDraft, ipv4: event.target.value })} /></Field><Field label="IPv6"><input className="mono" placeholder="2001:db8::10" value={endpointDraft.ipv6} onChange={(event) => setEndpointDraft({ ...endpointDraft, ipv6: event.target.value })} /></Field></>}
        {endpointEditor !== "new" && <label className="switch-row span-2"><span>忽略当前健康状态并强制发布</span><input type="checkbox" checked={endpointDraft.forceApply} onChange={(event) => setEndpointDraft({ ...endpointDraft, forceApply: event.target.checked })} /></label>}
      </form>
    </Dialog>

    <Dialog open={bindingEditor !== null} title={bindingEditor === "new" ? "添加域名绑定" : "编辑域名绑定"} onClose={() => setBindingEditor(null)} footer={<><Button variant="secondary" onClick={() => setBindingEditor(null)}>取消</Button><Button type="submit" form="binding-form" disabled={busy}>{bindingEditor === "new" ? "添加绑定" : "保存绑定"}</Button></>}>
      <form id="binding-form" className="field-grid" onSubmit={saveBinding}>
        <Field label="Zone"><select value={bindingDraft.zoneId} disabled={bindingEditor !== "new"} onChange={(event) => setBindingDraft({ ...bindingDraft, zoneId: event.target.value })} required><option value="">选择 Zone</option>{zones.data?.map((row) => <option key={row.zone.id} value={row.zone.id}>{row.zone.nameAscii} · {row.provider}</option>)}</select></Field>
        <Field label="记录类型"><select value={bindingDraft.recordType} disabled={bindingEditor !== "new"} onChange={(event) => setBindingDraft({ ...bindingDraft, recordType: event.target.value as Binding["recordType"] })}><option>A</option><option>AAAA</option></select></Field>
        <Field label="完整域名"><input placeholder="api.example.com" value={bindingDraft.fqdn} disabled={bindingEditor !== "new"} onChange={(event) => setBindingDraft({ ...bindingDraft, fqdn: event.target.value })} required /></Field>
        <Field label="原始节点"><select value={bindingDraft.originalEndpointId} onChange={(event) => setBindingDraft({ ...bindingDraft, originalEndpointId: event.target.value })} required={pool.strategy !== "healthy_set" || bindingDraft.takeoverExisting}><option value="">{pool.strategy === "healthy_set" ? "由健康集合决定" : "选择节点"}</option>{data.endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>)}</select></Field>
        <Field label="TTL"><input type="number" min={1} value={bindingDraft.ttl} onChange={(event) => setBindingDraft({ ...bindingDraft, ttl: Number(event.target.value) })} /></Field>
        {bindingEditor === "new" && <label className="switch-row"><span>接管现有同名记录</span><button type="button" className={`switch ${bindingDraft.takeoverExisting ? "on" : ""}`} aria-label="切换接管现有同名记录" onClick={() => setBindingDraft({ ...bindingDraft, takeoverExisting: !bindingDraft.takeoverExisting })} /></label>}
        {selectedProvider === "cloudflare" && <label className="switch-row"><span>Cloudflare Proxy</span><button type="button" className={`switch ${bindingDraft.proxied ? "on" : ""}`} aria-label="切换 Cloudflare Proxy" onClick={() => setBindingDraft({ ...bindingDraft, proxied: !bindingDraft.proxied })} /></label>}
        {selectedProvider === "aliyun" && <><Field label="解析线路"><input value={bindingDraft.aliLine} onChange={(event) => setBindingDraft({ ...bindingDraft, aliLine: event.target.value })} required /></Field><Field label="权重（可选）"><input type="number" min={1} max={100} value={bindingDraft.aliWeight} onChange={(event) => setBindingDraft({ ...bindingDraft, aliWeight: event.target.value })} /></Field><Field label="记录状态"><select value={bindingDraft.aliStatus} onChange={(event) => setBindingDraft({ ...bindingDraft, aliStatus: event.target.value as "Enable" | "Disable" })}><option value="Enable">启用</option><option value="Disable">停用</option></select></Field></>}
        {bindingEditor !== "new" && <label className="switch-row span-2"><span>忽略当前健康状态并强制发布</span><input type="checkbox" checked={bindingDraft.forceApply} onChange={(event) => setBindingDraft({ ...bindingDraft, forceApply: event.target.checked })} /></label>}
      </form>
    </Dialog>

    <Dialog open={checkOpen} title="添加健康检查" size="large" onClose={() => setCheckOpen(false)} footer={<><Button variant="secondary" onClick={() => setCheckOpen(false)}>取消</Button><Button type="submit" form="check-form" disabled={busy}>保存检查</Button></>}>
      <form id="check-form" className="field-grid" onSubmit={createCheck}>
        <Field label="作用范围"><select value={checkDraft.scope} onChange={(event) => setCheckDraft({ ...checkDraft, scope: event.target.value as CheckDraft["scope"], scopeId: "" })}><option value="pool">Pool 默认</option><option value="endpoint">节点覆盖</option><option value="binding">域名绑定覆盖</option></select></Field>
        {checkDraft.scope === "endpoint" && <Field label="节点"><select value={checkDraft.scopeId} onChange={(event) => setCheckDraft({ ...checkDraft, scopeId: event.target.value })} required><option value="">选择节点</option>{data.endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>)}</select></Field>}
        {checkDraft.scope === "binding" && <Field label="域名绑定"><select value={checkDraft.scopeId} onChange={(event) => setCheckDraft({ ...checkDraft, scopeId: event.target.value })} required><option value="">选择域名</option>{data.bindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.fqdn}</option>)}</select></Field>}
        <Field label="Checker"><select value={checkDraft.type} onChange={(event) => setCheckDraft({ ...checkDraft, type: event.target.value as CheckDraft["type"] })}><option value="http">HTTP / HTTPS</option><option value="tcp">TCP Connect</option></select></Field>
        {checkDraft.type === "http" && <Field label="协议"><select value={checkDraft.protocol} onChange={(event) => setCheckDraft({ ...checkDraft, protocol: event.target.value as CheckDraft["protocol"] })}><option value="https">HTTPS</option><option value="http">HTTP</option></select></Field>}
        <Field label="端口"><input type="number" min={1} max={65535} value={checkDraft.port} onChange={(event) => setCheckDraft({ ...checkDraft, port: Number(event.target.value) })} /></Field>
        {checkDraft.type === "http" && <>
          <Field label="Host / SNI"><input placeholder="service.example.com" value={checkDraft.hostname} onChange={(event) => setCheckDraft({ ...checkDraft, hostname: event.target.value })} /></Field>
          <Field label="请求方法"><select value={checkDraft.method} onChange={(event) => setCheckDraft({ ...checkDraft, method: event.target.value as CheckDraft["method"] })}><option>GET</option><option>HEAD</option></select></Field>
          <Field label="路径与查询参数"><input value={checkDraft.path} onChange={(event) => setCheckDraft({ ...checkDraft, path: event.target.value })} required /></Field>
          <Field label="期望状态码下限"><input type="number" min={100} max={599} value={checkDraft.expectedStatusMin} onChange={(event) => setCheckDraft({ ...checkDraft, expectedStatusMin: Number(event.target.value) })} /></Field>
          <Field label="期望状态码上限"><input type="number" min={100} max={599} value={checkDraft.expectedStatusMax} onChange={(event) => setCheckDraft({ ...checkDraft, expectedStatusMax: Number(event.target.value) })} /></Field>
          <Field label="响应包含文本"><input value={checkDraft.bodyContains} disabled={checkDraft.method === "HEAD"} onChange={(event) => setCheckDraft({ ...checkDraft, bodyContains: event.target.value })} /></Field>
          <Field label="响应正则"><input value={checkDraft.bodyPattern} disabled={checkDraft.method === "HEAD"} onChange={(event) => setCheckDraft({ ...checkDraft, bodyPattern: event.target.value })} /></Field>
          <Field label="自定义请求头 JSON"><textarea className="mono" value={checkDraft.headers} onChange={(event) => setCheckDraft({ ...checkDraft, headers: event.target.value })} /></Field>
          <div className="span-2 checkbox-grid"><label><input type="checkbox" checked={checkDraft.followRedirects} onChange={(event) => setCheckDraft({ ...checkDraft, followRedirects: event.target.checked })} />跟随跳转</label><label><input type="checkbox" checked={checkDraft.verifyTls} onChange={(event) => setCheckDraft({ ...checkDraft, verifyTls: event.target.checked })} />验证 TLS 证书</label></div>
        </>}
        <Field label="超时（毫秒）"><input type="number" min={100} max={60000} value={checkDraft.timeoutMs} onChange={(event) => setCheckDraft({ ...checkDraft, timeoutMs: Number(event.target.value) })} /></Field>
      </form>
    </Dialog>

    <Dialog open={settingsOpen && poolDraft !== null} title="Pool 设置" size="large" onClose={() => setSettingsOpen(false)} footer={<><Button variant="danger" icon={<Trash2 size={14} />} onClick={() => { setSettingsOpen(false); setDeletePoolOpen(true); }}>删除 Pool</Button><Button variant="secondary" onClick={() => setSettingsOpen(false)}>取消</Button><Button type="submit" form="pool-settings-form" disabled={busy}>保存设置</Button></>}>
      {poolDraft && <form id="pool-settings-form" className="field-grid" onSubmit={saveSettings}>
        <Field label="名称"><input value={poolDraft.name} onChange={(event) => setPoolDraft({ ...poolDraft, name: event.target.value })} required /></Field>
        <Field label="策略类型"><select value={poolDraft.strategy} onChange={(event) => setPoolDraft({ ...poolDraft, strategy: event.target.value as Pool["strategy"] })}><option value="primary_backup">主备模式</option><option value="healthy_set">健康集合</option><option value="assignment_pool">跨域名分配池</option></select></Field>
        <Field label="说明"><textarea value={poolDraft.description} onChange={(event) => setPoolDraft({ ...poolDraft, description: event.target.value })} /></Field>
        <Field label="调度方式"><select value={poolDraft.selectionMode} onChange={(event) => setPoolDraft({ ...poolDraft, selectionMode: event.target.value })}><option value="random">随机</option><option value="ordered">顺序</option><option value="round_robin">轮询</option><option value="least_assigned">最少分配</option></select></Field>
        <Field label="恢复方式"><select value={poolDraft.recoveryMode} onChange={(event) => setPoolDraft({ ...poolDraft, recoveryMode: event.target.value })}><option value="automatic">自动恢复原节点</option><option value="keep_current">保持当前节点</option><option value="manual">手动恢复</option><option value="delayed">延迟恢复</option></select></Field>
        {poolDraft.recoveryMode === "delayed" && <Field label="恢复等待（秒）"><input type="number" min={0} value={poolDraft.recoveryDelaySeconds} onChange={(event) => setPoolDraft({ ...poolDraft, recoveryDelaySeconds: Number(event.target.value) })} /></Field>}
        <Field label="检查间隔（秒）"><input type="number" min={5} value={poolDraft.checkIntervalSeconds} onChange={(event) => setPoolDraft({ ...poolDraft, checkIntervalSeconds: Number(event.target.value) })} /></Field>
        <Field label="检查超时（毫秒）"><input type="number" min={100} max={60000} value={poolDraft.checkTimeoutMs} onChange={(event) => setPoolDraft({ ...poolDraft, checkTimeoutMs: Number(event.target.value) })} /></Field>
        <Field label="失败阈值"><input type="number" min={1} max={20} value={poolDraft.failureThreshold} onChange={(event) => setPoolDraft({ ...poolDraft, failureThreshold: Number(event.target.value) })} /></Field>
        <Field label="恢复阈值"><input type="number" min={1} max={20} value={poolDraft.successThreshold} onChange={(event) => setPoolDraft({ ...poolDraft, successThreshold: Number(event.target.value) })} /></Field>
        <Field label="切换冷却（秒）"><input type="number" min={0} value={poolDraft.switchCooldownSeconds} onChange={(event) => setPoolDraft({ ...poolDraft, switchCooldownSeconds: Number(event.target.value) })} /></Field>
        <Field label="全池故障提醒（秒）"><input type="number" min={60} value={poolDraft.allDownReminderSeconds} onChange={(event) => setPoolDraft({ ...poolDraft, allDownReminderSeconds: Number(event.target.value) })} /></Field>
      </form>}
    </Dialog>

    <Dialog open={agentCommand !== null} title="安装 DDNS Agent" size="large" onClose={() => setAgentCommand(null)} footer={<><Button variant="secondary" icon={<Copy size={14} />} onClick={() => agentCommand && navigator.clipboard.writeText(agentCommand)}>复制命令</Button><Button onClick={() => setAgentCommand(null)}>完成</Button></>}><div className="code-box">{agentCommand}</div></Dialog>

    <Dialog open={restoreVersion !== null} title={`恢复 Revision ${restoreVersion ?? ""}`} size="small" onClose={() => setRestoreVersion(null)} footer={<><Button variant="secondary" onClick={() => setRestoreVersion(null)}>取消</Button><Button icon={<RotateCcw size={14} />} disabled={busy} onClick={() => void restorePolicy()}>{busy ? "正在恢复" : "恢复策略"}</Button></>}><p className="confirm-copy">旧配置会恢复为一个新的策略版本，并重新计算受管 DNS。节点或域名绑定集合不一致时，系统会拒绝本次操作。</p><label className="switch-row"><span>忽略当前健康状态并强制发布</span><input type="checkbox" checked={restoreForce} onChange={(event) => setRestoreForce(event.target.checked)} /></label></Dialog>

    <Dialog open={deletingEndpoint !== null} title="删除节点" size="small" onClose={() => setDeletingEndpoint(null)} footer={<><Button variant="secondary" onClick={() => setDeletingEndpoint(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={async () => { if (deletingEndpoint && await mutate(`/v1/pools/${poolId}/endpoints/${deletingEndpoint.id}`, "DELETE")) setDeletingEndpoint(null); }}>删除节点</Button></>}><p className="confirm-copy">删除 <strong>{deletingEndpoint?.name}</strong>。节点仍被域名分配引用时，系统会拒绝操作。</p></Dialog>

    <Dialog open={deletingBinding !== null} title="删除域名绑定" size="small" onClose={() => setDeletingBinding(null)} footer={<><Button variant="secondary" onClick={() => setDeletingBinding(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={async () => { if (deletingBinding && await mutate(`/v1/pools/${poolId}/bindings/${deletingBinding.id}`, "DELETE")) setDeletingBinding(null); }}>删除绑定</Button></>}><p className="confirm-copy">系统会先删除该绑定创建的云端 DNS 记录，再保留完整操作历史。确认删除 <strong>{deletingBinding?.fqdn}</strong>？</p></Dialog>

    <Dialog open={deletingCheck !== null} title="删除健康检查" size="small" onClose={() => setDeletingCheck(null)} footer={<><Button variant="secondary" onClick={() => setDeletingCheck(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={async () => { if (deletingCheck && await mutate(`/v1/pools/${poolId}/checks/${deletingCheck.id}`, "DELETE")) setDeletingCheck(null); }}>删除检查</Button></>}><p className="confirm-copy">删除后，该范围会重新继承上级健康检查配置。</p></Dialog>

    <Dialog open={deletePoolOpen} title="删除 Pool" size="small" onClose={() => setDeletePoolOpen(false)} footer={<><Button variant="secondary" onClick={() => setDeletePoolOpen(false)}>取消</Button><Button variant="danger" disabled={busy || deletePoolName !== pool.name} onClick={() => void deletePool()}>永久删除</Button></>}><div className="field-grid"><p className="confirm-copy span-2">只有清空域名绑定后才能删除 Pool。输入 <strong>{pool.name}</strong> 确认。</p><Field label="Pool 名称"><input value={deletePoolName} onChange={(event) => setDeletePoolName(event.target.value)} /></Field></div></Dialog>
  </ConsoleLayout>;
}

function currentAddress(endpoint: Endpoint, family: "4" | "6") {
  return endpoint.addresses.find((address) => address.family === family && address.state === "current")?.address ?? "";
}

function poolDraftFrom(pool: Pool): PoolDraft {
  return {
    name: pool.name,
    description: pool.description ?? "",
    strategy: pool.strategy,
    selectionMode: pool.selectionMode,
    recoveryMode: pool.recoveryMode,
    recoveryDelaySeconds: pool.recoveryDelaySeconds,
    failureThreshold: pool.failureThreshold,
    successThreshold: pool.successThreshold,
    checkIntervalSeconds: pool.checkIntervalSeconds,
    checkTimeoutMs: pool.checkTimeoutMs,
    switchCooldownSeconds: pool.switchCooldownSeconds,
    allDownReminderSeconds: pool.allDownReminderSeconds,
  };
}

function bindingProvider(zoneId: string, zoneRows: ZoneListRow[] | null | undefined, editor: Binding | "new" | null) {
  if (editor && editor !== "new") return editor.provider;
  return zoneRows?.find((row) => row.zone.id === zoneId)?.provider;
}

function buildProviderMetadata(provider: string | undefined, draft: BindingDraft, existing: Record<string, unknown>) {
  const metadata = { ...existing };
  if (provider === "cloudflare") metadata.proxied = draft.proxied;
  if (provider === "aliyun") {
    metadata.line = draft.aliLine;
    metadata.status = draft.aliStatus;
    if (draft.aliWeight) metadata.weight = Number(draft.aliWeight);
    else delete metadata.weight;
  }
  return metadata;
}

function checkScopeLabel(check: HealthCheck, detail: PoolDetail) {
  if (check.endpointId) return `节点 · ${endpointName(detail.endpoints, check.endpointId)}`;
  if (check.domainBindingId) return `域名 · ${detail.bindings.find((binding) => binding.id === check.domainBindingId)?.fqdn ?? "未知"}`;
  return "Pool 默认";
}

function checkTargetLabel(check: HealthCheck) {
  if (check.checkerType === "tcp") return `TCP :${String(check.config.port ?? "-")}`;
  const protocol = String(check.config.protocol ?? "https");
  const host = String(check.config.hostname ?? "目标 IP");
  const port = check.config.port ? `:${String(check.config.port)}` : "";
  const path = String(check.config.path ?? "/");
  return `${protocol}://${host}${port}${path}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function strategyLabel(value: string) {
  return ({ primary_backup: "主备模式", healthy_set: "健康集合", assignment_pool: "跨域名分配池" } as Record<string, string>)[value] ?? value;
}

function lifecycleLabel(value: string) {
  return ({ enabled: "启用", disabled: "停用", maintenance: "维护", draining: "排空中" } as Record<string, string>)[value] ?? value;
}

function endpointName(endpoints: Endpoint[], id: string | null) {
  return endpoints.find((endpoint) => endpoint.id === id)?.name ?? (id ? id.slice(0, 8) : "-");
}

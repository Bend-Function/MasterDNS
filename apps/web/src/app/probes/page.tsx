"use client";

import { Ban, Copy, Plus, RadioTower, RefreshCw, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { ProbeAgentConfig } from "../../components/probe-agent-config";
import { useSession } from "../../components/session-context";
import { Button, Dialog, EmptyState, Field, IconButton, LoadingState, MetricStrip, PageHeader, StatusBadge } from "../../components/ui";
import { API_URL, api, formatDate, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoProbeGroups, demoProbes } from "../../lib/probe-demo";
import { demoNow } from "../../lib/demo";
import { createProbeInstallInstructions, type ProbeAgentConfigInput, type ProbeInstallInstructions } from "../../lib/probe-install";
import type { ProbeAgent, ProbeGroup } from "../../lib/probe-types";
import { createRequestGeneration } from "../../lib/session-state";

type InstallView = { probeName: string; token: string; expiresAt: string; configInput: ProbeAgentConfigInput; instructions: ProbeInstallInstructions | null; instructionError: string | null };

export default function ProbesPage() {
  const { user } = useSession();
  const [probes, setProbes] = useState<ProbeAgent[] | null>(UI_PREVIEW ? demoProbes : null);
  const [groups, setGroups] = useState<ProbeGroup[] | null>(UI_PREVIEW ? demoProbeGroups : null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupTarget, setGroupTarget] = useState<ProbeGroup | "new" | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ProbeAgent | null>(null);
  const [installView, setInstallView] = useState<InstallView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requests = useRef(createRequestGeneration());
  const mutations = useRef(createRequestGeneration());

  const load = useCallback(async () => {
    const generation = requests.current.invalidate();
    setError(null);
    if (UI_PREVIEW) { setProbes(demoProbes); setGroups(demoProbeGroups); return; }
    try {
      const [nextProbes, nextGroups] = await Promise.all([api<ProbeAgent[]>("/v1/probes"), api<ProbeGroup[]>("/v1/probe-groups")]);
      if (requests.current.isCurrent(generation)) { setProbes(nextProbes); setGroups(nextGroups); }
    } catch (value) { if (requests.current.isCurrent(generation)) setError(message(value, "探测点加载失败")); }
  }, []);

  useEffect(() => { if (UI_PREVIEW) return; const requestState = requests.current; const mutationState = mutations.current; let active = true; Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; requestState.invalidate(); mutationState.invalidate(); }; }, [load]);

  const issueInstallToken = async (probe: ProbeAgent) => {
    const generation = mutations.current.invalidate(); setBusyId(probe.id); setError(null);
    try {
      const payload = UI_PREVIEW ? { installToken: "preview-probe-install-token", expiresAt: demoNow } : await api<{ installToken: string; expiresAt: string }>(`/v1/probes/${probe.id}/install-token`, { method: "POST" });
      if (!mutations.current.isCurrent(generation)) return;
      const version = UI_PREVIEW ? "v1.4.2" : process.env.NEXT_PUBLIC_PROBE_AGENT_VERSION ?? "";
      const serverUrl = UI_PREVIEW ? "https://dns.example.com" : resolveServerUrl();
      const configInput = { serverUrl, probeId: probe.id, maxConcurrency: probe.maxConcurrency };
      try {
        setInstallView({ probeName: probe.name, token: payload.installToken, expiresAt: payload.expiresAt, configInput, instructions: createProbeInstallInstructions({ version, serverUrl, installToken: payload.installToken, expiresAt: payload.expiresAt }), instructionError: null });
      } catch (value) {
        setInstallView({ probeName: probe.name, token: payload.installToken, expiresAt: payload.expiresAt, configInput, instructions: null, instructionError: message(value, "当前无法生成安装步骤") });
      }
      setBusyId(null); await load();
    } catch (value) { if (mutations.current.isCurrent(generation)) setError(message(value, "安装 Token 生成失败")); }
    finally { if (mutations.current.isCurrent(generation)) setBusyId(null); }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    const generation = mutations.current.invalidate(); setBusyId(revokeTarget.id); setError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/probes/${revokeTarget.id}/revoke`, { method: "POST" });
      else setProbes((current) => current?.map((probe) => probe.id === revokeTarget.id ? { ...probe, enabled: false, revokedAt: new Date().toISOString() } : probe) ?? null);
      if (mutations.current.isCurrent(generation)) setRevokeTarget(null);
      setBusyId(null); if (!UI_PREVIEW) await load();
    } catch (value) { if (mutations.current.isCurrent(generation)) setError(message(value, "探测点吊销失败")); }
    finally { if (mutations.current.isCurrent(generation)) setBusyId(null); }
  };

  const closeInstall = () => { mutations.current.invalidate(); setInstallView(null); setBusyId(null); };
  const cancelRevoke = () => { mutations.current.invalidate(); setRevokeTarget(null); setBusyId(null); };
  const active = probes?.filter((probe) => probe.enabled && !probe.revokedAt).length ?? 0;
  const ipv6 = probes?.filter((probe) => probe.enabled && probe.capabilities.ipv6).length ?? 0;

  return <ConsoleLayout><PageHeader title="外部探测点" description="管理 probe-agent/v1 节点、固定探测组与一次性安装凭据" actions={<><Button variant="secondary" icon={<UsersRound size={14} />} onClick={() => setGroupTarget("new")}>新建探测组</Button><Button icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>添加探测点</Button><IconButton label="刷新探测点" onClick={() => void load()}><RefreshCw size={16} /></IconButton></>} />
    <MetricStrip items={[{ label: "探测点", value: probes?.length ?? "-", detail: `${active} 个已启用` }, { label: "IPv4 能力", value: probes?.filter((probe) => probe.capabilities.ipv4).length ?? "-", detail: "unavailable 不计故障" }, { label: "IPv6 能力", value: ipv6, detail: "按地址族独立上报" }, { label: "固定探测组", value: groups?.length ?? "-", detail: "成员变更产生新 Revision" }]} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!probes || !groups ? <div className="surface"><LoadingState /></div> : <div className="content-grid"><section className="surface"><header className="surface-header"><div><h2>探测点</h2><p>能力来自最近一次 heartbeat</p></div><RadioTower size={16} /></header>{probes.length === 0 ? <EmptyState title="尚未创建外部探测点" /> : <div className="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>能力</th><th>并发</th><th>版本</th><th>最近心跳</th><th aria-label="操作" /></tr></thead><tbody>{probes.map((probe) => <tr key={probe.id}><td><div className="table-primary"><strong>{probe.name}</strong><small className="mono">{probe.id}</small></div></td><td><StatusBadge value={probe.revokedAt ? "revoked" : probe.enabled ? probe.lastSeenAt ? "reported" : "pending" : "disabled"} /></td><td><div className="capability-list"><span className={probe.capabilities.ipv4 ? "available" : "unavailable"}>IPv4 {probe.capabilities.ipv4 ? "可用" : "不可用"}</span><span className={probe.capabilities.ipv6 ? "available" : "unavailable"}>IPv6 {probe.capabilities.ipv6 ? "可用" : "不可用"}</span></div></td><td>{probe.reportedConcurrency} / {probe.maxConcurrency}</td><td>{probe.agentVersion ?? "尚未上报"}</td><td><RelativeTime value={probe.lastSeenAt} /></td><td><div className="row-actions"><Button variant="ghost" disabled={busyId === probe.id} onClick={() => void issueInstallToken(probe)}>{probe.lastSeenAt ? "重新注册" : "安装"}</Button>{probe.enabled && <IconButton label={`吊销 ${probe.name}`} disabled={busyId === probe.id} onClick={() => setRevokeTarget(probe)}><Ban size={15} /></IconButton>}</div></td></tr>)}</tbody></table></div>}</section>
      <aside className="surface"><header className="surface-header"><div><h2>固定探测组</h2><p>轮次开始后成员快照保持不变</p></div></header>{groups.length === 0 ? <EmptyState title="尚未创建探测组" /> : <ul className="compact-list">{groups.map((group) => <li key={group.id}><div><strong>{group.name}</strong><small>{group.memberIds.length} 个成员 · Revision {group.revision}</small></div><IconButton label={`编辑 ${group.name}`} onClick={() => setGroupTarget(group)}><UsersRound size={15} /></IconButton></li>)}</ul>}</aside></div>}
    <CreateProbeDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={async (probe) => { setCreateOpen(false); await issueInstallToken(probe); }} />
    <GroupDialog key={groupTarget === "new" ? "new" : groupTarget?.id ?? "closed"} target={groupTarget} probes={probes ?? []} actorId={user?.id ?? ""} onClose={() => setGroupTarget(null)} onSaved={async () => { setGroupTarget(null); await load(); }} />
    <Dialog open={installView !== null} title={`${installView?.probeName ?? "探测点"} 安装`} size="large" onClose={closeInstall} footer={<><Button variant="secondary" icon={<Copy size={14} />} disabled={!installView?.instructions} onClick={() => installView?.instructions && void navigator.clipboard.writeText(installView.instructions.installCommand)}>复制安装命令</Button><Button variant="secondary" icon={<Copy size={14} />} onClick={() => installView && void navigator.clipboard.writeText(installView.token)}>复制一次性 Token</Button><Button onClick={closeInstall}>完成</Button></>}>
      {installView && <InstallDetails view={installView} />}
    </Dialog>
    <Dialog open={revokeTarget !== null} title="吊销探测点" size="small" onClose={cancelRevoke} footer={<><Button variant="secondary" onClick={cancelRevoke}>取消</Button><Button variant="danger" disabled={busyId !== null} onClick={() => void revoke()}>确认吊销</Button></>}><p className="confirm-copy">吊销 <strong>{revokeTarget?.name}</strong> 的安装与运行凭据。已发布 DNS 和历史探测结果保持不变。</p></Dialog>
  </ConsoleLayout>;
}

function CreateProbeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (probe: ProbeAgent) => Promise<void> }) {
  const [name, setName] = useState(""); const [maxConcurrency, setMaxConcurrency] = useState(16); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const requests = useRef(createRequestGeneration()); const close = () => { requests.current.invalidate(); setSaving(false); onClose(); };
  const submit = async (event: FormEvent) => { event.preventDefault(); const generation = requests.current.invalidate(); setSaving(true); setError(null); try { const probe = UI_PREVIEW ? { ...demoProbes[0]!, id: crypto.randomUUID(), name, maxConcurrency, lastSeenAt: null } : await api<ProbeAgent>("/v1/probes", { method: "POST", ...jsonBody({ name, maxConcurrency }) }); if (!requests.current.isCurrent(generation)) return; setName(""); await onCreated(probe); } catch (value) { if (requests.current.isCurrent(generation)) setError(message(value, "探测点创建失败")); } finally { if (requests.current.isCurrent(generation)) setSaving(false); } };
  return <Dialog open={open} title="添加外部探测点" onClose={close} footer={<><Button variant="secondary" onClick={close}>取消</Button><Button type="submit" form="create-probe" disabled={saving}>{saving ? "创建中" : "创建并生成 Token"}</Button></>}><form id="create-probe" className="field-grid" onSubmit={submit}>{error && <div className="inline-error span-2">{error}</div>}<Field label="名称"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></Field><Field label="最大并发"><input type="number" min={1} max={100} value={maxConcurrency} onChange={(event) => setMaxConcurrency(Number(event.target.value))} required /></Field></form></Dialog>;
}

function GroupDialog({ target, probes, actorId, onClose, onSaved }: { target: ProbeGroup | "new" | null; probes: ProbeAgent[]; actorId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(target && target !== "new" ? target.name : ""); const [memberIds, setMemberIds] = useState<string[]>(target && target !== "new" ? target.memberIds : []); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const requests = useRef(createRequestGeneration()); const close = () => { requests.current.invalidate(); setSaving(false); onClose(); };
  const candidates = probes.filter((probe) => probe.ownerUserId === (target && target !== "new" ? target.ownerUserId : actorId));
  const submit = async (event: FormEvent) => { event.preventDefault(); const generation = requests.current.invalidate(); setSaving(true); setError(null); try { if (UI_PREVIEW) { await onSaved(); return; } if (target === "new") { const created = await api<ProbeGroup>("/v1/probe-groups", { method: "POST", ...jsonBody({ name }) }); if (!requests.current.isCurrent(generation)) return; if (memberIds.length) await api(`/v1/probe-groups/${created.id}/members`, { method: "PATCH", ...jsonBody({ memberIds }) }); } else if (target) await api(`/v1/probe-groups/${target.id}/members`, { method: "PATCH", ...jsonBody({ memberIds }) }); if (requests.current.isCurrent(generation)) await onSaved(); } catch (value) { if (requests.current.isCurrent(generation)) setError(message(value, "探测组保存失败")); } finally { if (requests.current.isCurrent(generation)) setSaving(false); } };
  return <Dialog open={target !== null} title={target === "new" ? "新建探测组" : `编辑 ${target?.name ?? "探测组"}`} onClose={close} footer={<><Button variant="secondary" onClick={close}>取消</Button><Button type="submit" form="probe-group" disabled={saving}>{saving ? "保存中" : "保存探测组"}</Button></>}><form id="probe-group" className="policy-form" onSubmit={submit}>{error && <div className="inline-error">{error}</div>}{target === "new" && <Field label="组名称"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></Field>}<fieldset><legend>固定成员</legend><div className="member-list">{candidates.map((probe) => <label className="check-row" key={probe.id}><input type="checkbox" checked={memberIds.includes(probe.id)} onChange={(event) => setMemberIds((current) => event.target.checked ? [...current, probe.id] : current.filter((id) => id !== probe.id))} /><span><strong>{probe.name}</strong><small>IPv4 {probe.capabilities.ipv4 ? "可用" : "不可用"} · IPv6 {probe.capabilities.ipv6 ? "可用" : "不可用"}</small></span></label>)}</div></fieldset></form></Dialog>;
}

function resolveServerUrl() { if (API_URL.startsWith("https://")) return API_URL; return window.location.protocol === "https:" ? window.location.origin : API_URL; }
function InstallDetails({ view }: { view: InstallView }) { return <div className="agent-install"><ProbeAgentConfig key={view.token} input={view.configInput} />{view.instructionError ? <div className="inline-error" role="alert">{view.instructionError}</div> : <><section><strong>Linux 安装固定版本</strong><div className="code-box">{view.instructions?.installCommand}</div></section><section><strong>Linux 以低权限账号注册</strong><div className="code-box">{view.instructions?.enrollCommand}</div><small>运行后通过标准输入粘贴一次性 Token。</small></section><section><strong>Linux 启动服务</strong><div className="code-box">{view.instructions?.startCommand}</div></section></>}<section><strong>一次性安装 Token</strong><div className="secret-box">{view.token}</div><small>有效期至 {formatDate(view.expiresAt)}。关闭窗口后不再显示。</small></section></div>; }
function message(value: unknown, fallback: string) { return value instanceof Error ? value.message : fallback; }

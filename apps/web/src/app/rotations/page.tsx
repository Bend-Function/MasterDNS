"use client";

import type { RotationPolicyInput } from "@masterdns/contracts/rotation";
import { ExternalLink, RefreshCw, RotateCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { RotationPolicyForm } from "../../components/rotation-policy-form";
import { RotationMachines, type RotationSelection } from "../../components/rotation-machines";
import { rotationSlotBlock } from "../../lib/rotation-machines";
import { Button, Dialog, EmptyState, IconButton, LoadingState, MetricStrip, PageHeader, StatusBadge } from "../../components/ui";
import { api, ApiError, jsonBody, UI_PREVIEW } from "../../lib/api";
import { cloudTargetAddresses, cloudTargetLabel, cloudErrorMessage, capabilityReason, cloudServiceLabel, rotationDowntimeNotice } from "../../lib/cloud-ui";
import { createRotationIntent } from "../../lib/rotation-action";
import { rotationLimitWait } from "../../lib/rotation-display";
import { demoRotations } from "../../lib/rotation-demo";
import type { RotationIncident, RotationPolicy } from "../../lib/rotation-types";
import { createRequestGeneration } from "../../lib/session-state";

type Selection = RotationSelection;

export default function RotationsPage() {
  const [incidents, setIncidents] = useState<RotationIncident[] | null>(UI_PREVIEW ? demoRotations : null);
  const [machineRefresh, setMachineRefresh] = useState(0);
  const [tab, setTab] = useState<"machines" | "history">("machines");
  const [updatedPolicy, setUpdatedPolicy] = useState<RotationPolicy | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loads = useRef(createRequestGeneration());
  const mutations = useRef(createRequestGeneration());
  const startIntent = useRef(createRotationIntent());

  const load = useCallback(async () => {
    const generation = loads.current.invalidate(); setError(null);
    if (UI_PREVIEW) { setIncidents(demoRotations); return; }
    try { const nextIncidents = await api<RotationIncident[]>("/v1/rotations"); if (loads.current.isCurrent(generation)) setIncidents(nextIncidents); }
    catch (value) { if (loads.current.isCurrent(generation)) setError(message(value, "轮换记录加载失败")); }
  }, []);
  useEffect(() => { if (UI_PREVIEW) return; const loadState = loads.current; const mutationState = mutations.current; let active = true; Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; loadState.invalidate(); mutationState.invalidate(); }; }, [load]);

  const close = () => { mutations.current.invalidate(); startIntent.current.cancel(); setSelection(null); setConfirmStart(false); setSaving(false); };
  const savePolicy = async (input: RotationPolicyInput) => {
    if (!selection) return; const generation = mutations.current.current(); setSaving(true); setError(null);
    try {
      const policy = UI_PREVIEW ? { ...selection.policy, ...input, revision: input.revision + 1 } : await api<RotationPolicy>(`/v1/rotation-policies/${selection.slot.slot.id}`, { method: "PATCH", ...jsonBody(input) });
      if (mutations.current.isCurrent(generation)) { setSelection({ ...selection, policy }); setUpdatedPolicy(policy); setSaving(false); }
    } catch (value) {
      if (!mutations.current.isCurrent(generation)) return;
      setSaving(false);
      if (value instanceof ApiError && value.status === 409) {
        const policy = UI_PREVIEW ? selection.policy : await api<RotationPolicy>(`/v1/rotation-policies?slotId=${encodeURIComponent(selection.slot.slot.id)}`);
        if (mutations.current.isCurrent(generation)) { setSelection({ ...selection, policy }); setUpdatedPolicy(policy); }
        throw new Error("策略已被其他操作更新，已载入最新 Revision");
      }
      throw value;
    }
  };
  const start = async () => {
    if (!selection) return; const block = rotationSlotBlock(selection.row, selection.slot); if (block) { setError(block); return; } const intent = startIntent.current.begin({ slotId: selection.slot.slot.id }); setSaving(true); setError(null);
    try {
      if (!UI_PREVIEW) await api("/v1/rotations", { method: "POST", headers: { "idempotency-key": intent.key }, ...jsonBody(intent.payload) });
      if (!startIntent.current.complete(intent)) return;
      close(); setMachineRefresh(current => current + 1); await load();
    } catch (value) { if (startIntent.current.isCurrent(intent)) { setSaving(false); setError(message(value, "手动轮换启动失败")); } }
  };
  const active = incidents?.filter((incident) => incident.status === "active").length ?? 0;
  const paused = incidents?.filter((incident) => incident.status === "paused").length ?? 0;
  const exhausted = incidents?.filter((incident) => incident.status === "exhausted").length ?? 0;
  return <ConsoleLayout><PageHeader title="IP 自动轮换" description="逐台查看机器地址、自动轮换开关与执行状态" />
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="tabs" role="tablist" aria-label="轮换视图"><button id="machines-tab" role="tab" aria-selected={tab === "machines"} aria-controls="machines-panel" className={tab === "machines" ? "active" : ""} onClick={() => setTab("machines")}>机器与策略</button><button id="history-tab" role="tab" aria-selected={tab === "history"} aria-controls="history-panel" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>轮换历史</button></div>
    <div id="machines-panel" role="tabpanel" aria-labelledby="machines-tab" hidden={tab !== "machines"}><RotationMachines onSelect={value => { mutations.current.invalidate(); setSelection(value); setError(null); }} updatedPolicy={updatedPolicy} editorOpen={selection !== null} refreshVersion={machineRefresh} incidents={incidents ?? []} /></div>
    <div id="history-panel" role="tabpanel" aria-labelledby="history-tab" hidden={tab !== "history"}>
    <div className="rotation-history-heading"><h2>轮换历史</h2><IconButton label="刷新轮换记录" onClick={() => void load()}><RefreshCw size={16} /></IconButton></div>
    <MetricStrip items={[{ label: "进行中", value: active, detail: "包含云端等待与候选复测" }, { label: "已暂停", value: paused, detail: "预算与授权保持不变" }, { label: "次数耗尽", value: exhausted, detail: "故障预算保持锁存" }, { label: "历史", value: incidents?.length ?? "-", detail: "最多显示最近 200 条" }]} />
    {incidents === null ? <div className="surface"><LoadingState /></div> : incidents.length === 0 ? <div className="surface"><EmptyState title="暂无轮换记录" action={<Button variant="secondary" onClick={() => setTab("machines")}>查看机器与策略</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>轮换事件</th><th>地址族</th><th>状态</th><th>阶段 / 等待原因</th><th>地址版本</th><th>下次处理</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{incidents.map((incident) => <tr key={incident.id}><td><Link className="table-primary" href={`/rotations/${incident.id}`}><strong>{incident.cloudTarget ? cloudTargetLabel(incident.cloudTarget) : shortId(incident.id)}</strong><small className="mono">{incident.cloudTarget ? cloudTargetAddresses(incident.cloudTarget) : shortId(incident.slotId)}</small></Link></td><td>IPv{incident.family}</td><td><StatusBadge value={incident.terminatedAt ? "terminated" : incident.status} /></td><td><div className="table-primary"><strong>{phaseLabel(incident.phase)}</strong><small>{waitingLabel(incident)}</small></div></td><td>Version {incident.addressVersion}</td><td><RelativeTime value={incident.nextRunAt} future /></td><td><RelativeTime value={incident.createdAt} /></td><td><Link className="icon-button" href={`/rotations/${incident.id}`} aria-label="查看轮换详情"><ExternalLink size={15} /></Link></td></tr>)}</tbody></table></div>}
    </div>
    <Dialog open={selection !== null} title={confirmStart ? "确认手动启动轮换" : selection ? selection.slot.cloudTarget ? `${cloudTargetLabel(selection.slot.cloudTarget)} · ${cloudTargetAddresses(selection.slot.cloudTarget)}` : `${selection.row.instance.name ?? selection.row.instance.externalId} · ${selection.slot.slot.name} / IPv${selection.slot.slot.family}` : "轮换策略"} size="large" onClose={() => { if (!saving) close(); }} footer={confirmStart ? <><Button variant="secondary" disabled={saving} onClick={() => { startIntent.current.cancel(); setConfirmStart(false); }}>返回</Button><Button variant="danger" icon={<RotateCw size={14} />} disabled={saving || !selection || rotationSlotBlock(selection.row, selection.slot) !== null} onClick={() => void start()}>{saving ? "提交中" : "确认启动"}</Button></> : <><Button variant="secondary" disabled={saving} onClick={close}>关闭</Button><Button variant="secondary" icon={<RotateCw size={14} />} disabled={saving || !selection?.policy.enabled || rotationSlotBlock(selection.row, selection.slot) !== null} onClick={() => { startIntent.current.cancel(); setConfirmStart(true); }}>手动启动</Button><Button type="submit" form="rotation-policy-form" disabled={saving}>{saving ? "保存中" : "保存策略"}</Button></>}>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {selection && (confirmStart ? <div className="danger-summary"><strong>本次操作可能修改真实云地址</strong><p>系统将复核当前管理授权、IPv{selection.slot.slot.family} 独立授权、外部健康证据和区域范围。新地址通过复测前不会发布 DNS；每次实际换址会消耗本次故障预算。</p>{rotationDowntimeNotice(selection.slot, true) && <p>{rotationDowntimeNotice(selection.slot, true)}</p>}<dl>{selection.slot.cloudTarget && <><dt>账号 / 实例</dt><dd>{cloudTargetLabel(selection.slot.cloudTarget)}</dd></>}<dt>云服务</dt><dd>{cloudServiceLabel(selection.row.instance.service)} · {selection.row.instance.region}</dd><dt>当前实际地址</dt><dd className="mono">{selection.slot.currentAddress?.address ?? "暂无观测数据"}</dd><dt>最大尝试</dt><dd>{selection.policy.maxAttempts} 次</dd><dt>旧云端 IP</dt><dd>接管完成且 DNS 缓存期限结束后自动释放，不保留备用</dd><dt>允许停止、启动或重启</dt><dd>{selection.row.authorization?.allowStopStart ? "已授权" : "未授权"}</dd></dl></div> : <RotationPolicyForm key={`${selection.slot.slot.id}:${selection.policy.revision}`} formId="rotation-policy-form" slot={selection.slot} authorization={selection.row.authorization} blockReason={rotationSlotBlock(selection.row, selection.slot)} policy={selection.policy} onSubmit={savePolicy} />)}
    </Dialog>
  </ConsoleLayout>;
}

function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function phaseLabel(value: RotationIncident["phase"]) { return ({ cloud: "云端换址", candidate: "候选复测", publish: "DNS 发布", cleanup: "资源清理", complete: "已完成" } as const)[value]; }
function waitingLabel(incident: RotationIncident) { if (incident.terminatedAt) return "已终止"; const limited = rotationLimitWait(incident, []); if (limited) return limited.label; if (incident.status === "paused") return "人工暂停，等待恢复"; if (incident.status === "exhausted") return "尝试次数已耗尽"; if (incident.errorCode) return capabilityReason(incident.errorCode); if (incident.phase === "candidate") return "等待固定外部 Cohort 复测"; if (incident.phase === "cloud") return "等待云端读取确认"; if (incident.phase === "publish") return "等待 DNS 写入与远端验证"; if (incident.phase === "cleanup") return "等待清理期限与归属复核"; return "无需等待"; }
function message(value: unknown, fallback: string) { return cloudErrorMessage(value, fallback); }

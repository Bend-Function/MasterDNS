"use client";

import type { RotationPolicyInput } from "@masterdns/contracts/rotation";
import { ExternalLink, Plus, RefreshCw, RotateCw, Settings2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { RotationPolicyForm } from "../../components/rotation-policy-form";
import { Button, Dialog, EmptyState, Field, IconButton, LoadingState, MetricStrip, PageHeader, StatusBadge } from "../../components/ui";
import { api, ApiError, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoCloudAccounts, demoCloudInstances, demoCloudSlots } from "../../lib/cloud-demo";
import type { AddressSlot, CloudAccount, CloudInstanceRow } from "../../lib/cloud-types";
import { cloudTargetAddresses, cloudTargetLabel, cloudErrorMessage, capabilityReason, cloudProviderLabels, cloudRotationBlock, cloudServiceLabel, rotationDowntimeNotice } from "../../lib/cloud-ui";
import { createRotationIntent } from "../../lib/rotation-action";
import { rotationLimitWait } from "../../lib/rotation-display";
import { demoRotationPolicy, demoRotations } from "../../lib/rotation-demo";
import type { RotationIncident, RotationPolicy } from "../../lib/rotation-types";
import { createRequestGeneration } from "../../lib/session-state";

type Selection = { row: CloudInstanceRow; slot: AddressSlot; policy: RotationPolicy };

export default function RotationsPage() {
  const [incidents, setIncidents] = useState<RotationIncident[] | null>(UI_PREVIEW ? demoRotations : null);
  const [accounts, setAccounts] = useState<CloudAccount[]>(UI_PREVIEW ? demoCloudAccounts : []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loads = useRef(createRequestGeneration());
  const mutations = useRef(createRequestGeneration());
  const startIntent = useRef(createRotationIntent());

  const load = useCallback(async () => {
    const generation = loads.current.invalidate(); setError(null);
    if (UI_PREVIEW) { setIncidents(demoRotations); setAccounts(demoCloudAccounts); return; }
    try { const [nextIncidents, nextAccounts] = await Promise.all([api<RotationIncident[]>("/v1/rotations"), api<CloudAccount[]>("/v1/cloud-accounts")]); if (loads.current.isCurrent(generation)) { setIncidents(nextIncidents); setAccounts(nextAccounts); } }
    catch (value) { if (loads.current.isCurrent(generation)) setError(message(value, "轮换记录加载失败")); }
  }, []);
  useEffect(() => { if (UI_PREVIEW) return; const loadState = loads.current; const mutationState = mutations.current; let active = true; Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; loadState.invalidate(); mutationState.invalidate(); }; }, [load]);

  const close = () => { mutations.current.invalidate(); startIntent.current.cancel(); setSelection(null); setPickerOpen(false); setConfirmStart(false); setSaving(false); };
  const savePolicy = async (input: RotationPolicyInput) => {
    if (!selection) return; const generation = mutations.current.current(); setSaving(true); setError(null);
    try {
      const policy = UI_PREVIEW ? { ...selection.policy, ...input, revision: input.revision + 1 } : await api<RotationPolicy>(`/v1/rotation-policies/${selection.slot.slot.id}`, { method: "PATCH", ...jsonBody(input) });
      if (mutations.current.isCurrent(generation)) { setSelection({ ...selection, policy }); setSaving(false); }
    } catch (value) {
      if (!mutations.current.isCurrent(generation)) return;
      setSaving(false);
      if (value instanceof ApiError && value.status === 409) {
        const policy = UI_PREVIEW ? selection.policy : await api<RotationPolicy>(`/v1/rotation-policies?slotId=${encodeURIComponent(selection.slot.slot.id)}`);
        if (mutations.current.isCurrent(generation)) setSelection({ ...selection, policy });
        throw new Error("策略已被其他操作更新，已载入最新 Revision");
      }
      throw value;
    }
  };
  const start = async () => {
    if (!selection) return; const block = cloudRotationBlock(selection.slot, selection.row.authorization); if (block) { setError(block); return; } const intent = startIntent.current.begin({ slotId: selection.slot.slot.id }); setSaving(true); setError(null);
    try {
      if (!UI_PREVIEW) await api("/v1/rotations", { method: "POST", headers: { "idempotency-key": intent.key }, ...jsonBody(intent.payload) });
      if (!startIntent.current.complete(intent)) return;
      close(); await load();
    } catch (value) { if (startIntent.current.isCurrent(intent)) { setSaving(false); setError(message(value, "手动轮换启动失败")); } }
  };
  const active = incidents?.filter((incident) => incident.status === "active").length ?? 0;
  const paused = incidents?.filter((incident) => incident.status === "paused").length ?? 0;
  const exhausted = incidents?.filter((incident) => incident.status === "exhausted").length ?? 0;
  return <ConsoleLayout><PageHeader title="IP 自动轮换" description="按地址族管理策略，并追踪候选复测、DNS 发布与清理" actions={<><Button icon={<Settings2 size={14} />} onClick={() => setPickerOpen(true)}>选择地址槽位</Button><IconButton label="刷新轮换记录" onClick={() => void load()}><RefreshCw size={16} /></IconButton></>} />
    <MetricStrip items={[{ label: "进行中", value: active, detail: "包含云端等待与候选复测" }, { label: "已暂停", value: paused, detail: "预算与授权保持不变" }, { label: "次数耗尽", value: exhausted, detail: "故障预算保持锁存" }, { label: "历史", value: incidents?.length ?? "-", detail: "最多显示最近 200 条" }]} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    {incidents === null ? <div className="surface"><LoadingState /></div> : incidents.length === 0 ? <div className="surface"><EmptyState title="暂无轮换记录" action={<Button icon={<Plus size={14} />} onClick={() => setPickerOpen(true)}>配置第一个槽位</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>轮换事件</th><th>地址族</th><th>状态</th><th>阶段 / 等待原因</th><th>地址版本</th><th>下次处理</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{incidents.map((incident) => <tr key={incident.id}><td><Link className="table-primary" href={`/rotations/${incident.id}`}><strong>{incident.cloudTarget ? cloudTargetLabel(incident.cloudTarget) : shortId(incident.id)}</strong><small className="mono">{incident.cloudTarget ? cloudTargetAddresses(incident.cloudTarget) : shortId(incident.slotId)}</small></Link></td><td>IPv{incident.family}</td><td><StatusBadge value={incident.terminatedAt ? "terminated" : incident.status} /></td><td><div className="table-primary"><strong>{phaseLabel(incident.phase)}</strong><small>{waitingLabel(incident)}</small></div></td><td>Version {incident.addressVersion}</td><td><RelativeTime value={incident.nextRunAt} future /></td><td><RelativeTime value={incident.createdAt} /></td><td><Link className="icon-button" href={`/rotations/${incident.id}`} aria-label="查看轮换详情"><ExternalLink size={15} /></Link></td></tr>)}</tbody></table></div>}
    <RotationTargetPicker open={pickerOpen} accounts={accounts} onClose={() => setPickerOpen(false)} onSelected={(value) => { setSelection(value); setPickerOpen(false); }} />
    <Dialog open={selection !== null} title={confirmStart ? "确认手动启动轮换" : selection ? selection.slot.cloudTarget ? `${cloudTargetLabel(selection.slot.cloudTarget)} · ${cloudTargetAddresses(selection.slot.cloudTarget)}` : `${selection.slot.slot.name} / IPv${selection.slot.slot.family}` : "轮换策略"} size="large" onClose={close} footer={confirmStart ? <><Button variant="secondary" disabled={saving} onClick={() => { startIntent.current.cancel(); setConfirmStart(false); }}>返回</Button><Button variant="danger" icon={<RotateCw size={14} />} disabled={saving || !selection || cloudRotationBlock(selection.slot, selection.row.authorization) !== null} onClick={() => void start()}>{saving ? "提交中" : "确认启动"}</Button></> : <><Button variant="secondary" onClick={close}>关闭</Button><Button variant="secondary" icon={<RotateCw size={14} />} disabled={saving || !selection?.policy.enabled || cloudRotationBlock(selection.slot, selection.row.authorization) !== null} onClick={() => { startIntent.current.cancel(); setConfirmStart(true); }}>手动启动</Button><Button type="submit" form="rotation-policy-form" disabled={saving}>{saving ? "保存中" : "保存策略"}</Button></>}>
      {selection && (confirmStart ? <div className="danger-summary"><strong>本次操作可能修改真实云地址</strong><p>系统将复核当前管理授权、IPv{selection.slot.slot.family} 独立授权、外部健康证据和区域范围。新地址通过复测前不会发布 DNS；每次实际换址会消耗本次故障预算。</p>{rotationDowntimeNotice(selection.slot, selection.row.authorization?.allowReleaseAddress === true) && <p>{rotationDowntimeNotice(selection.slot, selection.row.authorization?.allowReleaseAddress === true)}</p>}<dl>{selection.slot.cloudTarget && <><dt>账号 / 实例</dt><dd>{cloudTargetLabel(selection.slot.cloudTarget)}</dd></>}<dt>云服务</dt><dd>{cloudServiceLabel(selection.row.instance.service)} · {selection.row.instance.region}</dd><dt>当前实际地址</dt><dd className="mono">{selection.slot.currentAddress?.address ?? "暂无观测数据"}</dd><dt>最大尝试</dt><dd>{selection.policy.maxAttempts} 次</dd><dt>用户原有旧地址释放</dt><dd>{selection.row.authorization?.allowReleaseAddress ? "已授权" : "未授权"}</dd><dt>允许停止、启动或重启</dt><dd>{selection.row.authorization?.allowStopStart ? "已授权" : "未授权"}</dd></dl></div> : <RotationPolicyForm key={`${selection.slot.slot.id}:${selection.policy.revision}`} formId="rotation-policy-form" slot={selection.slot} authorization={selection.row.authorization} policy={selection.policy} onSubmit={savePolicy} />)}
    </Dialog>
  </ConsoleLayout>;
}

function RotationTargetPicker({ open, accounts, onClose, onSelected }: { open: boolean; accounts: CloudAccount[]; onClose: () => void; onSelected: (selection: Selection) => void }) {
  const [accountId, setAccountId] = useState(""); const [instances, setInstances] = useState<CloudInstanceRow[]>(UI_PREVIEW ? demoCloudInstances : []); const [instanceId, setInstanceId] = useState(""); const [slots, setSlots] = useState<AddressSlot[]>(UI_PREVIEW ? demoCloudSlots : []); const [slotId, setSlotId] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null); const generation = useRef(createRequestGeneration());
  useEffect(() => { if (!open) generation.current.invalidate(); }, [open]);
  const chooseAccount = async (id: string) => { setAccountId(id); setInstances([]); setInstanceId(""); setSlots([]); setSlotId(""); setError(null); if (!id) return; setLoading(true); const request = generation.current.invalidate(); try { const rows = UI_PREVIEW ? demoCloudInstances : await api<CloudInstanceRow[]>(`/v1/cloud-accounts/${id}/instances`); if (generation.current.isCurrent(request)) setInstances(rows); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "云实例加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } };
  const chooseInstance = async (id: string) => { setInstanceId(id); setSlots([]); setSlotId(""); setError(null); if (!id) return; setLoading(true); const request = generation.current.invalidate(); try { const rows = UI_PREVIEW ? demoCloudSlots : await api<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(id)}`); if (generation.current.isCurrent(request)) setSlots(rows); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "地址槽位加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } };
  const row = instances.find((item) => item.instance.id === instanceId); const slot = slots.find((item) => item.slot.id === slotId);
  const submit = async () => { if (!row || !slot) return; setLoading(true); setError(null); const request = generation.current.invalidate(); try { const policy = UI_PREVIEW ? { ...demoRotationPolicy, slotId: slot.slot.id } : await api<RotationPolicy>(`/v1/rotation-policies?slotId=${encodeURIComponent(slot.slot.id)}`); if (generation.current.isCurrent(request)) onSelected({ row, slot, policy }); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "轮换策略加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } };
  return <Dialog open={open} title="选择轮换地址槽位" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!slot || loading} onClick={() => void submit()}>打开策略</Button></>}><div className="policy-form">{error && <div className="inline-error">{error}</div>}<Field label="云账号"><select value={accountId} onChange={(event) => void chooseAccount(event.target.value)}><option value="">选择账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} / {cloudProviderLabels[account.provider]}</option>)}</select></Field><Field label="云实例"><select value={instanceId} disabled={!accountId} onChange={(event) => void chooseInstance(event.target.value)}><option value="">选择实例</option>{instances.map((item) => <option key={item.instance.id} value={item.instance.id}>{item.instance.name ?? item.instance.externalId} / {cloudServiceLabel(item.instance.service)} / {item.instance.region}</option>)}</select></Field><Field label="地址槽位"><select value={slotId} disabled={!instanceId} onChange={(event) => setSlotId(event.target.value)}><option value="">选择槽位</option>{slots.map((item) => <option key={item.slot.id} value={item.slot.id}>{item.cloudTarget ? `${cloudTargetLabel(item.cloudTarget)} · ${cloudTargetAddresses(item.cloudTarget)}` : `${item.slot.name} / IPv${item.slot.family} / ${item.currentAddress?.address ?? "暂无观测地址"}`}{item.capability?.available ? "" : " / 不可自动轮换"}</option>)}</select></Field>{slot && !slot.capability?.available && <div className="inline-warning">{capabilityReason(slot.capability?.reason)}</div>}{row && <div className="authorization-summary"><span>实例管理 <strong>{row.authorization?.managed ? "已授权" : "未授权"}</strong></span><span>IPv4 <strong>{row.authorization?.allowIpv4Rotation ? "已授权" : "关闭"}</strong></span><span>IPv6 <strong>{row.authorization?.allowIpv6Rotation ? "已授权" : "关闭"}</strong></span></div>}{loading && <LoadingState />}</div></Dialog>;
}

function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function phaseLabel(value: RotationIncident["phase"]) { return ({ cloud: "云端换址", candidate: "候选复测", publish: "DNS 发布", cleanup: "资源清理", complete: "已完成" } as const)[value]; }
function waitingLabel(incident: RotationIncident) { if (incident.terminatedAt) return "已终止"; const limited = rotationLimitWait(incident, []); if (limited) return limited.label; if (incident.status === "paused") return "人工暂停，等待恢复"; if (incident.status === "exhausted") return "尝试次数已耗尽"; if (incident.errorCode) return capabilityReason(incident.errorCode); if (incident.phase === "candidate") return "等待固定外部 Cohort 复测"; if (incident.phase === "cloud") return "等待云端读取确认"; if (incident.phase === "publish") return "等待 DNS 写入与远端验证"; if (incident.phase === "cleanup") return "等待清理期限与归属复核"; return "无需等待"; }
function message(value: unknown, fallback: string) { return cloudErrorMessage(value, fallback); }

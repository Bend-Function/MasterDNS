"use client";

import type { HealthCheckConfig } from "@masterdns/contracts";
import { Activity, ExternalLink, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { ProbePolicyForm } from "../../components/probe-policy-form";
import { RelativeTime } from "../../components/relative-time";
import { useSession } from "../../components/session-context";
import { Button, Dialog, EmptyState, Field, IconButton, LoadingState, MetricStrip, PageHeader, StatusBadge } from "../../components/ui";
import { api, ApiError, formatDate, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoCloudAccounts, demoCloudInstances, demoCloudSlots } from "../../lib/cloud-demo";
import type { AddressSlot, CloudAccount, CloudInstanceRow } from "../../lib/cloud-types";
import { demoPoolDetail, demoPools } from "../../lib/demo";
import { actualEndpointFamilies, reconcileEndpointFamily } from "../../lib/health-target";
import { demoHealthPolicies, demoProbeGroups, demoProbes, demoProbeRounds, demoProbeStats } from "../../lib/probe-demo";
import { consensusPreview, roundVoteRows } from "../../lib/probe-policy";
import type { AddressHealthPolicy, HealthConfigRow, HealthPolicyInput, ProbeAgent, ProbeGroup, ProbeObservationStat, ProbeRound } from "../../lib/probe-types";
import { createRequestGeneration } from "../../lib/session-state";
import type { Endpoint, Pool, PoolDetail } from "../../lib/types";

type PolicyTarget = { kind: "slot" | "endpoint"; id: string; family: "4" | "6"; label: string; poolId?: string; config?: HealthConfigRow | null; policy?: AddressHealthPolicy | null };

export default function HealthPage() {
  const { user } = useSession();
  const [policies, setPolicies] = useState<AddressHealthPolicy[] | null>(UI_PREVIEW ? demoHealthPolicies : null);
  const [probes, setProbes] = useState<ProbeAgent[]>(UI_PREVIEW ? demoProbes : []);
  const [groups, setGroups] = useState<ProbeGroup[]>(UI_PREVIEW ? demoProbeGroups : []);
  const [pools, setPools] = useState<Pool[]>(UI_PREVIEW ? demoPools : []);
  const [accounts, setAccounts] = useState<CloudAccount[]>(UI_PREVIEW ? demoCloudAccounts : []);
  const [error, setError] = useState<string | null>(null);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [evidence, setEvidence] = useState<{ policy: AddressHealthPolicy; rounds: ProbeRound[]; stats: ProbeObservationStat[] } | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const loadGeneration = useRef(createRequestGeneration());
  const mutationGeneration = useRef(createRequestGeneration());
  const evidenceGeneration = useRef(createRequestGeneration());

  const load = useCallback(async () => {
    const generation = loadGeneration.current.invalidate(); setError(null);
    if (UI_PREVIEW) { setPolicies(demoHealthPolicies); setProbes(demoProbes); setGroups(demoProbeGroups); setPools(demoPools); setAccounts(demoCloudAccounts); return; }
    try {
      const [nextPolicies, nextProbes, nextGroups, nextPools, nextAccounts] = await Promise.all([api<AddressHealthPolicy[]>("/v1/address-health-policies"), api<ProbeAgent[]>("/v1/probes"), api<ProbeGroup[]>("/v1/probe-groups"), api<Pool[]>("/v1/pools"), api<CloudAccount[]>("/v1/cloud-accounts")]);
      if (loadGeneration.current.isCurrent(generation)) { setPolicies(nextPolicies); setProbes(nextProbes); setGroups(nextGroups); setPools(nextPools); setAccounts(nextAccounts); }
    } catch (value) { if (loadGeneration.current.isCurrent(generation)) setError(message(value, "健康策略加载失败")); }
  }, []);
  useEffect(() => { if (UI_PREVIEW) return; const loadState = loadGeneration.current; const mutationState = mutationGeneration.current; const evidenceState = evidenceGeneration.current; let active = true; Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; loadState.invalidate(); mutationState.invalidate(); evidenceState.invalidate(); }; }, [load]);

  const beginEdit = (policy: AddressHealthPolicy) => setEditing({ kind: policy.slotId ? "slot" : "endpoint", id: policy.slotId ?? policy.endpointId!, family: policy.family, label: `${policy.slotId ? "云槽位" : "节点"} ${shortId(policy.slotId ?? policy.endpointId!)}`, config: policy.config, policy });
  const closeEditor = () => { mutationGeneration.current.invalidate(); setEditing(null); setSaving(false); };
  const save = async ({ config, policy }: { config: HealthCheckConfig; policy: HealthPolicyInput }) => {
    if (!editing) return;
    const generation = mutationGeneration.current.current(); setSaving(true);
    try {
      let configId = editing.config?.id ?? "";
      if (editing.kind === "slot") {
        const saved = UI_PREVIEW ? { ...(editing.config ?? demoHealthPolicies[0]!.config!), config, id: configId || "preview-config", revision: (editing.config?.revision ?? 0) + 1 } : await api<HealthConfigRow>(`/v1/address-slots/${editing.id}/health-config`, { method: "PUT", ...jsonBody({ config, ...(editing.config ? { expectedRevision: editing.config.revision } : {}) }) });
        configId = saved.id;
      } else if (!configId) {
        if (!editing.poolId) throw new Error("无法确定节点所属 Pool");
        const saved = UI_PREVIEW ? { ...demoHealthPolicies[0]!.config!, id: "preview-endpoint-config", endpointId: editing.id, slotId: null, config } : await api<HealthConfigRow>(`/v1/pools/${editing.poolId}/endpoints/${editing.id}/checks`, { method: "POST", ...jsonBody({ config }) });
        configId = saved.id;
      }
      if (!mutationGeneration.current.isCurrent(generation)) return;
      if (!UI_PREVIEW) await api("/v1/address-health-policies", { method: "PUT", ...jsonBody({ ...policy, configId }) });
      if (!mutationGeneration.current.isCurrent(generation)) return;
      mutationGeneration.current.invalidate(); setEditing(null); setSaving(false); await load();
    } catch (value) {
      if (!mutationGeneration.current.isCurrent(generation)) return;
      setSaving(false);
      if (value instanceof ApiError && value.status === 409) { mutationGeneration.current.invalidate(); setEditing(null); setSaving(false); await load(); setError("配置已被其他操作更新，编辑窗口已关闭，请重新打开最新 Revision"); return; }
      throw value;
    }
  };

  const openEvidence = async (policy: AddressHealthPolicy) => {
    const generation = evidenceGeneration.current.invalidate(); setEvidenceLoading(true); setEvidence({ policy, rounds: [], stats: [] });
    try {
      const [rounds, stats] = UI_PREVIEW ? [demoProbeRounds, demoProbeStats] : await Promise.all([api<ProbeRound[]>(`/v1/address-health-policies/${policy.id}/rounds`), api<ProbeObservationStat[]>(`/v1/address-health-policies/${policy.id}/stats`)]);
      if (evidenceGeneration.current.isCurrent(generation)) setEvidence({ policy, rounds, stats });
    } catch (value) { if (evidenceGeneration.current.isCurrent(generation)) setError(message(value, "投票明细加载失败")); }
    finally { if (evidenceGeneration.current.isCurrent(generation)) setEvidenceLoading(false); }
  };

  const configured = policies?.length ?? 0;
  const healthy = policies?.filter((policy) => policy.state?.healthState === "healthy").length ?? 0;
  const unknown = policies?.filter((policy) => !policy.state || policy.state.healthState === "unknown").length ?? 0;
  return <ConsoleLayout><PageHeader title="健康检查" description="本地与固定外部 Cohort 的 HTTP、HTTPS 和 TCP 检查" actions={<><Button icon={<Plus size={14} />} onClick={() => setTargetPickerOpen(true)}>配置地址策略</Button><IconButton label="刷新健康状态" onClick={() => void load()}><RefreshCw size={16} /></IconButton></>} />
    <MetricStrip items={[{ label: "地址策略", value: configured, detail: "按 IPv4 / IPv6 独立" }, { label: "健康", value: healthy, detail: "已达到连续成功阈值" }, { label: "未知", value: unknown, detail: "不会计为失败" }, { label: "外部探测点", value: probes.filter((probe) => probe.enabled).length, detail: `${groups.length} 个固定组` }]} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    {policies === null ? <div className="surface"><LoadingState /></div> : <><section className="surface"><header className="surface-header"><div><h2>地址健康策略</h2><p>云槽位必须保留外部探测权威</p></div><Activity size={16} /></header>{policies.length === 0 ? <EmptyState title="尚未配置地址健康策略" /> : <div className="table-wrap"><table><thead><tr><th>目标</th><th>地址族</th><th>状态</th><th>最近决策</th><th>Cohort / 语义</th><th>阈值</th><th>证据有效期</th><th aria-label="操作" /></tr></thead><tbody>{policies.map((policy) => { const group = groups.find((candidate) => candidate.id === policy.groupId); const size = policy.mode === "local" ? 1 : (group?.memberIds.length ?? 0) + (policy.mode === "mixed" ? 1 : 0); const preview = consensusPreview(policy.consensus, size); return <tr key={policy.id}><td><button className="table-link" onClick={() => beginEdit(policy)}><strong>{policy.slotId ? "云地址槽位" : "普通节点"}</strong><small className="mono">{shortId(policy.slotId ?? policy.endpointId!)}</small></button></td><td>IPv{policy.family}</td><td><StatusBadge value={policy.state?.healthState ?? "unknown"} /></td><td><StatusBadge value={policy.state?.latestDecision ?? "unknown"} /></td><td><div className="table-primary"><strong>{group?.name ?? (policy.mode === "local" ? "本地" : "探测组不可用")}</strong><small>{size} 票 · Q={policy.consensus.minimumValid}{preview.failureVotesRequired === null ? " · 指定点" : ` · F>=${preview.failureVotesRequired} · S>=${preview.successVotesRequired}`}</small></div></td><td>{policy.failureThreshold} 次失败 / {policy.successThreshold} 次成功</td><td><RelativeTime value={policy.state?.evidenceExpiresAt} future /></td><td><div className="row-actions"><Button variant="ghost" onClick={() => void openEvidence(policy)}>投票明细</Button><IconButton label="编辑策略" onClick={() => beginEdit(policy)}><ExternalLink size={15} /></IconButton></div></td></tr>; })}</tbody></table></div>}</section>
      <section className="surface"><header className="surface-header"><div><h2>Pool 检查概览</h2><p>原有本地健康检查与地址策略并行显示</p></div></header><div className="table-wrap"><table><thead><tr><th>Pool</th><th>状态</th><th>健康节点</th><th>间隔</th><th>最近协调</th><th aria-label="操作" /></tr></thead><tbody>{pools.map((pool) => <tr key={pool.id}><td><Link className="table-primary" href={`/pools/${pool.id}`}><strong>{pool.name}</strong><small>{pool.strategy}</small></Link></td><td><StatusBadge value={pool.enabled ? pool.state : "disabled"} /></td><td>{pool.healthyEndpointCount ?? 0} / {pool.endpointCount ?? 0}</td><td>{pool.checkIntervalSeconds}s</td><td><RelativeTime value={pool.lastReconciledAt} /></td><td><Link className="icon-button" href={`/pools/${pool.id}`} aria-label="打开 Pool"><ExternalLink size={15} /></Link></td></tr>)}</tbody></table></div></section></>}
    <HealthTargetPicker open={targetPickerOpen} accounts={accounts} pools={pools} policies={policies ?? []} onClose={() => setTargetPickerOpen(false)} onSelected={(target) => { setTargetPickerOpen(false); setEditing(target); }} />
    <Dialog open={editing !== null} title={editing ? `${editing.policy ? "编辑" : "配置"} ${editing.label} / IPv${editing.family}` : "配置健康策略"} size="large" onClose={closeEditor} footer={<><Button variant="secondary" disabled={saving} onClick={closeEditor}>取消</Button><Button type="submit" form="health-policy-form" disabled={saving}>{saving ? "保存中" : "保存配置"}</Button></>}>{editing && <ProbePolicyForm key={`${editing.kind}:${editing.id}:${editing.family}:${editing.policy?.revision ?? 0}`} formId="health-policy-form" targetKind={editing.kind} targetId={editing.id} family={editing.family} policy={editing.policy} config={editing.config} groups={groups} probes={probes} isAdmin={user?.role === "admin"} onSubmit={save} />}</Dialog>
    <Dialog open={evidence !== null} title="固定 Cohort 投票明细" size="large" onClose={() => { evidenceGeneration.current.invalidate(); setEvidence(null); }} footer={<Button variant="secondary" onClick={() => setEvidence(null)}>关闭</Button>}>{evidenceLoading ? <LoadingState /> : evidence && <EvidenceView evidence={evidence} probes={probes} />}</Dialog>
  </ConsoleLayout>;
}

function HealthTargetPicker({ open, accounts, pools, policies, onClose, onSelected }: { open: boolean; accounts: CloudAccount[]; pools: Pool[]; policies: AddressHealthPolicy[]; onClose: () => void; onSelected: (target: PolicyTarget) => void }) {
  const [kind, setKind] = useState<"slot" | "endpoint">("slot"); const [accountId, setAccountId] = useState(""); const [instances, setInstances] = useState<CloudInstanceRow[]>(UI_PREVIEW ? demoCloudInstances : []); const [instanceId, setInstanceId] = useState(""); const [slots, setSlots] = useState<AddressSlot[]>(UI_PREVIEW ? demoCloudSlots : []); const [slotId, setSlotId] = useState(""); const [poolId, setPoolId] = useState(""); const [poolDetail, setPoolDetail] = useState<PoolDetail | null>(UI_PREVIEW ? demoPoolDetail : null); const [endpointId, setEndpointId] = useState(""); const [family, setFamily] = useState<"4" | "6">("4"); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null); const generation = useRef(createRequestGeneration());
  useEffect(() => { if (!open) generation.current.invalidate(); }, [open]);
  const chooseAccount = async (id: string) => { setAccountId(id); setInstanceId(""); setSlotId(""); setSlots([]); setLoading(Boolean(id)); setError(null); if (!id) return; const request = generation.current.invalidate(); try { const rows = UI_PREVIEW ? demoCloudInstances : await api<CloudInstanceRow[]>(`/v1/cloud-accounts/${id}/instances`); if (generation.current.isCurrent(request)) setInstances(rows); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "实例加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } };
  const chooseInstance = async (id: string) => { setInstanceId(id); setSlotId(""); setSlots([]); setLoading(Boolean(id)); setError(null); if (!id) return; const request = generation.current.invalidate(); try { const rows = UI_PREVIEW ? demoCloudSlots : await api<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(id)}`); if (generation.current.isCurrent(request)) setSlots(rows); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "地址槽位加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } };
  const choosePool = async (id: string) => { setPoolId(id); setEndpointId(""); setPoolDetail(null); setLoading(Boolean(id)); setError(null); if (!id) return; const request = generation.current.invalidate(); try { const detail = UI_PREVIEW ? demoPoolDetail : await api<PoolDetail>(`/v1/pools/${id}`); if (generation.current.isCurrent(request)) setPoolDetail(detail); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "Pool 节点加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } };
  const slot = slots.find((entry) => entry.slot.id === slotId); const endpointCandidate = poolDetail?.endpoints.find((entry) => entry.id === endpointId); const endpointFamilies = endpointCandidate ? actualEndpointFamilies(endpointCandidate) : []; const selectedFamily = endpointCandidate ? reconcileEndpointFamily(family, endpointCandidate) : null; const endpoint = selectedFamily ? endpointCandidate : undefined; const endpointConfig = poolDetail?.healthChecks.find((check) => check.endpointId === endpointId) as HealthConfigRow | undefined;
  const submit = async () => { if (kind === "slot" && slot) { setLoading(true); setError(null); const request = generation.current.invalidate(); try { const policy = policies.find((item) => item.slotId === slot.slot.id) ?? null; const config = policy?.config ?? (UI_PREVIEW ? null : await api<HealthConfigRow | null>(`/v1/address-slots/${slot.slot.id}/health-config`)); if (generation.current.isCurrent(request)) onSelected({ kind, id: slot.slot.id, family: slot.slot.family, label: slot.slot.name, config, policy }); } catch (value) { if (generation.current.isCurrent(request)) setError(message(value, "健康配置加载失败")); } finally { if (generation.current.isCurrent(request)) setLoading(false); } return; } if (kind === "endpoint" && endpoint && selectedFamily && poolDetail) { const policy = policies.find((item) => item.endpointId === endpoint.id && item.family === selectedFamily) ?? null; onSelected({ kind, id: endpoint.id, family: selectedFamily, label: `${poolDetail.pool.name} / ${endpoint.name}`, poolId: poolDetail.pool.id, config: policy?.config ?? endpointConfig ?? null, policy }); } };
  return <Dialog open={open} title="选择健康目标" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={kind === "slot" ? !slot : !endpoint} onClick={submit}>继续配置</Button></>}><div className="policy-form">
    <div className="segmented"><button type="button" className={kind === "slot" ? "active" : ""} onClick={() => setKind("slot")}>云地址槽位</button><button type="button" className={kind === "endpoint" ? "active" : ""} onClick={() => setKind("endpoint")}>普通节点</button></div>
    {error && <div className="inline-error">{error}</div>}
    {kind === "slot" ? <><Field label="云账号"><select value={accountId} onChange={(event) => void chooseAccount(event.target.value)}><option value="">选择账号</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="云实例"><select value={instanceId} disabled={!accountId} onChange={(event) => void chooseInstance(event.target.value)}><option value="">选择实例</option>{instances.map((item) => <option key={item.instance.id} value={item.instance.id}>{item.instance.name ?? item.instance.externalId} / {item.instance.region}</option>)}</select></Field><Field label="地址槽位"><select value={slotId} disabled={!instanceId} onChange={(event) => setSlotId(event.target.value)}><option value="">选择槽位</option>{slots.map((entry) => <option key={entry.slot.id} value={entry.slot.id}>{entry.slot.name} / IPv{entry.slot.family} / {entry.currentAddress?.address ?? "暂无观测地址"}</option>)}</select></Field></> : <><Field label="Pool"><select value={poolId} onChange={(event) => void choosePool(event.target.value)}><option value="">选择 Pool</option>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></Field><Field label="普通节点"><select value={endpointId} disabled={!poolId} onChange={(event) => setEndpointId(event.target.value)}><option value="">选择节点</option>{poolDetail?.endpoints.filter((item) => item.addressMode !== ("cloud" as Endpoint["addressMode"])).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="地址族"><select value={selectedFamily ?? ""} disabled={!endpointCandidate || endpointFamilies.length === 0} onChange={(event) => setFamily(event.target.value as "4" | "6")}>{endpointFamilies.length === 0 && <option value="">{endpointCandidate ? "没有当前地址" : "请先选择节点"}</option>}{endpointFamilies.map((value) => <option key={value} value={value}>IPv{value}</option>)}</select></Field></>}
    {loading && <LoadingState />}
  </div></Dialog>;
}

function EvidenceView({ evidence, probes }: { evidence: { policy: AddressHealthPolicy; rounds: ProbeRound[]; stats: ProbeObservationStat[] }; probes: ProbeAgent[] }) { return <div className="evidence-view">
  {!!evidence.policy.states?.length && <section><h3>当前与候选地址</h3><div className="vote-grid">{evidence.policy.states.map(state => <div key={state.id}><strong>{state.addressRole === "current" ? "当前地址" : "候选地址"}</strong><span className="mono">{state.address}</span><StatusBadge value={state.healthState} /><small>{state.consecutiveFailures} 次失败 / {state.consecutiveSuccesses} 次成功</small></div>)}</div></section>}
  <div className="vote-preview"><strong>有效结果门槛 Q={evidence.policy.consensus.minimumValid}</strong><span>unknown 与 unavailable 不会转成 failure；截止时按轮次固定成员计算。</span></div>
  <section><h3>最近轮次</h3>{evidence.rounds.length === 0 ? <EmptyState title="暂无轮次证据" /> : evidence.rounds.slice(0, 20).map((round) => <div className="round-block" key={round.id}><header><span>#{round.sequence} · <span className="mono">{round.address}</span></span><StatusBadge value={round.consensusResult ?? "unknown"} /></header><div className="vote-grid">{roundVoteRows(round).map((vote) => <div key={vote.id}><strong>{vote.source === "local" ? "本地检查" : probes.find((probe) => probe.id === vote.id)?.name ?? shortId(vote.id)}</strong><StatusBadge value={vote.outcome} /><small>{vote.outcome === "unknown" ? "截止前未收到有效结果" : vote.outcome === "unavailable" ? "探测能力或网络不可用" : vote.source === "local" ? `本地结果 · ${formatDate(vote.receivedAt)}` : `${Math.round(vote.latencyMs ?? 0)} ms${vote.statusCode ? ` · HTTP ${vote.statusCode}` : ""}`}</small></div>)}</div></div>)}</section>
  <section><h3>聚合统计</h3><div className="table-wrap"><table><thead><tr><th>探测点</th><th>周期</th><th>样本</th><th>成功</th><th>不可用</th><th>平均延迟</th><th>开始</th></tr></thead><tbody>{evidence.stats.slice(0, 50).map((stat) => <tr key={stat.id}><td>{probes.find((probe) => probe.id === stat.probeId)?.name ?? shortId(stat.probeId)}</td><td>{stat.period === "hour" ? "小时" : "天"}</td><td>{stat.sampleCount}</td><td>{stat.successCount}</td><td>{stat.unavailableCount}</td><td>{stat.averageLatencyMs === null ? "-" : `${Math.round(stat.averageLatencyMs)} ms`}</td><td>{formatDate(stat.bucketStart)}</td></tr>)}</tbody></table></div></section>
</div>; }
function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function message(value: unknown, fallback: string) { return value instanceof Error ? value.message : fallback; }

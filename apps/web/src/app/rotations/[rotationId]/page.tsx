"use client";

import { ArrowLeft, Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleLayout } from "../../../components/console-layout";
import { RelativeTime } from "../../../components/relative-time";
import { Button, Dialog, EmptyState, ErrorState, LoadingState, StatusBadge } from "../../../components/ui";
import { api, ApiError, formatDate, jsonBody, UI_PREVIEW } from "../../../lib/api";
import { createRotationIntent, parseRotationResumeIntent, rotationResumeScope } from "../../../lib/rotation-action";
import { demoRotationDetail, demoRotationPolicy } from "../../../lib/rotation-demo";
import type { RotationDetail, RotationPolicy } from "../../../lib/rotation-types";
import { createRequestGeneration } from "../../../lib/session-state";

export default function RotationDetailPage() {
  const { rotationId } = useParams<{ rotationId: string }>();
  const [detail, setDetail] = useState<RotationDetail | null>(UI_PREVIEW ? demoRotationDetail : null);
  const [policy, setPolicy] = useState<RotationPolicy | null>(UI_PREVIEW ? demoRotationPolicy : null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"pause" | "resume" | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const loadGeneration = useRef(createRequestGeneration());
  const mutationGeneration = useRef(createRequestGeneration());
  const resumeIntent = useRef(createRotationIntent());
  const load = useCallback(async () => { const generation = loadGeneration.current.invalidate(); setLoading(true); setError(null); try { const next = UI_PREVIEW ? demoRotationDetail : await api<RotationDetail>(`/v1/rotations/${rotationId}`); const nextPolicy = UI_PREVIEW ? demoRotationPolicy : await api<RotationPolicy>(`/v1/rotation-policies?slotId=${encodeURIComponent(next.incident.slotId)}`); if (loadGeneration.current.isCurrent(generation)) { setDetail(next); setPolicy(nextPolicy); } } catch (value) { if (loadGeneration.current.isCurrent(generation)) setError(value instanceof Error ? value.message : "轮换详情加载失败"); } finally { if (loadGeneration.current.isCurrent(generation)) setLoading(false); } }, [rotationId]);
  useEffect(() => { if (UI_PREVIEW) return; const loadState = loadGeneration.current; const mutationState = mutationGeneration.current; let active = true; Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; loadState.invalidate(); mutationState.invalidate(); }; }, [load]);
  const closeAction = () => { mutationGeneration.current.invalidate(); resumeIntent.current.cancel(); setAction(null); setActionPending(false); };
  const submitAction = async () => {
    if (!action) return;
    setActionPending(true); setError(null);
    if (action === "resume") {
      if (!policy) { setActionPending(false); setError("当前轮换策略不可用，无法确认新预算"); return; }
      const intent = resumeIntent.current.begin(parseRotationResumeIntent({ expectedPolicyRevision: policy.revision }));
      try {
        if (!UI_PREVIEW) await api(`/v1/rotations/${rotationId}/resume`, { method: "POST", headers: { "idempotency-key": intent.key }, ...jsonBody(intent.payload) });
        if (!resumeIntent.current.complete(intent)) return;
        setAction(null); setActionPending(false); await load();
      } catch (value) {
        if (!resumeIntent.current.isCurrent(intent)) return;
        setActionPending(false);
        if (value instanceof ApiError && value.status === 409) { resumeIntent.current.cancel(); setAction(null); await load(); setError("轮换策略已变化，恢复未创建新预算，请按最新策略重新确认"); return; }
        setError(value instanceof Error ? value.message : "轮换恢复失败");
      }
      return;
    }
    const generation = mutationGeneration.current.current();
    try { if (!UI_PREVIEW) await api(`/v1/rotations/${rotationId}/pause`, { method: "POST" }); if (!mutationGeneration.current.isCurrent(generation)) return; setAction(null); setActionPending(false); await load(); }
    catch (value) { if (mutationGeneration.current.isCurrent(generation)) { setActionPending(false); setError(value instanceof Error ? value.message : "轮换暂停失败"); } }
  };
  if (loading) return <ConsoleLayout><LoadingState /></ConsoleLayout>;
  if (error && !detail) return <ConsoleLayout><ErrorState message={error} onRetry={() => void load()} /></ConsoleLayout>;
  if (!detail) return <ConsoleLayout><ErrorState message="轮换记录不存在" /></ConsoleLayout>;
  const { incident, addresses } = detail; const currentSegment = detail.segments.find((segment) => segment.id === incident.currentSegmentId) ?? detail.segments.at(-1); const currentAttempt = detail.attempts.find((attempt) => attempt.id === incident.currentAttemptId); const resumeScope = policy ? rotationResumeScope(policy, currentSegment, currentAttempt) : null;
  return <ConsoleLayout><div className="detail-header"><div className="detail-title"><Link className="icon-button" href="/rotations" aria-label="返回轮换记录"><ArrowLeft size={17} /></Link><div><h1>轮换 {shortId(incident.id)}</h1><p>IPv{incident.family} · 地址 Version {incident.addressVersion} · {phaseLabel(incident.phase)}</p></div></div><div className="detail-actions">{incident.status === "active" && <Button variant="secondary" icon={<Pause size={14} />} onClick={() => setAction("pause")}>暂停</Button>}{["paused", "exhausted"].includes(incident.status) && <Button icon={<Play size={14} />} disabled={!policy} onClick={() => { resumeIntent.current.cancel(); setAction("resume"); }}>恢复执行</Button>}<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>刷新</Button></div></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <section className="address-ledger"><div><span>云端实际观察</span><strong className="mono">{addresses.observedCloud.addresses.length ? addresses.observedCloud.addresses.join(" · ") : "暂无观测数据"}</strong><small>{addresses.observedCloud.observedAt ? `${addresses.observedCloud.source === "inventory" ? "清单" : "轮换读取"} · ${formatDate(addresses.observedCloud.observedAt)}` : "尚无可信云端观察"}</small></div><div><span>当前候选</span><strong className="mono">{addresses.candidate?.address ?? "暂无候选"}</strong><small>{addresses.candidate ? `Version ${addresses.candidate.version} · ${addresses.candidate.verified ? "已通过外部复测" : "待外部复测"}` : "尚未产生候选地址"}</small></div><div><span>最近已验证</span><strong className="mono">{addresses.lastVerified?.address ?? "暂无验证数据"}</strong><small>{addresses.lastVerified ? lastVerifiedLabel(addresses.lastVerified) : "未完成候选验证"}</small></div><div><span>已发布 DNS</span><strong>{addresses.published.length} 条记录</strong><small>{addresses.published.length ? "按远端观测逐条列出" : "尚未发布"}</small></div></section>
    <div className="content-grid"><div>
      <section className="surface"><header className="surface-header"><div><h2>DNS 发布记录</h2><p>不使用候选地址推断发布结果</p></div></header>{addresses.published.length === 0 ? <EmptyState title="尚无已发布 DNS 记录" /> : <div className="table-wrap"><table><thead><tr><th>记录</th><th>类型</th><th>发布地址</th><th>状态</th><th>远端观察</th></tr></thead><tbody>{addresses.published.map((entry) => <tr key={`${entry.zoneId}:${entry.fqdn}:${entry.recordType}:${entry.address}`}><td>{entry.fqdn}</td><td>{entry.recordType}</td><td className="mono">{entry.address}</td><td><StatusBadge value={entry.status} /></td><td>{formatDate(entry.lastObservedAt)}</td></tr>)}</tbody></table></div>}</section>
      {detail.publications.length > 0 && <section className="surface"><header className="surface-header"><div><h2>发布协调</h2><p>实际协调事件与 DNS Operation</p></div></header><div className="table-wrap"><table><thead><tr><th>地址版本</th><th>状态</th><th>协调事件</th><th>Operation</th><th>错误</th></tr></thead><tbody>{detail.publications.flatMap((publication) => publication.children.length ? publication.children.map((child) => <tr key={`${publication.id}:${child.poolId}`}><td>Version {publication.addressVersion}</td><td><StatusBadge value={publication.status} /></td><td className="mono">{shortId(child.eventId)}</td><td>{child.operationId ? <Link href={`/operations?id=${encodeURIComponent(child.operationId)}`} className="mono">{shortId(child.operationId)}</Link> : "-"}</td><td>{publication.errorCode ?? "-"}</td></tr>) : [<tr key={publication.id}><td>Version {publication.addressVersion}</td><td><StatusBadge value={publication.status} /></td><td>-</td><td>{publication.operationId ? <Link href={`/operations?id=${encodeURIComponent(publication.operationId)}`} className="mono">{shortId(publication.operationId)}</Link> : "-"}</td><td>{publication.errorCode ?? "-"}</td></tr>])}</tbody></table></div></section>}
      <section className="surface"><header className="surface-header"><div><h2>尝试与步骤</h2><p>云端写入只在读取验证后推进</p></div></header><div className="table-wrap"><table><thead><tr><th>尝试</th><th>状态</th><th>计入预算</th><th>候选版本</th><th>步骤状态</th><th>错误 / 重试</th></tr></thead><tbody>{detail.attempts.map((attempt) => { const steps = detail.steps.filter((step) => step.attemptId === attempt.id); return <tr key={attempt.id}><td>#{attempt.sequence}</td><td><StatusBadge value={attempt.status} /></td><td>{attempt.charged ? "是" : "否"}</td><td>{attempt.candidateVersion ? `Version ${attempt.candidateVersion}${attempt.candidateRepeated ? " · 重复" : ""}` : "-"}</td><td><div className="status-stack">{steps.map((step) => <span key={step.id}>#{step.sequence} <StatusBadge value={step.status} /></span>)}</div></td><td>{steps.map((step) => step.errorCode ?? (step.retryAt ? `重试 ${formatDate(step.retryAt)}` : null)).filter(Boolean).join(" · ") || "-"}</td></tr>; })}</tbody></table></div></section>
      <section className="surface"><header className="surface-header"><div><h2>地址资源与清理</h2><p>用户来源与系统来源分别保留归属</p></div></header><div className="table-wrap"><table><thead><tr><th>地址</th><th>角色</th><th>来源</th><th>清理状态</th><th>残留错误 / 步骤</th><th>最早清理</th></tr></thead><tbody>{detail.resources.map((resource) => <tr key={resource.id}><td className="mono">{resource.address}</td><td>{resource.role === "original" ? "原地址" : "候选地址"}</td><td>{resource.origin === "user" ? "用户" : "系统"}</td><td><StatusBadge value={resource.cleanupStatus} /></td><td><div className="table-primary"><strong>{resource.cleanupError ?? "-"}</strong>{resource.cleanupStepId && <small className="mono">{shortId(resource.cleanupStepId)}</small>}</div></td><td>{formatDate(resource.cleanupDueAt)}</td></tr>)}</tbody></table></div></section>
    </div>
      <aside><section className="surface"><header className="surface-header"><div><h2>执行状态</h2><p>当前等待原因与预算</p></div><StatusBadge value={incident.status} /></header><div className="surface-body detail-facts"><Info label="阶段" value={phaseLabel(incident.phase)} /><Info label="等待原因" value={waitingLabel(detail)} /><Info label="下次处理" value={<RelativeTime value={incident.nextRunAt} future />} /><Info label="候选截止" value={incident.candidateDeadline ? <RelativeTime value={incident.candidateDeadline} future /> : "-"} /><Info label="预算" value={currentSegment ? `${currentSegment.attemptsUsed} / ${currentSegment.maxAttempts}` : "暂无预算数据"} /><Info label="故障事件" value={incident.sourceEventId} mono /></div></section><section className="surface"><header className="surface-header"><div><h2>预算分段</h2><p>耗尽状态不会因重启刷新</p></div></header><ul className="compact-list">{detail.segments.map((segment, index) => <li key={segment.id}><div><strong>Segment {index + 1}</strong><small>{segment.attemptsUsed} / {segment.maxAttempts} 次 · {formatDate(segment.createdAt)}</small></div><StatusBadge value={segment.exhausted ? "exhausted" : "active"} /></li>)}</ul></section></aside></div>
    <Dialog open={action !== null} title={action === "pause" ? "确认暂停轮换" : "确认恢复轮换"} size="small" onClose={closeAction} footer={<><Button variant="secondary" disabled={actionPending} onClick={closeAction}>取消</Button><Button variant={action === "pause" ? "danger" : "primary"} disabled={actionPending || (action === "resume" && !resumeScope)} onClick={() => void submitAction()}>{actionPending ? "提交中" : action === "pause" ? "确认暂停" : "确认恢复"}</Button></>}>
      {action === "pause" ? <p className="confirm-copy">暂停只停止后续调度，不撤销已经完成的云端写入或 DNS 发布，也不会补回已消耗的尝试次数。</p> : resumeScope && <div className="danger-summary"><strong>恢复将创建新的预算 Segment</strong><p>新 Segment 按当前轮换策略获得 {resumeScope.newSegmentMaxAttempts} 次尝试，确认绑定 Policy Revision {resumeScope.expectedPolicyRevision}。当前 Segment 已使用 {resumeScope.currentSegmentAttemptsUsed} / {resumeScope.currentSegmentMaxAttempts} 次。</p>{resumeScope.finishesChargedAttemptFirst && <p>当前已计费的部分云端计划会先完成或确认结果；完成前新 Segment 保持等待，不会并行启动新的换址。</p>}<p>恢复时仍会复核授权、区域范围、云端观察和外部健康证据，不会重置实例授权开关。</p></div>}
    </Dialog>
  </ConsoleLayout>;
}

function Info({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) { return <div className="info-field"><span>{label}</span><strong className={mono ? "mono" : undefined}>{value}</strong></div>; }
function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function phaseLabel(value: RotationDetail["incident"]["phase"]) { return ({ cloud: "云端换址", candidate: "候选复测", publish: "DNS 发布", cleanup: "资源清理", complete: "已完成" } as const)[value]; }
function waitingLabel(detail: RotationDetail) { const incident = detail.incident; if (incident.status === "paused") return "人工暂停"; if (incident.status === "exhausted") return "本次故障尝试次数已耗尽"; if (incident.errorCode) return incident.errorCode; if (incident.phase === "cloud") return "等待云端读取确认"; if (incident.phase === "candidate") return addressesCandidate(detail); if (incident.phase === "publish") return "等待 DNS 写入与远端验证"; if (incident.phase === "cleanup") return "等待 TTL 与资源归属复核"; return "已完成"; }
function addressesCandidate(detail: RotationDetail) { return detail.addresses.candidate?.verified ? "候选已验证，等待推进" : "等待固定外部 Cohort 复测"; }
function lastVerifiedLabel(value: NonNullable<RotationDetail["addresses"]["lastVerified"]>) { if (value.cloudState === "released") return `Version ${value.version} · 历史验证证据 · 云端已释放`; if (value.cloudState === "not_observed") return `Version ${value.version} · 历史验证证据 · 当前云端未观察到`; return `Version ${value.version} · ${value.verifiedNow ? "当前验证有效" : "历史验证证据"}`; }

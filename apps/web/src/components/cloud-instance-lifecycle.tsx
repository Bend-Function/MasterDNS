"use client";

import type { CloudInstanceControlView, CloudLifecycleAction, CloudLifecycleOperation, CloudTrafficStopPolicy } from "@masterdns/contracts/cloud-lifecycle";
import { Activity, Play, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, formatDate, jsonBody, UI_PREVIEW } from "../lib/api";
import { demoCloudControlView } from "../lib/cloud-demo";
import {
  createLifecycleRequestGuard,
  createLifecyclePollLoop,
  lifecycleActionDisabledReason,
  lifecyclePolicyDraft,
  lifecycleStateDisabledReason,
  parseLifecyclePolicyInput,
  policyMutationDisabledReason,
  shouldPollLifecycle,
  validDeleteConfirmation,
  type LifecyclePolicyDraft,
} from "../lib/cloud-lifecycle";
import type { CloudAuthorization, CloudInstance } from "../lib/cloud-types";
import { capabilityReason } from "../lib/cloud-ui";
import { createIntentKey } from "../lib/intent-key";
import { Button, Dialog, Field, LoadingState, StatusBadge, Switch } from "./ui";

type LifecycleProps = {
  instance: CloudInstance;
  authorization: CloudAuthorization | null;
  accountEnabled: boolean;
  inScope: boolean;
  present: boolean;
  onChange: () => Promise<void>;
};

const actionLabels: Record<CloudLifecycleAction, string> = { start: "启动实例", stop: "停止实例", delete: "删除实例" };

export function CloudInstanceLifecycle({ instance, authorization, accountEnabled, inScope, present, onChange }: LifecycleProps) {
  const [control, setControl] = useState<CloudInstanceControlView | null>(UI_PREVIEW ? demoCloudControlView : null);
  const [draft, setDraft] = useState<LifecyclePolicyDraft>(() => policyDraft(UI_PREVIEW ? demoCloudControlView.policy : emptyPolicy(instance.id)));
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedAction, setSelectedAction] = useState<CloudLifecycleAction | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [busyAction, setBusyAction] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const loads = useRef(createLifecycleRequestGuard());
  const mutations = useRef(createLifecycleRequestGuard());
  const actionIntents = useRef({ start: createIntentKey(), stop: createIntentKey(), delete: createIntentKey() });
  const onChangeRef = useRef(onChange);
  const seenSucceeded = useRef<Set<string>>(new Set());
  const initializedOperations = useRef(false);
  const draftSourceRevision = useRef<number | null>(UI_PREVIEW ? demoCloudControlView.policy.revision : null);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const acceptControl = useCallback((next: CloudInstanceControlView) => {
    setControl(next);
    if (draftSourceRevision.current !== next.policy.revision) {
      draftSourceRevision.current = next.policy.revision;
      setDraft(policyDraft(next.policy));
    }
    const completed = next.operations.filter((operation) => operation.status === "succeeded" && (operation.action === "start" || operation.action === "stop"));
    if (!initializedOperations.current) {
      completed.forEach((operation) => seenSucceeded.current.add(operation.id));
      initializedOperations.current = true;
      return;
    }
    const changed = completed.some((operation) => {
      if (seenSucceeded.current.has(operation.id)) return false;
      seenSucceeded.current.add(operation.id);
      return true;
    });
    if (changed) void onChangeRef.current();
  }, []);

  const loadControl = useCallback(async (foreground = false) => {
    if (UI_PREVIEW) { setControl(demoCloudControlView); setLoading(false); return; }
    const token = loads.current.begin(instance.id);
    if (foreground) setLoading(true);
    try {
      const next = await api<CloudInstanceControlView>(`/v1/cloud-instances/${instance.id}/control`);
      if (!loads.current.isCurrent(token)) return;
      acceptControl(next);
      setError(null);
    } catch (value) {
      if (loads.current.isCurrent(token)) setError(value instanceof Error ? value.message : "实例控制状态加载失败");
    } finally {
      if (loads.current.isCurrent(token)) setLoading(false);
    }
  }, [acceptControl, instance.id]);

  useEffect(() => {
    const loadState = loads.current;
    const mutationState = mutations.current;
    loadState.invalidate();
    mutationState.invalidate();
    initializedOperations.current = false;
    draftSourceRevision.current = UI_PREVIEW ? demoCloudControlView.policy.revision : null;
    seenSucceeded.current.clear();
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      setSelectedAction(null);
      setDeleteConfirmation("");
      setNotice(null);
      if (UI_PREVIEW) {
        setControl(demoCloudControlView);
        setDraft(policyDraft(demoCloudControlView.policy));
        setLoading(false);
        return;
      }
      setControl(null);
      setDraft(policyDraft(emptyPolicy(instance.id)));
      setLoading(true);
      void loadControl();
    });
    return () => { active = false; loadState.invalidate(); mutationState.invalidate(); };
  }, [instance.id, loadControl]);

  useEffect(() => {
    if (UI_PREVIEW || !control || !shouldPollLifecycle(control.operations)) return;
    const poller = createLifecyclePollLoop(
      () => loadControl(),
      5_000,
      { set: (callback, delayMs) => window.setTimeout(callback, delayMs), clear: (handle) => window.clearTimeout(handle) },
    );
    poller.start();
    return poller.stop;
  }, [control, loadControl]);

  const actionReasons = useMemo(() => {
    const context = { accountEnabled, inScope, present };
    const reasons = {
      start: lifecycleActionDisabledReason("start", authorization, context),
      stop: lifecycleActionDisabledReason("stop", authorization, context),
      delete: lifecycleActionDisabledReason("delete", authorization, context),
    };
    if (control?.blocked) {
      const reason = lifecycleReason(control.blockReason) || "另一个云实例操作尚未完成";
      return { start: reason, stop: reason, delete: reason };
    }
    for (const action of ["start", "stop", "delete"] as const) {
      reasons[action] = lifecycleStateDisabledReason(action, instance.service, instance.state) ?? reasons[action];
    }
    return reasons;
  }, [accountEnabled, authorization, control, inScope, instance.service, instance.state, present]);

  const submitAction = async (action: CloudLifecycleAction) => {
    if (busyAction || savingPolicy || actionReasons[action]) return;
    if (action === "delete" && !validDeleteConfirmation(deleteConfirmation, instance.externalId)) return;
    setBusyAction(true); setError(null); setNotice(null);
    const token = mutations.current.begin(instance.id);
    const intent = actionIntents.current[action];
    try {
      if (UI_PREVIEW) {
        setNotice(`预览模式未执行“${actionLabels[action]}”云端操作`);
      } else {
        await api<CloudLifecycleOperation>(`/v1/cloud-instances/${instance.id}/actions`, {
          method: "POST",
          headers: { "Idempotency-Key": intent.current() },
          ...jsonBody({ action, ...(action === "delete" ? { confirmation: deleteConfirmation } : {}) }),
        });
        if (!mutations.current.isCurrent(token)) return;
        intent.reset();
        setNotice(`${actionLabels[action]}已排队，状态会自动更新`);
        await loadControl();
      }
      if (mutations.current.isCurrent(token)) {
        setSelectedAction(null);
        setDeleteConfirmation("");
      }
    } catch (value) {
      if (mutations.current.isCurrent(token)) setError(value instanceof Error ? value.message : `${actionLabels[action]}请求失败`);
    } finally {
      if (mutations.current.isCurrent(token)) setBusyAction(false);
    }
  };

  const savePolicy = async (event: FormEvent) => {
    event.preventDefault();
    if (!control || savingPolicy || busyAction) return;
    const policyReason = policyMutationDisabledReason(control.policy.enabled, draft.enabled, {
      accountEnabled, inScope, present, managed: Boolean(authorization?.managed), allowStopStart: Boolean(authorization?.allowStopStart),
    });
    if (policyReason) { setError(policyReason); return; }
    let payload;
    try { payload = parseLifecyclePolicyInput(draft); }
    catch (value) { setError(value instanceof Error ? value.message : "策略参数无效"); return; }
    setSavingPolicy(true); setError(null); setNotice(null);
    const token = mutations.current.begin(instance.id);
    try {
      if (UI_PREVIEW) {
        acceptControl({ ...control, policy: { ...control.policy, ...payload, revision: control.policy.revision + 1 } });
        setNotice("预览模式仅更新本页示例策略");
      } else {
        await api(`/v1/cloud-instances/${instance.id}/traffic-policy`, { method: "PATCH", ...jsonBody(payload) });
        if (!mutations.current.isCurrent(token)) return;
        await loadControl();
        setNotice(payload.enabled ? "月流量停机策略已保存" : "月流量停机策略已关闭；实例不会自动启动");
      }
    } catch (value) {
      if (mutations.current.isCurrent(token)) {
        if (value instanceof ApiError && value.status === 409) {
          setError("策略已被其他操作更新，已重新加载最新状态");
          await loadControl();
        } else setError(value instanceof Error ? value.message : "流量停机策略保存失败");
      }
    } finally {
      if (mutations.current.isCurrent(token)) setSavingPolicy(false);
    }
  };

  if (loading && !control) return <section className="surface"><LoadingState /></section>;

  const policyContext = { accountEnabled, inScope, present, managed: Boolean(authorization?.managed), allowStopStart: Boolean(authorization?.allowStopStart) };
  const policyReason = control ? policyMutationDisabledReason(control.policy.enabled, draft.enabled, policyContext) : "控制状态尚未加载";
  const policyFieldsDisabled = Boolean(policyMutationDisabledReason(false, true, policyContext));

  return <section className="surface lifecycle-control">
    <header className="surface-header"><div><h2>实例控制</h2><p>操作持久排队；云端状态以清单同步为准</p></div><Activity size={16} /></header>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <div className="inline-notice" role="status">{notice}</div>}
    <div className="surface-body lifecycle-actions">
      <LifecycleActionControls reasons={actionReasons} busy={busyAction || savingPolicy} onSelect={setSelectedAction} />
      <p className="muted">停止后不会自动重启。流量阈值触发、关闭策略或进入新月份也不会自动启动实例。</p>
      {control?.blocked && <p className="inline-warning">{lifecycleReason(control.blockReason) || "另一个实例操作尚未完成"}</p>}
    </div>
    {control && <>
      <form className="surface-body lifecycle-policy" onSubmit={savePolicy}>
        <div className="lifecycle-section-heading"><div><h3>月流量停机</h3><p>云指标存在发布延迟；首次观察到达到阈值后申请停止</p></div><Switch checked={draft.enabled} label="启用月流量停机" disabled={policyFieldsDisabled && !control.policy.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
        <div className="field-grid">
          <Field label="月流量阈值（GB）" hint="十进制 GB，1 GB = 1,000,000,000 字节"><input inputMode="decimal" value={draft.thresholdGigabytes} disabled={policyFieldsDisabled} onChange={(event) => setDraft({ ...draft, thresholdGigabytes: event.target.value })} placeholder="100" /></Field>
          <Field label="统计方向"><select value={draft.direction} disabled={policyFieldsDisabled} onChange={(event) => setDraft({ ...draft, direction: event.target.value as "total" | "outgoing" })}><option value="total">总流量（入站 + 出站）</option><option value="outgoing">仅出站流量</option></select></Field>
          <Field label="检查间隔（分钟）" hint="1–1440 分钟，默认 60"><input type="number" min={1} max={1440} step={1} value={draft.checkIntervalMinutes} disabled={policyFieldsDisabled} onChange={(event) => setDraft({ ...draft, checkIntervalMinutes: event.target.value })} /></Field>
        </div>
        {policyReason && <p className="inline-warning">{policyReason}</p>}
        <div className="lifecycle-policy-status">
          <Info label="本月用量" value={control.policy.lastUsageBytes === null ? "尚无可信数据" : `${decimalDisplay(control.policy.lastUsageBytes)} GB`} />
          <Info label="最近检查" value={control.policy.lastCheckedAt ? formatDate(control.policy.lastCheckedAt) : "尚未检查"} />
          <Info label="检查结果" value={control.policy.lastError ? lifecycleReason(control.policy.lastError) : control.policy.triggeredAt ? "已达到阈值并触发停机" : "未报告错误"} />
          <Info label="电源保持" value={powerHoldLabel(control.powerHold)} />
        </div>
        <Button type="submit" disabled={savingPolicy || busyAction || Boolean(policyReason)}>{savingPolicy ? "保存中" : draft.enabled ? "保存策略" : control.policy.enabled ? "关闭策略" : "保存策略"}</Button>
      </form>
      <div className="lifecycle-operations"><div className="lifecycle-section-heading"><div><h3>最近操作</h3><p>自动停机和人工操作使用同一持久队列</p></div></div><OperationHistory operations={control.operations} /></div>
    </>}
    <Dialog open={selectedAction !== null} title={selectedAction ? actionLabels[selectedAction] : "实例操作"} onClose={() => { if (!busyAction) { setSelectedAction(null); setDeleteConfirmation(""); } }} footer={selectedAction && selectedAction !== "delete" ? <><Button variant="secondary" disabled={busyAction} onClick={() => setSelectedAction(null)}>取消</Button><Button variant={selectedAction === "stop" ? "danger" : "primary"} disabled={busyAction} onClick={() => void submitAction(selectedAction)}>{busyAction ? "正在提交" : `确认${actionLabels[selectedAction]}`}</Button></> : undefined}>
      {selectedAction === "delete" ? <LifecycleDeleteConfirmation externalId={instance.externalId} value={deleteConfirmation} busy={busyAction} onChange={setDeleteConfirmation} onCancel={() => { setSelectedAction(null); setDeleteConfirmation(""); }} onConfirm={() => void submitAction("delete")} /> : selectedAction ? <div className="danger-summary"><strong>{selectedAction === "stop" ? "停止会中断实例上的服务" : "启动会修改真实云实例状态"}</strong><p>请求将进入持久操作队列。结果不确定时系统只观察，不会自动重复未知的云端写入。</p><dl><dt>远端实例</dt><dd className="mono">{instance.externalId}</dd><dt>当前状态</dt><dd>{instance.state ?? "unknown"}</dd></dl></div> : null}
    </Dialog>
  </section>;
}

export function LifecycleActionControls({ reasons, busy, onSelect }: { reasons: Record<CloudLifecycleAction, string | null>; busy: boolean; onSelect: (action: CloudLifecycleAction) => void }) {
  return <div className="lifecycle-action-buttons">
    <Button variant="secondary" icon={<Play size={14} />} disabled={busy || Boolean(reasons.start)} title={reasons.start ?? undefined} onClick={() => onSelect("start")}>启动实例</Button>
    <Button variant="secondary" icon={<Square size={14} />} disabled={busy || Boolean(reasons.stop)} title={reasons.stop ?? undefined} onClick={() => onSelect("stop")}>停止实例</Button>
    <Button variant="danger" icon={<Trash2 size={14} />} disabled={busy || Boolean(reasons.delete)} title={reasons.delete ?? undefined} onClick={() => onSelect("delete")}>删除实例</Button>
  </div>;
}

export function LifecycleDeleteConfirmation({ externalId, value, busy, onChange, onCancel, onConfirm }: { externalId: string; value: string; busy: boolean; onChange: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
  return <div className="danger-summary"><strong>此操作会删除真实云实例</strong><p>云厂商的原生删除行为可能删除随实例管理的磁盘与数据；独立资源（例如磁盘或公网 IP）也可能保留并继续收费。请在云厂商控制台核对。</p><p>输入完整远端 ID <strong className="mono">{externalId}</strong> 以确认。</p><Field label="远端实例 ID"><input autoComplete="off" spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} /></Field><div className="dialog-inline-actions"><Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button><Button variant="danger" disabled={busy || !validDeleteConfirmation(value, externalId)} onClick={onConfirm}>{busy ? "正在提交" : "确认删除实例"}</Button></div></div>;
}

function OperationHistory({ operations }: { operations: CloudLifecycleOperation[] }) {
  if (operations.length === 0) return <p className="surface-body muted">尚无生命周期操作。</p>;
  return <div className="table-wrap"><table><thead><tr><th>操作</th><th>来源</th><th>状态</th><th>时间</th><th>结果 / 重试</th></tr></thead><tbody>{operations.map((operation) => <tr key={operation.id}><td>{actionLabels[operation.action]}</td><td>{operation.source === "traffic" ? "自动流量策略" : "用户操作"}</td><td><StatusBadge value={operation.status} /></td><td>{formatDate(operation.updatedAt)}</td><td>{operationResult(operation)}</td></tr>)}</tbody></table></div>;
}

function policyDraft(policy: CloudTrafficStopPolicy): LifecyclePolicyDraft {
  return { revision: policy.revision, enabled: policy.enabled, direction: policy.direction, ...lifecyclePolicyDraft(policy) };
}

function emptyPolicy(instanceId: string): CloudTrafficStopPolicy {
  return { instanceId, revision: 0, enabled: false, thresholdBytes: null, direction: "total", checkIntervalSeconds: 3_600, month: null, lastUsageBytes: null, lastCheckedAt: null, lastError: null, triggeredAt: null };
}

function decimalDisplay(bytes: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(bytes / 1_000_000_000);
}

function lifecycleReason(reason: string | null): string {
  if (!reason) return "";
  const friendly = capabilityReason(reason);
  return friendly === reason ? reason : friendly;
}

function powerHoldLabel(value: CloudInstanceControlView["powerHold"]): string {
  return value === "manual_stop" ? "人工停止，保持关机" : value === "traffic_limit" ? "流量阈值触发，保持关机" : value === "deleted" ? "云实例已删除" : "无";
}

function operationResult(operation: CloudLifecycleOperation): string {
  const error = operation.errorCode ? lifecycleReason(operation.errorCode) : null;
  const retry = (operation.status === "queued" || operation.status === "in_flight") && operation.nextRunAt ? `下次处理 ${formatDate(operation.nextRunAt)}` : null;
  if (error || retry) return [error, retry].filter(Boolean).join(" · ");
  if (operation.status === "failed") return "操作失败";
  if (operation.status === "unknown") return "云端结果待人工确认，不会自动重复写入";
  if (operation.status === "cancelled") return "排队操作已取消";
  if (operation.status === "in_flight") return "已派发，正在观察云端状态";
  return operation.status === "queued" ? "等待执行" : "已完成";
}

function Info({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

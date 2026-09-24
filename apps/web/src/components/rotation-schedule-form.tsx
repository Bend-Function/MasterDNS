"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, formatDate, UI_PREVIEW } from "../lib/api";
import type { AddressSlot, CloudInstanceRow } from "../lib/cloud-types";
import { capabilityReason } from "../lib/cloud-ui";
import { previewRotationSchedule, previewScheduleRequest } from "../lib/rotation-schedule-demo";
import { createRotationScheduleEditor, scheduleSlotBlock, type ScheduleDraft, type ScheduleEditorState } from "../lib/rotation-schedule";
import type { RotationIncident } from "../lib/rotation-types";
import { Button, Field, LoadingState, Switch } from "./ui";

export function RotationScheduleEditor({ row, slot, incidents }: { row: CloudInstanceRow; slot: AddressSlot; incidents: RotationIncident[] }) {
  const [editor] = useState(() => createRotationScheduleEditor(slot.slot.id, UI_PREVIEW ? previewScheduleRequest : api, UI_PREVIEW ? previewRotationSchedule(slot.slot.id) : null));
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useEffect(() => { void editor.load(); return () => editor.cancel(); }, [editor]);
  return <RotationScheduleForm row={row} slot={slot} incidents={incidents} state={state} onEdit={editor.edit} onSave={editor.save} onResume={editor.resume} onReload={editor.load} />;
}

export function RotationScheduleForm({ row, slot, incidents, state, onEdit, onSave, onResume, onReload }: {
  row: CloudInstanceRow; slot: AddressSlot; incidents: RotationIncident[]; state: ScheduleEditorState;
  onEdit: (change: Partial<ScheduleDraft>) => void; onSave: () => Promise<void>; onResume: () => Promise<void>; onReload: () => Promise<void>;
}) {
  const { schedule, draft, pending, loading, error, notice } = state;
  const block = scheduleSlotBlock(row, slot, schedule);
  const lastId = schedule?.activeIncidentId ?? schedule?.lastHandledIncidentId;
  const last = incidents.find(incident => incident.id === lastId);
  const dirty = schedule && (draft.enabled !== schedule.enabled || draft.interval !== String(schedule.intervalMinutes));
  const busy = loading || pending;
  return <section className="rotation-schedule-section" aria-labelledby="rotation-schedule-heading">
    <div className="rotation-history-heading"><h2 id="rotation-schedule-heading">定时轮换</h2><Button type="button" variant="ghost" disabled={busy} onClick={() => void onReload()}>重新读取</Button></div>
    <p className="muted">按分钟启动，独立于故障自动轮换。沿用下方策略的尝试次数、等待、复测、DNS 和清理设置。</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <LoadingState /> : !schedule ? <p className="muted">日程状态未知，请重新读取。</p> : <form id="rotation-schedule-form" className="policy-form" onSubmit={event => { event.preventDefault(); if (!busy && (!draft.enabled || !block)) void onSave(); }}>
      <div className="switch-row policy-enable"><span><strong>定时轮换 IPv{slot.slot.family}</strong><small>{schedule.enabled ? schedule.pausedReason ? "日程已暂停" : schedule.activeIncidentId ? "已有任务，等待结束" : "日程已开启" : "日程已关闭"} · 每 {schedule.intervalMinutes} 分钟</small></span><Switch checked={draft.enabled} label={`定时轮换 IPv${slot.slot.family}`} disabled={busy || (!draft.enabled && block !== null)} onCheckedChange={enabled => onEdit({ enabled })} /></div>
      {block && <div className="inline-warning">{block}</div>}
      <Field label="轮换间隔（分钟）" hint="1–129600 个整数分钟，默认 1440 分钟（24 小时），最多 90 天。"><input aria-label="轮换间隔（分钟）" type="number" min={1} max={129600} step={1} value={draft.interval} disabled={busy} required onChange={event => onEdit({ interval: event.target.value })} /></Field>
      <dl className="detail-facts rotation-schedule-facts"><dt>下次执行</dt><dd>{!schedule.enabled ? "已关闭" : schedule.pausedReason ? "暂停期间不触发" : schedule.nextRunAt ? <time dateTime={schedule.nextRunAt} title={schedule.nextRunAt}>{formatDate(schedule.nextRunAt)}</time> : schedule.activeIncidentId ? "任务完成后重新计时" : "等待调度"}</dd><dt>最近任务</dt><dd>{lastId ? <Link href={`/rotations/${lastId}`}>{last?.terminatedAt ? "已终止" : last?.status === "paused" ? "任务已暂停" : last?.status === "exhausted" ? "次数耗尽" : last?.status === "complete" ? "已完成" : last?.status === "active" ? "执行中 / 等待处理" : "查看任务"}</Link> : "尚无任务"}</dd><dt>最近启动 / 完成</dt><dd>{formatDate(schedule.lastStartedAt)} / {formatDate(schedule.lastCompletedAt)}</dd></dl>
      {schedule.activeIncidentId && <p className="muted">即使显示的执行时间已过，已有任务未结束时也不会启动新的定时任务；请在任务详情中查看等待原因或暂停、恢复、终止任务。</p>}
      {schedule.pausedReason && <div className="inline-warning"><strong>日程暂停原因：{schedulePauseReason(schedule.pausedReason)}</strong><p>恢复日程会从现在重新计时，不会恢复旧任务。未结束的旧任务仍会阻止新任务启动。</p><Button type="button" variant="secondary" disabled={busy || !schedule.enabled || block !== null || Boolean(dirty)} onClick={() => void onResume()}>恢复日程</Button>{dirty && <small>请先保存定时设置，再恢复日程。</small>}</div>}
      <p className="muted">首次启用、重新启用、修改间隔或恢复后重新计时；相同配置保存不重置时间。间隔从上一次整个任务成功完成后开始计算（包括必要清理），不按任务开始时间计算。到期扫描通常有 0–10 秒延迟；关闭日程不会终止已启动的任务。</p>
      <div className="row-actions"><Button type="submit" disabled={busy || (draft.enabled && block !== null)}>{pending ? "保存中…" : "保存定时设置"}</Button>{dirty && <span className="muted">有未保存的定时更改</span>}</div>
    </form>}
  </section>;
}

function schedulePauseReason(reason: string) {
  return ({ manual_pause: "任务已人工暂停", rotation_paused: "关联任务已暂停", rotation_exhausted: "关联任务尝试次数耗尽", manual_terminated: "关联任务已终止" } as Record<string, string>)[reason] ?? capabilityReason(reason);
}

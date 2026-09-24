import { rotationScheduleResumeSchema, rotationScheduleUpdateSchema, type RotationSchedule } from "@masterdns/contracts/rotation";
import { ApiError, jsonBody } from "./api";
import type { AddressSlot, CloudInstanceRow } from "./cloud-types";
import { capabilityReason, cloudErrorMessage } from "./cloud-ui";
import { rotationSlotBlock } from "./rotation-machines";
import { createRequestGeneration } from "./session-state";

export type ScheduleDraft = { enabled: boolean; interval: string };
export type ScheduleEditorState = { schedule: RotationSchedule | null; draft: ScheduleDraft; loading: boolean; pending: boolean; error: string | null; notice: string | null };
export type ScheduleRequest = (path: string, init?: RequestInit) => Promise<RotationSchedule>;

export function parseScheduleInput(schedule: RotationSchedule, enabled: boolean, interval: string) {
  if (!/^\d+$/.test(interval.trim())) throw new Error("请输入 1–129600 之间的整数分钟");
  const parsed = rotationScheduleUpdateSchema.safeParse({ revision: schedule.revision, enabled, intervalMinutes: Number(interval) });
  if (!parsed.success) throw new Error("请输入 1–129600 之间的整数分钟");
  return parsed.data;
}

export function scheduleSlotBlock(row: CloudInstanceRow, slot: AddressSlot, schedule: RotationSchedule | null): string | null {
  if (slot.slot.family !== "4") return "定时轮换仅支持已支持的公网 IPv4 槽位";
  // An associated unfinished task blocks admission, not editing/resuming its schedule.
  const associated = schedule?.activeIncidentId && slot.blockedRotation?.incidentId === schedule.activeIncidentId;
  const capability = associated && slot.capability && ["rotation_in_progress", "rotation_uncertain"].includes(slot.capability.reason ?? "")
    ? { ...slot.capability, available: true }
    : slot.capability;
  return rotationSlotBlock(row, { ...slot, capability });
}

export function createRotationScheduleEditor(slotId: string, request: ScheduleRequest, initial: RotationSchedule | null = null) {
  let state: ScheduleEditorState = { schedule: initial, draft: { enabled: initial?.enabled ?? false, interval: String(initial?.intervalMinutes ?? 1440) }, loading: !initial, pending: false, error: null, notice: null };
  const generation = createRequestGeneration();
  const listeners = new Set<() => void>();
  const update = (change: Partial<ScheduleEditorState>) => { state = { ...state, ...change }; listeners.forEach(listener => listener()); };
  const accept = (schedule: RotationSchedule) => update({ schedule, draft: { enabled: schedule.enabled, interval: String(schedule.intervalMinutes) } });
  const path = `/v1/rotation-schedules/${encodeURIComponent(slotId)}`;
  const load = async () => {
    const token = generation.invalidate();
    update({ loading: true, pending: false, error: null, notice: null });
    try { const schedule = await request(path); if (generation.isCurrent(token)) accept(schedule); }
    catch (value) { if (generation.isCurrent(token)) update({ schedule: null, error: cloudErrorMessage(value, "日程读取失败，请重试") }); }
    finally { if (generation.isCurrent(token)) update({ loading: false }); }
  };
  const mutate = async (resume: boolean) => {
    if (!state.schedule || state.loading || state.pending) return;
    let input;
    try { input = resume ? rotationScheduleResumeSchema.parse({ revision: state.schedule.revision }) : parseScheduleInput(state.schedule, state.draft.enabled, state.draft.interval); }
    catch (value) { update({ error: cloudErrorMessage(value, "日程输入无效"), notice: null }); return; }
    const token = generation.invalidate();
    update({ pending: true, error: null, notice: null });
    try {
      const schedule = await request(resume ? `${path}/resume` : path, { method: resume ? "POST" : "PATCH", ...jsonBody(input) });
      if (generation.isCurrent(token)) { accept(schedule); update({ notice: resume ? "日程已恢复；已有任务需单独处理" : "定时设置已保存" }); }
    } catch (value) {
      if (!generation.isCurrent(token)) return;
      if (value instanceof ApiError && value.status === 409 && scheduleErrorReason(value) === "rotation_schedule_revision_conflict") {
        try {
          const latest = await request(path);
          if (generation.isCurrent(token)) { accept(latest); update({ error: "日程已被其他操作更新，已读取最新设置，请核对后重试" }); }
        } catch { if (generation.isCurrent(token)) update({ schedule: null, error: "最新日程读取失败，请重新读取后再保存" }); }
      } else update({ error: scheduleErrorMessage(value) });
    } finally { if (generation.isCurrent(token)) update({ pending: false }); }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(change: Partial<ScheduleDraft>) { if (!state.pending && !state.loading) update({ draft: { ...state.draft, ...change }, error: null, notice: null }); },
    load,
    save: () => mutate(false),
    resume: () => mutate(true),
    cancel: () => { generation.invalidate(); },
  };
}

export function rotationTriggerLabel(trigger: "health" | "manual" | "scheduled" | undefined): string {
  return trigger === "scheduled" ? "定时触发" : trigger === "manual" ? "手动换址" : "健康触发";
}

// Nest HTTP errors use a generic conflict code and preserve the domain reason in message.
function scheduleErrorReason(value: ApiError): string {
  return value.code === "conflict" ? value.message : value.code;
}

function scheduleErrorMessage(value: unknown): string {
  if (value instanceof ApiError) {
    const reason = scheduleErrorReason(value);
    const explanation = ({
      external_health_required: "请先配置有效的外部健康检查，再保存或恢复日程",
      rotation_candidate_window_too_short: "候选复测窗口过短，请在换址策略中增加复测窗口后重试",
      authorization_revoked: "管理授权已撤销，请检查实例授权后重试",
    } as Record<string, string>)[reason] ?? capabilityReason(reason);
    if (explanation !== reason) return explanation;
  }
  return cloudErrorMessage(value, "日程保存失败，已保留输入");
}

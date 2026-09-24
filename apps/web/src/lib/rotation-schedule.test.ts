import { describe, expect, it } from "vitest";
import type { RotationSchedule } from "@masterdns/contracts/rotation";
import { ApiError } from "./api";
import { createRotationScheduleEditor, parseScheduleInput, rotationTriggerLabel, scheduleSlotBlock, type ScheduleRequest } from "./rotation-schedule";
import { demoCloudInstances, demoCloudSlots } from "./cloud-demo";
import { policyToggleInput } from "./rotation-machines";
import { demoRotationPolicy } from "./rotation-demo";

export const schedule: RotationSchedule = { slotId: "slot-v4", enabled: false, intervalMinutes: 1440, revision: 0, nextRunAt: null, activeIncidentId: null, lastStartedAt: null, lastCompletedAt: null, lastHandledIncidentId: null, pausedReason: null, updatedAt: "2026-09-24T00:00:00Z" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe("minute schedule configuration", () => {
  it.each(["1", "1440", "129600"])("accepts integer minutes %s", interval => expect(parseScheduleInput(schedule, true, interval)).toEqual({ enabled: true, revision: 0, intervalMinutes: Number(interval) }));
  it.each(["", "0", "-1", "1.5", "129601", "abc", "Infinity"])("rejects invalid minutes %s", interval => expect(() => parseScheduleInput(schedule, true, interval)).toThrow());
  it("keeps failure and scheduled toggles in separate payloads", () => {
    expect(parseScheduleInput(schedule, true, "30")).toEqual({ revision: 0, enabled: true, intervalMinutes: 30 });
    expect(policyToggleInput(demoRotationPolicy, false)).not.toHaveProperty("intervalMinutes");
    expect(schedule.enabled).toBe(false);
    expect(demoRotationPolicy.enabled).toBe(true);
  });
  it.each(["ec2", "lightsail", "azure_vm", "linode"] as const)("supports existing public IPv4 capability for %s", service => {
    expect(scheduleSlotBlock({ ...demoCloudInstances[0]!, instance: { ...demoCloudInstances[0]!.instance, service } }, demoCloudSlots[0]!, schedule)).toBeNull();
  });
  it("lets an associated paused task resume its schedule without bypassing authorization", () => {
    const slot = { ...demoCloudSlots[0]!, blockedRotation: { incidentId: "task-1", reason: "rotation_in_progress" as const }, capability: { ...demoCloudSlots[0]!.capability!, available: false, reason: "rotation_in_progress" } };
    const associated = { ...schedule, activeIncidentId: "task-1" };
    expect(scheduleSlotBlock(demoCloudInstances[0]!, slot, associated)).toBeNull();
    expect(scheduleSlotBlock(demoCloudInstances[0]!, slot, schedule)).not.toBeNull();
    expect(scheduleSlotBlock({ ...demoCloudInstances[0]!, authorization: null }, slot, associated)).toContain("授权");
  });
  it("identifies scheduled triggers separately from manual and failure triggers", () => {
    expect(rotationTriggerLabel("scheduled")).toBe("定时触发");
    expect(rotationTriggerLabel("manual")).toBe("手动换址");
    expect(rotationTriggerLabel(undefined)).toBe("健康触发");
  });
  it("limits schedule to IPv4 and respects revoked management even for associated tasks", () => {
    expect(scheduleSlotBlock(demoCloudInstances[0]!, demoCloudSlots[1]!, schedule)).toContain("IPv4");
    expect(scheduleSlotBlock({ ...demoCloudInstances[0]!, authorization: null }, demoCloudSlots[0]!, schedule)).toContain("授权");
  });
});

describe("schedule editor async state", () => {
  it("does not turn failed reads into a disabled default", async () => {
    const editor = createRotationScheduleEditor(schedule.slotId, async () => { throw new Error("offline"); });
    await editor.load();
    expect(editor.getSnapshot()).toMatchObject({ schedule: null, error: "offline", loading: false });
  });
  it("retains saved state and edited minutes on save failure", async () => {
    const editor = createRotationScheduleEditor(schedule.slotId, async (_path, init) => { if (init) throw new Error("offline"); return schedule; });
    await editor.load(); editor.edit({ enabled: true, interval: "60" }); await editor.save();
    expect(editor.getSnapshot()).toMatchObject({ schedule, draft: { enabled: true, interval: "60" }, error: "offline", pending: false });
  });
  it.each([
    ["save", "external_health_required", "请先配置有效的外部健康检查，再保存或恢复日程"],
    ["save", "rotation_candidate_window_too_short", "候选复测窗口过短，请在换址策略中增加复测窗口后重试"],
    ["save", "authorization_revoked", "管理授权已撤销，请检查实例授权后重试"],
    ["resume", "external_health_required", "请先配置有效的外部健康检查，再保存或恢复日程"],
    ["resume", "rotation_candidate_window_too_short", "候选复测窗口过短，请在换址策略中增加复测窗口后重试"],
    ["resume", "authorization_revoked", "管理授权已撤销，请检查实例授权后重试"],
  ] as const)("retains draft and surfaces %s prerequisite failure %s", async (action, reason, message) => {
    let reads = 0;
    const paused = { ...schedule, enabled: true, pausedReason: "manual_pause", activeIncidentId: "incident-1" };
    const editor = createRotationScheduleEditor(schedule.slotId, async (_path, init) => {
      if (init) throw new ApiError(409, "conflict", reason);
      reads++; return paused;
    });
    await editor.load(); editor.edit({ enabled: true, interval: "60" });
    await editor[action]();
    expect(editor.getSnapshot()).toMatchObject({ schedule: paused, draft: { enabled: true, interval: "60" }, error: message, notice: null, pending: false });
    expect(reads).toBe(1);
  });
  it("submits only schedule fields and updates server confirmed minutes", async () => {
    const requests: Array<[string, RequestInit | undefined]> = [];
    const editor = createRotationScheduleEditor(schedule.slotId, async (path, init) => { requests.push([path, init]); return init ? { ...schedule, enabled: true, intervalMinutes: 30, revision: 1 } : schedule; });
    await editor.load(); editor.edit({ enabled: true, interval: "30" }); await editor.save();
    expect(requests[1]?.[0]).toBe("/v1/rotation-schedules/slot-v4");
    expect(JSON.parse(requests[1]![1]!.body as string)).toEqual({ revision: 0, enabled: true, intervalMinutes: 30 });
    expect(editor.getSnapshot()).toMatchObject({ schedule: { enabled: true, intervalMinutes: 30, revision: 1 }, draft: { enabled: true, interval: "30" }, error: null });
  });
  it("prevents late reads replacing a newer load", async () => {
    const old = deferred<RotationSchedule>(); let count = 0;
    const editor = createRotationScheduleEditor(schedule.slotId, async () => ++count === 1 ? old.promise : { ...schedule, intervalMinutes: 10, revision: 2 });
    const loading = editor.load(); await editor.load(); old.resolve(schedule); await loading;
    expect(editor.getSnapshot().schedule?.intervalMinutes).toBe(10);
  });
  it.each([false, true])("ignores late mutation results and errors after selection closes: error=%s", async failure => {
    const old = deferred<RotationSchedule>();
    const editor = createRotationScheduleEditor(schedule.slotId, async (_path, init) => init ? old.promise : schedule);
    await editor.load(); editor.edit({ interval: "30" }); const saving = editor.save(); editor.cancel();
    const snapshot = editor.getSnapshot(); if (failure) old.reject(new Error("late failure")); else old.resolve({ ...schedule, intervalMinutes: 30 }); await saving;
    expect(editor.getSnapshot()).toBe(snapshot);
  });
  it("discards stale writes when a newer load wins", async () => {
    const old = deferred<RotationSchedule>(); let reads = 0;
    const editor = createRotationScheduleEditor(schedule.slotId, async (_path, init) => init ? old.promise : ++reads === 1 ? schedule : { ...schedule, intervalMinutes: 90, revision: 3 });
    await editor.load(); const saving = editor.save(); await editor.load(); old.resolve({ ...schedule, intervalMinutes: 10, revision: 1 }); await saving;
    expect(editor.getSnapshot()).toMatchObject({ schedule: { intervalMinutes: 90 }, pending: false });
  });
  it("reloads conflicting configuration without retrying or hiding the conflict", async () => {
    let reads = 0;
    const editor = createRotationScheduleEditor(schedule.slotId, async (_path, init) => { if (init) throw new ApiError(409, "conflict", "rotation_schedule_revision_conflict"); return ++reads === 1 ? schedule : { ...schedule, intervalMinutes: 90, revision: 3 }; });
    await editor.load(); editor.edit({ interval: "10" }); await editor.save();
    expect(editor.getSnapshot()).toMatchObject({ schedule: { revision: 3 }, draft: { interval: "90" }, pending: false });
    expect(editor.getSnapshot().error).toContain("最新");
  });
  it("ignores a conflict refresh after closing the old selection", async () => {
    const conflict = deferred<RotationSchedule>(); let reads = 0;
    const editor = createRotationScheduleEditor(schedule.slotId, async (_path, init) => { if (init) throw new ApiError(409, "conflict", "rotation_schedule_revision_conflict"); return ++reads === 1 ? schedule : conflict.promise; });
    await editor.load(); const saving = editor.save(); await Promise.resolve(); editor.cancel(); const snapshot = editor.getSnapshot();
    conflict.resolve({ ...schedule, enabled: true, revision: 9 }); await saving;
    expect(editor.getSnapshot()).toBe(snapshot);
  });
  it("resumes schedule with revision only and leaves active task associated", async () => {
    let body: unknown;
    const paused = { ...schedule, enabled: true, revision: 3, pausedReason: "manual_pause", activeIncidentId: "incident-1" };
    const request: ScheduleRequest = async (path, init) => { if (!init) return paused; expect(path).toBe("/v1/rotation-schedules/slot-v4/resume"); body = JSON.parse(init.body as string); return { ...paused, revision: 4, pausedReason: null }; };
    const editor = createRotationScheduleEditor(schedule.slotId, request); await editor.load(); await editor.resume();
    expect(body).toEqual({ revision: 3 }); expect(editor.getSnapshot().schedule?.activeIncidentId).toBe("incident-1");
  });
});

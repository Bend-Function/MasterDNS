import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import { demoRotationPolicy } from "../lib/rotation-demo";
import { createRotationScheduleEditor } from "../lib/rotation-schedule";
import type { RotationSchedule } from "@masterdns/contracts/rotation";
import { RotationScheduleForm } from "./rotation-schedule-form";
import { RotationPolicyForm } from "./rotation-policy-form";

const schedule: RotationSchedule = { slotId: "slot-v4", enabled: true, intervalMinutes: 60, revision: 3, nextRunAt: "2026-09-24T01:00:00Z", activeIncidentId: null, lastStartedAt: null, lastCompletedAt: null, lastHandledIncidentId: null, pausedReason: null, updatedAt: "2026-09-24T00:00:00Z" };
function render(value: RotationSchedule | null = schedule, error: string | null = null, family: "4" | "6" = "4") {
  const state = createRotationScheduleEditor("slot-v4", async () => schedule, value).getSnapshot();
  return renderToStaticMarkup(createElement(RotationScheduleForm, { row: demoCloudInstances[0]!, slot: demoCloudSlots[family === "4" ? 0 : 1]!, state: { ...state, loading: false, error }, incidents: [], onEdit: () => {}, onSave: async () => {}, onResume: async () => {}, onReload: async () => {} }));
}
describe("schedule form rendering", () => {
  it("shows minute bounds, confirmed schedule and separately targeted submit", () => {
    const html = render();
    expect(html).toContain('min="1"'); expect(html).toContain('max="129600"'); expect(html).toContain('step="1"');
    expect(html).toContain("每 60 分钟"); expect(html).toContain("下次执行"); expect(html).toContain('id="rotation-schedule-form"');
    expect(html).toContain("保存定时设置"); expect(html).not.toContain('id="rotation-policy-form"');
  });
  it("shows failed reads as unknown without an editable disabled default", () => {
    const html = render(null, "日程读取失败");
    expect(html).toContain("日程读取失败"); expect(html).toContain("重新读取");
    expect(html).not.toContain('role="switch"'); expect(html).not.toContain("已关闭");
  });
  it("shows paused reason and associated task link while explaining separate task recovery", () => {
    const html = render({ ...schedule, pausedReason: "manual_pause", nextRunAt: null, activeIncidentId: "task-1" });
    expect(html).toContain("日程已暂停"); expect(html).toContain("恢复日程"); expect(html).toContain('/rotations/task-1'); expect(html).toContain("不会恢复旧任务");
  });
  it("can disable schedules after authorization/capability changes but cannot enable IPv6", () => {
    expect(render({ ...schedule, enabled: false }, null, "6").match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(render(schedule, null, "6").match(/<button[^>]*role="switch"[^>]*>/)?.[0]).not.toContain('disabled=""');
  });
  it("names the policy toggle as failure rotation independently of an enabled schedule", () => {
    const html = renderToStaticMarkup(createElement(RotationPolicyForm, { formId: "rotation-policy-form", slot: demoCloudSlots[0]!, authorization: demoCloudInstances[0]!.authorization, policy: { ...demoRotationPolicy, enabled: false }, onSubmit: async () => {} }));
    expect(html).toContain("故障自动轮换"); expect(html).toContain('aria-checked="false"');
    expect(render()).toContain('aria-checked="true"');
  });
});

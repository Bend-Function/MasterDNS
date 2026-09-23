import { describe, expect, it } from "vitest";
import {
  createLifecyclePollLoop,
  createLifecycleRequestGuard,
  lifecycleActionDisabledReason,
  lifecycleStateDisabledReason,
  lifecyclePolicyDraft,
  parseLifecyclePolicyInput,
  policyMutationDisabledReason,
  shouldPollLifecycle,
  validDeleteConfirmation,
} from "./cloud-lifecycle";

describe("cloud lifecycle policy input", () => {
  it("converts decimal gigabytes and minutes to safe integer API units", () => {
    expect(parseLifecyclePolicyInput({
      revision: 4,
      enabled: true,
      thresholdGigabytes: "12.345678901",
      direction: "outgoing",
      checkIntervalMinutes: "90",
    })).toEqual({
      revision: 4,
      enabled: true,
      thresholdBytes: 12_345_678_901,
      direction: "outgoing",
      checkIntervalSeconds: 5_400,
    });
  });

  it("rejects fractional bytes, unsafe thresholds, and out-of-range intervals", () => {
    const base = { revision: 0, enabled: true, direction: "total" as const };
    expect(() => parseLifecyclePolicyInput({ ...base, thresholdGigabytes: "0.0000000001", checkIntervalMinutes: "60" })).toThrow(/GB/);
    expect(() => parseLifecyclePolicyInput({ ...base, thresholdGigabytes: "9007199.254740992", checkIntervalMinutes: "60" })).toThrow(/安全范围/);
    expect(() => parseLifecyclePolicyInput({ ...base, thresholdGigabytes: "1", checkIntervalMinutes: "0" })).toThrow(/1.*1440/);
    expect(() => parseLifecyclePolicyInput({ ...base, thresholdGigabytes: "1", checkIntervalMinutes: "1.5" })).toThrow(/整数/);
  });

  it("allows a disabled policy with no threshold and restores API units for editing", () => {
    expect(parseLifecyclePolicyInput({ revision: 1, enabled: false, thresholdGigabytes: "", direction: "total", checkIntervalMinutes: "60" }).thresholdBytes).toBeNull();
    expect(lifecyclePolicyDraft({ thresholdBytes: 12_345_678_901, checkIntervalSeconds: 5_400 })).toEqual({ thresholdGigabytes: "12.345678901", checkIntervalMinutes: "90" });
  });
});

describe("cloud lifecycle controls", () => {
  const allowed = { managed: true, allowStopStart: true, allowDelete: true };

  it("requires saved management permissions and current account scope", () => {
    expect(lifecycleActionDisabledReason("start", { ...allowed, allowStopStart: false }, { accountEnabled: true, inScope: true, present: true })).toMatch(/启动和停止/);
    expect(lifecycleActionDisabledReason("delete", { ...allowed, allowDelete: false }, { accountEnabled: true, inScope: true, present: true })).toMatch(/删除/);
    expect(lifecycleActionDisabledReason("stop", allowed, { accountEnabled: false, inScope: true, present: true })).toMatch(/停用/);
    expect(lifecycleActionDisabledReason("stop", allowed, { accountEnabled: true, inScope: false, present: true })).toMatch(/范围/);
    expect(lifecycleActionDisabledReason("delete", allowed, { accountEnabled: true, inScope: true, present: false })).toMatch(/不存在/);
    expect(lifecycleActionDisabledReason("start", allowed, { accountEnabled: true, inScope: true, present: true })).toBeNull();
  });

  it("always permits disabling an enabled policy after account scope or authorization is revoked", () => {
    const revoked = { accountEnabled: false, inScope: false, present: true, managed: false, allowStopStart: false };
    expect(policyMutationDisabledReason(true, false, revoked)).toBeNull();
    expect(policyMutationDisabledReason(true, true, revoked)).toMatch(/停用/);
    expect(policyMutationDisabledReason(false, false, revoked)).toMatch(/停用/);
  });

  it("accepts only the exact external id for deletion", () => {
    expect(validDeleteConfirmation("i-012345", "i-012345")).toBe(true);
    expect(validDeleteConfirmation(" i-012345 ", "i-012345")).toBe(false);
    expect(validDeleteConfirmation("I-012345", "i-012345")).toBe(false);
  });

  it("keeps Azure allocated stops actionable until the VM is deallocated", () => {
    expect(lifecycleStateDisabledReason("stop", "azure_vm", "stopped")).toBeNull();
    expect(lifecycleStateDisabledReason("stop", "azure_vm", "stopped_allocated")).toBeNull();
    expect(lifecycleStateDisabledReason("stop", "azure_vm", "deallocating")).toMatch(/停止中/);
    expect(lifecycleStateDisabledReason("stop", "azure_vm", "deallocated")).toMatch(/已经停止/);
    expect(lifecycleStateDisabledReason("stop", "ec2", "stopped")).toMatch(/已经停止/);
  });

  it("polls only while an operation is queued or in flight", () => {
    expect(shouldPollLifecycle([{ status: "queued" }])).toBe(true);
    expect(shouldPollLifecycle([{ status: "in_flight" }])).toBe(true);
    expect(shouldPollLifecycle([{ status: "unknown" }, { status: "failed" }])).toBe(false);
  });

  it("reschedules pending polling after a transient control request failure", async () => {
    const scheduler = fakeScheduler();
    let attempts = 0;
    const poller = createLifecyclePollLoop(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    }, 5_000, scheduler);

    poller.start();
    expect(scheduler.size()).toBe(1);
    scheduler.runNext();
    await flushMicrotasks();
    expect(attempts).toBe(1);
    expect(scheduler.size()).toBe(1);

    scheduler.runNext();
    await flushMicrotasks();
    expect(attempts).toBe(2);
    expect(scheduler.size()).toBe(1);
    poller.stop();
    expect(scheduler.size()).toBe(0);
  });

  it("does not reschedule when an instance switch stops an in-flight poll", async () => {
    const scheduler = fakeScheduler();
    let resolveRequest!: () => void;
    const poller = createLifecyclePollLoop(() => new Promise<void>((resolve) => { resolveRequest = resolve; }), 5_000, scheduler);

    poller.start();
    scheduler.runNext();
    poller.stop();
    resolveRequest();
    await flushMicrotasks();

    expect(scheduler.size()).toBe(0);
  });

  it("invalidates callbacks from an old instance or older request", () => {
    const guard = createLifecycleRequestGuard();
    const oldInstance = guard.begin("instance-1");
    const newest = guard.begin("instance-1");
    expect(guard.isCurrent(oldInstance)).toBe(false);
    expect(guard.isCurrent(newest)).toBe(true);
    const nextInstance = guard.begin("instance-2");
    expect(guard.isCurrent(newest)).toBe(false);
    expect(guard.isCurrent(nextInstance)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(nextInstance)).toBe(false);
  });
});

function fakeScheduler() {
  let nextId = 0;
  const tasks = new Map<number, () => void>();
  return {
    set(callback: () => void) { const id = ++nextId; tasks.set(id, callback); return id; },
    clear(id: number) { tasks.delete(id); },
    runNext() {
      const next = tasks.entries().next().value as [number, () => void] | undefined;
      if (!next) throw new Error("No scheduled poll");
      tasks.delete(next[0]);
      next[1]();
    },
    size: () => tasks.size,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

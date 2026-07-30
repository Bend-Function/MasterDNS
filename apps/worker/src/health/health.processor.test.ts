import { describe, expect, it } from "vitest";
import { recoveryReconcileDelayMs } from "./health.processor.js";

describe("recovery reconcile delay", () => {
  const now = Date.parse("2026-07-30T05:00:00.000Z");

  it("never delays failure failover", () => {
    expect(recoveryReconcileDelayMs({
      trigger: "failure",
      recoveryMode: "delayed",
      recoveryDelaySeconds: 600,
      switchCooldownSeconds: 300,
      lastReconciledAt: new Date(now - 10_000),
    }, now)).toBe(0);
  });

  it("waits for the remaining switch cooldown before recovery", () => {
    expect(recoveryReconcileDelayMs({
      trigger: "recovery",
      recoveryMode: "automatic",
      recoveryDelaySeconds: 0,
      switchCooldownSeconds: 300,
      lastReconciledAt: new Date(now - 120_000),
    }, now)).toBe(180_000);
  });

  it("uses the longer delayed-recovery window", () => {
    expect(recoveryReconcileDelayMs({
      trigger: "recovery",
      recoveryMode: "delayed",
      recoveryDelaySeconds: 600,
      switchCooldownSeconds: 300,
      lastReconciledAt: new Date(now - 120_000),
    }, now)).toBe(600_000);
  });
});

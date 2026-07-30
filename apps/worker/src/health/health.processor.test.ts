import { describe, expect, it } from "vitest";
import {
  aggregatePoolState,
  isAddressStillIntended,
  isBindingHealthForAddress,
  isHealthCheckDefinitionCurrent,
  recoveryReconcileDelayMs,
} from "./health.processor.js";

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

describe("health transition guards", () => {
  const candidate = {
    id: "address-1",
    endpointId: "endpoint-1",
    family: "4" as const,
    address: "192.0.2.10",
    state: "candidate" as const,
    source: "ddns" as const,
  };

  it("rejects a candidate probe after a newer DDNS report replaced it", () => {
    expect(isAddressStillIntended(candidate, { ...candidate, state: "previous" }, "ddns")).toBe(false);
    expect(isAddressStillIntended(candidate, { ...candidate, id: "address-2", address: "192.0.2.11" }, "ddns")).toBe(false);
  });

  it("accepts only the same live DDNS candidate", () => {
    expect(isAddressStillIntended(candidate, candidate, "ddns")).toBe(true);
    expect(isAddressStillIntended(candidate, candidate, "static")).toBe(false);
    expect(isAddressStillIntended(candidate, { ...candidate, source: "static" }, "ddns")).toBe(false);
  });

  it("rejects current addresses whose source no longer matches the endpoint mode", () => {
    const current = { ...candidate, state: "current" as const };
    expect(isAddressStillIntended(current, current, "ddns")).toBe(true);
    expect(isAddressStillIntended(current, current, "static")).toBe(false);
  });

  it("rejects health work loaded before a policy rollback", () => {
    const observed = { id: "check-1", revision: 3, enabled: true, updatedAt: new Date("2026-07-30T12:00:00.000Z") };
    expect(isHealthCheckDefinitionCurrent(observed, { ...observed })).toBe(true);
    expect(isHealthCheckDefinitionCurrent(observed, { ...observed, updatedAt: new Date("2026-07-30T12:01:00.000Z") })).toBe(false);
    expect(isHealthCheckDefinitionCurrent(observed, { ...observed, enabled: false })).toBe(false);
  });

  it("clears aggregate pool failure after binding health recovers", () => {
    expect(aggregatePoolState(["healthy", "healthy"])).toBe("healthy");
    expect(aggregatePoolState(["healthy", "unhealthy"])).toBe("degraded");
  });

  it("does not reuse binding health after the endpoint address changes", () => {
    expect(isBindingHealthForAddress({ endpointAddressId: "address-old" }, "address-new")).toBe(false);
    expect(isBindingHealthForAddress({ endpointAddressId: "address-new" }, "address-new")).toBe(true);
    expect(isBindingHealthForAddress({ endpointAddressId: null }, "address-new")).toBe(false);
  });
});

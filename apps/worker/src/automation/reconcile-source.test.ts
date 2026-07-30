import { describe, expect, it } from "vitest";
import { reconcileOperationSource } from "./reconcile-source.js";

describe("Pool reconcile operation source", () => {
  const base = { poolId: "pool-1", eventId: "event-1" };

  it("derives failure and recovery sources for legacy jobs", () => {
    expect(reconcileOperationSource({ ...base, trigger: "failure" })).toBe("failover");
    expect(reconcileOperationSource({ ...base, trigger: "recovery" })).toBe("recovery");
  });

  it("defaults manual configuration and rebalance jobs to user", () => {
    expect(reconcileOperationSource({ ...base, trigger: "configuration" })).toBe("user");
    expect(reconcileOperationSource({ ...base, trigger: "rebalance" })).toBe("user");
  });

  it("preserves explicit DDNS, drift, and sync provenance", () => {
    expect(reconcileOperationSource({ ...base, trigger: "configuration", source: "ddns" })).toBe("ddns");
    expect(reconcileOperationSource({ ...base, trigger: "configuration", source: "drift" })).toBe("drift");
    expect(reconcileOperationSource({ ...base, trigger: "configuration", source: "sync" })).toBe("sync");
  });
});

import { describe, expect, it } from "vitest";
import { isOperationDecisionCurrent } from "../operations/operation.processor.js";
import { isReconcileDecisionCurrent, providersReadyForReconcile, shouldPlanProviderSteps } from "./reconcile.processor.js";

describe("automation decision revisions", () => {
  const pool = { policyRevision: 4, decisionRevision: 9 };

  it("supersedes a late failure reconcile after a newer recovery transition", () => {
    expect(isReconcileDecisionCurrent(pool, { policyRevision: 4, decisionRevision: 8 })).toBe(false);
    expect(isReconcileDecisionCurrent(pool, { policyRevision: 3, decisionRevision: 9 })).toBe(false);
    expect(isReconcileDecisionCurrent(pool, { policyRevision: 4, decisionRevision: 9 })).toBe(true);
  });

  it("supersedes queued provider writes when either policy or health intent changed", () => {
    expect(isOperationDecisionCurrent({ policyRevision: 4, decisionRevision: 8 }, pool)).toBe(false);
    expect(isOperationDecisionCurrent({ policyRevision: 3, decisionRevision: 9 }, pool)).toBe(false);
    expect(isOperationDecisionCurrent({ policyRevision: 4, decisionRevision: 9 }, pool)).toBe(true);
  });

  it("keeps legacy user operations guarded by policy revision only", () => {
    expect(isOperationDecisionCurrent({ policyRevision: 4, decisionRevision: null }, pool)).toBe(true);
  });
});

describe("reconcile provider availability", () => {
  it("keeps the outbox intent pending while a provider is concurrently disabled", () => {
    expect(providersReadyForReconcile(["active", "active"])).toBe(true);
    expect(providersReadyForReconcile(["active", "disabled"])).toBe(false);
    expect(providersReadyForReconcile(["error"])).toBe(false);
  });

  it("preserves current provider records when no endpoint has the required address family", () => {
    expect(shouldPlanProviderSteps("no_healthy_endpoint")).toBe(false);
    expect(shouldPlanProviderSteps("failure")).toBe(true);
  });
});

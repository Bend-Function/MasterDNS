import { describe, expect, it } from "vitest";
import type { HealthObservation } from "@masterdns/contracts";
import { advanceRoundHealth, evaluateProbeRound } from "./probe-consensus.js";

describe("probe round consensus", () => {
  const memberIds = ["a", "b", "c"];

  it.each([
    ["any", { a: "failure", b: "success", c: "success" }, "failure"],
    ["any", { a: "success", b: "success", c: "success" }, "success"],
    ["majority", { a: "failure", b: "failure", c: "success" }, "failure"],
    ["majority", { a: "failure", b: "success", c: "success" }, "success"],
    ["all", { a: "failure", b: "failure", c: "failure" }, "failure"],
    ["all", { a: "failure", b: "success", c: "success" }, "success"],
  ] as const)("applies the %s failure-vote rule", (mode, outcomes, expected) => {
    expect(evaluateProbeRound({
      memberIds,
      outcomes,
      policy: { mode, minimumValid: 3 },
    })).toBe(expected);
  });

  it("uses the fixed membership as the denominator", () => {
    expect(evaluateProbeRound({
      memberIds,
      outcomes: { a: "failure" },
      policy: { mode: "majority", minimumValid: 1 },
    })).toBe("unknown");
    expect(evaluateProbeRound({
      memberIds,
      outcomes: { a: "success", b: "success", outsider: "failure" },
      policy: { mode: "majority", minimumValid: 2 },
    })).toBe("success");
  });

  it("requires the minimum number of valid member outcomes", () => {
    expect(evaluateProbeRound({
      memberIds,
      outcomes: { a: "failure", b: "unavailable", c: "failure" },
      policy: { mode: "majority", minimumValid: 3 },
    })).toBe("unknown");
  });

  it.each([
    [1, { a: "failure", b: "success", c: "success" }, "failure"],
    [2, { a: "failure", b: "success", c: "success" }, "success"],
    [3, { a: "failure", b: "failure", c: "success" }, "success"],
  ] as const)("applies an at-least-%s failure threshold", (failureVotes, outcomes, expected) => {
    expect(evaluateProbeRound({
      memberIds,
      outcomes,
      policy: { mode: "at_least", minimumValid: 3, failureVotes },
    })).toBe(expected);
  });

  it("uses the complementary success bound for an even-sized membership", () => {
    expect(evaluateProbeRound({
      memberIds: ["a", "b", "c", "d"],
      outcomes: { a: "failure", b: "failure", c: "success", d: "success" },
      policy: { mode: "majority", minimumValid: 4 },
    })).toBe("success");
  });

  it("uses only the specified member after the valid-outcome gate", () => {
    expect(evaluateProbeRound({
      memberIds,
      outcomes: { a: "success", b: "failure", c: "success" },
      policy: { mode: "specified", minimumValid: 2, specifiedProbeId: "b" },
    })).toBe("failure");
    expect(evaluateProbeRound({
      memberIds,
      outcomes: { a: "success", b: "unavailable", c: "success" },
      policy: { mode: "specified", minimumValid: 2, specifiedProbeId: "b" },
    })).toBe("unknown");
  });

  it.each([
    [{ mode: "majority", minimumValid: 0 }, "minimumValid"],
    [{ mode: "majority", minimumValid: 4 }, "minimumValid"],
    [{ mode: "at_least", minimumValid: 1, failureVotes: 0 }, "failureVotes"],
    [{ mode: "at_least", minimumValid: 1, failureVotes: 4 }, "failureVotes"],
    [{ mode: "specified", minimumValid: 1, specifiedProbeId: "missing" }, "specifiedProbeId"],
  ] as const)("rejects invalid runtime policy %#", (policy, message) => {
    expect(() => evaluateProbeRound({ memberIds, outcomes: {}, policy })).toThrow(message);
  });
});

describe("round health advancement", () => {
  const thresholds = { failureThreshold: 2, successThreshold: 2 };

  it("counts each round once and transitions on consecutive failures", () => {
    const initial: HealthObservation = { state: "healthy", consecutiveSuccesses: 3, consecutiveFailures: 0 };
    const first = advanceRoundHealth(initial, "round-1", "failure", thresholds);
    const duplicate = advanceRoundHealth(first, "round-1", "failure", thresholds);
    const second = advanceRoundHealth(duplicate, "round-2", "failure", thresholds);

    expect(first).toEqual({ state: "degraded", consecutiveSuccesses: 0, consecutiveFailures: 1, lastRoundId: "round-1" });
    expect(duplicate).toBe(first);
    expect(second).toEqual({ state: "unhealthy", consecutiveSuccesses: 0, consecutiveFailures: 2, lastRoundId: "round-2" });
  });

  it("requires consecutive successful rounds to recover", () => {
    const initial = { state: "unhealthy" as const, consecutiveSuccesses: 0, consecutiveFailures: 2, lastRoundId: "round-0" };
    const first = advanceRoundHealth(initial, "round-1", "success", thresholds);
    const second = advanceRoundHealth(first, "round-2", "success", thresholds);

    expect(first.state).toBe("recovering");
    expect(second.state).toBe("healthy");
  });

  it("clears both streaks on an unknown round", () => {
    expect(advanceRoundHealth(
      { state: "degraded", consecutiveSuccesses: 0, consecutiveFailures: 1, lastRoundId: "round-0" },
      "round-1",
      "unknown",
      thresholds,
    )).toEqual({ state: "degraded", consecutiveSuccesses: 0, consecutiveFailures: 0, lastRoundId: "round-1" });
  });

  it("rejects invalid thresholds for an unknown round", () => {
    expect(() => advanceRoundHealth(
      { state: "unknown", consecutiveSuccesses: 0, consecutiveFailures: 0 },
      "round-1",
      "unknown",
      { failureThreshold: 0, successThreshold: 2 },
    )).toThrow("failureThreshold");
  });
});

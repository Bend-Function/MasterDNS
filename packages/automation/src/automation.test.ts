import { describe, expect, it } from "vitest";
import type { HealthObservation, StrategyContext, StrategyEndpoint } from "@masterdns/contracts";
import { applyHealthResult, evaluateStrategy } from "./index.js";

describe("health state machine", () => {
  it("requires consecutive failures before becoming unhealthy", () => {
    let state: HealthObservation = { state: "healthy", consecutiveSuccesses: 4, consecutiveFailures: 0 };
    state = applyHealthResult(state, false, { failureThreshold: 3, successThreshold: 3 });
    expect(state.state).toBe("degraded");
    state = applyHealthResult(state, false, { failureThreshold: 3, successThreshold: 3 });
    expect(state.state).toBe("degraded");
    state = applyHealthResult(state, false, { failureThreshold: 3, successThreshold: 3 });
    expect(state.state).toBe("unhealthy");
  });

  it("requires consecutive success to recover", () => {
    let state: HealthObservation = { state: "unhealthy", consecutiveSuccesses: 0, consecutiveFailures: 3 };
    state = applyHealthResult(state, true, { failureThreshold: 3, successThreshold: 2 });
    expect(state.state).toBe("recovering");
    state = applyHealthResult(state, true, { failureThreshold: 3, successThreshold: 2 });
    expect(state.state).toBe("healthy");
  });

  it.each([
    ["healthy", true, 3, "healthy"],
    ["degraded", true, 3, "degraded"],
    ["unknown", true, 1, "healthy"],
    ["unhealthy", false, 3, "unhealthy"],
    ["recovering", false, 3, "unhealthy"],
    ["unknown", false, 3, "unknown"],
    ["unknown", false, 1, "unhealthy"],
  ] as const)("moves %s on success=%s with threshold=%s to %s", (state, success, threshold, expected) => {
    expect(applyHealthResult(
      { state, consecutiveSuccesses: 0, consecutiveFailures: 0 },
      success,
      { failureThreshold: threshold, successThreshold: threshold },
    ).state).toBe(expected);
  });

  it.each([
    [{ failureThreshold: 0, successThreshold: 1 }, "failureThreshold"],
    [{ failureThreshold: 1.5, successThreshold: 1 }, "failureThreshold"],
    [{ failureThreshold: 1, successThreshold: 0 }, "successThreshold"],
    [{ failureThreshold: 1, successThreshold: 1.5 }, "successThreshold"],
  ])("rejects invalid thresholds %#", (thresholds, expectedMessage) => {
    expect(() => applyHealthResult(
      { state: "unknown", consecutiveSuccesses: 0, consecutiveFailures: 0 },
      true,
      thresholds,
    )).toThrow(expectedMessage);
  });
});

describe("pool strategy", () => {
  const endpoints: StrategyEndpoint[] = [
    { id: "a", priority: 1, lifecycle: "enabled", healthState: "unhealthy", activeBindingCount: 1 },
    { id: "b", priority: 2, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 4 },
    { id: "c", priority: 3, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 1 },
  ];

  function context(overrides: Partial<StrategyContext> = {}): StrategyContext {
    return {
      eventId: "event-1",
      trigger: "failure",
      strategy: "assignment_pool",
      selectionMode: "ordered",
      recoveryMode: "keep_current",
      endpoints,
      bindings: [{ id: "site", originalEndpointId: "a", currentEndpointIds: ["a"] }],
      ...overrides,
    };
  }

  it("moves a failed binding to the first healthy ordered endpoint", () => {
    expect(evaluateStrategy(context()).decisions[0]?.desiredEndpointIds).toEqual(["b"]);
  });

  it("uses the least assigned healthy endpoint", () => {
    expect(evaluateStrategy(context({ selectionMode: "least_assigned" })).decisions[0]?.desiredEndpointIds).toEqual(["c"]);
  });

  it("spreads several failed bindings as least-assigned counts change", () => {
    const result = evaluateStrategy(context({
      selectionMode: "least_assigned",
      endpoints: endpoints.map((endpoint) => ({ ...endpoint, activeBindingCount: endpoint.id === "a" ? 4 : 0 })),
      bindings: ["site-1", "site-2", "site-3", "site-4"].map((id) => ({ id, originalEndpointId: "a", currentEndpointIds: ["a"] })),
    }));
    expect(result.decisions.map((decision) => decision.desiredEndpointIds[0])).toEqual(["b", "c", "b", "c"]);
  });

  it("uses ordered selection for every failed binding", () => {
    const result = evaluateStrategy(context({
      bindings: ["site-1", "site-2", "site-3"].map((id) => ({ id, originalEndpointId: "a", currentEndpointIds: ["a"] })),
    }));
    expect(result.decisions.map((decision) => decision.desiredEndpointIds[0])).toEqual(["b", "b", "b"]);
  });

  it("advances round-robin selection within one reconcile", () => {
    const result = evaluateStrategy(context({
      selectionMode: "round_robin",
      bindings: ["site-1", "site-2", "site-3"].map((id) => ({ id, originalEndpointId: "a", currentEndpointIds: ["a"] })),
    }));
    expect(result.decisions.map((decision) => decision.desiredEndpointIds[0])).toEqual(["b", "c", "b"]);
    expect(Object.values(result.nextRoundRobinCursors ?? {})).toEqual(["b"]);
  });

  it("keeps independent round-robin cursors for different address candidate sets", () => {
    const first = evaluateStrategy(context({
      selectionMode: "round_robin",
      endpoints: [
        { id: "a4", priority: 1, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["4"] },
        { id: "b4", priority: 2, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["4"] },
        { id: "a6", priority: 1, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["6"] },
        { id: "b6", priority: 2, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["6"] },
      ],
      bindings: [
        { id: "site-a", currentEndpointIds: [], requiredAddressFamily: "4" },
        { id: "site-aaaa", currentEndpointIds: [], requiredAddressFamily: "6" },
      ],
    }));
    const second = evaluateStrategy(context({
      eventId: "event-2",
      selectionMode: "round_robin",
      endpoints: [
        { id: "a4", priority: 1, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["4"] },
        { id: "b4", priority: 2, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["4"] },
        { id: "a6", priority: 1, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["6"] },
        { id: "b6", priority: 2, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0, addressFamilies: ["6"] },
      ],
      bindings: [
        { id: "site-a", currentEndpointIds: [], requiredAddressFamily: "4" },
        { id: "site-aaaa", currentEndpointIds: [], requiredAddressFamily: "6" },
      ],
      roundRobinCursors: first.nextRoundRobinCursors!,
    }));
    expect(first.decisions.map((decision) => decision.desiredEndpointIds[0])).toEqual(["a4", "a6"]);
    expect(second.decisions.map((decision) => decision.desiredEndpointIds[0])).toEqual(["b4", "b6"]);
  });

  it("makes random selection reproducible for the same event", () => {
    const bindings = Array.from({ length: 10 }, (_, index) => ({ id: `site-${index}`, originalEndpointId: "a", currentEndpointIds: ["a"] }));
    const first = evaluateStrategy(context({ eventId: "stable-event", selectionMode: "random", bindings }));
    const second = evaluateStrategy(context({ eventId: "stable-event", selectionMode: "random", bindings }));
    expect(first.decisions.map((decision) => decision.desiredEndpointIds)).toEqual(second.decisions.map((decision) => decision.desiredEndpointIds));
    expect(new Set(first.decisions.flatMap((decision) => decision.desiredEndpointIds))).toEqual(new Set(["b", "c"]));
  });

  it("keeps current DNS when every endpoint is unhealthy", () => {
    const result = evaluateStrategy(context({ endpoints: endpoints.map((endpoint) => ({ ...endpoint, healthState: "unhealthy" })) }));
    expect(result.noHealthyEndpoints).toBe(true);
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["a"]);
  });

  it("publishes all healthy endpoints for a healthy set", () => {
    const result = evaluateStrategy(context({ strategy: "healthy_set" }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["b", "c"]);
  });

  it("recovers to the original endpoint when configured", () => {
    const recovered = endpoints.map((endpoint) => endpoint.id === "a" ? { ...endpoint, healthState: "healthy" as const } : endpoint);
    const result = evaluateStrategy(context({ trigger: "recovery", recoveryMode: "automatic", endpoints: recovered, bindings: [{ id: "site", originalEndpointId: "a", currentEndpointIds: ["b"] }] }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["a"]);
    expect(result.decisions[0]?.reason).toBe("recovery");
  });

  it("keeps the current healthy endpoint after recovery when configured", () => {
    const recovered = endpoints.map((endpoint) => ({ ...endpoint, healthState: "healthy" as const }));
    const result = evaluateStrategy(context({ trigger: "recovery", recoveryMode: "keep_current", endpoints: recovered, bindings: [{ id: "site", originalEndpointId: "a", currentEndpointIds: ["b"] }] }));
    expect(result.decisions).toEqual([]);
  });

  it.each(["keep_current", "manual"] as const)("does not republish recovered healthy-set members in %s mode", (recoveryMode) => {
    const result = evaluateStrategy(context({
      trigger: "recovery",
      strategy: "healthy_set",
      recoveryMode,
      endpoints: endpoints.map((endpoint) => ({ ...endpoint, healthState: "healthy" })),
      bindings: [{ id: "site", currentEndpointIds: ["b", "c"] }],
    }));
    expect(result.decisions).toEqual([]);
  });

  it.each(["automatic", "delayed"] as const)("republishes recovered healthy-set members in %s mode", (recoveryMode) => {
    const result = evaluateStrategy(context({
      trigger: "recovery",
      strategy: "healthy_set",
      recoveryMode,
      endpoints: endpoints.map((endpoint) => ({ ...endpoint, healthState: "healthy" })),
      bindings: [{ id: "site", currentEndpointIds: ["b", "c"] }],
    }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["a", "b", "c"]);
  });

  it("uses a recovered healthy-set member when keep-current has no available current member", () => {
    const result = evaluateStrategy(context({
      trigger: "recovery",
      strategy: "healthy_set",
      recoveryMode: "keep_current",
      endpoints: endpoints.map((endpoint) => endpoint.id === "a"
        ? { ...endpoint, healthState: "healthy" }
        : { ...endpoint, healthState: "unhealthy" }),
      bindings: [{ id: "site", currentEndpointIds: ["b", "c"] }],
    }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["a"]);
  });

  it("keeps degraded endpoints eligible until the failure threshold is reached", () => {
    const result = evaluateStrategy(context({
      endpoints: endpoints.map((endpoint) => endpoint.id === "a" ? { ...endpoint, healthState: "degraded" } : endpoint),
    }));
    expect(result.decisions).toEqual([]);
  });

  it("only selects endpoints with an address for the binding family", () => {
    const result = evaluateStrategy(context({
      endpoints: endpoints.map((endpoint) => ({
        ...endpoint,
        addressFamilies: endpoint.id === "b" ? ["4"] : ["6"],
      })),
      bindings: [{ id: "site", currentEndpointIds: ["a"], requiredAddressFamily: "6" }],
    }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["c"]);
  });

  it("repairs records without reassigning a healthy current endpoint", () => {
    const result = evaluateStrategy(context({
      trigger: "repair",
      endpoints: endpoints.map((endpoint) => endpoint.id === "a" ? { ...endpoint, healthState: "healthy" } : endpoint),
      bindings: [{ id: "site", originalEndpointId: "a", currentEndpointIds: ["c"] }],
    }));
    expect(result.decisions[0]).toMatchObject({ desiredEndpointIds: ["c"], reason: "rebalance" });
  });

  it("emits healthy-set repair decisions even when assignments are unchanged", () => {
    const result = evaluateStrategy(context({
      trigger: "repair",
      strategy: "healthy_set",
      bindings: [{ id: "site", currentEndpointIds: ["b", "c"] }],
    }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["b", "c"]);
  });

  it("does not mutate caller assignment counts", () => {
    const input = endpoints.map((endpoint) => ({ ...endpoint }));
    evaluateStrategy(context({ selectionMode: "least_assigned", endpoints: input }));
    expect(input).toEqual(endpoints);
  });

  it("uses binding-scoped health instead of global endpoint health", () => {
    const result = evaluateStrategy(context({
      endpoints: endpoints.map((endpoint) => endpoint.id === "a" ? { ...endpoint, healthState: "healthy" } : endpoint),
      bindings: [{
        id: "site",
        originalEndpointId: "a",
        currentEndpointIds: ["a"],
        endpointHealthStates: { a: "unhealthy", b: "unhealthy", c: "healthy" },
      }],
    }));
    expect(result.decisions[0]?.desiredEndpointIds).toEqual(["c"]);
  });

  it("keeps least-assigned counts across binding-scoped health overrides", () => {
    const result = evaluateStrategy(context({
      selectionMode: "least_assigned",
      endpoints: [
        { id: "a", priority: 1, lifecycle: "enabled", healthState: "unhealthy", activeBindingCount: 2 },
        { id: "b", priority: 2, lifecycle: "enabled", healthState: "unhealthy", activeBindingCount: 0 },
        { id: "c", priority: 3, lifecycle: "enabled", healthState: "unhealthy", activeBindingCount: 0 },
      ],
      bindings: ["site-1", "site-2"].map((id) => ({
        id,
        currentEndpointIds: ["a"],
        endpointHealthStates: { a: "unhealthy", b: "healthy", c: "healthy" },
      })),
    }));
    expect(result.decisions.map((decision) => decision.desiredEndpointIds[0])).toEqual(["b", "c"]);
  });

  it("allows different healthy sets for different domain bindings", () => {
    const result = evaluateStrategy(context({
      strategy: "healthy_set",
      bindings: [
        { id: "site-a", currentEndpointIds: ["b"], endpointHealthStates: { a: "unhealthy", b: "healthy", c: "unhealthy" } },
        { id: "site-b", currentEndpointIds: ["c"], endpointHealthStates: { a: "unhealthy", b: "unhealthy", c: "healthy" } },
      ],
    }));
    expect(result.decisions).toEqual([]);
  });

  it("preserves assignment counts when one binding has no healthy candidate", () => {
    const result = evaluateStrategy(context({
      selectionMode: "least_assigned",
      endpoints: [
        { id: "a", priority: 1, lifecycle: "enabled", healthState: "unhealthy", activeBindingCount: 1 },
        { id: "b", priority: 2, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 1 },
        { id: "c", priority: 3, lifecycle: "enabled", healthState: "healthy", activeBindingCount: 0 },
      ],
      bindings: [
        { id: "isolated", currentEndpointIds: ["b"], endpointHealthStates: { a: "unhealthy", b: "unhealthy", c: "unhealthy" } },
        { id: "movable", currentEndpointIds: ["a"] },
      ],
    }));
    expect(result.decisions[0]).toMatchObject({ bindingId: "isolated", desiredEndpointIds: ["b"], reason: "no_healthy_endpoint" });
    expect(result.decisions[1]).toMatchObject({ bindingId: "movable", desiredEndpointIds: ["c"] });
  });
});

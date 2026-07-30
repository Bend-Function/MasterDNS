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
});

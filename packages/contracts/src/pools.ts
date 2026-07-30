import type { HealthState } from "./health.js";

export type PoolStrategy = "primary_backup" | "healthy_set" | "assignment_pool";
export type SelectionMode = "random" | "ordered" | "round_robin" | "least_assigned";
export type RecoveryMode = "automatic" | "keep_current" | "manual" | "delayed";
export type EndpointLifecycle = "enabled" | "disabled" | "maintenance" | "draining";

export type StrategyEndpoint = {
  id: string;
  priority: number;
  lifecycle: EndpointLifecycle;
  healthState: HealthState;
  activeBindingCount: number;
  addressFamilies?: ("4" | "6")[];
};

export type StrategyBinding = {
  id: string;
  originalEndpointId?: string;
  currentEndpointIds: string[];
  endpointHealthStates?: Record<string, HealthState>;
  requiredAddressFamily?: "4" | "6";
};

export type StrategyContext = {
  eventId: string;
  trigger: "failure" | "recovery" | "rebalance" | "configuration" | "repair";
  strategy: PoolStrategy;
  selectionMode: SelectionMode;
  recoveryMode: RecoveryMode;
  endpoints: StrategyEndpoint[];
  bindings: StrategyBinding[];
  roundRobinCursor?: string;
  roundRobinCursors?: Record<string, string>;
};

export type BindingDecision = {
  bindingId: string;
  previousEndpointIds: string[];
  desiredEndpointIds: string[];
  reason: "failure" | "recovery" | "rebalance" | "no_healthy_endpoint";
};

export type StrategyDecision = {
  eventId: string;
  decisions: BindingDecision[];
  nextRoundRobinCursor?: string;
  nextRoundRobinCursors?: Record<string, string>;
  noHealthyEndpoints: boolean;
};

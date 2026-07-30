import type {
  BindingDecision,
  StrategyBinding,
  StrategyContext,
  StrategyDecision,
  StrategyEndpoint,
} from "@masterdns/contracts";

export function evaluateStrategy(context: StrategyContext): StrategyDecision {
  // Strategy evaluation keeps a working assignment count so one reconcile can
  // spread several failed bindings instead of selecting the same least-loaded node.
  const working = context.endpoints.map((endpoint) => ({ ...endpoint }));
  const workingById = new Map(working.map((endpoint) => [endpoint.id, endpoint]));
  const healthy = working.filter(isAvailable);
  if (context.strategy === "healthy_set") return evaluateHealthySet(context, healthy);

  const decisions: BindingDecision[] = [];
  const cursors = { ...(context.roundRobinCursors ?? {}) };
  let noHealthyEndpoints = false;

  for (const binding of context.bindings) {
    const bindingHealthy = healthyForBinding(binding, healthy, working);
    const cursorKey = roundRobinCursorKey(binding, bindingHealthy);
    const currentHealthy = binding.currentEndpointIds.some((id) => bindingHealthy.some((endpoint) => endpoint.id === id));
    const recoverOriginal = context.trigger === "recovery"
      && (context.recoveryMode === "automatic" || context.recoveryMode === "delayed")
      && binding.originalEndpointId !== undefined
      && bindingHealthy.some((endpoint) => endpoint.id === binding.originalEndpointId)
      && !binding.currentEndpointIds.includes(binding.originalEndpointId);
    const repairing = context.trigger === "repair";
    const shouldSelect = context.trigger === "rebalance" || context.trigger === "configuration" || repairing || !currentHealthy || recoverOriginal;
    if (!shouldSelect) continue;

    for (const endpointId of binding.currentEndpointIds) {
      const current = workingById.get(endpointId);
      if (current) current.activeBindingCount = Math.max(0, current.activeBindingCount - 1);
    }

    const selected = recoverOriginal
      ? bindingHealthy.find((endpoint) => endpoint.id === binding.originalEndpointId)
      : repairing && currentHealthy
        ? binding.currentEndpointIds.map((id) => bindingHealthy.find((endpoint) => endpoint.id === id)).find(Boolean)
        : selectEndpoint(bindingHealthy, context.selectionMode, context.eventId, binding, cursors[cursorKey] ?? context.roundRobinCursor);
    if (!selected) {
      for (const endpointId of binding.currentEndpointIds) {
        const current = workingById.get(endpointId);
        if (current) current.activeBindingCount += 1;
      }
      noHealthyEndpoints = true;
      decisions.push({
        bindingId: binding.id,
        previousEndpointIds: binding.currentEndpointIds,
        desiredEndpointIds: binding.currentEndpointIds,
        reason: "no_healthy_endpoint",
      });
      continue;
    }
    if (context.selectionMode === "round_robin") cursors[cursorKey] = selected.id;
    selected.activeBindingCount += 1;
    if (!repairing && context.trigger !== "configuration" && binding.currentEndpointIds.length === 1 && binding.currentEndpointIds[0] === selected.id) continue;
    decisions.push({
      bindingId: binding.id,
      previousEndpointIds: binding.currentEndpointIds,
      desiredEndpointIds: [selected.id],
      reason: recoverOriginal ? "recovery" : context.trigger === "rebalance" || context.trigger === "configuration" || repairing ? "rebalance" : "failure",
    });
  }

  return {
    eventId: context.eventId,
    decisions,
    ...(context.selectionMode === "round_robin" ? { nextRoundRobinCursors: cursors } : {}),
    noHealthyEndpoints,
  };
}

function evaluateHealthySet(context: StrategyContext, healthy: StrategyEndpoint[]): StrategyDecision {
  let noHealthyEndpoints = false;
  const decisions = context.bindings.flatMap((binding): BindingDecision[] => {
    const available = healthyForBinding(binding, healthy, healthy);
    const preserveCurrentOnRecovery = context.trigger === "recovery"
      && (context.recoveryMode === "keep_current" || context.recoveryMode === "manual");
    const availableCurrent = available.filter((endpoint) => binding.currentEndpointIds.includes(endpoint.id));
    const desired = (preserveCurrentOnRecovery && availableCurrent.length > 0
      ? availableCurrent
      : available).map((endpoint) => endpoint.id).sort();
    noHealthyEndpoints ||= desired.length === 0;
    const current = [...binding.currentEndpointIds].sort();
    if (desired.length === 0) {
      return [{ bindingId: binding.id, previousEndpointIds: current, desiredEndpointIds: current, reason: "no_healthy_endpoint" }];
    }
    if (context.trigger !== "configuration" && context.trigger !== "repair" && sameIds(current, desired)) return [];
    return [{
      bindingId: binding.id,
      previousEndpointIds: current,
      desiredEndpointIds: desired,
      reason: context.trigger === "configuration" || context.trigger === "repair" ? "rebalance" : desired.length > current.length ? "recovery" : "failure",
    }];
  });
  return { eventId: context.eventId, decisions, noHealthyEndpoints };
}

function healthyForBinding(
  binding: StrategyBinding,
  fallback: StrategyEndpoint[],
  working: StrategyEndpoint[],
): StrategyEndpoint[] {
  const supportsFamily = (endpoint: StrategyEndpoint) => !binding.requiredAddressFamily
    || endpoint.addressFamilies?.includes(binding.requiredAddressFamily) === true;
  if (!binding.endpointHealthStates) return fallback.filter(supportsFamily);
  return working
    .filter((endpoint) => endpoint.lifecycle === "enabled"
      && isHealthyEnough(binding.endpointHealthStates?.[endpoint.id] ?? "unknown")
      && supportsFamily(endpoint));
}

function roundRobinCursorKey(binding: StrategyBinding, candidates: StrategyEndpoint[]): string {
  const candidateIds = candidates.map((endpoint) => endpoint.id).sort();
  return [binding.requiredAddressFamily ?? "any", ...candidateIds].join(":");
}

function selectEndpoint(
  candidates: StrategyEndpoint[],
  mode: StrategyContext["selectionMode"],
  eventId: string,
  binding: StrategyBinding,
  cursor?: string,
): StrategyEndpoint | undefined {
  if (candidates.length === 0) return undefined;
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (mode === "ordered") return ordered[0];
  if (mode === "least_assigned") {
    return ordered.sort((a, b) => a.activeBindingCount - b.activeBindingCount || a.priority - b.priority || a.id.localeCompare(b.id))[0];
  }
  if (mode === "random") return ordered[stableHash(`${eventId}:${binding.id}`) % ordered.length];
  const cursorIndex = cursor ? ordered.findIndex((endpoint) => endpoint.id === cursor) : -1;
  return ordered[(cursorIndex + 1) % ordered.length];
}

function isAvailable(endpoint: StrategyEndpoint): boolean {
  return endpoint.lifecycle === "enabled" && isHealthyEnough(endpoint.healthState);
}

function isHealthyEnough(state: StrategyEndpoint["healthState"]): boolean {
  return state === "healthy" || state === "degraded";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

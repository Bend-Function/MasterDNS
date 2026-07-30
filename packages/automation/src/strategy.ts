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
  const healthy = context.endpoints.filter(isAvailable).map((endpoint) => ({ ...endpoint }));
  if (context.strategy === "healthy_set") return evaluateHealthySet(context, healthy);

  const decisions: BindingDecision[] = [];
  let cursor = context.roundRobinCursor;
  let noHealthyEndpoints = false;

  for (const binding of context.bindings) {
    const bindingHealthy = healthyForBinding(context, binding, healthy);
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
      const current = healthy.find((endpoint) => endpoint.id === endpointId);
      if (current) current.activeBindingCount = Math.max(0, current.activeBindingCount - 1);
    }

    const selected = recoverOriginal
      ? bindingHealthy.find((endpoint) => endpoint.id === binding.originalEndpointId)
      : repairing && currentHealthy
        ? binding.currentEndpointIds.map((id) => bindingHealthy.find((endpoint) => endpoint.id === id)).find(Boolean)
        : selectEndpoint(bindingHealthy, context.selectionMode, context.eventId, binding, cursor);
    if (!selected) {
      for (const endpointId of binding.currentEndpointIds) {
        const current = healthy.find((endpoint) => endpoint.id === endpointId);
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
    cursor = context.selectionMode === "round_robin" ? selected.id : cursor;
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
    ...(cursor !== undefined ? { nextRoundRobinCursor: cursor } : {}),
    noHealthyEndpoints,
  };
}

function evaluateHealthySet(context: StrategyContext, healthy: StrategyEndpoint[]): StrategyDecision {
  let noHealthyEndpoints = false;
  const decisions = context.bindings.flatMap((binding): BindingDecision[] => {
    const desired = healthyForBinding(context, binding, healthy).map((endpoint) => endpoint.id).sort();
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

function healthyForBinding(context: StrategyContext, binding: StrategyBinding, fallback: StrategyEndpoint[]): StrategyEndpoint[] {
  if (!binding.endpointHealthStates) return fallback;
  return context.endpoints
    .filter((endpoint) => endpoint.lifecycle === "enabled" && binding.endpointHealthStates?.[endpoint.id] === "healthy")
    .map((endpoint) => fallback.find((candidate) => candidate.id === endpoint.id) ?? { ...endpoint });
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
  return endpoint.lifecycle === "enabled" && endpoint.healthState === "healthy";
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

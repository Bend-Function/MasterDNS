import type { AddressHealthPolicy, ProbeGroup } from "./probe-types";

type AddressFamily = "4" | "6";
type EndpointWithAddresses = { addresses: Array<{ family: AddressFamily; state: string }> };

export function actualEndpointFamilies(endpoint: EndpointWithAddresses): AddressFamily[] {
  return [...new Set(endpoint.addresses.filter((address) => address.state === "current").map((address) => address.family))].sort();
}

export function reconcileEndpointFamily(current: AddressFamily, endpoint: EndpointWithAddresses): AddressFamily | null {
  const families = actualEndpointFamilies(endpoint);
  return families.includes(current) ? current : families[0] ?? null;
}

export function healthPolicyDisplay(policy: AddressHealthPolicy, group: ProbeGroup | undefined, now: number) {
  const pending = (reason: string) => ({ status: "unknown", decision: "unknown", reason });
  const state = policy.state;
  if (policy.slotId && policy.cloudTarget?.inventoryCurrent === false && !policy.cloudTarget.activeCandidate) return pending("历史地址已不在当前清单中，已停止探测");
  if (policy.slotId && policy.cloudTarget?.available === false) return pending("云地址当前不可用，已停止探测");
  if (policy.slotId && policy.mode === "local") return pending("云地址需要外部 Agent 验证，本地结果不能用于发布");
  if (!state || !policy.config?.enabled) return pending("等待有效检查结果");
  if (state.policyId !== policy.id || state.policyRevision !== policy.revision || state.configId !== policy.config.id || state.configVersion !== policy.config.revision || state.family !== policy.family) return pending("配置已更新，等待重新验证");
  if (policy.mode !== "local" && (!group || group.id !== policy.groupId || state.groupRevision !== group.revision)) return pending("探测组已更新或不可用，等待重新验证");
  if (policy.slotId) {
    const target = policy.cloudTarget;
    if (policy.config.slotId !== policy.slotId) return pending("健康配置与云地址不匹配");
    const address = target?.candidateAddress ?? target?.currentAddress;
    const version = target?.candidateAddress ? target.slot.candidateVersion : target?.slot.currentVersion;
    if (!target || target.slot.id !== policy.slotId || target.slot.family !== policy.family || !address || state.slotId !== policy.slotId || state.addressId !== address.id || state.addressVersion !== version) return pending("地址已变化，等待重新验证");
  }
  if (!state.evidenceExpiresAt || !(Date.parse(state.evidenceExpiresAt) > now)) return pending("检查证据已过期，等待重新验证");
  if (state.latestDecision === "unknown") return pending("最新轮次未形成有效结论");
  if (state.latestDecision === "success") {
    if (state.healthState === "healthy" && state.consecutiveSuccesses >= policy.successThreshold) return { status: "healthy", decision: "success", reason: "" };
    return { status: "recovering", decision: "success", reason: `连续成功 ${state.consecutiveSuccesses}/${policy.successThreshold}，尚未通过` };
  }
  if (state.healthState === "unhealthy" && state.consecutiveFailures >= policy.failureThreshold) return { status: "unhealthy", decision: "failure", reason: "" };
  return { status: "degraded", decision: "failure", reason: `连续失败 ${state.consecutiveFailures}/${policy.failureThreshold}` };
}

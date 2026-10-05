import { CloudError } from "./errors.js";
import type { CloudProviderAdapter, CloudRotationAdapter, CloudLifecycleAdapter, CloudTrafficAdapter, CloudIdleIpAdapter } from "./provider.js";

export function hasCloudRotation(adapter: CloudProviderAdapter): adapter is CloudProviderAdapter & CloudRotationAdapter {
  return typeof adapter.capabilities === "function" && typeof adapter.execute === "function" && typeof adapter.observe === "function";
}

export function requireCloudRotation(adapter: CloudProviderAdapter): CloudProviderAdapter & CloudRotationAdapter {
  if (!hasCloudRotation(adapter)) throw new CloudError("rotation_unsupported", false, undefined, "rotation_unavailable");
  return adapter;
}

export function hasCloudLifecycle(adapter: CloudProviderAdapter): adapter is CloudProviderAdapter & CloudLifecycleAdapter {
  return typeof adapter.inspectLifecycle === "function" && typeof adapter.mutateLifecycle === "function";
}

export function hasCloudTraffic(adapter: CloudProviderAdapter): adapter is CloudProviderAdapter & CloudTrafficAdapter {
  return typeof adapter.monthlyTraffic === "function";
}

export function hasCloudIdleIps(adapter: CloudProviderAdapter): adapter is CloudProviderAdapter & CloudIdleIpAdapter {
  return typeof adapter.listIdleStaticIps === "function" && typeof adapter.releaseIdleStaticIp === "function";
}

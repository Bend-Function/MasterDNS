import { cloudServiceProvider } from "@masterdns/contracts";
import { cloudServiceRegistry } from "./registry.js";
import type { CloudAdapterConfig } from "./service-registry.js";
import type { AwsAdapterDependencies, CloudProviderAdapter } from "./provider.js";

export type { CloudAdapterConfig } from "./service-registry.js";
export function createCloudAdapter(config: CloudAdapterConfig, dependencies: AwsAdapterDependencies = {}): CloudProviderAdapter {
  // Keep the existing public error for unknown service identifiers.
  cloudServiceProvider(config.service);
  return cloudServiceRegistry.createAdapter(config, dependencies);
}

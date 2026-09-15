import { cloudServiceProvider, type CloudService, type CloudProvider } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import { credentialsMatchProvider } from "./provider.js";
import { AzureCloudAdapter } from "./azure.js";
import { LinodeCloudAdapter } from "./linode.js";
import { Ec2CloudAdapter } from "./ec2.js";
import { LightsailCloudAdapter } from "./lightsail.js";
import type { AwsAdapterDependencies, CloudCredentials, CloudAdapter } from "./provider.js";

export type CloudAdapterConfig = {
  accountId: string;
  service: CloudService;
  provider?: CloudProvider;
  credentials: CloudCredentials;
};

export function createCloudAdapter(config: CloudAdapterConfig, dependencies: AwsAdapterDependencies = {}): CloudAdapter {
  const provider = cloudServiceProvider(config.service);
  if ((config.provider !== undefined && config.provider !== provider) || !credentialsMatchProvider(provider, config.credentials)) throw new CloudError("invalid_credentials", false);

  switch (config.service) {
    case "ec2": if (config.credentials.kind === "access_key" || config.credentials.kind === "role") return new Ec2CloudAdapter(config.accountId, config.credentials, dependencies); break;
    case "lightsail": if (config.credentials.kind === "access_key" || config.credentials.kind === "role") return new LightsailCloudAdapter(config.accountId, config.credentials, dependencies); break;
    case "azure_vm": if (config.credentials.kind === "azure_service_principal") return new AzureCloudAdapter(config.accountId, config.credentials, dependencies); break;
    case "linode": if (config.credentials.kind === "linode_token") return new LinodeCloudAdapter(config.accountId, config.credentials, dependencies); break;
    default: throw new CloudError("rotation_unsupported", false, undefined, "service_unavailable");
  }
  throw new CloudError("invalid_credentials", false);
}

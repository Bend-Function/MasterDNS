import { Ec2CloudAdapter } from "./ec2.js";
import { LightsailCloudAdapter } from "./lightsail.js";
import type { AwsAdapterDependencies, AwsCredentials, CloudAdapter } from "./provider.js";

export type CloudAdapterConfig = {
  accountId: string;
  service: "ec2" | "lightsail";
  credentials: AwsCredentials;
};

export function createCloudAdapter(config: CloudAdapterConfig, dependencies: AwsAdapterDependencies = {}): CloudAdapter {
  return config.service === "ec2"
    ? new Ec2CloudAdapter(config.accountId, config.credentials, dependencies)
    : new LightsailCloudAdapter(config.accountId, config.credentials, dependencies);
}

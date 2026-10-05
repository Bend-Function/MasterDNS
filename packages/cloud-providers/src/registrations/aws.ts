import { ec2WorkflowPolicy, lightsailWorkflowPolicy } from "../workflow-policy.js";
import { Ec2CloudAdapter } from "../ec2.js";
import { LightsailCloudAdapter } from "../lightsail.js";
import { awsCapabilities } from "../aws-capabilities.js";
import { planAwsRotation, planAwsRotationCleanup } from "../aws-rotation-plan.js";
import { CloudError } from "../errors.js";
import type { CloudServiceRegistration } from "../service-registry.js";

const rotation = { capabilities: awsCapabilities, planRotation: planAwsRotation, planCleanup: planAwsRotationCleanup };
export const ec2Registration: CloudServiceRegistration = {
  workflow: ec2WorkflowPolicy,
  service: "ec2", provider: "aws", rotation,
  createAdapter(config, dependencies) {
    if (config.credentials.kind !== "access_key" && config.credentials.kind !== "role") throw new CloudError("invalid_credentials", false);
    return new Ec2CloudAdapter(config.accountId, config.credentials, dependencies);
  },
};
export const lightsailRegistration: CloudServiceRegistration = {
  workflow: lightsailWorkflowPolicy,
  service: "lightsail", provider: "aws", rotation,
  createAdapter(config, dependencies) {
    if (config.credentials.kind !== "access_key" && config.credentials.kind !== "role") throw new CloudError("invalid_credentials", false);
    return new LightsailCloudAdapter(config.accountId, config.credentials, dependencies);
  },
};

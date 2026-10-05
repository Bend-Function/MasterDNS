import { azureWorkflowPolicy } from "../workflow-policy.js";
import { AzureCloudAdapter } from "../azure.js";
import { azureCapabilities } from "../azure-capabilities.js";
import { planAzureRotation, planAzureCleanup } from "../azure-rotation.js";
import { CloudError } from "../errors.js";
import type { CloudServiceRegistration } from "../service-registry.js";

export const azureVmRegistration: CloudServiceRegistration = {
  workflow: azureWorkflowPolicy,
  service: "azure_vm", provider: "azure",
  rotation: { capabilities: azureCapabilities, planRotation: planAzureRotation, planCleanup: planAzureCleanup },
  createAdapter(config, dependencies) {
    if (config.credentials.kind !== "azure_service_principal") throw new CloudError("invalid_credentials", false);
    return new AzureCloudAdapter(config.accountId, config.credentials, dependencies);
  },
};

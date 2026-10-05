import { linodeWorkflowPolicy } from "../workflow-policy.js";
import { LinodeCloudAdapter } from "../linode.js";
import { linodeCapabilities } from "../linode-capabilities.js";
import { planLinodeRotation, planLinodeCleanup } from "../linode-rotation.js";
import { CloudError } from "../errors.js";
import type { CloudServiceRegistration } from "../service-registry.js";

export const linodeRegistration: CloudServiceRegistration = {
  workflow: linodeWorkflowPolicy,
  service: "linode", provider: "linode",
  rotation: { capabilities: linodeCapabilities, planRotation: planLinodeRotation, planCleanup: planLinodeCleanup },
  createAdapter(config, dependencies) {
    if (config.credentials.kind !== "linode_token") throw new CloudError("invalid_credentials", false);
    return new LinodeCloudAdapter(config.accountId, config.credentials, dependencies);
  },
};

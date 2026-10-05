import type { CloudService } from "@masterdns/contracts";
import { CloudServiceRegistry } from "./service-registry.js";
import { ec2Registration, lightsailRegistration } from "./registrations/aws.js";
import { azureVmRegistration } from "./registrations/azure.js";
import { linodeRegistration } from "./registrations/linode.js";

export const cloudServiceRegistry = new CloudServiceRegistry([ec2Registration, lightsailRegistration, azureVmRegistration, linodeRegistration]);
export function getCloudServiceRegistration(service: CloudService) { return cloudServiceRegistry.get(service); }

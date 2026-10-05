import { cloudServiceProvider, type CloudService, type CloudProvider, type SlotRef, type CloudStep } from "@masterdns/contracts";
import { CloudError } from "./errors.js";
import { credentialsMatchProvider, type AwsAdapterDependencies, type CloudCredentials, type CloudProviderAdapter, type Capability, type CloudInventory } from "./provider.js";
import type { CloudWorkflowPolicy } from "./workflow-policy.js";
import type { RotationPlanOptions, CleanupPlanOptions } from "./rotation-step.js";

export type CloudAdapterConfig = {
  accountId: string;
  service: CloudService;
  provider?: CloudProvider;
  credentials: CloudCredentials;
};

export interface CloudRotationRegistration {
  capabilities(slot: SlotRef, inventory: CloudInventory): Capability;
  planRotation(slot: SlotRef, inventory: CloudInventory, options: RotationPlanOptions): CloudStep[];
  planCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[];
}

/** Rotation needs ownership/publication policies before any cloud mutation is possible. */
export type CloudServiceRegistration = {
  readonly service: CloudService;
  readonly provider: CloudProvider;
  readonly createAdapter: (config: CloudAdapterConfig, dependencies: AwsAdapterDependencies) => CloudProviderAdapter;
} & (
  | { readonly rotation: CloudRotationRegistration; readonly workflow: CloudWorkflowPolicy }
  | { readonly rotation?: undefined; readonly workflow?: CloudWorkflowPolicy }
);

const unavailable = (): Capability => ({ available: false, reason: "service_unavailable", permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false });

/** Explicit registrations; independent instances allow contract testing without mutating production dispatch. */
export class CloudServiceRegistry {
  private readonly registrations = new Map<CloudService, CloudServiceRegistration>();

  constructor(registrations: readonly CloudServiceRegistration[]) {
    for (const registration of registrations) {
      if (this.registrations.has(registration.service) || cloudServiceProvider(registration.service) !== registration.provider
        || (registration.rotation !== undefined && !registration.workflow)) throw new Error("invalid_cloud_registration");
      const frozen = registration.rotation === undefined
        ? Object.freeze({ ...registration })
        : Object.freeze({ ...registration, rotation: Object.freeze({ ...registration.rotation }) });
      this.registrations.set(registration.service, frozen);
    }
  }

  get(service: CloudService): CloudServiceRegistration | undefined { return this.registrations.get(service); }

  createAdapter(config: CloudAdapterConfig, dependencies: AwsAdapterDependencies = {}): CloudProviderAdapter {
    const registration = this.get(config.service);
    if (!registration) throw new CloudError("rotation_unsupported", false, undefined, "service_unavailable");
    if ((config.provider !== undefined && config.provider !== registration.provider) || !credentialsMatchProvider(registration.provider, config.credentials)) throw new CloudError("invalid_credentials", false);
    return registration.createAdapter(config, dependencies);
  }

  evaluateCapabilities(slot: SlotRef, inventory: CloudInventory): Capability {
    return this.get(slot.service)?.rotation?.capabilities(slot, inventory) ?? unavailable();
  }

  planRotation(slot: SlotRef, inventory: CloudInventory, options: RotationPlanOptions): CloudStep[] {
    const rotation = this.get(slot.service)?.rotation;
    if (!rotation) throw new CloudError("rotation_unsupported", false, undefined, "service_unavailable");
    return rotation.planRotation(slot, inventory, options);
  }

  planCleanup(slot: SlotRef, inventory: CloudInventory, options: CleanupPlanOptions): CloudStep[] {
    const rotation = this.get(slot.service)?.rotation;
    if (!rotation) throw new CloudError("rotation_unsupported", false, undefined, "service_unavailable");
    return rotation.planCleanup(slot, inventory, options);
  }
}

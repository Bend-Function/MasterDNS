import { cloudServiceDefinitions } from "./cloud-catalog.js";
import type { CloudProvider, CloudService } from "./cloud.js";

export type CloudRotationTrigger = "health" | "manual" | "scheduled";
export function supportsRotationTrigger(provider: CloudProvider, service: CloudService, trigger: CloudRotationTrigger): boolean {
  const definition = cloudServiceDefinitions[service];
  return definition?.provider === provider && (definition.supportedRotationTriggers as readonly CloudRotationTrigger[]).includes(trigger);
}
export type RotationAuthorizationPolicy = { linodeIpv4Strategy?: string; linodeAllowTemporaryInstance?: boolean };
export type ManualRotationPrerequisites = { allowStopStart?: boolean; allocationId?: string | null; primary?: boolean; privateAddress?: unknown; deviceIndex?: unknown; ipv6Only?: unknown };

type RotationPrerequisites = {
  authorization(policy: RotationAuthorizationPolicy): string | undefined;
  manual(input: ManualRotationPrerequisites): string | undefined;
};
const noError = () => undefined;
const prerequisites: Record<CloudService, RotationPrerequisites> = {
  ec2: {
    authorization: noError,
    manual: input => {
      if (!input.allocationId && !input.primary) return "rotation_capability_unavailable";
      if (input.allocationId && !input.primary && typeof input.privateAddress !== "string") return "rotation_capability_unavailable";
      if (!input.allocationId && input.deviceIndex !== 0) return "rotation_capability_unavailable";
    },
  },
  lightsail: { authorization: noError, manual: input => input.ipv6Only !== false ? "rotation_capability_unavailable" : undefined },
  azure_vm: { authorization: noError, manual: noError },
  linode: {
    authorization: policy => policy.linodeIpv4Strategy === "instance_swap" && !policy.linodeAllowTemporaryInstance ? "rotation_temporary_instance_not_authorized" : undefined,
    manual: input => !input.allowStopStart ? "rotation_stop_start_not_authorized" : undefined,
  },
};
export function rotationAuthorizationPrerequisiteError(service: CloudService, policy: RotationAuthorizationPolicy): string | undefined {
  return prerequisites[service]?.authorization(policy);
}
export function manualRotationServicePrerequisiteError(service: CloudService, input: ManualRotationPrerequisites): string | undefined {
  return prerequisites[service]?.manual(input);
}

/** Called after the generic family/address validation at incident admission. */
export function rotationPrivateIpv4Error(address: string, providerMetadata: unknown): string | undefined {
  if (providerMetadata !== null && typeof providerMetadata === "object" && !Array.isArray(providerMetadata) &&
    (providerMetadata as Record<string, unknown>).awsAddressScope === "private") return "rotation_private_ipv4_unsupported";
  const [first = 0, second = 0] = address.split(".").map(Number);
  if (first === 10 || first === 127 || first === 0 || first >= 224 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127)) return "rotation_private_ipv4_unsupported";
}

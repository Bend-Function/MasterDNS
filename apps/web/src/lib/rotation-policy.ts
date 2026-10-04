import { rotationPolicySchema, type RotationPolicyInput } from "@masterdns/contracts/rotation";
import type { RotationPolicy } from "./rotation-types";
import { demoRotationPolicy } from "./rotation-demo";

export type RotationAuthorizationCheck = {
  managed: boolean;
  ipv4Enabled?: boolean;
  ipv6Enabled?: boolean;
  ipv4Authorized?: boolean;
  ipv6Authorized?: boolean;
};

export function validateRotationPolicy(input: RotationAuthorizationCheck): string[] {
  const errors: string[] = [];
  if (!input.managed && (input.ipv4Enabled || input.ipv6Enabled)) errors.push("instance_not_managed");
  if (input.ipv4Enabled && input.ipv4Authorized === false) errors.push("ipv4_not_authorized");
  if (input.ipv6Enabled && input.ipv6Authorized === false) errors.push("ipv6_not_authorized");
  return errors;
}

export function parseRotationPolicyInput(input: unknown, context?: { savedPolicy: RotationPolicy; blockReason: string | null }): RotationPolicyInput {
  const parsed = rotationPolicySchema.parse(input);
  const revokesTemporaryInstance = context?.savedPolicy.enabled && context.savedPolicy.linodeAllowTemporaryInstance && !parsed.linodeAllowTemporaryInstance;
  if (parsed.enabled && context?.blockReason && !revokesTemporaryInstance) throw new Error(context.blockReason);
  return parsed;
}

export function linodeTemporaryInstanceBlock(policy: Pick<RotationPolicy, "linodeIpv4Strategy" | "linodeAllowTemporaryInstance">): string | null {
  return policy.linodeIpv4Strategy === "instance_swap" && !policy.linodeAllowTemporaryInstance ? "请先授权创建和删除临时实例，并保存换址策略" : null;
}

export async function resolveManualRotationPolicy(service: string, slotId: string, savedPolicy: RotationPolicy | undefined, preview: boolean, request: (path: string) => Promise<RotationPolicy>): Promise<RotationPolicy | null> {
  if (service !== "linode") return null;
  if (savedPolicy) return savedPolicy;
  if (preview) return { ...demoRotationPolicy, slotId };
  return request(`/v1/rotation-policies?slotId=${encodeURIComponent(slotId)}`);
}

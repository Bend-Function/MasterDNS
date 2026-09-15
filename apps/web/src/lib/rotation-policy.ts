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

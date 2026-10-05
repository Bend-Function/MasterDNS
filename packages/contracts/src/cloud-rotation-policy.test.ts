import { expect, it } from "vitest";
import { supportsRotationTrigger, rotationAuthorizationPrerequisiteError, manualRotationServicePrerequisiteError, rotationPrivateIpv4Error } from "./cloud-rotation-policy.js";
it("rejects cross-provider services and preserves manual trigger scope", () => {
  expect(supportsRotationTrigger("azure", "azure_vm", "scheduled")).toBe(true);
  expect(supportsRotationTrigger("azure", "azure_vm", "manual")).toBe(false);
  expect(supportsRotationTrigger("linode", "ec2", "manual")).toBe(false);
  expect(supportsRotationTrigger("aws", "ec2", "manual")).toBe(true);
});
it("requires the Linode temporary-instance and stop/start grants", () => {
  expect(rotationAuthorizationPrerequisiteError("linode", { linodeIpv4Strategy: "instance_swap", linodeAllowTemporaryInstance: false })).toBe("rotation_temporary_instance_not_authorized");
  expect(rotationAuthorizationPrerequisiteError("ec2", { linodeIpv4Strategy: "instance_swap", linodeAllowTemporaryInstance: false })).toBeUndefined();
  expect(manualRotationServicePrerequisiteError("linode", {})).toBe("rotation_stop_start_not_authorized");
});
it("preserves EC2 private-address and primary-interface prerequisites", () => {
  expect(rotationPrivateIpv4Error("192.0.2.1", { awsAddressScope: "private" })).toBe("rotation_private_ipv4_unsupported");
  expect(rotationPrivateIpv4Error("10.0.0.1", {})).toBe("rotation_private_ipv4_unsupported");
  expect(rotationPrivateIpv4Error("192.0.2.1", {})).toBeUndefined();
  expect(manualRotationServicePrerequisiteError("ec2", { primary: true, deviceIndex: 0 })).toBeUndefined();
  expect(manualRotationServicePrerequisiteError("ec2", { primary: true, deviceIndex: 1 })).toBe("rotation_capability_unavailable");
  expect(manualRotationServicePrerequisiteError("ec2", { allocationId: "allocation", primary: false })).toBe("rotation_capability_unavailable");
  expect(manualRotationServicePrerequisiteError("ec2", { allocationId: "allocation", primary: false, privateAddress: "10.0.0.1" })).toBeUndefined();
  expect(manualRotationServicePrerequisiteError("lightsail", {})).toBe("rotation_capability_unavailable");
});

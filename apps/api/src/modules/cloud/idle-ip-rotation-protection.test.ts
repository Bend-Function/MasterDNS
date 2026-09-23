import { expect, it } from "vitest";
import { makeRotationStep, type RotationAction, type RotationStepArguments } from "@masterdns/cloud-providers";
import { unresolvedRotationProtectsIdleIp } from "./idle-ip-rotation-protection.js";

const region = "ap-northeast-1";
const slot = { accountId: "local", service: "lightsail" as const, region, instanceId: `arn:aws:lightsail:${region}:123456789012:Instance/one`, interfaceId: "primary", slotId: "slot", address: "203.0.113.8", family: 4 as const };
const original = { address: slot.address, family: 4 as const, primary: true, allocationId: "original", resourceId: `arn:aws:lightsail:${region}:123456789012:StaticIp/original` };
const args: RotationStepArguments = { slot, attemptId: "attempt-1", phase: "rotation", before: { ref: slot, name: "one", nativeName: "one", state: "running", interfaces: [{ id: "primary", addresses: [original] }] } };
const candidate = { name: "masterdns-attempt-1", address: "203.0.113.9", arn: `arn:aws:lightsail:${region}:123456789012:StaticIp/candidate`, region, createdAt: "2026-09-01T00:00:00.000Z" };
const unrelated = { ...candidate, name: "unrelated", address: "203.0.113.10", arn: `arn:aws:lightsail:${region}:123456789012:StaticIp/unrelated` };
function evidence(action: RotationAction) {
  const plan = makeRotationStep(action, { ...args, phase: action.endsWith("release") ? "post_publish_cleanup" : "rotation" }, 0);
  return { plan, stepId: plan.id, attemptId: "attempt-1", accountId: "local", externalAccountId: "123456789012", region, instanceId: slot.instanceId, interfaceId: "primary", slotId: "slot", receipt: null as unknown, resources: [] as unknown };
}

it.each(["lightsail.static-ip.allocate", "lightsail.static-ip.attach"] as const)("protects the deterministic candidate before a %s receipt exists", action => {
  const row = evidence(action);
  expect(unresolvedRotationProtectsIdleIp(candidate, row)).toBe(true);
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(false);
});

it.each(["lightsail.static-ip.detach", "lightsail.static-ip.release"] as const)("scopes unresolved %s protection to the exact original", action => {
  const row = evidence(action);
  expect(unresolvedRotationProtectsIdleIp({ ...candidate, name: original.allocationId, address: original.address, arn: original.resourceId }, row)).toBe(true);
  expect(unresolvedRotationProtectsIdleIp(candidate, row)).toBe(false);
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(false);
});

it("uses durable receipt and resource identities alongside the planned candidate name", () => {
  const row = evidence("lightsail.static-ip.attach");
  row.receipt = { allocationId: candidate.name, resourceId: candidate.arn, candidateAddress: candidate.address };
  row.resources = [{ role: "candidate", allocationId: candidate.name, resourceId: candidate.arn, address: candidate.address, cleanupStepId: null }];
  expect(unresolvedRotationProtectsIdleIp({ ...candidate, name: "other", arn: unrelated.arn }, row)).toBe(true);
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(false);
});

it("does not let an unrelated historical resource widen a release target", () => {
  const row = evidence("lightsail.static-ip.release");
  row.resources = [{ role: "candidate", allocationId: unrelated.name, resourceId: unrelated.arn, address: unrelated.address, cleanupStepId: null }];
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(false);
});

it("does not narrow protection using a receipt that conflicts with the planned candidate", () => {
  const row = evidence("lightsail.static-ip.attach");
  row.receipt = { allocationId: "a-different-candidate" };
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(true);
});

it("does not narrow protection using an unexpected action phase", () => {
  const row = evidence("lightsail.static-ip.release");
  row.plan.arguments.phase = "rotation";
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(true);
});

it("uses the persisted cleanup ownership snapshot and rejects conflicting evidence conservatively", () => {
  const row = evidence("lightsail.static-ip.release");
  row.plan.arguments.ownershipSnapshot = { accountId: slot.accountId, instanceId: slot.instanceId, interfaceId: slot.interfaceId, allocationId: original.allocationId, address: original.address, resourceId: original.resourceId };
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(false);
  row.plan.arguments.ownershipSnapshot = { ...row.plan.arguments.ownershipSnapshot as object, address: "203.0.113.99" };
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(true);
});

it.each(["lightsail.ipv6.disable", "lightsail.ipv6.enable"] as const)("valid %s steps do not protect static IPs", action => {
  const row = evidence(action);
  const v6slot = { ...slot, family: 6 as const, address: "2001:db8::1" };
  row.plan = makeRotationStep(action, { ...args, slot: v6slot, before: { ...args.before, interfaces: [{ id: "primary", addresses: [{ address: v6slot.address, family: 6, primary: true }] }] } }, 0);
  expect(unresolvedRotationProtectsIdleIp(unrelated, row)).toBe(false);
});

it.each([
  { plan: null },
  { plan: { action: "unknown", arguments: {} } },
  { attemptId: "wrong-attempt" },
  { instanceId: "wrong-instance" },
  { receipt: "malformed" },
  { resources: "malformed" },
  { resources: [{ role: "unknown" }] },
])("keeps malformed unresolved evidence conservative: %j", patch => {
  expect(unresolvedRotationProtectsIdleIp(unrelated, { ...evidence("lightsail.static-ip.release"), ...patch })).toBe(true);
});

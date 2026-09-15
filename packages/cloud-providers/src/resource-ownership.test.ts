import { expect, it } from "vitest";
import * as providers from "./index.js";

const step = { id: "a", action: "ec2.eip.allocate", resourceKey: "x", destructive: false, arguments: { phase: "rotation", attemptId: "attempt-1", slot: { accountId: "local", service: "ec2", region: "us-east-1", instanceId: "i-one", slotId: "v4", interfaceId: "eni-one", address: "198.51.100.1", family: 4 }, before: { ref: { accountId: "local", service: "ec2", region: "us-east-1", instanceId: "i-one" }, interfaces: [] } } };
it("requires all ownership tags and refuses conflicting attachments", () => {
  const tags = [{ Key: "masterdns:attempt", Value: "attempt-1" }, { Key: "masterdns:account", Value: "local" }, { Key: "masterdns:instance", Value: "i-one" }, { Key: "masterdns:slot", Value: "v4" }];
  expect(providers.ownsRotationAddress(step, { Tags: tags })).toBe(true);
  expect(providers.ownsRotationAddress(step, { Tags: tags.slice(1) })).toBe(false);
  expect(providers.ownsRotationAddress(step, { Tags: tags, NetworkInterfaceId: "eni-other" })).toBe(false);
  expect(providers.ownsRotationAddress(step, { Tags: tags, InstanceId: "i-other" })).toBe(false);
});
it("uses lossless attempt names and rejects unsafe names instead of colliding sanitization", () => {
  expect(providers.rotationResourceName(step)).toBe("masterdns-attempt-1");
  expect(() => providers.rotationResourceName({ ...step, arguments: { ...step.arguments, attemptId: "attempt/1" } })).toThrow();
});

it("rejects corrupt durable step identities before reaching the cloud", async () => {
  const calls: string[] = [];
  const cloud = new providers.Ec2CloudAdapter("local", { kind: "access_key", accessKeyId: "fake", secretAccessKey: "fake" }, { ec2Send: async c => { calls.push(c.constructor.name); return {}; } });
  const malformed = { ...step, arguments: { ...step.arguments, slot: { ...step.arguments.slot, region: "" }, before: { ...step.arguments.before, ref: { ...step.arguments.before.ref, region: "" } } } };
  await expect(cloud.execute(malformed)).rejects.toMatchObject({ code: "invalid_rotation_step" });
  expect(calls).toEqual([]);
});

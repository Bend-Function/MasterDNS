import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { healthPolicyInputSchema } from "./health-policies.schemas.js";

it("requires external authority for cloud slots but preserves local endpoint policies", () => {
  const input = { slotId: randomUUID(), family: "4", configId: randomUUID(), mode: "local" };
  expect(healthPolicyInputSchema.safeParse(input).success).toBe(false);
  expect(healthPolicyInputSchema.safeParse({ ...input, slotId: undefined, endpointId: randomUUID() }).success).toBe(true);
  expect(healthPolicyInputSchema.safeParse({ ...input, mode: "external", groupId: randomUUID() }).success).toBe(true);
});

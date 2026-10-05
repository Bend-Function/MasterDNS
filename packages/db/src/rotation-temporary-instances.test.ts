import { describe, expect, it } from "vitest";
import { linodeTemporaryInstanceProof, publicRotationTemporaryInstances } from "./rotation-temporary-instances.js";

const temporaryInstance = { id: "43", targetInstanceId: "42", accountId: "local-account", externalAccountId: "provider-account", region: "us-east", attemptId: "attempt-1", label: "masterdns-swap-test", created: "2026-10-04T00:00:00Z", originalAddress: "192.0.2.1", type: "g6-nanode-1" };

describe("temporary rotation instance evidence", () => {
  it("rejects a helper aliasing the production instance or malformed evidence", () => {
    expect(linodeTemporaryInstanceProof({ after: { temporaryInstance: { ...temporaryInstance, id: "42" } } })).toBeUndefined();
    expect(linodeTemporaryInstanceProof({ after: { temporaryInstance: { ...temporaryInstance, originalAddress: "invalid" } } })).toBeUndefined();
    expect(linodeTemporaryInstanceProof({ after: { temporaryInstance } })).toEqual(temporaryInstance);
  });
  it("shows pre-swap retained instances and redacts account and unrelated receipt metadata", () => {
    const receipt = { after: { temporaryInstance, secret: "hidden" } };
    const result = publicRotationTemporaryInstances([{ attemptId: "attempt-1", receipt }], []);
    expect(result).toEqual([{ id: "43", label: temporaryInstance.label, region: "us-east", attemptId: "attempt-1", originalAddress: "192.0.2.1", cleanupStatus: "retained" }]);
    expect(JSON.stringify(result)).not.toMatch(/hidden|externalAccountId|accountId/);
  });
  it("deduplicates helper observations and follows the matching original cleanup resource", () => {
    const receipt = { after: { temporaryInstance: { ...temporaryInstance, candidateAddress: "192.0.2.2" } } };
    const result = publicRotationTemporaryInstances([{ attemptId: "attempt-1", receipt }, { attemptId: "attempt-1", receipt }], [{ attemptId: "attempt-1", role: "original", snapshot: { linodeSwapReceipt: receipt }, cleanupStatus: "pending" }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "43", candidateAddress: "192.0.2.2", cleanupStatus: "pending" });
  });
  it("omits deleted helpers from the active temporary-instance list", () => {
    const receipt = { after: { temporaryInstance } };
    expect(publicRotationTemporaryInstances([{ attemptId: "attempt-1", receipt }], [{ attemptId: "attempt-1", role: "original", snapshot: { linodeSwapReceipt: receipt }, cleanupStatus: "released" }])).toEqual([]);
  });
});

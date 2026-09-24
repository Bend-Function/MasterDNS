import { demoNow } from "./demo";
import { demoCloudTarget } from "./cloud-demo";
import type { RotationDetail, RotationIncident, RotationPolicy } from "./rotation-types";

export const demoRotationPolicy: RotationPolicy = { slotId: "slot-v4", enabled: true, revision: 2, maxAttempts: 3, minIntervalSeconds: 60, cloudWaitSeconds: 120, candidateWindowSeconds: 180, updatedAt: demoNow };
export const demoRotations: RotationIncident[] = [{ cloudTarget: { ...demoCloudTarget, slot: { ...demoCloudTarget.slot, candidateVersion: 3 }, candidateAddress: { id: "address-new", address: "203.0.113.44" } }, id: "rotation-01", ownerUserId: "user-1", slotId: "slot-v4", family: "4", sourceEventId: "scheduled-2-preview", trigger: "scheduled", status: "active", phase: "candidate", currentSegmentId: "segment-1", currentAttemptId: "attempt-1", addressVersion: 2, nextAttemptAt: demoNow, nextRunAt: demoNow, candidateDeadline: demoNow, errorCode: null, createdAt: demoNow, updatedAt: demoNow, completedAt: null }];
export const demoRotationDetail: RotationDetail = {
  incident: demoRotations[0]!, instanceId: "cloud-instance-1",
  addresses: { observedCloud: { addresses: ["203.0.113.44"], observedAt: demoNow, source: "rotation_observation" }, candidate: { id: "address-new", address: "203.0.113.44", version: 3, verified: false }, lastVerified: { id: "address-v4", address: "203.0.113.18", version: 2, cloudState: "not_observed", verifiedNow: false }, published: [{ zoneId: "zone-1", fqdn: "api.example.com", recordType: "A", address: "203.0.113.18", status: "observed", lastObservedAt: demoNow }] },
  segments: [{ id: "segment-1", maxAttempts: 3, attemptsUsed: 1, exhausted: false, createdAt: demoNow }],
  attempts: [{ id: "attempt-1", segmentId: "segment-1", sequence: 1, status: "candidate", charged: true, chargedAt: demoNow, candidateAddressId: "address-new", candidateVersion: 3, candidateRepeated: false }],
  steps: [{ id: "attempt-1:0:allocate", attemptId: "attempt-1", sequence: 0, status: "applied", errorCode: null, dispatchedAt: demoNow, observeDeadline: null, retryAt: null }],
  resources: [{ id: "resource-original", attemptId: "attempt-1", addressId: "address-v4", address: "203.0.113.18", role: "original", origin: "user", cleanupStatus: "retained", cleanupDueAt: null, cleanupError: null, cleanupStepId: null }, { id: "resource-candidate", attemptId: "attempt-1", addressId: "address-new", address: "203.0.113.44", role: "candidate", origin: "system", cleanupStatus: "retained", cleanupDueAt: null, cleanupError: null, cleanupStepId: null }],
  publications: [{ id: "publication-1", addressId: "address-v4", addressVersion: 2, status: "applied", operationId: "operation-1", children: [{ poolId: "pool-1", eventId: "event-1", policyRevision: 3, decisionRevision: 2, operationId: "operation-1" }], errorCode: null, updatedAt: demoNow }],
};

export const demoPausedRotation: RotationIncident = { ...demoRotations[0]!, id: "rotation-paused", slotId: "linode-4", status: "paused", errorCode: "manual_pause", cloudTarget: { ...demoCloudTarget, account: { id: "linode-account", name: "Linode Production", provider: "linode" }, instance: { ...demoCloudTarget.instance, id: "linode", name: "edge-linode-06", externalId: "linode-vm", service: "linode", region: "ap-south" }, slot: { ...demoCloudTarget.slot, id: "linode-4" } } };
demoRotations.push(demoPausedRotation);
export function previewRotationDetail(id: string): RotationDetail { return { ...demoRotationDetail, incident: demoRotations.find(incident => incident.id === id) ?? demoRotationDetail.incident }; }

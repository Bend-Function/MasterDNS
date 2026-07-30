import type { Delivery, Operation, Pool, PoolDetail, ProviderAccount, User, ZoneListRow } from "./types";

export const demoNow = "2026-07-30T04:55:00.000Z";
const now = demoNow;
export const demoUser: User = { id: "demo-admin", username: "admin", email: "ops@example.internal", role: "admin", status: "active", createdAt: now };
export const demoAccounts: ProviderAccount[] = [
  { id: "acct-cf", ownerUserId: demoUser.id, provider: "cloudflare", name: "Cloudflare Production", credentialHint: "API Token", status: "active", errorCode: null, lastVerifiedAt: now, lastSyncedAt: now, createdAt: now },
  { id: "acct-ali", ownerUserId: demoUser.id, provider: "aliyun", name: "AliDNS Global", credentialHint: "AccessKey ...8F2A", status: "active", errorCode: null, lastVerifiedAt: now, lastSyncedAt: now, createdAt: now },
];
export const demoZones: ZoneListRow[] = [
  { zone: { id: "zone-1", providerAccountId: "acct-cf", nameAscii: "edge.example.com", status: "active", lastSyncedAt: now }, accountName: "Cloudflare Production", provider: "cloudflare", ownerUserId: demoUser.id },
  { zone: { id: "zone-2", providerAccountId: "acct-ali", nameAscii: "service.example.cn", status: "active", lastSyncedAt: now }, accountName: "AliDNS Global", provider: "aliyun", ownerUserId: demoUser.id },
];
export const demoPools: Pool[] = [
  { id: "pool-1", ownerUserId: demoUser.id, name: "Public edge pool", description: "Global public endpoints", strategy: "assignment_pool", selectionMode: "least_assigned", recoveryMode: "keep_current", recoveryDelaySeconds: 0, failureThreshold: 3, successThreshold: 3, checkIntervalSeconds: 15, checkTimeoutMs: 3000, switchCooldownSeconds: 300, allDownReminderSeconds: 1800, state: "degraded", policyRevision: 12, enabled: true, lastReconciledAt: now, endpointCount: 4, healthyEndpointCount: 3, bindingCount: 10 },
  { id: "pool-2", ownerUserId: demoUser.id, name: "API primary / backup", description: null, strategy: "primary_backup", selectionMode: "ordered", recoveryMode: "automatic", recoveryDelaySeconds: 0, failureThreshold: 3, successThreshold: 3, checkIntervalSeconds: 15, checkTimeoutMs: 3000, switchCooldownSeconds: 300, allDownReminderSeconds: 1800, state: "healthy", policyRevision: 5, enabled: true, lastReconciledAt: now, endpointCount: 2, healthyEndpointCount: 2, bindingCount: 2 },
];
export const demoOperations: Operation[] = [
  { id: "op-1", ownerUserId: demoUser.id, actorUserId: null, source: "failover", resourceType: "endpoint_pool", resourceId: "pool-1", status: "succeeded", errorCode: null, createdAt: now, startedAt: now, finishedAt: now },
  { id: "op-2", ownerUserId: demoUser.id, actorUserId: demoUser.id, source: "user", resourceType: "dns_record", resourceId: "record-2", status: "running", errorCode: null, createdAt: now, startedAt: now, finishedAt: null },
];
export const demoPoolDetail: PoolDetail = {
  pool: demoPools[0]!,
  endpoints: [
    { id: "ep-1", poolId: "pool-1", name: "Auckland 01", addressMode: "static", priority: 10, lifecycle: "enabled", healthState: "healthy", consecutiveSuccesses: 81, consecutiveFailures: 0, lastCheckedAt: now, stateChangedAt: now, addresses: [{ id: "addr-1", endpointId: "ep-1", family: "4", address: "203.0.113.11", state: "current", source: "static", observedAt: now, promotedAt: now }] },
    { id: "ep-2", poolId: "pool-1", name: "Singapore 02", addressMode: "ddns", priority: 20, lifecycle: "enabled", healthState: "unhealthy", consecutiveSuccesses: 0, consecutiveFailures: 4, lastCheckedAt: now, stateChangedAt: now, addresses: [{ id: "addr-2", endpointId: "ep-2", family: "4", address: "198.51.100.24", state: "current", source: "ddns", observedAt: now, promotedAt: now }] },
    { id: "ep-3", poolId: "pool-1", name: "Tokyo 03", addressMode: "static", priority: 30, lifecycle: "enabled", healthState: "healthy", consecutiveSuccesses: 56, consecutiveFailures: 0, lastCheckedAt: now, stateChangedAt: now, addresses: [{ id: "addr-3", endpointId: "ep-3", family: "4", address: "192.0.2.37", state: "current", source: "static", observedAt: now, promotedAt: now }] },
  ],
  bindings: [
    { id: "bind-1", poolId: "pool-1", zoneId: "zone-1", zoneName: "edge.example.com", provider: "cloudflare", fqdn: "api.edge.example.com", recordType: "A", ttl: 60, providerMetadata: { proxied: false }, originalEndpointId: "ep-2", desiredRevision: 12, state: "healthy", assignments: [{ endpointId: "ep-3", desired: true, applied: true, dnsRecordId: "record-1", reason: "failure" }] },
    { id: "bind-2", poolId: "pool-1", zoneId: "zone-2", zoneName: "service.example.cn", provider: "aliyun", fqdn: "app.service.example.cn", recordType: "A", ttl: 60, providerMetadata: { line: "default", status: "Enable" }, originalEndpointId: "ep-1", desiredRevision: 12, state: "healthy", assignments: [{ endpointId: "ep-1", desired: true, applied: true, dnsRecordId: "record-2", reason: "configuration" }] },
  ],
  healthChecks: [{ id: "check-1", poolId: "pool-1", endpointId: null, domainBindingId: null, checkerType: "http", config: { type: "http", protocol: "https", path: "/health", timeoutMs: 3000 }, enabled: true, revision: 1 }],
  healthResults: [{ result: { id: "res-1", endpointId: "ep-2", success: false, latencyMs: 3001, statusCode: null, errorCode: "etimedout", checkedAt: now }, endpointName: "Singapore 02" }],
  events: [{ id: "event-1", eventType: "pool.failure", createdAt: now, evidence: { endpointId: "ep-2" }, decision: { replacement: "ep-3" } }],
  policyVersions: [{ id: "ver-12", version: 12, reason: "endpoint.update", createdAt: now }, { id: "ver-11", version: 11, reason: "binding.create", createdAt: now }],
};
export const demoDeliveries: Delivery[] = [{ delivery: { id: "del-1", eventId: "evt-1", status: "delivered", attempts: 1, durationMs: 184, responseStatus: 200, errorCode: null, deliveredAt: now, createdAt: now }, channelName: "Ops webhook", channelType: "webhook" }];

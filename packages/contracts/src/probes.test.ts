import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isProbeOnline,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  leaseRequestSchema,
  leaseResponseSchema,
  probeResultSchema,
  probeTaskSchema,
  resultAckSchema,
  resultBatchSchema,
} from "./probes.js";

describe("probe liveness", () => {
  const now = new Date("2026-09-15T01:00:00Z");
  const probe = { enabled: true, revokedAt: null, lastSeenAt: now };

  it("excludes never-seen, expired, disabled and revoked probes", () => {
    expect(isProbeOnline({ ...probe, lastSeenAt: null }, now)).toBe(false);
    expect(isProbeOnline({ ...probe, lastSeenAt: new Date(now.getTime() - 90_001) }, now)).toBe(false);
    expect(isProbeOnline({ ...probe, enabled: false }, now)).toBe(false);
    expect(isProbeOnline({ ...probe, revokedAt: now }, now)).toBe(false);
  });

  it("accepts a fresh heartbeat at the 90-second boundary and after recovery", () => {
    expect(isProbeOnline({ ...probe, lastSeenAt: new Date(now.getTime() - 90_000).toISOString() }, now)).toBe(true);
    expect(isProbeOnline(probe, now)).toBe(true);
  });
});

const taskFixture: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/contracts/fixtures/probe-task-v1.json", import.meta.url)), "utf8"),
);
const resultFixture: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/contracts/fixtures/probe-result-v1.json", import.meta.url)), "utf8"),
);

describe("probe-agent/v1 contracts", () => {
  it("parses the published task and result fixtures", () => {
    const task = probeTaskSchema.parse(taskFixture);
    const result = probeResultSchema.parse(resultFixture);

    expect(task).toMatchObject({ address: "192.0.2.10", family: 4, config: { type: "tcp", port: 443, timeoutMs: 3000 } });
    expect(result).toMatchObject({ taskId: task.taskId, leaseId: task.leaseId, addressVersion: 1, configVersion: 1, outcome: "success" });
  });

  it.each([
    ["an IPv4 address declared as IPv6", { family: 6 }],
    ["an IPv6 address declared as IPv4", { family: 4, address: "2001:db8::10" }],
    ["an unknown protocol version", { protocol: "probe-agent/v2" }],
  ])("rejects %s", (_name, replacement) => {
    expect(probeTaskSchema.safeParse({ ...(taskFixture as object), ...replacement }).success).toBe(false);
  });

  it.each([
    ["negative latency", -1],
    ["NaN latency", Number.NaN],
  ])("rejects %s", (_name, latencyMs) => {
    expect(probeResultSchema.safeParse({ ...(resultFixture as object), latencyMs }).success).toBe(false);
  });

  it("bounds result error strings", () => {
    expect(probeResultSchema.safeParse({ ...(resultFixture as object), outcome: "failure", errorCode: "E".repeat(129) }).success).toBe(false);
  });

  it("rejects unknown fields at the wire boundary", () => {
    expect(probeTaskSchema.safeParse({ ...(taskFixture as object), unexpected: true }).success).toBe(false);
    expect(probeResultSchema.safeParse({ ...(resultFixture as object), unexpected: true }).success).toBe(false);
  });

  it("validates heartbeat and lease payload limits", () => {
    expect(heartbeatRequestSchema.safeParse({
      protocol: "probe-agent/v1",
      agentVersion: "1.0.0",
      capabilities: { ipv4: true, ipv6: false },
      maxConcurrency: 8,
    }).success).toBe(true);
    expect(leaseRequestSchema.safeParse({ protocol: "probe-agent/v1", capacity: 0 }).success).toBe(false);
  });

  it("accepts only an empty heartbeat response object", () => {
    expect(heartbeatResponseSchema.safeParse({}).success).toBe(true);
    expect(heartbeatResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("limits result batches to 100 observations", () => {
    expect(resultBatchSchema.safeParse({ protocol: "probe-agent/v1", results: Array.from({ length: 101 }, () => resultFixture) }).success).toBe(false);
  });

  it("validates lease responses and per-task acknowledgements", () => {
    const task = probeTaskSchema.parse(taskFixture);
    expect(leaseResponseSchema.safeParse({ serverTime: "2026-09-15T11:59:55.000Z", tasks: [task], retryAfterMs: 1000 }).success).toBe(true);
    expect(resultAckSchema.safeParse({ taskId: task.taskId, status: "duplicate" }).success).toBe(true);
    expect(resultAckSchema.safeParse({ taskId: task.taskId, status: "invalid" }).success).toBe(false);
  });

  it("permits private ranges only when the task contains an explicit CIDR allowlist", () => {
    expect(probeTaskSchema.safeParse({ ...(taskFixture as object), address: "10.0.0.10" }).success).toBe(false);
    expect(probeTaskSchema.safeParse({
      ...(taskFixture as object),
      address: "10.0.0.10",
      networkPolicy: { allowedPrivateCIDRs: ["10.0.0.0/24"] },
    }).success).toBe(true);
    expect(probeTaskSchema.safeParse({
      ...(taskFixture as object),
      address: "10.0.0.10",
      networkPolicy: { allowedPrivateCIDRs: [] },
    }).success).toBe(false);
  });

  it.each([
    ["IPv4-mapped IPv6 with dotted notation", "::ffff:127.0.0.1"],
    ["IPv4-mapped IPv6 with hexadecimal notation", "::ffff:7f00:1"],
    ["mapped private IPv4", "::ffff:10.0.0.1"],
  ])("rejects %s", (_name, address) => {
    expect(probeTaskSchema.safeParse({
      ...(taskFixture as object),
      address,
      family: 6,
      networkPolicy: { allowedPrivateCIDRs: ["::/0"] },
    }).success).toBe(false);
  });

  it("accepts a non-mapped IPv6 address with an embedded dotted tail", () => {
    expect(probeTaskSchema.safeParse({
      ...(taskFixture as object),
      address: "2001:db8::192.0.2.10",
      family: 6,
    }).success).toBe(true);
  });

  it.each([
    ["IPv4 loopback", "127.0.0.1", 4, "127.0.0.0/8"],
    ["cloud metadata/link-local IPv4", "169.254.169.254", 4, "169.254.0.0/16"],
    ["IPv6 loopback", "::1", 6, "::1/128"],
    ["IPv6 link-local", "fe80::1", 6, "fe80::/10"],
    ["IPv6 multicast", "ff02::1", 6, "ff00::/8"],
  ])("permanently rejects %s even with a matching allowlist", (_name, address, family, cidr) => {
    expect(probeTaskSchema.safeParse({
      ...(taskFixture as object),
      address,
      family,
      networkPolicy: { allowedPrivateCIDRs: [cidr] },
    }).success).toBe(false);
  });

  it.each([
    ["AWS IPv6 metadata", "fd00:ec2::254", 6, "fc00::/7"],
    ["Alibaba IPv4 metadata", "100.100.100.200", 4, "100.64.0.0/10"],
  ])("permanently rejects %s even when its private range is allowed", (_name, address, family, cidr) => {
    expect(probeTaskSchema.safeParse({
      ...(taskFixture as object),
      address,
      family,
      networkPolicy: { allowedPrivateCIDRs: [cidr] },
    }).success).toBe(false);
  });
});

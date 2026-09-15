import { z } from "zod";
import { httpCheckConfigSchema, tcpCheckConfigSchema } from "./health.js";

export const probeProtocolSchema = z.literal("probe-agent/v1");
export const addressFamilySchema = z.union([z.literal(4), z.literal(6)]);
export const probeOutcomeSchema = z.enum(["success", "failure", "unavailable"]);

const uuidSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const versionSchema = z.number().int().min(1);
const ipv4Schema = z.ipv4();
const ipv6Schema = z.ipv6();
const cidrSchema = z.union([z.cidrv4(), z.cidrv6()]);
const probeHealthCheckConfigSchema = z.discriminatedUnion("type", [
  httpCheckConfigSchema.strict(),
  tcpCheckConfigSchema.strict(),
]);

const networkPolicySchema = z.object({
  allowedPrivateCIDRs: z.array(cidrSchema).min(1).max(64),
}).strict();

export const probeTaskSchema = z.object({
  protocol: probeProtocolSchema,
  taskId: uuidSchema,
  roundId: uuidSchema,
  probeId: uuidSchema,
  leaseId: uuidSchema,
  addressVersion: versionSchema,
  configVersion: versionSchema,
  address: z.union([ipv4Schema, ipv6Schema]),
  family: addressFamilySchema,
  hostname: z.string().trim().min(1).max(255).optional(),
  config: probeHealthCheckConfigSchema,
  deadline: timestampSchema,
  networkPolicy: networkPolicySchema.optional(),
}).strict().superRefine((task, context) => {
  const expectedFamily = ipv4Schema.safeParse(task.address).success ? 4 : 6;
  if (task.family !== expectedFamily) {
    context.addIssue({ code: "custom", path: ["address"], message: `address must be IPv${task.family}` });
  }

  if (isPermanentlyForbiddenAddress(task.address, task.family)) {
    context.addIssue({ code: "custom", path: ["address"], message: "address is not a permitted probe target" });
  } else if (requiresPrivateAllowlist(task.address, task.family)) {
    const allowed = task.networkPolicy?.allowedPrivateCIDRs.some((cidr) => cidrContains(cidr, task.address)) ?? false;
    if (!allowed) {
      context.addIssue({ code: "custom", path: ["address"], message: "restricted address is not explicitly allowed" });
    }
  }
});

export const probeResultSchema = z.object({
  protocol: probeProtocolSchema,
  taskId: uuidSchema,
  leaseId: uuidSchema,
  addressVersion: versionSchema,
  configVersion: versionSchema,
  outcome: probeOutcomeSchema,
  latencyMs: z.number().finite().nonnegative().max(60_000),
  measuredAt: timestampSchema,
  statusCode: z.number().int().min(100).max(599).optional(),
  errorCode: z.string().trim().min(1).max(128).optional(),
}).strict();

export const exchangeRequestSchema = z.object({ installToken: z.string().trim().min(1).max(2048) }).strict();
export const exchangeResponseSchema = z.object({
  probeId: uuidSchema,
  runtimeToken: z.string().trim().min(1).max(2048),
  protocol: probeProtocolSchema,
}).strict();

export const heartbeatRequestSchema = z.object({
  protocol: probeProtocolSchema,
  agentVersion: z.string().trim().min(1).max(64),
  capabilities: z.object({ ipv4: z.boolean(), ipv6: z.boolean() }).strict(),
  maxConcurrency: z.number().int().min(1).max(1_000),
}).strict();

export const heartbeatResponseSchema = z.object({}).strict();

export const leaseRequestSchema = z.object({
  protocol: probeProtocolSchema,
  capacity: z.number().int().min(1).max(100),
}).strict();

export const leaseResponseSchema = z.object({
  serverTime: timestampSchema,
  tasks: z.array(probeTaskSchema).max(100),
  retryAfterMs: z.number().int().nonnegative().max(3_600_000),
}).strict();

export const resultBatchSchema = z.object({
  protocol: probeProtocolSchema,
  results: z.array(probeResultSchema).min(1).max(100),
}).strict();

export const resultAckSchema = z.object({
  taskId: uuidSchema,
  status: z.enum(["accepted", "duplicate", "stale", "rejected"]),
}).strict();

export const resultBatchAckSchema = z.object({ results: z.array(resultAckSchema).max(100) }).strict();

export type ProbeOutcome = z.infer<typeof probeOutcomeSchema>;
export type ProbeTask = z.infer<typeof probeTaskSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type LeaseResponse = z.infer<typeof leaseResponseSchema>;
export type ResultAck = z.infer<typeof resultAckSchema>;

function isPermanentlyForbiddenAddress(address: string, family: 4 | 6): boolean {
  const ranges = family === 4
    ? ["0.0.0.0/8", "100.100.100.200/32", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4"]
    : ["::/128", "::1/128", "fd00:ec2::254/128", "fe80::/10", "ff00::/8"];
  return isIpv4MappedIpv6(address, family) || ranges.some((cidr) => cidrContains(cidr, address));
}

function requiresPrivateAllowlist(address: string, family: 4 | 6): boolean {
  const ranges = family === 4
    ? ["10.0.0.0/8", "100.64.0.0/10", "172.16.0.0/12", "192.168.0.0/16"]
    : ["fc00::/7"];
  return ranges.some((cidr) => cidrContains(cidr, address));
}

function isIpv4MappedIpv6(address: string, family: 4 | 6): boolean {
  if (family !== 6) return false;
  return cidrContains("::ffff:0:0/96", address);
}

function cidrContains(cidr: string, address: string): boolean {
  const [network, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const networkBytes = ipBytes(network!);
  const addressBytes = ipBytes(address);
  if (!networkBytes || !addressBytes || networkBytes.length !== addressBytes.length) return false;

  const completeBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  for (let index = 0; index < completeBytes; index += 1) {
    if (networkBytes[index] !== addressBytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (networkBytes[completeBytes]! & mask) === (addressBytes[completeBytes]! & mask);
}

function ipBytes(address: string): number[] | undefined {
  if (address.includes(".")) {
    const ipv4 = address.slice(address.lastIndexOf(":") + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    if (!address.includes(":")) return ipv4;
    const hexTail = `${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
    return ipBytes(`${address.slice(0, address.lastIndexOf(":") + 1)}${hexTail}`);
  }

  const [leftText, rightText] = address.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  if (!address.includes("::") && left.length !== 8) return undefined;
  const groups = address.includes("::")
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

import { z } from "zod";

export const healthStateSchema = z.enum(["unknown", "healthy", "degraded", "unhealthy", "recovering"]);
export type HealthState = z.infer<typeof healthStateSchema>;

export const checkTargetSchema = z.object({
  address: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  hostname: z.string().trim().min(1).optional(),
  family: z.union([z.literal(4), z.literal(6)]).optional(),
});
export type CheckTarget = z.infer<typeof checkTargetSchema>;

export const httpCheckConfigSchema = z.object({
  type: z.literal("http"),
  protocol: z.enum(["http", "https"]).default("https"),
  port: z.number().int().min(1).max(65535).optional(),
  hostname: z.string().trim().min(1).max(255).optional(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  path: z.string().startsWith("/").default("/"),
  headers: z.record(z.string(), z.string()).default({}),
  expectedStatuses: z.array(z.number().int().min(100).max(599)).optional(),
  expectedStatusMin: z.number().int().min(100).max(599).default(200),
  expectedStatusMax: z.number().int().min(100).max(599).default(399),
  bodyContains: z.string().max(2048).optional(),
  bodyPattern: z.string().max(2048).refine(isValidRegularExpression, "响应正文正则表达式不合法").optional(),
  followRedirects: z.boolean().default(true),
  verifyTls: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(60_000).default(3000),
});
export type HttpCheckConfig = z.infer<typeof httpCheckConfigSchema>;

export const tcpCheckConfigSchema = z.object({
  type: z.literal("tcp"),
  port: z.number().int().min(1).max(65535),
  timeoutMs: z.number().int().min(100).max(60_000).default(3000),
});
export type TcpCheckConfig = z.infer<typeof tcpCheckConfigSchema>;

export const healthCheckConfigSchema = z.discriminatedUnion("type", [httpCheckConfigSchema, tcpCheckConfigSchema]);
export type HealthCheckConfig = z.infer<typeof healthCheckConfigSchema>;

export type CheckResult = {
  success: boolean;
  latencyMs: number;
  checkedAt: Date;
  statusCode?: number;
  errorCode?: string;
  errorDetail?: string;
};

export type HealthObservation = {
  state: HealthState;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
};

function isValidRegularExpression(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

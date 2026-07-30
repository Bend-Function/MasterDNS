import { z } from "zod";

export const env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  PGHOST: z.string().min(1).optional(),
  PGPORT: z.coerce.number().int().min(1).max(65535).optional(),
  PGDATABASE: z.string().min(1).optional(),
  PGUSER: z.string().min(1).optional(),
  PGPASSWORD: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  HEALTH_RAW_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  HEALTH_STATS_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  PROVIDER_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  PROVIDER_SYNC_SCAN_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  ALLOW_PRIVATE_HEALTH_TARGETS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ALLOW_PRIVATE_WEBHOOK_TARGETS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
}).superRefine((value, context) => {
  if (value.DATABASE_URL || (value.PGHOST && value.PGDATABASE && value.PGUSER && value.PGPASSWORD)) return;
  context.addIssue({ code: "custom", message: "DATABASE_URL or complete PGHOST/PGDATABASE/PGUSER/PGPASSWORD settings are required" });
}).parse(process.env);

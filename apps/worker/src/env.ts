import { z } from "zod";

export const env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  HEALTH_RAW_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  HEALTH_STATS_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  PROVIDER_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  PROVIDER_SYNC_SCAN_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
}).parse(process.env);

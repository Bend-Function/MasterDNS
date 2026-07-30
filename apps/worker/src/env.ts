import { z } from "zod";

export const env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
}).parse(process.env);

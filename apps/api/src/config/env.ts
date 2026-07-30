import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUSTED_PROXY_CIDRS: z.string().default("127.0.0.1/32,::1/128"),
});

const parsed = schema.parse(process.env);
export const env = { ...parsed, TRUST_PROXY: parsed.TRUSTED_PROXY_CIDRS.split(",").map((value) => value.trim()).filter(Boolean) };

import { isIP } from "node:net";
import { z } from "zod";

export const exchangeSchema = z.object({ installToken: z.string().min(32).max(256) });

export const heartbeatSchema = z.object({
  ipv4: z.union([z.string().refine((value) => isIP(value) === 4, "IPv4 地址不合法"), z.null()]).optional(),
  ipv6: z.union([z.string().refine((value) => isIP(value) === 6, "IPv6 地址不合法"), z.null()]).optional(),
  hostname: z.string().trim().min(1).max(255).optional(),
  agentVersion: z.string().trim().min(1).max(40).optional(),
});

export const installTokenSchema = z.object({ expiresInSeconds: z.number().int().min(60).max(3600).default(900) });

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

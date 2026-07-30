import { createHash } from "node:crypto";
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { QueueService } from "../infrastructure/queue.module.js";
import type { AuthUser } from "./auth.types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly queues: QueueService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { currentUser?: AuthUser }>();
    const route = request.routeOptions.url ?? request.url;
    const category = limitFor(request, route);
    if (!category) return true;
    const count = await this.queues.incrementRateLimit(`masterdns:rate:${category.key}`, category.windowMs);
    if (count > category.limit) throw new HttpException("请求过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS);
    return true;
  }
}

function limitFor(request: FastifyRequest & { currentUser?: AuthUser }, route: string): { key: string; limit: number; windowMs: number } | null {
  if (route.endsWith("/auth/login")) return { key: `login:${request.ip}`, limit: 10, windowMs: 60_000 };
  if (route.includes("/ddns/heartbeat")) {
    const credential = request.headers.authorization ?? request.ip;
    return { key: `ddns:${digest(credential)}`, limit: 120, windowMs: 60_000 };
  }
  if (route.includes("/ddns/exchange")) return { key: `exchange:${request.ip}`, limit: 20, windowMs: 60_000 };
  if (SAFE_METHODS.has(request.method)) return null;
  return { key: `write:${request.currentUser?.id ?? request.ip}`, limit: 300, windowMs: 60_000 };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

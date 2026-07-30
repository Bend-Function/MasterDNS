import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { QueueService } from "../infrastructure/queue.module.js";
import type { AuthUser } from "./auth.types.js";
import { rateLimitPolicyFor } from "./rate-limit-policy.js";

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly queues: QueueService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { currentUser?: AuthUser }>();
    const route = request.routeOptions.url ?? request.url;
    const policy = rateLimitPolicyFor(request, route);
    if (!policy) return true;
    const categories = Array.isArray(policy) ? policy : [policy];
    for (const category of categories) {
      const count = await this.queues.incrementRateLimit(`masterdns:rate:${category.key}`, category.windowMs);
      if (count > category.limit) throw new HttpException("请求过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}

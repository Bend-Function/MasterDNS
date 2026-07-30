import { randomUUID } from "node:crypto";
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { QueueService } from "../infrastructure/queue.module.js";
import type { AuthUser } from "./auth.types.js";

const SSE_CONNECTION_LIMIT = 5;
const SSE_LEASE_TTL_MS = 75_000;
const SSE_LEASE_RENEW_MS = 30_000;

@Injectable()
export class SseConcurrencyGuard implements CanActivate {
  constructor(private readonly queues: QueueService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { currentUser?: AuthUser }>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const actor = request.currentUser;
    if (!actor) throw new UnauthorizedException("请先登录");

    const key = `masterdns:sse:${actor.id}`;
    const member = randomUUID();
    if (!(await this.queues.acquireConcurrencyLease(key, member, SSE_CONNECTION_LIMIT, SSE_LEASE_TTL_MS))) {
      throw new HttpException("事件连接过多，请关闭其他页面后重试", HttpStatus.TOO_MANY_REQUESTS);
    }

    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      clearInterval(renewal);
      reply.raw.off("finish", cleanup);
      reply.raw.off("close", cleanup);
      void this.queues.releaseConcurrencyLease(key, member).catch(() => undefined);
    };
    const renewal = setInterval(() => {
      void this.queues.renewConcurrencyLease(key, member, SSE_LEASE_TTL_MS)
        .then((renewed) => {
          if (!renewed) reply.raw.destroy();
        })
        .catch(() => reply.raw.destroy());
    }, SSE_LEASE_RENEW_MS);
    renewal.unref();
    reply.raw.once("finish", cleanup);
    reply.raw.once("close", cleanup);
    return true;
  }
}

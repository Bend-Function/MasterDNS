import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { NON_BROWSER_ROUTE } from "./auth.decorators.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(NON_BROWSER_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const origin = request.headers.origin;
    if (origin !== env.WEB_URL) throw new ForbiddenException("请求来源校验失败");
    return true;
  }
}

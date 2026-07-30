import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { sessions, users } from "@masterdns/db";
import { hashToken } from "@masterdns/crypto";
import { DatabaseService } from "../infrastructure/database.module.js";
import { PUBLIC_ROUTE } from "./auth.decorators.js";
import type { AuthUser } from "./auth.types.js";

export const SESSION_COOKIE = "masterdns_session";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException("请先登录");
    const rows = await this.database.db
      .select({
        sessionId: sessions.id,
        sessionVersion: sessions.sessionVersion,
        userId: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        userSessionVersion: users.sessionVersion,
        userStatus: users.status,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row || row.userStatus !== "active" || row.sessionVersion !== row.userSessionVersion) throw new UnauthorizedException("登录已失效");
    const currentUser: AuthUser = { id: row.userId, username: row.username, email: row.email, role: row.role, sessionId: row.sessionId };
    (request as FastifyRequest & { currentUser: AuthUser }).currentUser = currentUser;
    return true;
  }
}

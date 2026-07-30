import { Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, or, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sessions, users } from "@masterdns/db";
import { createOpaqueToken, hashToken, verifyPassword } from "@masterdns/crypto";
import { DatabaseService } from "../infrastructure/database.module.js";
import { env } from "../config/env.js";
import { SESSION_COOKIE } from "./auth.guard.js";

const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  async login(identifier: string, password: string, request: FastifyRequest, reply: FastifyReply) {
    const normalized = identifier.trim().toLowerCase();
    const rows = await this.database.db.select().from(users).where(and(
      eq(users.status, "active"),
      or(sql`lower(${users.username}) = ${normalized}`, sql`lower(${users.email}) = ${normalized}`),
    )).limit(1);
    const user = rows[0];
    if (!user || !(await verifyPassword(user.passwordHash, password))) throw new UnauthorizedException("用户名或密码错误");
    const token = createOpaqueToken();
    const expiresAt = new Date(Date.now() + SESSION_AGE_SECONDS * 1000);
    await this.database.db.insert(sessions).values({
      userId: user.id,
      tokenHash: hashToken(token),
      sessionVersion: user.sessionVersion,
      expiresAt,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]?.slice(0, 512),
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_AGE_SECONDS,
    });
    return publicUser(user);
  }

  async logout(sessionId: string, reply: FastifyReply) {
    await this.database.db.delete(sessions).where(eq(sessions.id, sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { success: true };
  }
}

export function publicUser(user: typeof users.$inferSelect) {
  return { id: user.id, username: user.username, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt };
}

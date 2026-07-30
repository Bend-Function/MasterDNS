import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import { auditLogs, sessions, users } from "@masterdns/db";
import { hashPassword } from "@masterdns/crypto";
import type { AuthUser } from "../../auth/auth.types.js";
import { publicUser } from "../../auth/auth.service.js";
import { DatabaseService } from "../../infrastructure/database.module.js";

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async list(actor: AuthUser) {
    assertAdmin(actor);
    const rows = await this.database.db.select().from(users).orderBy(asc(users.username));
    return rows.map(publicUser);
  }

  async create(actor: AuthUser, input: { username: string; email?: string | undefined; password: string; role: "admin" | "user" }) {
    assertAdmin(actor);
    const existingUsername = await this.database.db.select({ id: users.id }).from(users)
      .where(sql`lower(${users.username}) = ${input.username.toLowerCase()}`).limit(1);
    if (existingUsername.length > 0) throw new ConflictException("用户名已存在");
    if (input.email) {
      const existingEmail = await this.database.db.select({ id: users.id }).from(users)
        .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`).limit(1);
      if (existingEmail.length > 0) throw new ConflictException("邮箱已被其他用户使用");
    }
    const [created] = await this.database.db.insert(users).values({
      username: input.username.trim(),
      email: input.email?.trim() || null,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    }).returning();
    if (!created) throw new Error("User insert returned no row");
    await this.audit(actor, "user.create", created.id, null, publicUser(created));
    return publicUser(created);
  }

  async setStatus(actor: AuthUser, userId: string, status: "active" | "disabled") {
    assertAdmin(actor);
    if (actor.id === userId && status === "disabled") throw new ConflictException("不能禁用当前登录的管理员");
    const [current] = await this.database.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!current) throw new NotFoundException("用户不存在");
    const [updated] = await this.database.db.update(users).set({
      status,
      sessionVersion: status === "disabled" ? current.sessionVersion + 1 : current.sessionVersion,
      updatedAt: new Date(),
    }).where(eq(users.id, userId)).returning();
    if (!updated) throw new Error("User update returned no row");
    if (status === "disabled") await this.database.db.delete(sessions).where(eq(sessions.userId, userId));
    await this.audit(actor, "user.status", userId, publicUser(current), publicUser(updated));
    return publicUser(updated);
  }

  async resetPassword(actor: AuthUser, userId: string, password: string) {
    assertAdmin(actor);
    const [current] = await this.database.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!current) throw new NotFoundException("用户不存在");
    await this.database.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(password), sessionVersion: current.sessionVersion + 1, updatedAt: new Date() }).where(eq(users.id, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    });
    await this.audit(actor, "user.password_reset", userId, null, { sessionsRevoked: true });
    return { success: true };
  }

  private async audit(actor: AuthUser, action: string, resourceId: string, before: unknown, after: unknown) {
    await this.database.db.insert(auditLogs).values({ ownerUserId: resourceId, actorUserId: actor.id, source: "user", action, resourceType: "user", resourceId, beforeSnapshot: before, afterSnapshot: after });
  }
}

function assertAdmin(actor: AuthUser) {
  if (actor.role !== "admin") throw new ForbiddenException("仅管理员可执行此操作");
}

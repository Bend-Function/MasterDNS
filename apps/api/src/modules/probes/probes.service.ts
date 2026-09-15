import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { heartbeatRequestSchema } from "@masterdns/contracts";
import { createOpaqueToken, hashToken } from "@masterdns/crypto";
import { probeAgents, probeTokens, probeGroups, probeGroupMembers, auditLogs } from "@masterdns/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { lockActiveProbe } from "./probe-agent-auth.js";

@Injectable()
export class ProbesService {
  constructor(private readonly database: DatabaseService) {}
  async list(actor: AuthUser) {
    return this.database.db.select().from(probeAgents).where(actor.role === "admin" ? undefined : eq(probeAgents.ownerUserId, actor.id));
  }
  async create(actor: AuthUser, input: { name: string; maxConcurrency: number }) {
    const [agent] = await this.database.db.insert(probeAgents).values({ ownerUserId: actor.id, ...input }).returning();
    return agent!;
  }
  async update(actor: AuthUser, id: string, input: { name?: string | undefined; maxConcurrency?: number | undefined; enabled?: boolean | undefined }) {
    return this.database.db.transaction(async tx => {
      const [agent] = await tx.select().from(probeAgents).where(eq(probeAgents.id, id)).for("update");
      if (!agent || (actor.role !== "admin" && agent.ownerUserId !== actor.id)) throw new NotFoundException("Probe not found");
      const [updated] = await tx.update(probeAgents).set({ ...input, updatedAt: new Date() }).where(eq(probeAgents.id, id)).returning();
      return updated!;
    });
  }
  async createInstallToken(actor: AuthUser, id: string, now = new Date()) {
    const installToken = createOpaqueToken(32);
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    await this.database.db.transaction(async tx => {
      const [agent] = await tx.select().from(probeAgents).where(eq(probeAgents.id, id)).for("update");
      if (!agent || (actor.role !== "admin" && agent.ownerUserId !== actor.id)) throw new NotFoundException("Probe not found");
      await tx.update(probeTokens).set({ revokedAt: now }).where(and(eq(probeTokens.probeId, id), eq(probeTokens.kind, "install"), isNull(probeTokens.revokedAt)));
      await tx.update(probeAgents).set({ enabled: true, revokedAt: null, updatedAt: now }).where(eq(probeAgents.id, id));
      await tx.insert(probeTokens).values({ probeId: id, kind: "install", tokenHash: hashToken(installToken), expiresAt, createdAt: now });
      await tx.insert(auditLogs).values({ ownerUserId: agent.ownerUserId, actorUserId: actor.id, source: "user", action: "probe.install_token.create", resourceType: "probe_agent", resourceId: id, afterSnapshot: { expiresAt } });
    });
    return { installToken, expiresAt };
  }
  async revoke(actor: AuthUser, id: string, now = new Date()) {
    return this.database.db.transaction(async tx => {
      const [agent] = await tx.select().from(probeAgents).where(eq(probeAgents.id, id)).for("update");
      if (!agent || (actor.role !== "admin" && agent.ownerUserId !== actor.id)) throw new NotFoundException("Probe not found");
      await tx.update(probeTokens).set({ revokedAt: now }).where(and(eq(probeTokens.probeId, id), isNull(probeTokens.revokedAt)));
      const [revoked] = await tx.update(probeAgents).set({ enabled: false, revokedAt: now, updatedAt: now }).where(eq(probeAgents.id, id)).returning();
      await tx.insert(auditLogs).values({ ownerUserId: agent.ownerUserId, actorUserId: actor.id, source: "user", action: "probe.revoke", resourceType: "probe_agent", resourceId: id });
      return revoked!;
    });
  }
  async heartbeat(probeId: string, tokenHash: string, input: z.infer<typeof heartbeatRequestSchema>, now = new Date()) {
    await this.database.db.transaction(async tx => {
      await lockActiveProbe(tx, probeId, now, tokenHash);
      await tx.update(probeAgents).set({ reportedConcurrency: input.maxConcurrency, capabilities: input.capabilities, agentVersion: input.agentVersion, lastSeenAt: now, updatedAt: now }).where(eq(probeAgents.id, probeId));
    });
    return {};
  }
  async createGroup(actor: AuthUser, input: { name: string }) {
    const [group] = await this.database.db.insert(probeGroups).values({ ...input, ownerUserId: actor.id }).returning();
    return group!;
  }
  async listGroups(actor: AuthUser) {
    const groups = await this.database.db.select().from(probeGroups).where(actor.role === "admin" ? undefined : eq(probeGroups.ownerUserId, actor.id));
    if (!groups.length) return [];
    const members = await this.database.db.select().from(probeGroupMembers).where(inArray(probeGroupMembers.groupId, groups.map(g => g.id)));
    return groups.map(group => ({ ...group, memberIds: members.filter(m => m.groupId === group.id).map(m => m.probeId) }));
  }
  async setMembers(actor: AuthUser, groupId: string, memberIds: string[]) {
    if (memberIds.length > 100 || new Set(memberIds).size !== memberIds.length) throw new BadRequestException("Invalid members");
    return this.database.db.transaction(async tx => {
      const [group] = await tx.select().from(probeGroups).where(eq(probeGroups.id, groupId)).for("update");
      if (!group || (actor.role !== "admin" && group.ownerUserId !== actor.id)) throw new NotFoundException("Group not found");
      const members = memberIds.length ? await tx.select().from(probeAgents).where(inArray(probeAgents.id, memberIds)) : [];
      if (members.length !== memberIds.length || members.some(p => p.ownerUserId !== group.ownerUserId)) throw new NotFoundException("Probe not found");
      await tx.delete(probeGroupMembers).where(eq(probeGroupMembers.groupId, groupId));
      if (memberIds.length) await tx.insert(probeGroupMembers).values(memberIds.map(probeId => ({ groupId, probeId })));
      const [updated] = await tx.update(probeGroups).set({ revision: group.revision + 1 }).where(eq(probeGroups.id, groupId)).returning();
      return { ...updated!, memberIds };
    });
  }
}

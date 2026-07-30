import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { HealthCheckJob } from "@masterdns/contracts";
import { createOpaqueToken, hashToken } from "@masterdns/crypto";
import {
  auditLogs,
  ddnsAgents,
  endpointAddresses,
  endpointPools,
  endpoints,
  healthCheckConfigs,
} from "@masterdns/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import type { HeartbeatInput } from "./ddns.schemas.js";

@Injectable()
export class DdnsService {
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async getAgent(actor: AuthUser, poolId: string, endpointId: string) {
    await this.findOwnedEndpoint(actor, poolId, endpointId);
    const [agent] = await this.database.db.select().from(ddnsAgents).where(eq(ddnsAgents.endpointId, endpointId)).limit(1);
    if (!agent) throw new NotFoundException("DDNS Agent 不存在");
    return publicAgent(agent);
  }

  async createInstallToken(actor: AuthUser, poolId: string, endpointId: string, input: { expiresInSeconds: number }) {
    const owned = await this.findOwnedEndpoint(actor, poolId, endpointId);
    if (owned.endpoint.addressMode !== "ddns") throw new BadRequestException("只有 DDNS 节点可以安装 Agent");
    const token = createOpaqueToken(32);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const [agent] = await this.database.db.insert(ddnsAgents).values({
      endpointId,
      installTokenHash: hashToken(token),
      installTokenExpiresAt: expiresAt,
      installTokenUsedAt: null,
      status: "active",
      revokedAt: null,
    }).onConflictDoUpdate({
      target: ddnsAgents.endpointId,
      set: { installTokenHash: hashToken(token), installTokenExpiresAt: expiresAt, installTokenUsedAt: null, status: "active", revokedAt: null, updatedAt: new Date() },
    }).returning();
    if (!agent) throw new Error("DDNS Agent token update returned no row");
    await this.database.db.insert(auditLogs).values({
      ownerUserId: owned.pool.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      action: "ddns.install_token.create",
      resourceType: "ddns_agent",
      resourceId: agent.id,
      afterSnapshot: { endpointId, expiresAt },
    });
    const apiUrl = env.PUBLIC_API_URL.replace(/\/$/, "");
    return {
      installToken: token,
      expiresAt,
      command: `curl -fsSL '${apiUrl}/api/v1/ddns/install.sh' | sudo sh -s -- install --url '${apiUrl}' --token '${token}'`,
    };
  }

  async revoke(actor: AuthUser, poolId: string, endpointId: string) {
    const owned = await this.findOwnedEndpoint(actor, poolId, endpointId);
    const [agent] = await this.database.db.update(ddnsAgents).set({
      status: "disabled",
      installTokenHash: null,
      runtimeTokenHash: null,
      revokedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(ddnsAgents.endpointId, endpointId)).returning();
    if (!agent) throw new NotFoundException("DDNS Agent 不存在");
    await this.database.db.insert(auditLogs).values({
      ownerUserId: owned.pool.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      action: "ddns.agent.revoke",
      resourceType: "ddns_agent",
      resourceId: agent.id,
      afterSnapshot: { endpointId, revokedAt: agent.revokedAt },
    });
    return publicAgent(agent);
  }

  async exchange(input: { installToken: string }) {
    const installTokenHash = hashToken(input.installToken);
    const runtimeToken = createOpaqueToken(32);
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from ddns_agents where install_token_hash = ${installTokenHash} for update`);
      const [row] = await tx.select({ agent: ddnsAgents, endpoint: endpoints, pool: endpointPools })
        .from(ddnsAgents).innerJoin(endpoints, eq(ddnsAgents.endpointId, endpoints.id))
        .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
        .where(eq(ddnsAgents.installTokenHash, installTokenHash)).limit(1);
      if (!row || row.agent.status !== "active" || row.agent.installTokenUsedAt || !row.agent.installTokenExpiresAt || row.agent.installTokenExpiresAt <= now) {
        throw new UnauthorizedException("安装 Token 无效、已使用或已过期");
      }
      const [agent] = await tx.update(ddnsAgents).set({
        installTokenUsedAt: now,
        installTokenHash: null,
        runtimeTokenHash: hashToken(runtimeToken),
        lastSeenAt: now,
        updatedAt: now,
      }).where(eq(ddnsAgents.id, row.agent.id)).returning();
      await tx.insert(auditLogs).values({
        ownerUserId: row.pool.ownerUserId,
        source: "ddns",
        action: "ddns.install_token.exchange",
        resourceType: "ddns_agent",
        resourceId: row.agent.id,
        afterSnapshot: { endpointId: row.endpoint.id, exchangedAt: now },
      });
      return agent;
    });
    if (!result) throw new Error("DDNS exchange did not update the agent");
    return { runtimeToken, endpointId: result.endpointId };
  }

  async heartbeat(authorization: string | undefined, input: HeartbeatInput, sourceIp: string) {
    const token = bearerToken(authorization);
    const runtimeTokenHash = hashToken(token);
    const [owned] = await this.database.db.select({ agent: ddnsAgents, endpoint: endpoints, pool: endpointPools })
      .from(ddnsAgents).innerJoin(endpoints, eq(ddnsAgents.endpointId, endpoints.id))
      .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
      .where(and(
        eq(ddnsAgents.runtimeTokenHash, runtimeTokenHash),
        eq(ddnsAgents.status, "active"),
        isNull(ddnsAgents.revokedAt),
      )).limit(1);
    if (!owned) throw new UnauthorizedException("DDNS 运行 Token 无效或已吊销");

    const inferred = normalizeSourceIp(sourceIp);
    const reported: { family: "4" | "6"; address: string }[] = [];
    if (input.ipv4) reported.push({ family: "4", address: input.ipv4 });
    if (input.ipv6) reported.push({ family: "6", address: input.ipv6 });
    if (reported.length === 0 && inferred) reported.push({ family: isIP(inferred) === 4 ? "4" : "6", address: inferred });
    if (reported.length === 0) throw new BadRequestException("未提供或检测到有效 IP 地址");

    const now = new Date();
    const candidates = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from ddns_agents where id = ${owned.agent.id} for update`);
      await tx.update(ddnsAgents).set({
        hostname: input.hostname ?? owned.agent.hostname,
        agentVersion: input.agentVersion ?? owned.agent.agentVersion,
        lastSeenAt: now,
        updatedAt: now,
      }).where(eq(ddnsAgents.id, owned.agent.id));
      const changed: (typeof endpointAddresses.$inferSelect)[] = [];
      for (const address of reported) {
        const [current, candidate] = await Promise.all([
          tx.select().from(endpointAddresses).where(and(eq(endpointAddresses.endpointId, owned.endpoint.id), eq(endpointAddresses.family, address.family), eq(endpointAddresses.state, "current"))).limit(1),
          tx.select().from(endpointAddresses).where(and(eq(endpointAddresses.endpointId, owned.endpoint.id), eq(endpointAddresses.family, address.family), eq(endpointAddresses.state, "candidate"))).limit(1),
        ]).then(([currentRows, candidateRows]) => [currentRows[0], candidateRows[0]] as const);
        if (current?.address === address.address) continue;
        if (candidate?.address === address.address) {
          changed.push(candidate);
          continue;
        }
        if (candidate) await tx.update(endpointAddresses).set({ state: "previous", replacedAt: now }).where(eq(endpointAddresses.id, candidate.id));
        const [created] = await tx.insert(endpointAddresses).values({
          endpointId: owned.endpoint.id,
          family: address.family,
          address: address.address,
          state: "candidate",
          source: "ddns",
          observedAt: now,
        }).returning();
        if (created) changed.push(created);
      }
      if (changed.length > 0) await tx.insert(auditLogs).values({
        ownerUserId: owned.pool.ownerUserId,
        source: "ddns",
        action: "ddns.address.candidate",
        resourceType: "endpoint",
        resourceId: owned.endpoint.id,
        afterSnapshot: changed.map((item) => ({ family: item.family, address: item.address, observedAt: item.observedAt })),
      });
      return changed;
    });

    let queuedChecks = 0;
    for (const candidate of candidates) queuedChecks += await this.enqueueCandidateChecks(owned.pool.id, owned.endpoint.id, candidate.id);
    return {
      accepted: true,
      changed: candidates.length > 0,
      candidateAddresses: candidates.map((item) => ({ family: item.family, address: item.address })),
      queuedChecks,
      lastSeenAt: now,
    };
  }

  async script(name: "install.sh" | "masterdns-ddns") {
    return readFile(resolve(process.cwd(), "agent", name), "utf8");
  }

  private async enqueueCandidateChecks(poolId: string, endpointId: string, addressId: string) {
    const configs = await this.database.db.select().from(healthCheckConfigs).where(and(
      eq(healthCheckConfigs.enabled, true),
      or(
        eq(healthCheckConfigs.endpointId, endpointId),
        eq(healthCheckConfigs.poolId, poolId),
      ),
    ));
    const endpointConfigs = configs.filter((config) => config.endpointId === endpointId);
    const effective = endpointConfigs.length > 0 ? endpointConfigs : configs.filter((config) => config.poolId === poolId);
    if (effective.length === 0) throw new BadRequestException("DDNS 候选地址没有可用的节点或 Pool 健康检查，无法安全发布");
    await Promise.all(effective.map((config) => {
      const data: HealthCheckJob = {
        endpointId,
        configId: config.id,
        addressId,
        manual: true,
      };
      return this.queues.health.add("check-ddns-candidate", data, {
        jobId: `ddns-health-${addressId}-${config.id}-${Date.now()}`,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    }));
    return effective.length;
  }

  private async findOwnedEndpoint(actor: AuthUser, poolId: string, endpointId: string) {
    const [row] = await this.database.db.select({ endpoint: endpoints, pool: endpointPools })
      .from(endpoints).innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
      .where(and(
        eq(endpoints.id, endpointId),
        eq(endpointPools.id, poolId),
        actor.role === "admin" ? undefined : eq(endpointPools.ownerUserId, actor.id),
      )).limit(1);
    if (!row) throw new NotFoundException("DDNS 节点不存在");
    return row;
  }
}

function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1] || match[1].length < 32 || match[1].length > 256) throw new UnauthorizedException("缺少有效的 DDNS 运行 Token");
  return match[1];
}

function normalizeSourceIp(value: string): string | undefined {
  const unwrapped = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(unwrapped) ? unwrapped : undefined;
}

function publicAgent(agent: typeof ddnsAgents.$inferSelect) {
  return {
    id: agent.id,
    endpointId: agent.endpointId,
    status: agent.status,
    agentVersion: agent.agentVersion,
    hostname: agent.hostname,
    hasRuntimeToken: Boolean(agent.runtimeTokenHash),
    installTokenExpiresAt: agent.installTokenExpiresAt,
    installTokenUsedAt: agent.installTokenUsedAt,
    lastSeenAt: agent.lastSeenAt,
    lastIpChangedAt: agent.lastIpChangedAt,
    revokedAt: agent.revokedAt,
    createdAt: agent.createdAt,
  };
}

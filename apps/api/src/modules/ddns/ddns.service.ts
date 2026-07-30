import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  reconcileIntents,
} from "@masterdns/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { normalizeDdnsSourceIp, parseDdnsBearerToken } from "./ddns-auth.js";
import {
  buildDdnsInstallCommand,
  currentRuntimeTokenMatches,
  resolveAgentScriptPath,
  resolveDdnsAddressUpdates,
  rotateRuntimeToken,
  runtimeTokenMatches,
} from "./ddns-policy.js";
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
    let installer: ReturnType<typeof buildDdnsInstallCommand>;
    try {
      installer = buildDdnsInstallCommand(env.PUBLIC_API_URL);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "PUBLIC_API_URL 无效");
    }
    const token = createOpaqueToken(32);
    const installTokenHash = hashToken(token);
    const result = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from endpoints where id = ${endpointId} and pool_id = ${poolId} for update`);
      const [lockedEndpoint] = await tx.select().from(endpoints).where(and(
        eq(endpoints.id, endpointId),
        eq(endpoints.poolId, poolId),
      )).limit(1);
      if (!lockedEndpoint) throw new NotFoundException("DDNS 节点不存在");
      if (lockedEndpoint.addressMode !== "ddns") throw new BadRequestException("只有 DDNS 节点可以安装 Agent");

      await tx.execute(sql`select id from ddns_agents where endpoint_id = ${endpointId} for update`);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1000);
      const [agent] = await tx.insert(ddnsAgents).values({
        endpointId,
        installTokenHash,
        installTokenExpiresAt: expiresAt,
        installTokenUsedAt: null,
        status: "active",
        revokedAt: null,
      }).onConflictDoUpdate({
        target: ddnsAgents.endpointId,
        set: { installTokenHash, installTokenExpiresAt: expiresAt, installTokenUsedAt: null, status: "active", revokedAt: null, updatedAt: now },
      }).returning();
      if (!agent) throw new Error("DDNS Agent token update returned no row");
      await tx.insert(auditLogs).values({
        ownerUserId: owned.pool.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: "ddns.install_token.create",
        resourceType: "ddns_agent",
        resourceId: agent.id,
        afterSnapshot: { endpointId, expiresAt },
      });
      return { expiresAt };
    });
    return {
      installToken: token,
      expiresAt: result.expiresAt,
      command: installer.command,
    };
  }

  async revoke(actor: AuthUser, poolId: string, endpointId: string) {
    const owned = await this.findOwnedEndpoint(actor, poolId, endpointId);
    const [agent] = await this.database.db.update(ddnsAgents).set({
      status: "disabled",
      installTokenHash: null,
      installTokenExpiresAt: null,
      runtimeTokenHash: null,
      previousRuntimeTokenHash: null,
      previousRuntimeTokenExpiresAt: null,
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
    const [candidate] = await this.database.db.select({ agentId: ddnsAgents.id, endpointId: endpoints.id })
      .from(ddnsAgents).innerJoin(endpoints, eq(ddnsAgents.endpointId, endpoints.id))
      .where(eq(ddnsAgents.installTokenHash, installTokenHash)).limit(1);
    if (!candidate) throw new UnauthorizedException("安装 Token 无效、已使用或已过期");
    const result = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from endpoints where id = ${candidate.endpointId} for update`);
      await tx.execute(sql`select id from ddns_agents where id = ${candidate.agentId} for update`);
      const [row] = await tx.select({ agent: ddnsAgents, endpoint: endpoints, pool: endpointPools })
        .from(ddnsAgents).innerJoin(endpoints, eq(ddnsAgents.endpointId, endpoints.id))
        .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
        .where(eq(ddnsAgents.id, candidate.agentId)).limit(1);
      const now = new Date();
      if (!row
        || row.endpoint.addressMode !== "ddns"
        || row.agent.installTokenHash !== installTokenHash
        || row.agent.status !== "active"
        || row.agent.installTokenUsedAt
        || !row.agent.installTokenExpiresAt
        || row.agent.installTokenExpiresAt <= now) {
        throw new UnauthorizedException("安装 Token 无效、已使用或已过期");
      }
      const [agent] = await tx.update(ddnsAgents).set({
        installTokenUsedAt: now,
        installTokenHash: null,
        ...rotateRuntimeToken(row.agent.runtimeTokenHash, hashToken(runtimeToken), now),
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
    const now = new Date();
    const { owned, runtimeTokenHash } = await this.authenticateRuntimeToken(authorization, now);
    const inferred = normalizeDdnsSourceIp(sourceIp);
    const reported = resolveDdnsAddressUpdates(input, inferred);
    if (reported.length === 0) throw new BadRequestException("未提供或检测到有效 IP 地址");

    const eventId = randomUUID();
    const result = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${owned.pool.id}))`);
      await tx.execute(sql`select id from endpoints where id = ${owned.endpoint.id} for update`);
      await tx.execute(sql`select id from ddns_agents where id = ${owned.agent.id} for update`);
      const [lockedEndpoint] = await tx.select().from(endpoints).where(eq(endpoints.id, owned.endpoint.id)).limit(1);
      const [lockedAgent] = await tx.select().from(ddnsAgents).where(eq(ddnsAgents.id, owned.agent.id)).limit(1);
      if (!lockedEndpoint
        || lockedEndpoint.addressMode !== "ddns"
        || !lockedAgent
        || lockedAgent.status !== "active"
        || lockedAgent.revokedAt
        || !runtimeTokenMatches(lockedAgent, runtimeTokenHash)) {
        throw new UnauthorizedException("DDNS 运行 Token 无效或已吊销");
      }
      await tx.update(ddnsAgents).set({
        hostname: input.hostname ?? lockedAgent.hostname,
        agentVersion: input.agentVersion ?? lockedAgent.agentVersion,
        lastSeenAt: now,
        ...(lockedAgent.previousRuntimeTokenExpiresAt && lockedAgent.previousRuntimeTokenExpiresAt <= now
          ? { previousRuntimeTokenHash: null, previousRuntimeTokenExpiresAt: null }
          : {}),
        updatedAt: now,
      }).where(eq(ddnsAgents.id, lockedAgent.id));

      const candidates: (typeof endpointAddresses.$inferSelect)[] = [];
      const createdCandidates: (typeof endpointAddresses.$inferSelect)[] = [];
      const withdrawnFamilies: ("4" | "6")[] = [];
      const publishedWithdrawals: ("4" | "6")[] = [];
      let addressStateChanged = false;
      for (const address of reported) {
        const [current, candidate] = await Promise.all([
          tx.select().from(endpointAddresses).where(and(eq(endpointAddresses.endpointId, owned.endpoint.id), eq(endpointAddresses.family, address.family), eq(endpointAddresses.state, "current"))).limit(1),
          tx.select().from(endpointAddresses).where(and(eq(endpointAddresses.endpointId, owned.endpoint.id), eq(endpointAddresses.family, address.family), eq(endpointAddresses.state, "candidate"))).limit(1),
        ]).then(([currentRows, candidateRows]) => [currentRows[0], candidateRows[0]] as const);

        if (address.address === null) {
          if (candidate) {
            await tx.update(endpointAddresses).set({ state: "previous", replacedAt: now }).where(eq(endpointAddresses.id, candidate.id));
            addressStateChanged = true;
          }
          if (current) {
            await tx.update(endpointAddresses).set({ state: "previous", replacedAt: now }).where(eq(endpointAddresses.id, current.id));
            publishedWithdrawals.push(address.family);
            addressStateChanged = true;
          }
          if (candidate || current) withdrawnFamilies.push(address.family);
          continue;
        }

        if (current?.address === address.address) {
          if (candidate) {
            await tx.update(endpointAddresses).set({ state: "previous", replacedAt: now }).where(eq(endpointAddresses.id, candidate.id));
            addressStateChanged = true;
          }
          continue;
        }
        if (candidate?.address === address.address) {
          candidates.push(candidate);
          continue;
        }
        if (candidate) {
          await tx.update(endpointAddresses).set({ state: "previous", replacedAt: now }).where(eq(endpointAddresses.id, candidate.id));
          addressStateChanged = true;
        }
        const [created] = await tx.insert(endpointAddresses).values({
          endpointId: owned.endpoint.id,
          family: address.family,
          address: address.address,
          state: "candidate",
          source: "ddns",
          observedAt: now,
        }).returning();
        if (created) {
          candidates.push(created);
          createdCandidates.push(created);
          addressStateChanged = true;
        }
      }

      if (addressStateChanged) {
        await tx.update(ddnsAgents).set({ lastIpChangedAt: now, updatedAt: now }).where(eq(ddnsAgents.id, lockedAgent.id));
      }
      if (createdCandidates.length > 0) await tx.insert(auditLogs).values({
        ownerUserId: owned.pool.ownerUserId,
        source: "ddns",
        action: "ddns.address.candidate",
        resourceType: "endpoint",
        resourceId: owned.endpoint.id,
        afterSnapshot: createdCandidates.map((item) => ({ family: item.family, address: item.address, observedAt: item.observedAt })),
      });
      if (withdrawnFamilies.length > 0) {
        await tx.insert(auditLogs).values({
          ownerUserId: owned.pool.ownerUserId,
          source: "ddns",
          action: "ddns.address.withdraw",
          resourceType: "endpoint",
          resourceId: owned.endpoint.id,
          afterSnapshot: { families: withdrawnFamilies, withdrawnAt: now },
        });
      }
      if (publishedWithdrawals.length > 0) {
        const [sequencedPool] = await tx.update(endpointPools).set({
          decisionRevision: sql`${endpointPools.decisionRevision} + 1`,
          updatedAt: now,
        }).where(eq(endpointPools.id, owned.pool.id)).returning({
          decisionRevision: endpointPools.decisionRevision,
          policyRevision: endpointPools.policyRevision,
        });
        if (!sequencedPool) throw new Error("Pool decision revision update returned no row");
        await tx.insert(reconcileIntents).values({
          eventId,
          poolId: owned.pool.id,
          endpointId: owned.endpoint.id,
          decisionRevision: sequencedPool.decisionRevision,
          policyRevision: sequencedPool.policyRevision,
          trigger: "repair",
          source: "ddns",
          availableAt: now,
        });
      }
      return { addressStateChanged, candidates, withdrawnFamilies };
    });

    let queuedChecks = 0;
    for (const candidate of result.candidates) queuedChecks += await this.enqueueCandidateChecks(owned.pool.id, owned.endpoint.id, candidate.id);
    return {
      accepted: true,
      changed: result.addressStateChanged,
      candidateAddresses: result.candidates.map((item) => ({ family: item.family, address: item.address })),
      withdrawnFamilies: result.withdrawnFamilies,
      queuedChecks,
      lastSeenAt: now,
    };
  }

  async revokeRuntime(authorization: string | undefined, sourceIp: string) {
    const now = new Date();
    const { owned, runtimeTokenHash } = await this.authenticateRuntimeToken(authorization, now);
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from endpoints where id = ${owned.endpoint.id} for update`);
      await tx.execute(sql`select id from ddns_agents where id = ${owned.agent.id} for update`);
      const [lockedEndpoint] = await tx.select().from(endpoints).where(eq(endpoints.id, owned.endpoint.id)).limit(1);
      const [lockedAgent] = await tx.select().from(ddnsAgents).where(eq(ddnsAgents.id, owned.agent.id)).limit(1);
      if (!lockedEndpoint
        || lockedEndpoint.addressMode !== "ddns"
        || !lockedAgent
        || lockedAgent.status !== "active"
        || lockedAgent.revokedAt
        || !currentRuntimeTokenMatches(lockedAgent, runtimeTokenHash)) {
        throw new UnauthorizedException("DDNS 运行 Token 无效或已吊销");
      }
      await tx.update(ddnsAgents).set({
        status: "disabled",
        installTokenHash: null,
        installTokenExpiresAt: null,
        runtimeTokenHash: null,
        previousRuntimeTokenHash: null,
        previousRuntimeTokenExpiresAt: null,
        revokedAt: now,
        updatedAt: now,
      }).where(eq(ddnsAgents.id, lockedAgent.id));
      await tx.insert(auditLogs).values({
        ownerUserId: owned.pool.ownerUserId,
        source: "ddns",
        action: "ddns.agent.self_revoke",
        resourceType: "ddns_agent",
        resourceId: lockedAgent.id,
        afterSnapshot: { endpointId: owned.endpoint.id, revokedAt: now },
        ipAddress: normalizeDdnsSourceIp(sourceIp),
      });
    });
    return { revoked: true, revokedAt: now };
  }

  async script(name: "install.sh" | "masterdns-ddns") {
    return readFile(resolveAgentScriptPath(name), "utf8");
  }

  private async authenticateRuntimeToken(authorization: string | undefined, now: Date) {
    const runtimeTokenHash = hashToken(parseDdnsBearerToken(authorization));
    const [owned] = await this.database.db.select({ agent: ddnsAgents, endpoint: endpoints, pool: endpointPools })
      .from(ddnsAgents).innerJoin(endpoints, eq(ddnsAgents.endpointId, endpoints.id))
      .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
      .where(and(
        or(
          eq(ddnsAgents.runtimeTokenHash, runtimeTokenHash),
          and(
            eq(ddnsAgents.previousRuntimeTokenHash, runtimeTokenHash),
            gt(ddnsAgents.previousRuntimeTokenExpiresAt, now),
          ),
        ),
        eq(endpoints.addressMode, "ddns"),
        eq(ddnsAgents.status, "active"),
        isNull(ddnsAgents.revokedAt),
      )).limit(1);
    if (!owned) throw new UnauthorizedException("DDNS 运行 Token 无效或已吊销");
    return { owned, runtimeTokenHash };
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

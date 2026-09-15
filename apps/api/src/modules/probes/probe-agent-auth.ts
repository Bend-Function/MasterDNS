import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createOpaqueToken, hashToken } from "@masterdns/crypto";
import { probeAgents, probeTokens, users, type MasterDnsDatabase } from "@masterdns/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { DatabaseService } from "../../infrastructure/database.module.js";

export type ProbeTransaction = Parameters<Parameters<MasterDnsDatabase["transaction"]>[0]>[0];
// Serialize runtime writes with revoke/re-enrollment, including requests authenticated earlier.
// No key changes: allow task/member/token FK KEY SHARE checks to proceed.
export async function lockActiveProbe(tx: ProbeTransaction, probeId: string, now: Date, tokenHash?: string) {
  const [agent] = await tx.select().from(probeAgents).where(eq(probeAgents.id, probeId)).for("no key update");
  if (!agent || !agent.enabled || agent.revokedAt) throw new UnauthorizedException("Probe is disabled or revoked");
  const [owner] = await tx.select().from(users).where(eq(users.id, agent.ownerUserId)).for("share");
  if (!owner || owner.status !== "active") throw new UnauthorizedException("Probe owner is disabled");
  if (tokenHash) {
    const [token] = await tx.select().from(probeTokens).where(and(eq(probeTokens.probeId, probeId), eq(probeTokens.tokenHash, tokenHash), eq(probeTokens.kind, "runtime"), isNull(probeTokens.revokedAt), or(isNull(probeTokens.expiresAt), gt(probeTokens.expiresAt, now))));
    if (!token) throw new UnauthorizedException("Probe token is invalid or revoked");
  }
  return agent;
}

@Injectable()
export class ProbeAgentAuth {
  constructor(private readonly database: DatabaseService) {}

  async exchange(installToken: string, now = new Date()) {
    const tokenHash = hashToken(installToken);
    const [candidate] = await this.database.db.select().from(probeTokens).where(and(eq(probeTokens.tokenHash, tokenHash), eq(probeTokens.kind, "install")));
    if (!candidate) throw new UnauthorizedException("Invalid install token");
    return this.database.db.transaction(async tx => {
      await lockActiveProbe(tx, candidate.probeId, now);
      const [token] = await tx.select().from(probeTokens).where(eq(probeTokens.id, candidate.id)).for("update");
      if (!token || token.usedAt || token.revokedAt || !token.expiresAt || token.expiresAt <= now) throw new UnauthorizedException("Install token expired or used");
      await tx.update(probeTokens).set({ usedAt: now }).where(eq(probeTokens.id, token.id));
      await tx.update(probeTokens).set({ revokedAt: now }).where(and(eq(probeTokens.probeId, token.probeId), eq(probeTokens.kind, "runtime"), isNull(probeTokens.revokedAt)));
      const runtimeToken = createOpaqueToken(32);
      await tx.insert(probeTokens).values({ probeId: token.probeId, kind: "runtime", tokenHash: hashToken(runtimeToken), createdAt: now });
      return { probeId: token.probeId, runtimeToken, protocol: "probe-agent/v1" as const };
    });
  }

  async authenticate(authorization: string | undefined, now = new Date()) {
    const match = /^Bearer ([A-Za-z0-9_-]{20,2048})$/i.exec(authorization ?? "");
    if (!match) throw new UnauthorizedException("Probe bearer token required");
    const tokenHash = hashToken(match[1]!);
    const [row] = await this.database.db.select({ probeId: probeAgents.id }).from(probeTokens)
      .innerJoin(probeAgents, eq(probeTokens.probeId, probeAgents.id))
      .innerJoin(users, eq(probeAgents.ownerUserId, users.id))
      .where(and(eq(probeTokens.tokenHash, tokenHash), eq(probeTokens.kind, "runtime"), isNull(probeTokens.revokedAt), or(isNull(probeTokens.expiresAt), gt(probeTokens.expiresAt, now)), eq(probeAgents.enabled, true), isNull(probeAgents.revokedAt), eq(users.status, "active")));
    if (!row) throw new UnauthorizedException("Probe token is invalid or revoked");
    return { probeId: row.probeId, tokenHash };
  }
}

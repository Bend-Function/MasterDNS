import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { probeTaskSchema, type ProbeTask } from "@masterdns/contracts";
import { probeRounds, probeTasks } from "@masterdns/db";
import { and, asc, count, eq, gt } from "drizzle-orm";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { lockActiveProbe } from "./probe-agent-auth.js";
import { lockRoundState } from "./probe-round-state.js";

@Injectable()
export class ProbeLeasesService {
  constructor(private readonly database: DatabaseService) {}
  async lease(probeId: string, capacity: number, now = new Date(), tokenHash?: string): Promise<ProbeTask[]> {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw new BadRequestException("Invalid capacity");
    return this.database.db.transaction(async tx => {
      const agent = await lockActiveProbe(tx, probeId, now, tokenHash);
      const [outstanding] = await tx.select({ count: count() }).from(probeTasks).where(and(eq(probeTasks.probeId, probeId), eq(probeTasks.status, "leased"), gt(probeTasks.leaseDeadline, now)));
      const available = Math.min(capacity, Math.max(0, Math.min(100, agent.maxConcurrency, agent.reportedConcurrency) - (outstanding?.count ?? 0)));
      if (!available) return [];
      const pending = await tx.select({ task: probeTasks, round: probeRounds }).from(probeTasks)
        .innerJoin(probeRounds, eq(probeTasks.roundId, probeRounds.id))
        .where(and(eq(probeTasks.probeId, probeId), eq(probeTasks.status, "pending"), eq(probeRounds.status, "pending"), gt(probeRounds.deadline, now)))
        .orderBy(asc(probeRounds.createdAt), asc(probeTasks.id)).limit(available).for("update", { of: probeTasks, skipLocked: true });
      const leased: ProbeTask[] = [];
      for (const row of pending) {
        const { round, fresh } = await lockRoundState(tx, row.round, now);
        if (!round || !fresh) {
          await tx.update(probeTasks).set({ status: "stale", finishedAt: now }).where(eq(probeTasks.id, row.task.id));
          continue;
        }
        const leaseId = randomUUID();
        const task = probeTaskSchema.parse({ protocol: "probe-agent/v1", taskId: row.task.id, roundId: round.id, probeId, leaseId, addressVersion: round.addressVersion, configVersion: round.configVersion, address: round.address, family: Number(round.family), ...(round.hostname ? { hostname: round.hostname } : {}), config: round.config, deadline: round.deadline.toISOString(), ...(round.networkPolicy ? { networkPolicy: round.networkPolicy } : {}) });
        await tx.update(probeTasks).set({ status: "leased", leaseId, leaseDeadline: round.deadline, leasedAt: now }).where(eq(probeTasks.id, row.task.id));
        leased.push(task);
      }
      return leased;
    });
  }
}

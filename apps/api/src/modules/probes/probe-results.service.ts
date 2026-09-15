import { Injectable } from "@nestjs/common";
import { probeResultSchema, type ProbeResult, type ResultAck } from "@masterdns/contracts";
import { probeRounds, probeTasks, probeObservations } from "@masterdns/db";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { lockActiveProbe } from "./probe-agent-auth.js";
import { lockRoundState } from "./probe-round-state.js";

@Injectable()
export class ProbeResultsService {
  constructor(private readonly database: DatabaseService) {}
  async accept(probeId: string, result: ProbeResult, now = new Date(), tokenHash?: string): Promise<ResultAck["status"]> {
    const input = probeResultSchema.parse(result);
    return this.database.db.transaction(async tx => {
      await lockActiveProbe(tx, probeId, now, tokenHash);
      const [task] = await tx.select().from(probeTasks).where(and(eq(probeTasks.id, input.taskId), eq(probeTasks.probeId, probeId))).for("update");
      if (!task || !task.leaseId || task.leaseId !== input.leaseId) return "rejected";
      const [snapshot] = await tx.select().from(probeRounds).where(eq(probeRounds.id, task.roundId));
      if (!snapshot) return "rejected";
      if (snapshot.addressVersion !== input.addressVersion || snapshot.configVersion !== input.configVersion) return "stale";
      const [previous] = await tx.select().from(probeObservations).where(eq(probeObservations.taskId, task.id));
      if (previous) return previous.status === "accepted" ? "duplicate" : "stale";
      if (task.status !== "leased") return "rejected";
      const { fresh } = await lockRoundState(tx, snapshot, now);
      const status = fresh && task.leaseDeadline && task.leaseDeadline > now ? "accepted" : "stale";
      await tx.insert(probeObservations).values({ taskId: task.id, roundId: task.roundId, probeId, leaseId: input.leaseId, addressVersion: input.addressVersion, configVersion: input.configVersion, status, outcome: input.outcome, latencyMs: input.latencyMs, statusCode: input.statusCode, errorCode: input.errorCode, measuredAt: new Date(input.measuredAt), receivedAt: now });
      await tx.update(probeTasks).set({ status, finishedAt: now }).where(eq(probeTasks.id, task.id));
      return status;
    });
  }
}

import { HttpException, Injectable } from "@nestjs/common";
import { createProbeRound, ProbeRoundError, type CreateProbeRound } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
export type { CreateProbeRound } from "@masterdns/db";
@Injectable()
export class ProbeRoundsService {
  constructor(private readonly database: DatabaseService) {}
  async create(actor: AuthUser, input: CreateProbeRound, now = new Date()) {
    try { return await this.database.db.transaction(tx => createProbeRound(tx, actor, input, now)); }
    catch (error) { if (error instanceof ProbeRoundError) throw new HttpException(error.message, error.status); throw error; }
  }
}

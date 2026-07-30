import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Public } from "../../auth/auth.decorators.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";

@Controller("health")
export class HealthController {
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  @Public()
  @Get()
  async health() {
    try {
      await Promise.all([this.database.db.execute(sql`select 1`), this.queues.ping()]);
      return { status: "ok", service: "masterdns-api", dependencies: { postgres: "ok", redis: "ok" }, time: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException("服务依赖尚未就绪");
    }
  }
}

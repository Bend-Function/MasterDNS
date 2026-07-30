import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { queueNames } from "@masterdns/contracts";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

@Injectable()
export class QueueRuntimeService implements OnModuleDestroy {
  readonly redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  readonly operations = new Queue(queueNames.operations, { connection: this.redis });
  readonly health = new Queue(queueNames.health, { connection: this.redis });
  readonly reconcile = new Queue(queueNames.reconcile, { connection: this.redis });
  readonly sync = new Queue(queueNames.sync, { connection: this.redis });
  readonly notifications = new Queue(queueNames.notifications, { connection: this.redis });

  async onModuleDestroy() {
    await Promise.all([this.operations.close(), this.health.close(), this.reconcile.close(), this.sync.close(), this.notifications.close()]);
    await this.redis.quit();
  }
}

import { Global, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { queueNames } from "@masterdns/contracts";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
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

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}

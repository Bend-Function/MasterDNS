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

  async incrementRateLimit(key: string, windowMs: number): Promise<number> {
    const result = await this.redis.eval(
      "local value = redis.call('incr', KEYS[1]); if value == 1 then redis.call('pexpire', KEYS[1], ARGV[1]); end; return value",
      1,
      key,
      windowMs,
    );
    return Number(result);
  }

  async ping(): Promise<string> {
    return this.redis.ping();
  }

  async onModuleDestroy() {
    await Promise.all([this.operations.close(), this.health.close(), this.reconcile.close(), this.sync.close(), this.notifications.close()]);
    await this.redis.quit();
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}

import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { NotificationEvent, NotificationJob } from "@masterdns/contracts";
import { queueNames } from "@masterdns/contracts";
import { decryptJson, parseEncryptionKey, signWebhook } from "@masterdns/crypto";
import {
  notificationChannels,
  notificationDeliveries,
  poolNotificationChannels,
} from "@masterdns/db";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { Job, Worker } from "bullmq";
import { request } from "undici";
import { DatabaseService } from "../database.service.js";
import { env } from "../env.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

class DeliveryError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly excerpt?: string) {
    super(code);
  }
}

@Injectable()
export class NotificationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationProcessor.name);
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  private worker?: Worker<NotificationJob>;
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  async onModuleInit() {
    this.worker = new Worker<NotificationJob>(queueNames.notifications, (job) => this.process(job), {
      connection: this.queues.redis,
      concurrency: 10,
      lockDuration: 30_000,
    });
    this.worker.on("failed", (job, error) => this.logger.warn(`Notification job ${job?.id ?? "unknown"} failed: ${error instanceof DeliveryError ? error.code : "delivery_failed"}`));
    await this.recoverDeliveries();
    this.recoveryTimer = setInterval(() => void this.recoverDeliveries(), 30_000);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.worker?.close();
  }

  private async process(job: Job<NotificationJob>) {
    if (job.data.kind === "fanout") return this.fanout(job.data.event);
    return this.deliver(job.data.deliveryId, job.attemptsMade, job.opts.attempts ?? 1);
  }

  private async fanout(event: NotificationEvent) {
    const defaults = await this.database.db.select().from(notificationChannels).where(and(
      eq(notificationChannels.ownerUserId, event.ownerUserId),
      eq(notificationChannels.enabled, true),
      eq(notificationChannels.isDefault, true),
    ));
    const linked = event.poolId
      ? await this.database.db.select({ channel: notificationChannels, link: poolNotificationChannels })
        .from(poolNotificationChannels).innerJoin(notificationChannels, eq(poolNotificationChannels.channelId, notificationChannels.id))
        .where(and(eq(poolNotificationChannels.poolId, event.poolId), eq(notificationChannels.enabled, true)))
      : [];
    const matchingLinks = linked.filter(({ link }) => link.eventFilter.length === 0 || link.eventFilter.includes(event.eventType));
    const overrideDefaults = matchingLinks.some(({ link }) => link.overridesDefaults);
    const selected = new Map<string, typeof notificationChannels.$inferSelect>();
    if (!overrideDefaults) for (const channel of defaults) selected.set(channel.id, channel);
    for (const { channel } of matchingLinks) selected.set(channel.id, channel);

    const deliveryRows: Array<{ id: string; attempts: number; status: string }> = [];
    for (const channel of selected.values()) {
      const [created] = await this.database.db.insert(notificationDeliveries).values({
        eventId: event.eventId,
        channelId: channel.id,
        payload: event as unknown as Record<string, unknown>,
      }).onConflictDoNothing().returning({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts, status: notificationDeliveries.status });
      const delivery = created ?? (await this.database.db.select({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts, status: notificationDeliveries.status })
        .from(notificationDeliveries).where(and(
          eq(notificationDeliveries.eventId, event.eventId),
          eq(notificationDeliveries.channelId, channel.id),
        )).limit(1))[0];
      if (delivery && !["delivered", "failed"].includes(delivery.status)) deliveryRows.push(delivery);
    }
    await Promise.all(deliveryRows.map((delivery) => this.queues.notifications.add("deliver-notification", { kind: "deliver", deliveryId: delivery.id }, {
      jobId: `deliver-${delivery.id}-${delivery.attempts}`,
      attempts: Math.max(1, 5 - delivery.attempts),
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    })));
    return { deliveries: deliveryRows.length };
  }

  private async deliver(deliveryId: string, attemptsMade: number, maxAttempts: number) {
    const lockKey = `masterdns:notification-lock:${deliveryId}`;
    const lockToken = randomUUID();
    if (await this.queues.redis.set(lockKey, lockToken, "PX", 30_000, "NX") !== "OK") return;
    try {
      return await this.deliverLocked(deliveryId, attemptsMade, maxAttempts);
    } finally {
      await this.queues.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockToken,
      );
    }
  }

  private async deliverLocked(deliveryId: string, attemptsMade: number, maxAttempts: number) {
    const [row] = await this.database.db.select({ delivery: notificationDeliveries, channel: notificationChannels })
      .from(notificationDeliveries).innerJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
      .where(eq(notificationDeliveries.id, deliveryId)).limit(1);
    if (!row || row.delivery.status === "delivered") return;
    if (!row.channel.enabled) {
      await this.database.db.update(notificationDeliveries).set({ status: "failed", errorCode: "channel_disabled", updatedAt: new Date() })
        .where(eq(notificationDeliveries.id, row.delivery.id));
      return;
    }
    const secret = decryptJson<{ secret: string }>({
      ciphertext: row.channel.secretCiphertext,
      iv: row.channel.secretIv,
      tag: row.channel.secretTag,
      keyVersion: row.channel.secretKeyVersion,
    }, this.encryptionKey).secret;
    const startedAt = Date.now();
    try {
      const response = row.channel.type === "webhook"
        ? await deliverWebhook(row.channel.endpoint, secret, row.delivery.eventId, row.delivery.payload)
        : await deliverTelegram(row.channel.endpoint, secret, row.delivery.payload);
      await this.database.db.update(notificationDeliveries).set({
        status: "delivered",
        attempts: row.delivery.attempts + 1,
        durationMs: Date.now() - startedAt,
        responseStatus: response.status,
        responseExcerpt: response.excerpt,
        errorCode: null,
        nextRetryAt: null,
        deliveredAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(notificationDeliveries.id, row.delivery.id));
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError("delivery_failed");
      const finalAttempt = row.delivery.attempts + 1 >= 5 || attemptsMade + 1 >= maxAttempts;
      await this.database.db.update(notificationDeliveries).set({
        status: finalAttempt ? "failed" : "retrying",
        attempts: row.delivery.attempts + 1,
        durationMs: Date.now() - startedAt,
        responseStatus: failure.status ?? null,
        responseExcerpt: failure.excerpt?.slice(0, 512) ?? null,
        errorCode: failure.code,
        nextRetryAt: finalAttempt ? null : new Date(Date.now() + 2_000 * 2 ** attemptsMade),
        updatedAt: new Date(),
      }).where(eq(notificationDeliveries.id, row.delivery.id));
      throw failure;
    }
  }

  private async recoverDeliveries() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const due = await this.database.db.select({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts })
        .from(notificationDeliveries).where(and(
          inArray(notificationDeliveries.status, ["pending", "retrying"]),
          or(isNull(notificationDeliveries.nextRetryAt), lte(notificationDeliveries.nextRetryAt, new Date())),
        ));
      const exhausted = due.filter((delivery) => delivery.attempts >= 5);
      if (exhausted.length > 0) {
        await this.database.db.update(notificationDeliveries).set({ status: "failed", errorCode: "retry_exhausted", nextRetryAt: null, updatedAt: new Date() })
          .where(inArray(notificationDeliveries.id, exhausted.map((delivery) => delivery.id)));
      }
      const slot = Math.floor(Date.now() / 30_000);
      await Promise.all(due.filter((delivery) => delivery.attempts < 5).map((delivery) => this.queues.notifications.add("deliver-notification", {
        kind: "deliver",
        deliveryId: delivery.id,
      }, {
        jobId: `recover-delivery-${delivery.id}-${delivery.attempts}-${slot}`,
        attempts: Math.max(1, 5 - delivery.attempts),
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 5_000,
        removeOnFail: 5_000,
      })));
    } catch (error) {
      this.logger.warn(`Notification recovery scan failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
    } finally {
      this.recovering = false;
    }
  }
}

async function deliverWebhook(endpoint: string | null, secret: string, eventId: string, payload: Record<string, unknown>) {
  if (!endpoint) throw new DeliveryError("webhook_endpoint_missing");
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "MasterDNS-Webhook/1.0",
      "x-masterdns-event-id": eventId,
      "x-masterdns-timestamp": String(timestamp),
      "x-masterdns-signature": signWebhook(secret, timestamp, body),
    },
    body,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const excerpt = await readExcerpt(response.body);
  if (response.statusCode < 200 || response.statusCode >= 300) throw new DeliveryError("webhook_http_error", response.statusCode, excerpt);
  return { status: response.statusCode, excerpt };
}

async function deliverTelegram(chatId: string | null, botToken: string, payload: Record<string, unknown>) {
  if (!chatId) throw new DeliveryError("telegram_chat_id_missing");
  const event = payload as Partial<NotificationEvent>;
  const text = [
    `MasterDNS: ${event.eventType ?? "event"}`,
    `Time: ${event.occurredAt ?? new Date().toISOString()}`,
    `Event: ${event.eventId ?? "unknown"}`,
    event.poolId ? `Pool: ${event.poolId}` : undefined,
    summarizePayload(event.payload),
  ].filter(Boolean).join("\n").slice(0, 4096);
  const response = await request(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const excerpt = await readExcerpt(response.body);
  if (response.statusCode < 200 || response.statusCode >= 300) throw new DeliveryError("telegram_http_error", response.statusCode, excerpt);
  return { status: response.statusCode, excerpt };
}

function summarizePayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  if (summary) return summary.slice(0, 1000);
  const keys = Object.keys(payload).slice(0, 8);
  return keys.length > 0 ? `Details: ${keys.join(", ")}` : undefined;
}

async function readExcerpt(body: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const remaining = 64 * 1024 - size;
    if (remaining <= 0) break;
    chunks.push(buffer.subarray(0, remaining));
    size += Math.min(buffer.length, remaining);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n\t]+/g, " ").slice(0, 512);
}

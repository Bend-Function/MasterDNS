import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { NotificationEvent } from "@masterdns/contracts";
import { encryptJson, parseEncryptionKey } from "@masterdns/crypto";
import {
  auditLogs,
  endpointPools,
  notificationChannels,
  notificationDeliveries,
  poolNotificationChannels,
} from "@masterdns/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import type { CreateChannelInput, UpdateChannelInput } from "./notifications.schemas.js";

@Injectable()
export class NotificationsService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);

  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async list(actor: AuthUser) {
    const rows = await this.database.db.select().from(notificationChannels)
      .where(actor.role === "admin" ? undefined : eq(notificationChannels.ownerUserId, actor.id))
      .orderBy(desc(notificationChannels.createdAt));
    if (rows.length === 0) return [];
    const links = await this.database.db.select().from(poolNotificationChannels)
      .where(inArray(poolNotificationChannels.channelId, rows.map((channel) => channel.id)));
    return rows.map((channel) => ({
      ...publicChannel(channel),
      poolLinks: links.filter((link) => link.channelId === channel.id),
    }));
  }

  async create(actor: AuthUser, input: CreateChannelInput) {
    const secret = input.type === "webhook" ? input.secret : input.botToken;
    const encrypted = encryptJson({ secret }, this.encryptionKey);
    const [channel] = await this.database.db.insert(notificationChannels).values({
      ownerUserId: actor.id,
      type: input.type,
      name: input.name,
      endpoint: input.type === "webhook" ? input.url : input.chatId,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretTag: encrypted.tag,
      secretKeyVersion: encrypted.keyVersion,
      enabled: input.enabled,
      isDefault: input.isDefault,
    }).returning();
    if (!channel) throw new Error("Notification channel insert returned no row");
    await this.database.db.insert(auditLogs).values({
      ownerUserId: actor.id,
      actorUserId: actor.id,
      source: "user",
      action: "notification_channel.create",
      resourceType: "notification_channel",
      resourceId: channel.id,
      afterSnapshot: publicChannel(channel),
    });
    return publicChannel(channel);
  }

  async update(actor: AuthUser, channelId: string, input: UpdateChannelInput) {
    const current = await this.findOwned(actor, channelId);
    const secret = current.type === "webhook" ? input.secret : input.botToken;
    const encrypted = secret ? encryptJson({ secret }, this.encryptionKey) : undefined;
    const endpoint = current.type === "webhook" ? input.url : input.chatId;
    const [updated] = await this.database.db.update(notificationChannels).set({
      name: input.name,
      enabled: input.enabled,
      isDefault: input.isDefault,
      endpoint,
      ...(encrypted ? {
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretTag: encrypted.tag,
        secretKeyVersion: encrypted.keyVersion,
      } : {}),
      updatedAt: new Date(),
    }).where(eq(notificationChannels.id, channelId)).returning();
    if (!updated) throw new Error("Notification channel update returned no row");
    await this.database.db.insert(auditLogs).values({
      ownerUserId: current.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      action: "notification_channel.update",
      resourceType: "notification_channel",
      resourceId: channelId,
      beforeSnapshot: publicChannel(current),
      afterSnapshot: publicChannel(updated),
    });
    return publicChannel(updated);
  }

  async remove(actor: AuthUser, channelId: string) {
    const channel = await this.findOwned(actor, channelId);
    await this.database.db.transaction(async (tx) => {
      await tx.insert(auditLogs).values({ ownerUserId: channel.ownerUserId, actorUserId: actor.id, source: "user", action: "notification_channel.delete", resourceType: "notification_channel", resourceId: channelId, beforeSnapshot: publicChannel(channel) });
      await tx.delete(notificationChannels).where(eq(notificationChannels.id, channelId));
    });
    return { deleted: true };
  }

  async test(actor: AuthUser, channelId: string) {
    const channel = await this.findOwned(actor, channelId);
    const event: NotificationEvent = {
      eventId: `test-${randomUUID()}`,
      eventType: "notification.test",
      ownerUserId: channel.ownerUserId,
      occurredAt: new Date().toISOString(),
      payload: { message: "MasterDNS notification test", channelId: channel.id },
    };
    const [delivery] = await this.database.db.insert(notificationDeliveries).values({
      eventId: event.eventId,
      channelId: channel.id,
      payload: event as unknown as Record<string, unknown>,
    }).returning();
    if (!delivery) throw new Error("Notification test delivery insert returned no row");
    await this.queues.notifications.add("deliver-notification", { kind: "deliver", deliveryId: delivery.id }, {
      jobId: delivery.id,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    return { deliveryId: delivery.id };
  }

  async deliveries(actor: AuthUser, limit: number) {
    return this.database.db.select({ delivery: notificationDeliveries, channelName: notificationChannels.name, channelType: notificationChannels.type })
      .from(notificationDeliveries).innerJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
      .where(actor.role === "admin" ? undefined : eq(notificationChannels.ownerUserId, actor.id))
      .orderBy(desc(notificationDeliveries.createdAt)).limit(limit);
  }

  async linkPool(actor: AuthUser, poolId: string, channelId: string, input: { eventFilter: string[]; overridesDefaults: boolean }) {
    const [pool, channel] = await Promise.all([this.findOwnedPool(actor, poolId), this.findOwned(actor, channelId)]);
    if (pool.ownerUserId !== channel.ownerUserId) throw new NotFoundException("通知渠道与 Pool 不属于同一用户");
    const [existing] = await this.database.db.select().from(poolNotificationChannels).where(and(
      eq(poolNotificationChannels.poolId, poolId),
      eq(poolNotificationChannels.channelId, channelId),
    )).limit(1);
    const [link] = await this.database.db.transaction(async (tx) => {
      const result = await tx.insert(poolNotificationChannels).values({ poolId, channelId, ...input }).onConflictDoUpdate({
        target: [poolNotificationChannels.poolId, poolNotificationChannels.channelId],
        set: { ...input },
      }).returning();
      await tx.insert(auditLogs).values({
        ownerUserId: pool.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: existing ? "notification_channel.pool_link.update" : "notification_channel.pool_link.create",
        resourceType: "notification_channel",
        resourceId: channelId,
        beforeSnapshot: existing,
        afterSnapshot: result[0],
      });
      return result;
    });
    if (!link) throw new Error("Notification Pool link insert returned no row");
    return link;
  }

  async unlinkPool(actor: AuthUser, poolId: string, channelId: string) {
    const [pool] = await Promise.all([this.findOwnedPool(actor, poolId), this.findOwned(actor, channelId)]);
    const [existing] = await this.database.db.select().from(poolNotificationChannels).where(and(
      eq(poolNotificationChannels.poolId, poolId),
      eq(poolNotificationChannels.channelId, channelId),
    )).limit(1);
    if (!existing) throw new NotFoundException("Pool 未关联该通知渠道");
    await this.database.db.transaction(async (tx) => {
      await tx.delete(poolNotificationChannels).where(and(eq(poolNotificationChannels.poolId, poolId), eq(poolNotificationChannels.channelId, channelId)));
      await tx.insert(auditLogs).values({
        ownerUserId: pool.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: "notification_channel.pool_link.delete",
        resourceType: "notification_channel",
        resourceId: channelId,
        beforeSnapshot: existing,
      });
    });
    return { deleted: true };
  }

  private async findOwned(actor: AuthUser, channelId: string) {
    const [channel] = await this.database.db.select().from(notificationChannels).where(and(
      eq(notificationChannels.id, channelId),
      actor.role === "admin" ? undefined : eq(notificationChannels.ownerUserId, actor.id),
    )).limit(1);
    if (!channel) throw new NotFoundException("通知渠道不存在");
    return channel;
  }

  private async findOwnedPool(actor: AuthUser, poolId: string) {
    const [pool] = await this.database.db.select().from(endpointPools).where(and(
      eq(endpointPools.id, poolId),
      actor.role === "admin" ? undefined : eq(endpointPools.ownerUserId, actor.id),
    )).limit(1);
    if (!pool) throw new NotFoundException("IP Pool 不存在");
    return pool;
  }
}

function publicChannel(channel: typeof notificationChannels.$inferSelect) {
  return {
    id: channel.id,
    ownerUserId: channel.ownerUserId,
    type: channel.type,
    name: channel.name,
    endpoint: channel.type === "telegram" ? maskChatId(channel.endpoint) : channel.endpoint,
    enabled: channel.enabled,
    isDefault: channel.isDefault,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function maskChatId(value: string | null): string | null {
  if (!value || value.length <= 4) return value;
  return `${"*".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

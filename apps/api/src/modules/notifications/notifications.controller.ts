import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { NotificationsService } from "./notifications.service.js";
import { createChannelSchema, linkChannelSchema, updateChannelSchema } from "./notifications.schemas.js";

@Controller("v1/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get("channels")
  list(@CurrentUser() actor: AuthUser) { return this.notifications.list(actor); }

  @Post("channels")
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.notifications.create(actor, createChannelSchema.parse(body)); }

  @Patch("channels/:channelId")
  update(@CurrentUser() actor: AuthUser, @Param("channelId") channelId: string, @Body() body: unknown) {
    return this.notifications.update(actor, channelId, updateChannelSchema.parse(body));
  }

  @Delete("channels/:channelId")
  remove(@CurrentUser() actor: AuthUser, @Param("channelId") channelId: string) { return this.notifications.remove(actor, channelId); }

  @Post("channels/:channelId/test")
  test(@CurrentUser() actor: AuthUser, @Param("channelId") channelId: string) { return this.notifications.test(actor, channelId); }

  @Get("deliveries")
  deliveries(@CurrentUser() actor: AuthUser, @Query("limit") value?: string) {
    return this.notifications.deliveries(actor, z.coerce.number().int().min(1).max(200).default(50).parse(value));
  }

  @Post("pools/:poolId/channels/:channelId")
  link(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("channelId") channelId: string, @Body() body: unknown) {
    return this.notifications.linkPool(actor, poolId, channelId, linkChannelSchema.parse(body));
  }

  @Delete("pools/:poolId/channels/:channelId")
  unlink(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("channelId") channelId: string) {
    return this.notifications.unlinkPool(actor, poolId, channelId);
  }
}

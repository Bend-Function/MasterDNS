import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";

const base = { name: z.string().trim().min(2).max(120), ownerUserId: z.string().uuid().optional() };
const createSchema = z.discriminatedUnion("provider", [
  z.object({ ...base, provider: z.literal("cloudflare"), apiToken: z.string().trim().min(20).max(512) }),
  z.object({ ...base, provider: z.literal("aliyun"), accessKeyId: z.string().trim().min(8).max(128), accessKeySecret: z.string().trim().min(16).max(256), regionId: z.string().trim().max(80).optional() }),
]);
const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });

@Controller("v1/provider-accounts")
export class ProviderAccountsController {
  constructor(private readonly accounts: ProviderAccountsService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser) { return this.accounts.list(actor); }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.accounts.create(actor, createSchema.parse(body)); }

  @Post(":id/sync")
  sync(@CurrentUser() actor: AuthUser, @Param("id") id: string) { return this.accounts.sync(actor, id); }

  @Patch(":id/status")
  status(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.accounts.setStatus(actor, id, statusSchema.parse(body).status);
  }
}

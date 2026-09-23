import { Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ZodBody } from "../../common/zod-body.decorator.js";
import { cloudProxyCheckSchema, cloudProxyUpdateSchema, type CloudProxyCheckInput, type CloudProxyUpdateInput } from "./cloud-proxy.js";
import { CloudProxyService } from "./cloud-proxy.service.js";

@Controller("v1/cloud-accounts/:id/proxy")
export class CloudProxyController {
  constructor(private readonly proxies: CloudProxyService) {}
  @Get() get(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.proxies.get(actor, id); }
  @Patch() set(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudProxyUpdateSchema) input: CloudProxyUpdateInput) { return this.proxies.set(actor, id, input.proxyUrl); }
  @Post("check") check(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudProxyCheckSchema) input: CloudProxyCheckInput) { return this.proxies.check(actor, id, input); }
}

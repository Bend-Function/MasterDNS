import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { CloudIdleIpsService } from "./cloud-idle-ips.service.js";

@Controller("v1/cloud-accounts/:accountId/lightsail-idle-ips")
export class CloudIdleIpsController {
  constructor(private readonly service: CloudIdleIpsService) {}
  @Get() list(@CurrentUser() actor: AuthUser, @Param("accountId", ParseUUIDPipe) accountId: string) { return this.service.list(actor, accountId); }
  @Post("preview") preview(@CurrentUser() actor: AuthUser, @Param("accountId", ParseUUIDPipe) accountId: string) { return this.service.preview(actor, accountId); }
  @Get(":id") detail(@CurrentUser() actor: AuthUser, @Param("accountId", ParseUUIDPipe) accountId: string, @Param("id", ParseUUIDPipe) id: string) { return this.service.detail(actor, accountId, id); }
  @Post(":id/confirm") confirm(@CurrentUser() actor: AuthUser, @Param("accountId", ParseUUIDPipe) accountId: string, @Param("id", ParseUUIDPipe) id: string) { return this.service.confirm(actor, accountId, id); }
  @Post(":id/items/:index") execute(@CurrentUser() actor: AuthUser, @Param("accountId", ParseUUIDPipe) accountId: string, @Param("id", ParseUUIDPipe) id: string, @Param("index", ParseIntPipe) index: number) { return this.service.execute(actor, accountId, id, index); }
}

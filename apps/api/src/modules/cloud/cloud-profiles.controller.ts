import { Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ZodBody } from "../../common/zod-body.decorator.js";
import { cloudProxyProfileSchema, cloudProxyProfileUpdateSchema, cloudProxySelectionSchema, cloudProxyCheckSchema, type CloudProxyCheckInput, type CloudProxyProfileInput, type CloudProxyProfileUpdateInput } from "./cloud-proxy.js";
import { CloudProxyService } from "./cloud-proxy.service.js";

@Controller("v1/cloud-proxies")
export class CloudProfilesController {
  constructor(private readonly proxies: CloudProxyService) {}
  @Get() list(@CurrentUser() actor: AuthUser) { return this.proxies.listProfiles(actor); }
  @Post() create(@CurrentUser() actor: AuthUser, @ZodBody(cloudProxyProfileSchema) input: CloudProxyProfileInput) { return this.proxies.createProfile(actor, input); }
  @Post("check") checkDraft(@CurrentUser() actor: AuthUser, @ZodBody(cloudProxyCheckSchema) input: CloudProxyCheckInput) { return this.proxies.checkDraft(actor, input); }
  @Patch(":id") update(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudProxyProfileUpdateSchema) input: CloudProxyProfileUpdateInput) { return this.proxies.updateProfile(actor, id, input); }
  @Delete(":id") remove(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.proxies.deleteProfile(actor, id); }
  @Post(":id/check") check(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.proxies.checkProfile(actor, id); }
}

@Controller("v1/cloud-accounts/:id/proxy-selection")
export class CloudProxySelectionController {
  constructor(private readonly proxies: CloudProxyService) {}
  @Patch() select(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudProxySelectionSchema) input: { proxyId: string | null }) { return this.proxies.selectProfile(actor, id, input.proxyId); }
}

import { Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Query, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ZodBody } from "../../common/zod-body.decorator.js";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { cloudRequestKey } from "./cloud-idempotency.js";
import { CloudService } from "./cloud.service.js";
import { cloudAuthorizationSchema, cloudBindingSchema, cloudCredentialsUpdateSchema, cloudEnabledSchema, cloudRegionsUpdateSchema, createCloudAccountSchema } from "./cloud.schemas.js";
import type { CloudAuthorizationInput, CloudBindingInput, CloudCredentialsUpdateInput, CreateCloudAccountInput } from "./cloud.schemas.js";
import { cloudRotationLimitPolicySchema } from "@masterdns/contracts";

@Controller("v1")
export class CloudController {
  constructor(private readonly cloud: CloudService, private readonly bindings: CloudBindingsService) {}
  @Get("cloud-accounts") list(@CurrentUser() actor: AuthUser) { return this.cloud.list(actor); }
  @Post("cloud-accounts") create(@CurrentUser() actor: AuthUser, @ZodBody(createCloudAccountSchema) input: CreateCloudAccountInput, @Headers("idempotency-key") key: string | undefined) { return this.cloud.create(actor, input, cloudRequestKey(key)); }
  @Patch("cloud-accounts/:id/credentials") credentials(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudCredentialsUpdateSchema) input: CloudCredentialsUpdateInput) { return this.cloud.rotateCredentials(actor, id, input); }
  @Patch("cloud-accounts/:id/status") status(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudEnabledSchema) input: { enabled: boolean }) { return this.cloud.setEnabled(actor, id, input.enabled); }
  @Patch("cloud-accounts/:id/regions") regions(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudRegionsUpdateSchema) input: { regions: string[] | null }) { return this.cloud.setRegions(actor, id, input.regions); }
  @Post("cloud-accounts/:id/sync") sync(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.cloud.sync(actor, id); }
  @Get("cloud-accounts/:id/scopes") scopes(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.cloud.scopes(actor, id); }
  @Get("cloud-accounts/:id/instances") instances(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.cloud.instances(actor, id); }
  @Get("cloud-accounts/:id/rotation-limits/:service") rotationLimits(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Param("service") service: string) { return this.cloud.rotationLimits(actor, id, service); }
  @Patch("cloud-accounts/:id/rotation-limits/:service") setRotationLimits(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Param("service") service: string, @ZodBody(cloudRotationLimitPolicySchema) input: { utilizationPercent: number; enabled?: boolean }) { return this.cloud.setRotationLimits(actor, id, service, input); }
  @Get("cloud-instances/:id") instance(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.cloud.instance(actor, id); }
  @Get("cloud-instances/:id/traffic") traffic(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.cloud.monthlyTraffic(actor, id); }
  @Get("address-slots") slots(@CurrentUser() actor: AuthUser, @Query("instanceId", ParseUUIDPipe) id: string) { return this.cloud.slots(actor, id); }
  @Patch("cloud-instances/:id/authorization") authorize(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudAuthorizationSchema) input: CloudAuthorizationInput) { return this.cloud.authorize(actor, id, input); }
  @Post("address-slots/:id/bindings") bind(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudBindingSchema.omit({ slotId: true })) input: Omit<CloudBindingInput, "slotId">, @Headers("idempotency-key") key: string | undefined) { return this.bindings.bind(actor, { ...input, slotId: id }, cloudRequestKey(key)); }
}

import { Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ZodBody } from "../../common/zod-body.decorator.js";
import { cloudRequestKey } from "../cloud/cloud-idempotency.js";
import { rotationPolicySchema, rotationStartSchema, rotationResumeSchema, type RotationResumeInput, type RotationPolicyInput } from "./rotation.schemas.js";
import { RotationService } from "./rotation.service.js";
@Controller("v1")
export class RotationController {
  constructor(private readonly rotations: RotationService) {}
  @Get("rotation-policies") policy(@CurrentUser() actor: AuthUser, @Query("slotId", ParseUUIDPipe) slotId: string) { return this.rotations.policy(actor, slotId); }
  @Patch("rotation-policies/:slotId") setPolicy(@CurrentUser() actor: AuthUser, @Param("slotId", ParseUUIDPipe) slotId: string, @ZodBody(rotationPolicySchema) input: RotationPolicyInput) { return this.rotations.setPolicy(actor, slotId, input); }
  @Get("rotations") list(@CurrentUser() actor: AuthUser) { return this.rotations.list(actor); }
  @Post("rotations") start(@CurrentUser() actor: AuthUser, @ZodBody(rotationStartSchema) input: { slotId: string }, @Headers("idempotency-key") key?: string) { return this.rotations.start(actor, input.slotId, cloudRequestKey(key)); }
  @Get("rotations/:id") detail(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.rotations.detail(actor, id); }
  @Post("rotations/:id/pause") pause(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.rotations.pause(actor, id); }
  @Post("rotations/:id/resume") resume(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Headers("idempotency-key") key?: string, @ZodBody(rotationResumeSchema) input: RotationResumeInput = {}) { return this.rotations.resume(actor, id, cloudRequestKey(key), input); }
}

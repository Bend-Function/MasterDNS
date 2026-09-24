import { Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import type { RotationScheduleResumeInput, RotationScheduleUpdateInput } from "@masterdns/contracts";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ZodBody } from "../../common/zod-body.decorator.js";
import { rotationScheduleResumeSchema, rotationScheduleUpdateSchema } from "./rotation.schemas.js";
import { RotationSchedulesService } from "./rotation-schedules.service.js";

@Controller("v1/rotation-schedules")
export class RotationSchedulesController {
  constructor(private readonly schedules: RotationSchedulesService) {}

  @Get(":slotId")
  get(@CurrentUser() actor: AuthUser, @Param("slotId", ParseUUIDPipe) slotId: string) {
    return this.schedules.get(actor, slotId);
  }

  @Patch(":slotId")
  update(@CurrentUser() actor: AuthUser, @Param("slotId", ParseUUIDPipe) slotId: string, @ZodBody(rotationScheduleUpdateSchema) input: RotationScheduleUpdateInput) {
    return this.schedules.update(actor, slotId, input);
  }

  @Post(":slotId/resume")
  resume(@CurrentUser() actor: AuthUser, @Param("slotId", ParseUUIDPipe) slotId: string, @ZodBody(rotationScheduleResumeSchema) input: RotationScheduleResumeInput) {
    return this.schedules.resume(actor, slotId, input);
  }
}

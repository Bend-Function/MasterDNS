import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { HealthPoliciesService } from "./health-policies.service.js";
@Controller("v1")
export class HealthPoliciesController {
  constructor(@Inject(HealthPoliciesService) private readonly policies: HealthPoliciesService) {}
  @Get("address-health-policies") list(@CurrentUser() actor: AuthUser) { return this.policies.list(actor); }
  @Put("address-health-policies") save(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.policies.save(actor, body); }
  @Get("address-health-policies/:id/rounds") rounds(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.policies.rounds(actor, id); }
  @Get("address-health-policies/:id/stats") stats(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.policies.stats(actor, id); }
  @Get("address-slots/:id/health-config") config(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.policies.slotConfig(actor, id); }
  @Put("address-slots/:id/health-config") slotConfig(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) { return this.policies.saveSlotConfig(actor, id, body); }
}

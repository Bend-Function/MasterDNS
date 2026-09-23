import { Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { CloudStateResetService } from "./cloud-state-reset.service.js";

@Controller("v1/cloud-instances")
export class CloudStateResetController {
  constructor(private readonly service: CloudStateResetService) {}
  @Post(":id/reset-state") reset(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.service.reset(actor, id); }
}

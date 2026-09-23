import { Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { cloudLifecycleActionSchema, cloudTrafficStopPolicySchema, type CloudLifecycleActionInput, type CloudTrafficStopPolicyInput } from "@masterdns/contracts";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ZodBody } from "../../common/zod-body.decorator.js";
import { cloudRequestKey } from "./cloud-idempotency.js";
import { CloudLifecycleService } from "./cloud-lifecycle.service.js";
@Controller("v1/cloud-instances")
export class CloudLifecycleController {
  constructor(private readonly lifecycle: CloudLifecycleService) {}
  @Get(":id/control") control(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.lifecycle.control(actor, id); }
  @Patch(":id/traffic-policy") policy(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudTrafficStopPolicySchema) input: CloudTrafficStopPolicyInput) { return this.lifecycle.setTrafficPolicy(actor, id, input); }
  @Post(":id/actions") action(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @ZodBody(cloudLifecycleActionSchema) input: CloudLifecycleActionInput, @Headers("idempotency-key") key: string | undefined) { return this.lifecycle.action(actor, id, input, cloudRequestKey(key)); }
}

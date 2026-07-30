import { Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { OperationsService } from "./operations.service.js";

@Controller("v1/operations")
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser, @Query("limit") value?: string) {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(value);
    return this.operations.list(actor, limit);
  }

  @Get(":id")
  get(@CurrentUser() actor: AuthUser, @Param("id") id: string) { return this.operations.get(actor, id); }

  @Post(":id/rollback")
  rollback(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Headers("idempotency-key") key?: string) {
    return this.operations.rollback(actor, id, key);
  }

  @Post(":id/retry")
  retry(@CurrentUser() actor: AuthUser, @Param("id") id: string) { return this.operations.retry(actor, id); }
}

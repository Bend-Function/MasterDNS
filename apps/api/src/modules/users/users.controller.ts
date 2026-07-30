import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { UsersService } from "./users.service.js";

const createUserSchema = z.object({
  username: z.string().trim().min(2).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.string().email().max(320).optional(),
  password: z.string().min(12).max(1024),
  role: z.enum(["admin", "user"]).default("user"),
});
const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const passwordSchema = z.object({ password: z.string().min(12).max(1024) });

@Controller("v1/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser) { return this.users.list(actor); }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.users.create(actor, createUserSchema.parse(body)); }

  @Patch(":id/status")
  status(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.users.setStatus(actor, id, statusSchema.parse(body).status);
  }

  @Post(":id/reset-password")
  resetPassword(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.users.resetPassword(actor, id, passwordSchema.parse(body).password);
  }
}

import { Body, Controller, Get, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CurrentUser, Public } from "./auth.decorators.js";
import type { AuthUser } from "./auth.types.js";
import { AuthService } from "./auth.service.js";

const loginSchema = z.object({ identifier: z.string().min(1).max(320), password: z.string().min(1).max(1024) });

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = loginSchema.parse(body);
    return this.auth.login(input.identifier, input.password, request, reply);
  }

  @Post("logout")
  logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.logout(user.sessionId, reply);
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}

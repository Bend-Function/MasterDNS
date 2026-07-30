import { Body, Controller, Get, Header, Headers, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AllowNonBrowser, CurrentUser, Public } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { DdnsService } from "./ddns.service.js";
import { exchangeSchema, heartbeatSchema, installTokenSchema } from "./ddns.schemas.js";

@Controller()
export class DdnsController {
  constructor(private readonly ddns: DdnsService) {}

  @Get("v1/pools/:poolId/endpoints/:endpointId/ddns")
  getAgent(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string) {
    return this.ddns.getAgent(actor, poolId, endpointId);
  }

  @Post("v1/pools/:poolId/endpoints/:endpointId/ddns/install-token")
  installToken(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string, @Body() body: unknown) {
    return this.ddns.createInstallToken(actor, poolId, endpointId, installTokenSchema.parse(body));
  }

  @Post("v1/pools/:poolId/endpoints/:endpointId/ddns/revoke")
  revoke(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string) {
    return this.ddns.revoke(actor, poolId, endpointId);
  }

  @Public()
  @AllowNonBrowser()
  @Post("v1/ddns/exchange")
  exchange(@Body() body: unknown) { return this.ddns.exchange(exchangeSchema.parse(body)); }

  @Public()
  @AllowNonBrowser()
  @Post("v1/ddns/heartbeat")
  heartbeat(@Headers("authorization") authorization: string | undefined, @Body() body: unknown, @Req() request: FastifyRequest) {
    return this.ddns.heartbeat(authorization, heartbeatSchema.parse(body), request.ip);
  }

  @Public()
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Get("v1/ddns/install.sh")
  installScript() { return this.ddns.script("install.sh"); }

  @Public()
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Get("v1/ddns/agent.sh")
  agentScript() { return this.ddns.script("masterdns-ddns"); }
}

import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import {
  createBindingSchema,
  createEndpointSchema,
  createHealthCheckSchema,
  createPoolSchema,
  reconcilePoolSchema,
  policyVersionParamSchema,
  restorePolicyVersionSchema,
  updateBindingSchema,
  updateEndpointSchema,
  updatePoolSchema,
} from "./pools.schemas.js";
import { PoolsService } from "./pools.service.js";

@Controller("v1/pools")
export class PoolsController {
  constructor(private readonly pools: PoolsService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser) { return this.pools.list(actor); }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.pools.create(actor, createPoolSchema.parse(body)); }

  @Get(":poolId")
  get(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string) { return this.pools.get(actor, poolId); }

  @Patch(":poolId")
  update(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Body() body: unknown) {
    return this.pools.update(actor, poolId, updatePoolSchema.parse(body));
  }

  @Post(":poolId/pause")
  pause(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string) { return this.pools.pause(actor, poolId); }

  @Post(":poolId/resume")
  resume(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string) { return this.pools.resume(actor, poolId); }

  @Post(":poolId/reconcile")
  reconcile(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Body() body: unknown) {
    return this.pools.reconcile(actor, poolId, reconcilePoolSchema.parse(body));
  }

  @Post(":poolId/policy-versions/:version/restore")
  restorePolicyVersion(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("version") version: string, @Body() body: unknown) {
    return this.pools.restorePolicyVersion(actor, poolId, policyVersionParamSchema.parse(version), restorePolicyVersionSchema.parse(body));
  }

  @Delete(":poolId")
  remove(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string) { return this.pools.remove(actor, poolId); }

  @Post(":poolId/endpoints")
  createEndpoint(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Body() body: unknown) {
    return this.pools.createEndpoint(actor, poolId, createEndpointSchema.parse(body));
  }

  @Patch(":poolId/endpoints/:endpointId")
  updateEndpoint(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string, @Body() body: unknown) {
    return this.pools.updateEndpoint(actor, poolId, endpointId, updateEndpointSchema.parse(body));
  }

  @Delete(":poolId/endpoints/:endpointId")
  deleteEndpoint(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string) {
    return this.pools.deleteEndpoint(actor, poolId, endpointId);
  }

  @Post(":poolId/endpoints/:endpointId/check")
  checkEndpoint(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string) {
    return this.pools.checkEndpoint(actor, poolId, endpointId);
  }

  @Post(":poolId/bindings")
  createBinding(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Body() body: unknown) {
    return this.pools.createBinding(actor, poolId, createBindingSchema.parse(body));
  }

  @Patch(":poolId/bindings/:bindingId")
  updateBinding(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("bindingId") bindingId: string, @Body() body: unknown) {
    return this.pools.updateBinding(actor, poolId, bindingId, updateBindingSchema.parse(body));
  }

  @Delete(":poolId/bindings/:bindingId")
  deleteBinding(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("bindingId") bindingId: string) {
    return this.pools.deleteBinding(actor, poolId, bindingId);
  }

  @Post(":poolId/checks")
  createPoolCheck(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Body() body: unknown) {
    return this.pools.createHealthCheck(actor, poolId, "pool", undefined, createHealthCheckSchema.parse(body).config);
  }

  @Post(":poolId/endpoints/:endpointId/checks")
  createEndpointCheck(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("endpointId") endpointId: string, @Body() body: unknown) {
    return this.pools.createHealthCheck(actor, poolId, "endpoint", endpointId, createHealthCheckSchema.parse(body).config);
  }

  @Post(":poolId/bindings/:bindingId/checks")
  createBindingCheck(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("bindingId") bindingId: string, @Body() body: unknown) {
    return this.pools.createHealthCheck(actor, poolId, "binding", bindingId, createHealthCheckSchema.parse(body).config);
  }

  @Delete(":poolId/checks/:checkId")
  deleteCheck(@CurrentUser() actor: AuthUser, @Param("poolId") poolId: string, @Param("checkId") checkId: string) {
    return this.pools.deleteHealthCheck(actor, poolId, checkId);
  }
}

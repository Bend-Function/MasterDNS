import { Body, Controller, Get, Header, Inject, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ProbesService } from "./probes.service.js";
const name = z.string().trim().min(1).max(120);
const concurrency = z.number().int().min(1).max(100);
const createProbe = z.object({ name, maxConcurrency: concurrency.default(16) }).strict();
const updateProbe = z.object({ name: name.optional(), maxConcurrency: concurrency.optional(), enabled: z.boolean().optional() }).strict();
const createGroup = z.object({ name }).strict();
const members = z.object({ memberIds: z.array(z.uuid()).max(100) }).strict();

@Controller("v1")
export class ProbesController {
  constructor(@Inject(ProbesService) private readonly probes: ProbesService) {}
  @Get("probes")
  list(@CurrentUser() actor: AuthUser) { return this.probes.list(actor); }
  @Post("probes")
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.probes.create(actor, createProbe.parse(body)); }
  @Patch("probes/:id")
  update(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) { return this.probes.update(actor, id, updateProbe.parse(body)); }
  @Post("probes/:id/install-token")
  @Header("Cache-Control", "no-store")
  install(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.probes.createInstallToken(actor, id); }
  @Post("probes/:id/revoke")
  revoke(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string) { return this.probes.revoke(actor, id); }
  @Get("probe-groups")
  groups(@CurrentUser() actor: AuthUser) { return this.probes.listGroups(actor); }
  @Post("probe-groups")
  createGroup(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.probes.createGroup(actor, createGroup.parse(body)); }
  @Patch("probe-groups/:id/members")
  members(@CurrentUser() actor: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) { return this.probes.setMembers(actor, id, members.parse(body).memberIds); }
}

import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from "@nestjs/common";
import { dnsRecordInputSchema } from "@masterdns/contracts";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { DnsService } from "./dns.service.js";

@Controller("v1/zones")
export class DnsController {
  constructor(private readonly dns: DnsService) {}

  @Get()
  zones(@CurrentUser() actor: AuthUser) { return this.dns.listZones(actor); }

  @Get(":zoneId/records")
  records(@CurrentUser() actor: AuthUser, @Param("zoneId") zoneId: string) { return this.dns.listRecords(actor, zoneId); }

  @Post(":zoneId/sync")
  sync(@CurrentUser() actor: AuthUser, @Param("zoneId") zoneId: string) { return this.dns.syncZone(actor, zoneId); }

  @Post(":zoneId/records")
  create(@CurrentUser() actor: AuthUser, @Param("zoneId") zoneId: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    return this.dns.createRecord(actor, zoneId, dnsRecordInputSchema.parse(body), key);
  }

  @Patch(":zoneId/records/:recordId")
  update(@CurrentUser() actor: AuthUser, @Param("zoneId") zoneId: string, @Param("recordId") recordId: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    return this.dns.updateRecord(actor, zoneId, recordId, dnsRecordInputSchema.parse(body), key);
  }

  @Delete(":zoneId/records/:recordId")
  remove(@CurrentUser() actor: AuthUser, @Param("zoneId") zoneId: string, @Param("recordId") recordId: string, @Headers("idempotency-key") key?: string) {
    return this.dns.deleteRecord(actor, zoneId, recordId, key);
  }
}

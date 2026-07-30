import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module.js";
import { DnsController } from "./dns.controller.js";
import { DnsService } from "./dns.service.js";

@Module({ imports: [OperationsModule], controllers: [DnsController], providers: [DnsService] })
export class DnsModule {}

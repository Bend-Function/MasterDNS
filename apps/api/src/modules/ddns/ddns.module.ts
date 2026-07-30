import { Module } from "@nestjs/common";
import { DdnsController } from "./ddns.controller.js";
import { DdnsService } from "./ddns.service.js";

@Module({ controllers: [DdnsController], providers: [DdnsService] })
export class DdnsModule {}

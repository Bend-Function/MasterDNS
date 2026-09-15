import { Module } from "@nestjs/common";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { CloudController } from "./cloud.controller.js";
import { CloudService } from "./cloud.service.js";

@Module({ controllers: [CloudController], providers: [CloudService, CloudBindingsService], exports: [CloudService, CloudBindingsService] })
export class CloudModule {}

import { Module } from "@nestjs/common";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { CloudController } from "./cloud.controller.js";
import { CloudService } from "./cloud.service.js";
import { CloudIdleIpsService } from "./cloud-idle-ips.service.js";
import { CloudIdleIpsController } from "./cloud-idle-ips.controller.js";

@Module({ controllers: [CloudController, CloudIdleIpsController], providers: [CloudService, CloudBindingsService, CloudIdleIpsService], exports: [CloudService, CloudBindingsService] })
export class CloudModule {}

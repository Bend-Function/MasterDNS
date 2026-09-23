import { Module } from "@nestjs/common";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { CloudController } from "./cloud.controller.js";
import { CloudService } from "./cloud.service.js";
import { CloudIdleIpsService } from "./cloud-idle-ips.service.js";
import { CloudIdleIpsController } from "./cloud-idle-ips.controller.js";
import { CloudStateResetService } from "./cloud-state-reset.service.js";
import { CloudStateResetController } from "./cloud-state-reset.controller.js";

@Module({ controllers: [CloudController, CloudIdleIpsController, CloudStateResetController], providers: [CloudService, CloudBindingsService, CloudIdleIpsService, CloudStateResetService], exports: [CloudService, CloudBindingsService] })
export class CloudModule {}

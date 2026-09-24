import { Module } from "@nestjs/common";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { CloudController } from "./cloud.controller.js";
import { CloudService } from "./cloud.service.js";
import { CloudIdleIpsService } from "./cloud-idle-ips.service.js";
import { CloudIdleIpsController } from "./cloud-idle-ips.controller.js";
import { CloudStateResetService } from "./cloud-state-reset.service.js";
import { CloudStateResetController } from "./cloud-state-reset.controller.js";
import { CloudLifecycleController } from "./cloud-lifecycle.controller.js";
import { CloudLifecycleService } from "./cloud-lifecycle.service.js";
import { CloudProxyController } from "./cloud-proxy.controller.js";
import { CloudProxyService } from "./cloud-proxy.service.js";
import { CloudProfilesController, CloudProxySelectionController } from "./cloud-profiles.controller.js";

@Module({ controllers: [CloudController, CloudIdleIpsController, CloudStateResetController, CloudLifecycleController, CloudProxyController, CloudProfilesController, CloudProxySelectionController], providers: [CloudService, CloudBindingsService, CloudIdleIpsService, CloudStateResetService, CloudLifecycleService, CloudProxyService], exports: [CloudService, CloudBindingsService] })
export class CloudModule {}

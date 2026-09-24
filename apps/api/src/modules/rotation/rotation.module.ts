import { Module } from "@nestjs/common";
import { RotationController } from "./rotation.controller.js";
import { RotationService } from "./rotation.service.js";
import { RotationSchedulesController } from "./rotation-schedules.controller.js";
import { RotationSchedulesService } from "./rotation-schedules.service.js";
@Module({ controllers: [RotationController, RotationSchedulesController], providers: [RotationService, RotationSchedulesService], exports: [RotationService, RotationSchedulesService] })
export class RotationModule {}

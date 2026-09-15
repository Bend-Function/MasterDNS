import { Module } from "@nestjs/common";
import { RotationController } from "./rotation.controller.js";
import { RotationService } from "./rotation.service.js";
@Module({ controllers: [RotationController], providers: [RotationService], exports: [RotationService] })
export class RotationModule {}

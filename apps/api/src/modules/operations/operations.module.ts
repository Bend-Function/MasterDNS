import { Module } from "@nestjs/common";
import { OperationsController } from "./operations.controller.js";
import { OperationsService } from "./operations.service.js";

@Module({ controllers: [OperationsController], providers: [OperationsService], exports: [OperationsService] })
export class OperationsModule {}

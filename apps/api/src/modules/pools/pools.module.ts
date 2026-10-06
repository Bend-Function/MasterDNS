import { Module } from "@nestjs/common";
import { PoolsController } from "./pools.controller.js";
import { PoolsService } from "./pools.service.js";
import { BindingReadbackService } from "../dns/binding-readback.service.js";

@Module({ controllers: [PoolsController], providers: [PoolsService, BindingReadbackService], exports: [PoolsService] })
export class PoolsModule {}

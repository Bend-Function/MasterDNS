import { Module } from "@nestjs/common";
import { PoolsController } from "./pools.controller.js";
import { PoolsService } from "./pools.service.js";

@Module({ controllers: [PoolsController], providers: [PoolsService], exports: [PoolsService] })
export class PoolsModule {}

import { Module } from "@nestjs/common";
import { ProviderAccountsController } from "./provider-accounts.controller.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";

@Module({ controllers: [ProviderAccountsController], providers: [ProviderAccountsService], exports: [ProviderAccountsService] })
export class ProviderAccountsModule {}

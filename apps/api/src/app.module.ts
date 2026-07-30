import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { OriginGuard } from "./auth/origin.guard.js";
import { RateLimitGuard } from "./auth/rate-limit.guard.js";
import { DatabaseModule } from "./infrastructure/database.module.js";
import { QueueModule } from "./infrastructure/queue.module.js";
import { DdnsModule } from "./modules/ddns/ddns.module.js";
import { DnsModule } from "./modules/dns/dns.module.js";
import { EventsController } from "./modules/events/events.controller.js";
import { HealthController } from "./modules/health/health.controller.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { OperationsModule } from "./modules/operations/operations.module.js";
import { ProviderAccountsModule } from "./modules/provider-accounts/provider-accounts.module.js";
import { PoolsModule } from "./modules/pools/pools.module.js";
import { UsersModule } from "./modules/users/users.module.js";

@Module({
  imports: [DatabaseModule, QueueModule, AuthModule, UsersModule, ProviderAccountsModule, OperationsModule, DnsModule, PoolsModule, DdnsModule, NotificationsModule],
  controllers: [HealthController, EventsController],
  providers: [
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}

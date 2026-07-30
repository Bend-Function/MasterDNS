import { Module } from "@nestjs/common";
import { ReconcileProcessor } from "./automation/reconcile.processor.js";
import { ReconcileOutboxService } from "./automation/reconcile-outbox.service.js";
import { DatabaseService } from "./database.service.js";
import { HealthProcessor } from "./health/health.processor.js";
import { HealthRetentionService } from "./health/health-retention.service.js";
import { HealthSchedulerService } from "./health/health-scheduler.service.js";
import { NotificationProcessor } from "./notifications/notification.processor.js";
import { AllDownReminderService } from "./notifications/all-down-reminder.service.js";
import { OperationProcessor } from "./operations/operation.processor.js";
import { ProviderRuntimeService } from "./providers/provider-runtime.service.js";
import { QueueRuntimeService } from "./queue-runtime.service.js";
import { SyncProcessor } from "./sync/sync.processor.js";
import { SyncSchedulerService } from "./sync/sync-scheduler.service.js";

@Module({
  providers: [
    DatabaseService,
    QueueRuntimeService,
    ProviderRuntimeService,
    OperationProcessor,
    SyncProcessor,
    SyncSchedulerService,
    HealthProcessor,
    HealthSchedulerService,
    HealthRetentionService,
    ReconcileProcessor,
    ReconcileOutboxService,
    NotificationProcessor,
    AllDownReminderService,
  ],
})
export class WorkerModule {}

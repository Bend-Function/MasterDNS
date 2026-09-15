import { RotationPublicationService } from "./rotation/rotation-publication.service.js";
import { RotationCleanupService } from "./rotation/rotation-cleanup.service.js";
import { RotationProcessor } from "./rotation/rotation.processor.js";
import { RotationRecoveryService } from "./rotation/rotation-recovery.service.js";
import { RotationStore } from "./rotation/rotation-store.js";
import { HealthResultService } from "./health/health-result.service.js";
import { ProbeSchedulerService } from "./probes/probe-scheduler.service.js";
import { ProbeHealthService } from "./probes/probe-health.service.js";
import { Module } from "@nestjs/common";
import { ReconcileProcessor } from "./automation/reconcile.processor.js";
import { ReconcileOutboxService } from "./automation/reconcile-outbox.service.js";
import { CloudRuntimeService } from "./cloud/cloud-runtime.service.js";
import { CloudSyncService } from "./cloud/cloud-sync.service.js";
import { DatabaseService } from "./database.service.js";
import { HealthProcessor } from "./health/health.processor.js";
import { HealthRetentionService } from "./health/health-retention.service.js";
import { HealthSchedulerService } from "./health/health-scheduler.service.js";
import { NotificationProcessor } from "./notifications/notification.processor.js";
import { AllDownReminderService } from "./notifications/all-down-reminder.service.js";
import { NotificationStateScannerService } from "./notifications/notification-state-scanner.service.js";
import { OperationProcessor } from "./operations/operation.processor.js";
import { ProviderRuntimeService } from "./providers/provider-runtime.service.js";
import { QueueRuntimeService } from "./queue-runtime.service.js";
import { SyncProcessor } from "./sync/sync.processor.js";
import { SyncSchedulerService } from "./sync/sync-scheduler.service.js";

@Module({
  providers: [
    RotationProcessor, RotationRecoveryService, RotationStore, RotationPublicationService, RotationCleanupService,
    DatabaseService,
    CloudRuntimeService,
    CloudSyncService,
    QueueRuntimeService,
    ProviderRuntimeService,
    OperationProcessor,
    SyncProcessor,
    SyncSchedulerService,
    HealthResultService,
    ProbeHealthService,
    ProbeSchedulerService,
    HealthProcessor,
    HealthSchedulerService,
    HealthRetentionService,
    ReconcileProcessor,
    ReconcileOutboxService,
    NotificationProcessor,
    NotificationStateScannerService,
    AllDownReminderService,
  ],
})
export class WorkerModule {}

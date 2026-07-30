import { Module } from "@nestjs/common";
import { ReconcileProcessor } from "./automation/reconcile.processor.js";
import { DatabaseService } from "./database.service.js";
import { HealthProcessor } from "./health/health.processor.js";
import { HealthSchedulerService } from "./health/health-scheduler.service.js";
import { OperationProcessor } from "./operations/operation.processor.js";
import { ProviderRuntimeService } from "./providers/provider-runtime.service.js";
import { QueueRuntimeService } from "./queue-runtime.service.js";
import { SyncProcessor } from "./sync/sync.processor.js";

@Module({
  providers: [
    DatabaseService,
    QueueRuntimeService,
    ProviderRuntimeService,
    OperationProcessor,
    SyncProcessor,
    HealthProcessor,
    HealthSchedulerService,
    ReconcileProcessor,
  ],
})
export class WorkerModule {}

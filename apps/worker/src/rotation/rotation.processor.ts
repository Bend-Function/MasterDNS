import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";
import { queueNames, type RotationJob } from "@masterdns/contracts";
import { CloudError } from "@masterdns/cloud-providers";
import { CloudRuntimeService } from "../cloud/cloud-runtime.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
import { env } from "../env.js";
import { RotationStore } from "./rotation-store.js";

// These are explicit authentication/admission rejections. Transport failures and
// arbitrary retryable errors remain uncertain and are never redispatched blindly.
const noEffectErrors = new Set(["permission_denied", "quota_exceeded", "rate_limited", "credentials_expired", "invalid_credentials", "rotation_unsupported", "invalid_rotation_step", "cloud_writes_not_enabled", "remote_identity_changed", "cleanup_not_authorized"]);
@Injectable()
export class RotationProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<RotationJob>;
  private readonly logger = new Logger(RotationProcessor.name);
  constructor(private readonly store: RotationStore, private readonly runtime: CloudRuntimeService, private readonly queues: QueueRuntimeService) {}
  onModuleInit() {
    this.worker = new Worker<RotationJob>(queueNames.rotation, job => this.run(job.data.incidentId), { connection: { url: env.REDIS_URL }, concurrency: 8 });
    this.worker.on("error", error => this.logger.error(error.message));
  }
  async onModuleDestroy() { await this.worker?.close(); }
  async run(incidentId: string) {
    const lease = await this.store.claim(incidentId); if (!lease) return;
    try {
      const run = await this.store.read(incidentId, lease);
      const action = run.action;
      if (run.incident.phase === "publish" || run.incident.phase === "cleanup") return; // Durable P10 boundary, never no-op success.
      if (action.kind !== "execute" && action.kind !== "observe") { await this.store.settle(incidentId, lease); return; }
      const identity = { credentialCiphertext: run.c.account.credentialCiphertext, externalAccountId: run.c.account.externalAccountId };
      const adapter = await this.runtime.adapter(run.c.account.id, run.c.instance.service, { observation: action.kind === "observe" });
      if (!adapter.observeDetails) throw new CloudError("rotation_unsupported", false);
      if (action.kind === "observe") {
        const step = run.steps.find(s => s.id === action.stepId)!;
        try {
          const observation = await adapter.observeDetails({ ...step.plan, arguments: { ...step.plan.arguments, ...(step.receipt ? { receipt: step.receipt } : {}), previousExecution: true } });
          await this.store.saveReceipt(incidentId, step.id, observation, true);
          if (action.convergenceExpired && observation.status === "pending") await this.store.pause(incidentId, "cloud_convergence_timeout");
        } catch (error) { await this.store.reject(incidentId, step.id, safeError(error), false); }
      } else if (action.operation === "prepare_attempt") {
        const inventory = await adapter.inspect({ accountId: run.c.account.id, service: run.c.instance.service, region: run.c.instance.region, instanceId: run.c.instance.externalId });
        await this.store.prepare(incidentId, lease, inventory, identity);
      } else {
        const plan = await this.store.dispatch(incidentId, lease, action.stepId, identity); if (!plan) return;
        let receipt;
        try { receipt = await adapter.execute(plan); }
        catch (error) { await this.store.reject(incidentId, action.stepId, safeError(error), error instanceof CloudError && noEffectErrors.has(error.code)); return; }
        // A failure here leaves the original in_flight intent. Recovery observes;
        // it cannot infer no-effect from a lost database write or SDK response.
        await this.store.saveReceipt(incidentId, action.stepId, receipt);
      }
    } catch (error) {
      await this.store.pause(incidentId, safeError(error));
    } finally { await this.store.release(lease); }
  }
}
function safeError(error: unknown) {
  if (error instanceof CloudError) return error.code;
  if (error instanceof Error && ["authorization_changed", "authorization_revoked", "family_disabled", "region_excluded", "resource_not_found", "conflicting_manager"].includes(error.message)) return error.message;
  return "rotation_runtime_failed";
}

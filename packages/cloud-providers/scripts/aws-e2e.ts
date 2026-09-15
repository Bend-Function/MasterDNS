import { CloudError } from "../src/errors.js";
import { createCloudAdapter } from "../src/factory.js";
import { FileAwsE2eJournalStore, loadAwsE2eConfig, runAwsE2e } from "../src/aws-e2e-harness.js";

try {
  const loaded = loadAwsE2eConfig(process.env);
  if (loaded.outcome === "skipped") {
    console.log(JSON.stringify(loaded));
  } else {
    const { config } = loaded;
    const adapter = createCloudAdapter({
      accountId: config.scope.accountId,
      service: config.scope.service,
      credentials: config.credentials,
    });
    const result = await runAwsE2e(config, {
      adapter,
      ...(config.journalPath ? { journal: new FileAwsE2eJournalStore(config.journalPath) } : {}),
    });
    console.log(JSON.stringify(result));
    if (result.outcome === "pending" || result.outcome === "needs_review") process.exitCode = 2;
  }
} catch (error) {
  const failure = error instanceof CloudError
    ? error.toJSON()
    : { name: "AwsE2eError", code: error instanceof Error ? error.message : "unknown_failure" };
  console.error(JSON.stringify({ outcome: "failed", error: failure }));
  process.exitCode = 1;
}

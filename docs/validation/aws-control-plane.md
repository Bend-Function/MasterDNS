# AWS control-plane acceptance harness

This opt-in command exercises one explicitly scoped EC2 or Lightsail address-rotation plan through `@masterdns/cloud-providers`. It uses the production adapter, planner, live preconditions, and ownership checks. It does not publish DNS, stop or create instances, change Lightsail bundles, release any address, restore the original address, or claim business-health success.

Without the full credential and resource scope below, the command exits successfully with an `outcome: "skipped"` JSON result and the missing variable names. It never falls back to an AWS profile, instance role, shared configuration, or other ambient credential source.

## Command and environment

Use temporary STS credentials dedicated to an isolated test resource. Every resource selector is mandatory even for the default read-only run.

| Variable | Required value |
| --- | --- |
| `MASTERDNS_AWS_E2E_ACCESS_KEY_ID` | Temporary test access-key ID |
| `MASTERDNS_AWS_E2E_SECRET_ACCESS_KEY` | Temporary test secret access key |
| `MASTERDNS_AWS_E2E_SESSION_TOKEN` | Temporary test session token |
| `MASTERDNS_AWS_E2E_ACCOUNT_ID` | Exact 12-digit external AWS account ID expected from STS |
| `MASTERDNS_AWS_E2E_SERVICE` | Exactly `ec2` or `lightsail` |
| `MASTERDNS_AWS_E2E_REGION` | Exact AWS region |
| `MASTERDNS_AWS_E2E_INSTANCE_ID` | Exact EC2 instance ID, or exact Lightsail instance ARN |
| `MASTERDNS_AWS_E2E_SLOT_ID` | Stable local identifier for this exact address slot |
| `MASTERDNS_AWS_E2E_INTERFACE_ID` | Exact EC2 ENI ID, or exactly `primary` for Lightsail |
| `MASTERDNS_AWS_E2E_ADDRESS` | Exact currently attached public IPv4 or IPv6 address |
| `MASTERDNS_AWS_E2E_FAMILY` | Exactly `4` or `6`, matching the address |
| `MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME` | Lightsail only: exact native instance name |
| `MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME` | Lightsail only: exact attached static-IP name, or exactly `none` for a dynamic address |

Run the read-only inspection and plan first:

```sh
pnpm --filter @masterdns/cloud-providers test:aws-e2e
```

A read-only result reports `outcome: "read_only"`, the exact scope, current instance state, and planned action names. It performs no mutation. Confirm that scope and plan refer only to the isolated test resource before enabling writes.

Write mode additionally requires both variables below:

```sh
export MASTERDNS_AWS_E2E_WRITE=1
export MASTERDNS_AWS_E2E_JOURNAL=/absolute/private/path/masterdns-aws-e2e.json
pnpm --filter @masterdns/cloud-providers test:aws-e2e
```

The journal directory and file must be protected as test control data. Credentials are never written to it. `MASTERDNS_AWS_E2E_OBSERVE_TIMEOUT_MS` may set the per-step read-back window from `0` to `300000` milliseconds; its default is `30000`. `MASTERDNS_AWS_E2E_OBSERVE_INTERVAL_MS` has the same range and defaults to `2000`.

## Safety and recovery

The harness acquires `<journal>.lock` before loading the journal and holds it through observation or completion. A concurrent invocation exits with `journal_locked` before any cloud read or mutation. Lock ownership uses the local host and PID only to distinguish a definitely dead same-host owner as `journal_lock_stale`; it never steals a lock based on elapsed time. After confirming the recorded process is gone and inspecting the journal/resources, an operator may remove only that stale `.lock` file and rerun with the same scope.

The harness creates one attempt and persists its original normalized inventory and full production `CloudStep` plan before dispatch. Each journal replacement is written to a private temporary file, synced, renamed, and followed by a directory sync. Persistence errors abort before the corresponding mutation. On resume, the plan is rebuilt from the persisted original inventory and must exactly match action order, IDs, scope, and before snapshots. Before each mutation the harness rechecks the STS account and exact instance/interface scope. After each side effect it immediately persists the provider receipt, then reads the remote state through `observeDetails`. No next step is dispatched until the prior observation is `applied`.

Lightsail inspection uses only `GetInstance` for the explicit native instance name and, unless `MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME=none`, `GetStaticIp` for the explicit static-IP name. It verifies the instance ARN and the static IP's address and attachment identity. The harness does not call `GetInstances` or `GetStaticIps` to discover matching resources.

If the process stops after dispatch, rerun the same command with the same scope and journal path. A `dispatched`, `received`, or `pending` step is observed; it is not blindly executed again. A pending observation exits with code 2 and retains the attempt, action, allocation/resource ID, and candidate address in the journal and output. An ambiguous or not-applied observation becomes `needs_review`, also exits with code 2, and requires inspection rather than replay. Do not edit or delete the journal to force another attempt.

This harness intentionally has no cleanup mode. An allocated candidate may remain detached or attached after a timeout or successful run. It never releases the original address, an attached candidate, a reused resource, or an unknown resource. Record the journal path and reported resource IDs for manual investigation through the normal reviewed ownership workflow.

The command is a narrow AWS control-plane gate. A live `completed` result only verifies the selected cloud steps and their remote observations. Unit tests use injected fake adapters and do not count as live acceptance. This command does not cover the Probe Agent, platform worker recovery, DNS publication, health verification, production credentials, or deployment.

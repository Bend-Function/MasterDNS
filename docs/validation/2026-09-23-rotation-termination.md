# Rotation termination and optional local limits

## Behavior

- Rotation details expose a confirmed **终止轮换** action. The API checks ownership and serializes termination with slot mutations. Termination is idempotent, preserves history and current cloud addresses, disables automatic rotation for the slot, cancels pending publication intents/operations, retains unfinished cleanup resources, and removes only unused quota reservations.
- A terminated incident is persisted with `terminated_at` and terminal status `complete`. The UI and notifications distinguish termination from successful completion. It cannot be resumed. Recovery, cleanup, publication and late receipts cannot revive it.
- Requests already admitted to cloud/DNS providers may finish after termination. Receipts remain historical evidence. An unresolved cloud effect retains its physical-instance exclusion until it is reconciled; termination does not assert that an uncertain operation had no effect or delete remaining cloud resources.
- Cloud account **换址限制** exposes **启用换址限额**, enabled by default. The switch is shared by remote account identity and cloud service, including credential aliases. Disabling bypasses local token/window admission while preserving usage, reservations and provider-throttle cooldowns. Re-enabling uses retained usage. Existing active local-budget waits are woken after the policy transaction commits.

## Deployment

Apply migration `0024_rotation_termination.sql` before starting the updated API and Worker; rebuild the web app as well. Existing deployments retain enabled local limits and unchanged rotation behavior until the user operates the new controls. No production state is changed by this implementation.

## Validation

Regression tests exercise ownership, idempotence, resume rejection, disabled retriggering, shared-account limit bypass, re-enabled retained usage, vendor cooldown, Lightsail reservation release, late cleanup errors/receipts, stale queue work, pending DNS operations and candidate publication recovery. Integration tests use isolated local PostgreSQL databases and Redis, with fake provider adapters rather than real cloud writes.

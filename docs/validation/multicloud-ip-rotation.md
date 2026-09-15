# Multicloud address rotation acceptance

The isolated acceptance command uses the independently built Agent specified by `MASTERDNS_TEST_AGENT_BINARY`. It never builds a sibling Go checkout, reads production `DATABASE_URL`, or calls real AWS/DNS services.

```sh
MASTERDNS_TEST_AGENT_BINARY=/absolute/path/to/masterdns-agent-linux-arm64 \
MASTERDNS_TEST_DATABASE_URL=postgres://test_user:test_password@127.0.0.1:55432/test_admin \
pnpm test:probe-integration
```

Use `node scripts/test-probe-integration.ts --closed-loop` with the same environment for the focused scheduler/rotation/recovery acceptance. The complete entry also runs P12a's real TCP/HTTPS, IPv4/IPv6, enrollment, version, token replay/revocation and private-target-policy acceptance once. Podman must already be available, with `node:22-alpine` and `redis:7-alpine` images locally available; the script does not pull images or start the Podman VM.

Each run creates a uniquely named PostgreSQL database, a uniquely named network, Agent and target containers, a private Redis container bound to an ephemeral localhost port, and temporary certificates/configuration. Only these owned resources are removed in `finally`. The supplied PostgreSQL server and other Redis/container resources are retained. The test DB identity must permit creating and dropping the test database.

P12b uses owned `192.0.2.0/24` container addresses. The old address belongs to a running container with no TCP listener; the candidate belongs to a container with an actual TCP listener. These documentation addresses remain inside the owned network. P12a independently exercises intersecting local/platform private-address allowlists; no production Agent target-policy exception or dialer injection is used.

The cloud and DNS control planes are the only fakes. Production EC2 and Cloudflare adapters, HTTP ingestion, scheduler/finalization, rotation persistence, publication and operations execute against them. Remote effects live in the parent process and survive termination of actual worker child processes. Child environments contain only the explicit test connections and runtime paths; no cloud credentials or notification/webhook settings are inherited.

## Acceptance evidence

Agent artifact: `dev-bb03f40`, independently built from reviewed Agent commit `bb03f40` on `codex/external-health-agent`. Platform integration started at `ff685c2` on `codex/rotation-integration`, with P10 publication/cleanup `51c6a3e`, atomic health fanout `de269fb`, and review fixes `e871901` (local cherry-picks `b0cf4bb`, `114e060`, and `8bcd51f`). The final test source revision is recorded in the task report and commit history.

- Actual Agent task lease/result submission over verified platform TLS, three TCP failure rounds, one charged allocation/attachment, a new candidate version and three TCP success rounds.
- Expired submitted results and old address versions remain stale; a round without a valid vote becomes unknown and creates no incident, cloud write or candidate publication.
- Actual SIGKILL after remote allocation and after attachment, before the receipt reaches the worker; restarted processors preserve the original attempt, unresolved intent, allocation and budget segment.
- No release while the default release permission is disabled; no writes to unmanaged instances.

- Real reconcile and operation BullMQ workers publish both DNS bindings after exact-version candidate verification. The successful DNS step is preserved across SIGKILL before the second provider write; restart completes only the remaining work.
- SIGKILL immediately before cleanup preserves the pending cleanup record. The harness waits the actual persisted old TTL plus 60 seconds; after a second SIGKILL loses the release receipt, restart observes absence and never releases twice.
- Initial candidate version 1 publishes with automatic rotation disabled and no incident. After the real policy-restore helper requests revalidation of that same current address, three failures update the linked Pool atomically and switch DNS to a separately hosted backup that also completed three actual Agent success rounds.
- P12a migrates an empty database; P12b populates a pre-publication schema, upgrades it through migration 0019, and checks that the existing row remains intact.

Focused integration typing: `node node_modules/typescript/bin/tsc -p apps/api/test/tsconfig.integration.json`. In the provided worktree, pnpm 11.19 tried to reinstall the shared pnpm 11.9 dependency directory; the acceptance invocation used `pnpm --config.verify-deps-before-run=false test:probe-integration` against the already installed and built dependencies. This overrides only pnpm's dependency preflight; every acceptance assertion still runs.

## Boundaries

Live AWS acceptance is separate and must report skipped when temporary credentials and explicitly allowed test resource IDs are absent. See [AWS control-plane acceptance](aws-control-plane.md). No real cloud or DNS side effects are part of this local suite.

Native Windows/Linux service-manager CI and visual browser acceptance were not executed in this environment. Visual tool authorization was unavailable. This command does not claim those checks, production deployment, real-cloud acceptance, or the full monorepo build/typecheck/lint/test/coverage run; the controller records the final monorepo checks after all dependencies are integrated.

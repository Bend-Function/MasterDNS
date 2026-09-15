# Azure / Linode validation record

Status: **Task 5 Web validation complete; Task 4 integration and final release acceptance pending.** This is an offline implementation record, not a live-cloud or deployment acceptance claim. The integration controller must append its final evidence before treating the whole branch as validated.

## Branches and ownership

- Integration: `codex/azure-linode-cloud`, canonical checkout `/Users/funcma/Project/MasterDNS`.
- Azure/provider and Web delivery worktree: `codex/azure-cloud`, `/Users/funcma/Project/MasterDNS/.worktrees/azure`.
- Linode/provider worktree: `codex/linode-cloud`, `/Users/funcma/Project/MasterDNS/.worktrees/linode`.
- Task 5 started at `66e5c26`, which contains both reviewed provider implementations. The controller reported both provider review checkpoints complete. Shared API/runtime work continues separately under Task 4; no Task 4 source was copied into this worktree for these checks.

The branches and worktrees are retained. Provider documents remain owned by their implementation tasks: [Azure](../providers/azure.md), [Linode](../providers/linode.md).

## Executed for Task 5

All commands below ran in the Azure worktree with `pnpm_config_verify_deps_before_run=false`; no dependency installation occurred.

| Command | Result / scope |
| --- | --- |
| `pnpm --filter @masterdns/contracts build` | Passed; rebuilt the local browser-safe cloud subpath before Web checks |
| `pnpm --filter @masterdns/web test` | 50 tests passed across 14 files |
| `pnpm --filter @masterdns/web typecheck` | Passed |
| `pnpm --filter @masterdns/web lint` | Passed |
| `pnpm --filter @masterdns/web build` | Production Next.js 16.2.12 **Turbopack** build passed; 17 static pages generated. Multiple-workspace-root warning selected the canonical project root. No webpack fallback was needed |
| `pnpm --filter @masterdns/cloud-providers test` | 241 tests passed across 14 files, including AWS EC2/Lightsail regression/harness suites and Azure/Linode fake-HTTP tests |
| `pnpm typecheck` (initial) | Failed because `@masterdns/crypto` build declarations were absent from this worktree, not because of a Web type error |
| `pnpm build:packages`, then `pnpm typecheck` | Both passed; all workspace packages, API, Worker and Web typechecked at the pre-Task-4 worktree revision |
| `git diff --check` | Passed |

New Web checks exercise Azure payloads without hidden AWS/Linode fields, Linode token replacement with unchanged provider, provider mismatch rejection, credential and regional validation, draft clearing, rendered secret fields, explicit service labels, Linode reboot permission gating, policy switch behavior, both reboot notices, bindable immutable SLAAC IPv6, quota messages, and distinct cleanup-health/probe-evidence waits. Existing idempotency, session generation, address binding and rotation tests also passed. Focused tests were first observed failing for the missing credential/gating behavior, then passed after implementation. Component checks use server rendering plus pure helpers; they do not claim browser interaction or visual acceptance.

## Pending controller integration evidence

- Task 4 factory/discovery/metadata integration, provider-aware authorization/planning and persisted recovery tests, including post-cleanup-reboot health confirmation.
- Full final integration-branch build, tests, typecheck/lint and relevant regression suites. The Web worktree build above does not replace the required canonical checkout production build.
- Fresh isolated PostgreSQL migration and previous-version upgrade checks. **Task 5 ran no migration, upgrade or database integration test.** The controller must record exact databases/scenarios and outcomes.
- Whole-branch independent review and any consolidated corrections. The task author performed source review; this is not an independent final review.

## Not executed / acceptance limits

- No live AWS, Azure, Linode, Cloudflare or other provider calls/writes; no production resource, quota, billing or real DNS acceptance.
- No live ingress/egress, guest Network Helper, real reboot/ARM polling, external NIC concurrency or cleanup acceptance. Azure NIC PUT has no established external atomic CAS guarantee. Linode unknown allocations cannot be owned from inventory differences; ordinary IPv4 lacks immutable allocation generation and reboot events lack request correlation tokens. Keep the documented conservative recovery limits.
- No native browser visual or desktop/mobile interactive acceptance. The controller's fresh CUA inventory returned `apps=[]` and `browsers=[]`; the native Mac was locked and the Codex browser authentication token unavailable. Task 5 did not retry, bypass the restriction or request an unlock. Visual acceptance remains pending unless the user independently restores access.
- No deployment, push, dependency reinstall, user/third-party messaging or live notification test.
- Go Agent and protocol are unchanged; no new Agent binary build, install or release was performed by this task.

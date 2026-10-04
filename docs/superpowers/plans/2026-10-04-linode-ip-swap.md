# Linode IPv4 swap implementation plan

**Goal:** Offer optional same-region temporary-instance IPv4 swapping without requiring a second IPv4 on the production instance.

**Architecture:** Keep provider actions durably persisted in rotation_steps. Reuse the existing publication and grace-period cleanup framework, with per-attempt helper ownership evidence and companion instance reservations. Preserve additional-IP plans and previously persisted tasks.

**Tech Stack:** TypeScript, pnpm, Vitest, Drizzle/PostgreSQL, Next.js, NestJS.

**Spec:** ../specs/2026-10-04-linode-ip-swap.md

## Global constraints

- Node.js 22+, pnpm 11.9.0; strict TypeScript and existing ESM conventions.
- Never mutate real cloud resources during implementation or tests.
- Explicit temporary-instance authorization; original instance deletion is forbidden.
- Unknown cloud outcomes are observed and retained, not retried as new writes.

## Tasks

- [x] Add the three policy fields to shared contracts, DB defaults and checks, API policy defaults, and migration. Admission rejects swap without temporary-instance and downtime authorization. Register create/swap/delete rate-limit operations.
- [x] Implement and test the provider's isolated swap adapter path in `packages/cloud-providers/src/linode-swap.ts`, routing swap plans and receipts through existing `planCloudRotation`/`LinodeCloudAdapter` interfaces. Add the optional policy fields and `allowTemporaryInstance` to plan arguments/options; cleanup additionally receives `linodeSwapReceipt`.
- [x] Add web policy controls and preservation on toggles, manual confirmation based on saved policy, safe error descriptions, and temporary-resource detail display. Add focused UI/contract tests.
- [x] Integrate worker plan options, admission-time grant checks, receipt ownership snapshots, companion reservations, and alias-aware helper cleanup. Public detail responses expose only sanitized helper metadata. Test end-to-end fake-provider execution and cleanup/revocation/retention.
- [x] Update provider documentation; run targeted red/green tests, migration tests, complete workspace tests in isolated PostgreSQL/Redis, typecheck, lint and build. Inspect local preview and conduct an independent code review.

## Decisions

- Keep the existing allocation strategy as default; no automatic migration of active jobs.
- Authorization is a persisted policy checkbox specifically scoped to helpers, distinct from permission to delete the production instance.
- Successful task cleanup waits for DNS grace. Failed/terminated tasks retain known helper identities with an explicit ongoing-charge notice for recovery.
- Do not create or delete any cloud instances while verifying this feature.

## Verification

- 2026-10-04: all 1,559 workspace tests passed after the official API audit and backup-protection fix, using isolated PostgreSQL and Redis with test-only encryption configuration. Database migration tests preserve existing restart mode and leave swap/helper grants disabled by default.
- Shared packages, API, worker and preview web build passed; type checks, ESLint and whitespace checks passed.
- Provider tests cover 64 swap scenarios, including backup protection; worker tests cover persisted creation identity, both power modes, grant revocation, DNS/TTL cleanup, helper aliases and terminal unresolved effects.
- Independent review found and closed the companion-lock termination race and diagnostic-code handling gap. Terminal late receipts conservatively retain unresolved locks, matching the existing original-instance behavior.
- Local preview confirmed the selectable strategy, explicit helper grant, plan ID and independent stop/start option. Preview save only updates browser memory; no real cloud mutation was performed.

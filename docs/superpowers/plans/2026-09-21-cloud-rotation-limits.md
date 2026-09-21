# Cloud Rotation Limits Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the bounded tasks and review their integration. Preserve all pre-existing monthly-traffic changes.

**Goal:** Persistently constrain IP rotation mutations by provider rules at a configurable default 80%.

**Architecture:** Contracts holds provider rules; DB owns transactional shared budgets and Lightsail reservations; Worker admits durable dispatches through the limiter; API/Web expose policy and waiting state.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, NestJS, Next.js, Vitest.

**Spec:** docs/superpowers/specs/2026-09-21-cloud-rotation-limits-design.md

## Global Constraints

- Default 80%, range 1–100 integer. Real external identity shares budgets. No reset by credential rotation or restart.
- Never sleep inside a DB transaction/lease. Do not consume failure-attempt budget on local denial.
- All write dispatch paths including cleanup are guarded. Uncertain writes remain observation-only.
- No deployment or live cloud mutation; preserve monthly-traffic work.

## Tasks

- [x] 1. Contracts + persistence: add provider rules and configuration/usage contracts; migration, buckets, reservations, cooldown, status helper; run rules and real PostgreSQL concurrency tests.
- [x] 2. Worker integration: gate main and cleanup dispatch before charging/marking in_flight; defer exact waiting time, preserve observations, record vendor cooldown; regression tests.
- [x] 3. API + UI: owned policy read/update with audit and provider validation, account dialog with defaults/status, task waiting descriptions; focused tests and visual inspection.
- [x] 4. Integrate, run relevant suites/build/lint/migration checks, independent read-only review, record limits and upgrade notes. Leave changes reviewable in workspace.

## Progress

- Initial inspection: every currently supported rotation CloudStep contains at most one mutation. Existing local monthly-traffic changes are uncommitted and must be retained.
- Cross-task interfaces will be pinned in the shared task brief before implementation; DB/contract files owned by task 1, Worker by task 2, API/Web by task 3.
- Task 1: 3 rule tests + 13 PostgreSQL limiter tests passed, Contracts/DB builds and migration consistency passed. Effective percentage change materializes prior refill rate; low Lightsail capacity fails explicitly before writes.
- Task 2: 46 processor tests and 35 cleanup tests passed; added separate successful cleanup Retry-After regression (36th cleanup test). Budget/cooldown denial leaves prepared steps and failure-attempt counts intact; pending observations proceed. Existing mixed-provider fake cleanup chain updated to a consistent Linode fixture.
- Limiter/Worker independent read-only review approved without findings.
- Task 3: API ownership/service/percent/audit tests, settings dialog, shared status, task waiting and low-capacity explanations complete. Review found paused-label masking of low-capacity error; fixed with shared display helper and paused-incident regression, scoped re-review approved.
- Final validation: API 189, Worker 237, Web 89, DB 43, Contracts 43 tests passed (601 total). All touched TypeScript packages/apps built, Web production Webpack build and full ESLint passed. Desktop and 390px settings dialog visually verified, preview saving 75% recalculated Lightsail to 37/hour and 375/day, reset to 80% afterward. No deployment/live cloud calls.

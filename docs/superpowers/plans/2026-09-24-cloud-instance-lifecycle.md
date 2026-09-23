# Cloud Instance Lifecycle Implementation Plan

> Use superpowers:subagent-driven-development for independent implementation tasks, with test-first verification and final read-only review.

**Goal:** Add cloud instance start/stop/delete and optional month-to-date traffic stop.
**Architecture:** Provider lifecycle methods + shared contracts; durable DB operations/policy/holds; API/Worker orchestration; UI controls; existing rotation/binding fences consume common lifecycle guards.
**Tech Stack:** TypeScript, NestJS, PostgreSQL/Drizzle, Next.js, Vitest.
**Spec:** docs/superpowers/specs/2026-09-24-cloud-instance-lifecycle-design.md

## Constraints

- No live cloud mutations or deployment. Preserve existing features and current checkout work.
- Auto-stop default off; every action authorized by owner/admin and saved instance permissions.
- Durable dispatch before single mutation, unknown outcome observes only.
- Check each immutable resource identity; deletion requires exact externalId confirmation and no active references.
- Traffic checks default3600s, configurable60–86400s, UTC month, selected total/outgoing, missing evidence never stops; no automatic restart.
- Per-account optional SOCKS proxy applies to all cloud requests/identity checks, credentials encrypted and not echoed.

## Tasks

- [x] 1. Provider lifecycle methods for four services and IAM/request-shape tests.
- [x] 1b. SOCKS transport, per-account API proxy configuration and secrecy/transport tests.
- [x] 2. Database migration, task/policy/hold helpers, API, Worker scheduling and integration tests.
- [x] 3. Instance control UI, allow-delete authorization, traffic policy editor and history with focused tests.
- [x] 4. Cross-flow guards in rotation, binding, state-reset and address deletion protection; integration tests.
- [x] 5. Full relevant validation, browser inspection, documentation and independent review.

## Progress

- Initial base b9b425d on master, worktree clean. Existing lifecycle methods not present; allowStopStart exists but no delete permission.

- Completed provider/API/Worker/UI implementation, proxy credential transport and independent review fixes. Validation: API 278, Worker 303, providers 376, Web 113, DB 48, contracts 48, automation 116, cross-service acceptance 30 tests pass. Desktop and 390px browser preview inspected; no geo lookup. See docs/validation/2026-09-24-cloud-instance-lifecycle.md.

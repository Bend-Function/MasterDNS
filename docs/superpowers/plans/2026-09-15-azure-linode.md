# Azure and Linode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Independent Azure and Linode provider files run concurrently in their user-requested worktrees.

**Goal:** Extend existing instance inventory, managed IP rotation, verified DNS and cleanup to Azure and Linode.
**Architecture:** Shared contract/schema groundwork; two isolated adapter implementations; one integration of runtime/recovery; UI and cross-provider acceptance, each independently reviewed.
**Tech Stack:** Existing TypeScript/Nest/Next/Drizzle/PostgreSQL/BullMQ. Official REST through injectable fetch; Go Agent protocol unchanged.
**Spec:** docs/superpowers/specs/2026-09-15-azure-linode-design.md

**Completion:** Local implementation, all five task reviews and final review/fix verification completed on 2026-09-16. Current source checkpoint: 9e37607; requirement and verification evidence: [validation record](../../validation/azure-linode.md). Live-cloud and interactive-browser acceptance remain explicitly unexecuted.

## Global Constraints
- Provider keys aws/azure/linode; service keys ec2/lightsail/azure_vm/linode.
- Explicit managed and IPv4/IPv6 authorization, max-attempt budgets, version/fence checks and verify-before-DNS remain mandatory.
- Azure exact existing NIC IP configuration; Linode legacy single-config Network Helper with explicit reboot permission. IPv6 SLAAC monitor-only.
- No live cloud calls, push, deployment, Agent changes, pointless hashes, or unreviewed external messages.
- Preserve uncertain operations; no fresh allocation inferred from inventory difference.
- Each worktree has one source writer. Provider tasks only write their provider files; controller's integration checkout owns shared files.

## Task 1: Shared contracts, schema and account/runtime groundwork
**Files:** packages/contracts/src/cloud.ts; packages/cloud-providers/src/provider.ts, factory.ts, rotation-plan.ts, capabilities.ts; packages/db/src/schema/cloud.ts, schema/rotation.ts, cloud-policy.ts and one generated migration; apps/api/src/modules/cloud/{cloud.schemas,cloud.service}.ts; apps/api/src/modules/pools/pools.service.ts; apps/api/src/common/api-exception.filter.ts; apps/worker/src/cloud/{cloud-runtime.service,cloud-sync.service}.ts; focused existing/new tests.
**Interfaces:** CloudProvider/CloudService; AzureCredentials/LinodeCredentials/CloudCredentials; provider/service validation and provider-to-services mapping; optional inventory/interface/address metadata; RotationStepArguments.priorReceipts. createCloudAdapter retains AWS compatibility; new service unavailability is explicit until Task4 wires adapters.
- [x] Red tests for mismatched provider/credentials, generic scopes, long ARM IDs, metadata scan/API roundtrip and unchanged AWS behavior, e.g. `expect(parse({provider:'azure',credentials:{kind:'linode_token',token:'x'}}).success).toBe(false)`.
- [x] Implement exact spec types, bounded scope validation, provider-aware identity/hints/sync and durable metadata. Generate one additive migration, cover old populated schema and fresh DB. Never invent fake provider instances to pass tests.
- [x] Run contracts/cloud-provider/API/worker relevant tests and builds. Record expected temporary factory-unavailable capability for new providers, commit shared files, independent review.

## Task 2: Azure adapter (parallel provider worktree)
**Files:** packages/cloud-providers/src/azure.ts, azure-http.ts, azure-rotation.ts, azure*.test.ts; docs/providers/azure.md.
**Interfaces:** `AzureCloudAdapter(accountId, credentials: AzureCredentials, dependencies?: {fetch?: typeof fetch})`; `azureCapabilities(slot,inventory):Capability`; `planAzureRotation(slot,inventory,{allowStop,attemptId}):CloudStep[]`; `planAzureCleanup(slot,inventory,options:CleanupPlanOptions):CloudStep[]`. Uses shared makeRotationStep/rotationArguments; actions azure.public-ip.allocate/associate/delete.
- [x] Red HTTP fake tests for exact subscription/token form, paginated discovery, malicious URLs, NIC sibling preservation and unsupported topology; e.g. `expect(mutatedNic.properties.ipConfigurations[1]).toEqual(originalSibling)`.
- [x] Implement fixed-host authenticated REST, bounded calls, normalized evidence, deterministic allocation tags, exact association and async observe; cleanup validates original snapshot and detached PIP. No undocumented If-Match safety claims or secret bodies in errors.
- [x] Test both address families, lost responses/receipt collisions/permission/quota/429/reused resource, build/typecheck provider package. Write official-source docs and live-acceptance limits; commit only Azure-owned files and review.

## Task 3: Linode adapter (parallel provider worktree)
**Files:** packages/cloud-providers/src/linode.ts, linode-http.ts, linode-rotation.ts, linode*.test.ts; docs/providers/linode.md.
**Interfaces:** `LinodeCloudAdapter(accountId, credentials:LinodeCredentials, dependencies?:{fetch?:typeof fetch})`; `linodeCapabilities`; `planLinodeRotation` and `planLinodeCleanup` with Task2 signatures. Actions linode.ipv4.allocate, linode.instance.reboot, linode.ipv4.release; phase distinguishes rotation/cleanup reboot.
- [x] Red tests for authenticated account identity/scopes, complete pagination, exact legacy config/helper eligibility, immutable IPv6, opt-in reboot; `expect(plan(...,{allowStop:false})).toThrow()` before any cloud write.
- [x] Implement allocation receipt ownership, event-based reboot observation and candidate checks; lost allocation response stays ambiguous regardless of inventory diff. Cleanup plans release then reboot as separately persisted actions.
- [x] Test explicit quota/permission failures, matched/mismatched event/config, revoked conditions, retained/reused/last/current IPv4 release refusal, no guest commands. Build/typecheck; official-source docs and limitations; commit only Linode-owned files and review.

## Task 4: Integrate provider dispatch, durable multi-step cleanup and runtime acceptance
**Files:** packages/cloud-providers/src/{factory,capabilities,rotation-plan,index}.ts; apps/worker/src/rotation/{rotation-store,rotation-cleanup.service,rotation-publication.service}.ts and tests; apps/api/test provider integration tests; shared scan/runtime adjustments only when required by reviewed metadata.
**Interfaces:** explicit provider/service switch; all applied allocation receipts propagate; priorReceipts snapshots; persisted cleanup plan before first call, cleanupStepId advances after applied observation and terminal status only after final step.
- [x] Red tests for Azure/Linode factory and mismatches, e.g. `expect(createCloudAdapter(azureConfig)).toBeInstanceOf(AzureCloudAdapter)`.
- [x] Red actual DB tests for Linode two-step cleanup: release effect before receipt, recovery same release without replay, pause before reboot forbids write, resume executes original reboot exactly once, reboot result uncertain preserves original intent. Retain legacy AWS one-step recovery.
- [x] Implement minimal generic dispatch/step progression; new writes require managed/family/revisions and reboot permission where needed. Treat Linode original IPv4 still attached to SAME VM as provider-specific allowed release, never relax AWS/Azure attached-resource guards.
- [x] Exercise actual providers through mocked HTTP with real coordinator/DNS services: authorized failure -> candidate -> verified publication; current/foreign resource and credential changes block effects. Run affected API/worker/package tests and build; independent review.

## Task 5: Provider-aware console and delivery
**Files:** apps/web/src/app/cloud-accounts/page.tsx, cloud-instances/page.tsx, cloud-instances/[instanceId]/page.tsx; apps/web/src/lib/{cloud-types,cloud-ui}.ts; focused credential helpers/tests; rotation-policy-form/manual confirmation; README.md, docs/DEPLOYMENT.md, docs/TEST_PLAN.md, docs/validation/azure-linode.md.
**Interfaces:** browser-safe CloudProvider/CloudService constants and credential payload validation; Azure service principal vs Linode PAT fields; neutral scope labels; capabilities.requiresStop explained before opt-in and action.
- [x] Red meaningful form tests: Azure payload contains no AWS fields; Linode token updates preserve provider; stale form clear, server/provider mismatch rejected; IPv6 immutable remains bindable.
- [x] Implement provider picker, labels, fields and scope examples. Preserve session/stale-request/error behavior, secret clearing and default permissions off. Surface actual capability/quota/unsupported reasons.
- [x] Run Web tests/typecheck/lint and production build; full integration typing plus relevant AWS regression suites. Record fresh migration/upgrade and exact performed vs skipped live/cloud/native tests. Final whole-branch independent review, one consolidated fix wave if needed, preserve new branches/worktrees.

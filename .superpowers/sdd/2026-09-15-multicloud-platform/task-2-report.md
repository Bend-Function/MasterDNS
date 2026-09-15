# P2 report: persistent cloud resources, slots, and access

## Result

- Added AWS cloud account, scan scope, instance, interface, address, managed slot, instance authorization, and endpoint-link schema exports.
- Added encrypted credential columns, full instance identity uniqueness `(account_id, service, region, external_id)`, scan generations, authorization revision/default-deny flags, and current/candidate slot versions.
- Added database enforcement that slot addresses are host addresses on the same interface/family, each endpoint/family has one slot, and cloud links attach only to cloud-mode endpoints.
- Added owner/admin `assertCloudAccess` authorization and endpoint request validation that keeps cloud-managed addresses mutually exclusive with direct IPv4/IPv6 input.
- Extended `endpoint_address_mode` with `cloud`; existing rows retain the `static` default.

## TDD evidence

Red run before implementation:

- API: 2 failed suites. `cloud-access.js` was missing and `addressMode: "cloud"` failed Zod enum validation; 56 existing tests passed.
- DB: 5 cloud integration tests failed with PostgreSQL `42P01 relation "cloud_accounts" does not exist`; 6 existing tests passed.

Green runs after implementation:

- `MASTERDNS_TEST_DATABASE_URL=postgres://masterdns_test:masterdns_test@127.0.0.1:55432/masterdns_test pnpm_config_verify_deps_before_run=false pnpm --filter @masterdns/db test`: 3 files, 13 tests passed, including 7 isolated PostgreSQL constraint tests.
- `pnpm_config_verify_deps_before_run=false pnpm --filter @masterdns/api test`: 11 files, 60 tests passed.
- `pnpm_config_verify_deps_before_run=false pnpm --filter @masterdns/db typecheck`: passed.
- `pnpm_config_verify_deps_before_run=false pnpm --filter @masterdns/db build`: passed and refreshed the workspace declaration consumed by API.
- `pnpm_config_verify_deps_before_run=false pnpm --filter @masterdns/api typecheck`: passed after the db build.
- `pnpm_config_verify_deps_before_run=false pnpm db:generate`: no schema changes after generated metadata review.
- `git diff --check`: passed.

## Migration evidence

- Fresh disposable database: all migrations through `0011_pretty_norman_osborn.sql` applied; real inserts verified regional identity coexistence, full identity rejection (`23505`), default-deny authorization, endpoint/family link uniqueness (`23505`), prefix rejection for slots (`23503`), DDNS/cloud source exclusion (`23514`), and preserved current/candidate uniqueness (`23505`). Database was dropped by test cleanup.
- Explicit 0010 baseline: applied migrations 0000 through 0010, inserted an existing static endpoint with current and candidate IPv4 addresses, then applied 0011. Result: `{"baseline":"0010","upgraded":"0011","oldEndpointMode":"static","enumValues":"{static,ddns,cloud}","activeUniquePreserved":true}`. Database was dropped after verification.
- Migration development caught and fixed PostgreSQL `42830` index ordering and `55P04` same-transaction enum-use failures. The final migration creates supporting composite indexes before foreign keys and does not use the newly added enum value until after migration commit.

## Concerns

- PostgreSQL emits existing identifier-truncation notices for three pre-P2 foreign-key names during fresh migrations; they are unrelated to this task and do not affect migration success.

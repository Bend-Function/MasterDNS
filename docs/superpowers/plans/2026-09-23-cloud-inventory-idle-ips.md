# Cloud inventory and Lightsail idle IP cleanup

Approved scope: repair stale address/slot display and health scheduling; safely revalidate manually replaced primary addresses without losing bindings; add an account-level preview and confirmed bulk release of idle Lightsail static IPs in configured regions.

- [x] Inventory: reproduce primary name collision and stale address visibility, implement generation-aware current/history projection, revalidate replacement in the original slot, reject stale probe evidence and preserve active rotation candidates.
- [x] AWS adapter: paginate static IP discovery, require complete resource identity and explicit unattached status, recheck identity/attachment immediately before ReleaseStaticIp, verify absence and observe uncertain writes without redispatch.
- [x] Cleanup API: persist preview and per-address results; validate account ownership, region and credential identity on every execution; protect active rotations, pending writes and managed DNS; enforce shared rate limits and durable release admission before effects.
- [x] UI: current/history inventory toggle; AWS account cleanup button with preview, skipped reasons, confirmation and per-address result/progress. Closed/failed UI must not silently resubmit uncertain releases.
- [x] Validation: adapter tests with fake SDK, PostgreSQL integration for ownership/idempotence/concurrency and stale slots, independent review, package build/typecheck/lint and full suite. No production cloud calls during tests.

Default local limits and provider throttling apply to cleanup. An already missing resource is treated as gone only after a successful authoritative read. Permissions/network errors are never proof of absence. The action releases only the frozen preview resource identity; new idle IPs require another preview.

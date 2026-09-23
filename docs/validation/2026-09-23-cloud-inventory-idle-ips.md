# Current cloud inventory and idle Lightsail IP cleanup

## Inventory repair

Current inventory and historical slot/address identity are now distinct. Cloud instance and health pages hide history by default, with explicit history toggles. Historical cloud health becomes unknown and cannot authorize rotation or DNS publication. Scheduler, direct probe creation, queued probe leasing, result acceptance and local probe execution all reject historical targets.

A manually changed primary public IP is staged as a candidate on the existing role slot when no unfinished or uncertain cloud operation owns the instance. This preserves slot policies and DNS links. It never changes the published current address before external verification. Existing private/public primary roles remain separate regardless of cloud response ordering. A verified rotation candidate is still probeable while periodic inventory catches up; exact live promotion refreshes only that address's observation generation and rejects an inspection raced by a newer inventory scan.

## Cleanup flow

AWS accounts expose **清理 Lightsail 闲置 IP**. Scanning freezes a 15-minute preview of explicitly unattached static IPs in the account's configured Lightsail regions. Region read failures remain visible. Confirmation authorizes only those exact names, addresses, ARNs and creation timestamps. Newly discovered idle IPs require another preview.

Before release, the service revalidates ownership, account identity, current credentials, configured region, active rotation/uncertain effects and managed/pending DNS references. Shared remote-account admission and per-IP locks coordinate cleanup with rotation and DNS. The adapter rereads attachment and allocation identity immediately before ReleaseStaticIp, never detaches, and uses SDK maxAttempts=1. AWS ReleaseStaticIp is name-based rather than conditional: external cloud-console changes cannot be serialized by MasterDNS; the immediate recheck and AWS's attached-resource rejection are the boundary.

Preview and per-IP execution state are persisted before effects in `cloud_idle_ip_cleanups`. Results distinguish released, already missing, skipped, failed, quota waiting and pending observation. An authoritative not-found read is required to report removal. Lost mutation responses use read-only observation, while failures known to occur before dispatch do not retain a mutation lock. Explicit no-effect rejections may be retried after vendor cooldown. Dispatch IDs prevent old observations from settling a newer request. Unresolved batches remain available in history even beyond the latest 20 previews; disabled accounts can still observe admitted effects.

The browser submits items sequentially after one confirmation. Closing it stops later submissions; reopening the saved batch permits continued processing/observation. Short quota waits are retried automatically; long waits and unresolved effects are displayed for later continuation. Usage accounting and provider cooldown remain intact, including when local limits are disabled.

## Verification and rollout

Independent read-only review covered ownership, credential aliases, concurrent DNS writes, late observations, disabled accounts, pagination, manual primary drift and candidate promotion freshness. Regressions cover those paths using real isolated PostgreSQL/Redis with fake cloud/DNS adapters. No production cloud resources were touched.

Apply migration `0025_idle_ip_cleanup.sql` before starting the updated API/Worker, and rebuild the web application. Run **同步云清单** after deployment so historical flags and replacement candidates reflect a fresh successful scan. Existing history, policies and DNS bindings are preserved; this change does not bulk-delete database address history.

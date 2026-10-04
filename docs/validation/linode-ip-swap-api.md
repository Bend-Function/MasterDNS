# Linode IPv4 swap API validation

Checked on 2026-10-04 against current Akamai reference pages and the official [OpenAPI repository](https://github.com/linode/linode-api-openapi), specification version **4.229.1**. This verifies documented request/response contracts and offline recovery behavior; it is not a live account mutation test.

| Stage | Official contract | Implementation / result |
| --- | --- | --- |
| Create helper | `POST /linode/instances`; required fields are `type` and `region`; an empty instance can omit image, disks and disk authentication and remains offline. | Same region and saved type, deterministic label/tag, `booted: false`, `interface_generation: legacy_config`, `backups_enabled: false`. The original instance and its disks are not rebuilt. |
| Observe empty helper | Instance, configs, disks, volumes, IPs and backups are readable with the applicable Linode read permissions. | Exact ID, account, region, creation timestamp, label/tag, plan and offline state; zero disks/configs/volumes and no backup data/history. Empty backup response is `{automatic: [], snapshot: {current: null, in_progress: null}}`. Missing or unreadable evidence blocks use/deletion. |
| Exchange IPs | `POST /networking/ips/assign` accepts `region` and `assignments` of `{address, linode_id}`; all participants share a region and retain at least one public IPv4 after the assignments. Scopes include `ips:read_write` and `linodes:read_write`. | One request contains both directions of the exchange. Both assignments are read back before progressing. Reserved/shared addresses and unsupported interface/NAT arrangements are rejected conservatively; provider-side restrictions still apply. |
| Reboot or stop/start | `POST /linode/instances/{id}/reboot` and `/boot` accept `config_id`; `/shutdown` needs no configuration selector. HTTP 200 with `{}` means the operation started. | Persisted independent steps, exact saved configuration, `linode_reboot`, `linode_shutdown`, `linode_boot` events and final power state. Accept documented `finished`/`completed` events; never equate the initial empty response with completed networking. |
| Delete helper | `DELETE /linode/instances/{id}` destroys its disks, backups, configuration profiles and interfaces, detaches volumes and relinquishes ephemeral IPs. Reserved IPs remain billable. | Only the proven helper ID can be deleted after DNS/TTL and current authorization checks. Added backup protection during this audit. Reserved IPs are not used. Unknown responses are observed without repeating the mutation. |
| Pagination / identity | Paginated lists have `data`, `page`, `pages`, `results`; request page size 100 is valid. `X-Customer-UUID` identifies the token's account; `X-OAuth-Scopes` describes allowed token scopes. | An unauthenticated public `/linode/types` query with a nonexistent label returned `{data:[],page:1,pages:1,results:0}`, which the client accepts. Header/identity validation stays conservative. |

## Account prerequisites and limits

- `interfaces_for_new_linodes: linode_only` disallows creation of the legacy helper, including accounts with existing legacy production instances. No automatic interface conversion is performed.
- Account-wide Backups enrollment overrides `backups_enabled: false`; extra service fees may apply. The default firewall is inherited because `firewall_id` is omitted.
- Token scopes do not prove effective IAM grants. The user also needs create/delete and management permissions, including the ability to tag new instances. Account instance limits, plan availability, regional capacity and resource locks can still reject operations.
- Public read-only `/linode/types/g6-nanode-1` returned the current `Nanode 1GB` type. This does not prove that a specific account can deploy it in a specific region.
- Event IDs are documented as unique; the official SDK also uses an event-ID watermark when waiting for operations. The adapter additionally matches actor, instance, action and resulting state. Concurrent external operations remain unsupported.
- Once IPs are exchanged, old DNS caches point at the offline helper. Service interruption may last until clients refresh those caches.

## Validation evidence

The missing-backup guard was reproduced with failing tests before the correction. Regression coverage includes automatic backup data, manual snapshots, snapshots in progress, available/history metadata, permission failures, malformed listings and an enabled-but-empty backup service. Creation explicitly requests Backups disabled while documentation/UI disclose the account-wide override.

After the correction, all **1,559 workspace tests** passed, along with type checks, ESLint and the preview web build. The focused Linode swap/HTTP/existing rotation run passed **141 tests**. An independent document-based re-review confirmed the backup fix and found no further blocker.

No credentials, private account reads, instance creation, IP assignment, reboot, shutdown or deletion were performed during this audit. Effective IAM permissions, capacity and guest-network convergence require a separately authorized live trial.

## Official references

- [Create a Linode](https://techdocs.akamai.com/linode-api/reference/post-linode-instance)
- [Assign IP addresses](https://techdocs.akamai.com/linode-api/reference/post-assign-ips)
- [Delete a Linode](https://techdocs.akamai.com/linode-api/reference/delete-linode-instance)
- [List backups](https://techdocs.akamai.com/linode-api/reference/get-backups)
- [Get account settings](https://techdocs.akamai.com/linode-api/reference/get-account-settings)
- [Boot](https://techdocs.akamai.com/linode-api/reference/post-boot-linode-instance), [reboot](https://techdocs.akamai.com/linode-api/reference/post-reboot-linode-instance), [shutdown](https://techdocs.akamai.com/linode-api/reference/post-shutdown-linode-instance)
- [Events](https://techdocs.akamai.com/linode-api/reference/get-events), [networking](https://techdocs.akamai.com/linode-api/reference/get-linode-ips), [response headers](https://techdocs.akamai.com/linode-api/reference/response-headers)

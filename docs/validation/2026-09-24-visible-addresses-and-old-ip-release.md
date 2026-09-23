# Visible IPs and automatic release of replaced addresses

## Display regression

Inventory freshness of the selected probe candidate previously doubled as visibility of the whole slot. A stale candidate could hide a current IP still observed in the cloud. Display now has independent current/candidate observation flags; probe, binding and publication eligibility retain their stricter checks. Instance lists/details always show observed current IPs regardless of rotation capability. When none are confirmed, they show labelled last-known addresses with inventory status/error context. Those displayed IPs are searchable. Historical IPs are not promoted to usable targets by this display fallback.

## Old cloud IP lifecycle

New health/manual rotation incidents persist `release_old_address=true`. After successful takeover, complete DNS publication and TTL grace, eligible replaced cloud addresses are released automatically, including user-origin old addresses; they are not retained as backups. Identity/ownership evidence, current management authorization, live attachment, reference checks and stop/reboot permissions still apply. Audit and address history remain stored.

Migration `0026_release_replaced_addresses.sql` defaults existing incidents to false. Upgrading does not retrospectively grant deletion authority to old incidents; those retain the saved legacy authorization behavior. The legacy checkbox is labelled accordingly. Existing unbound Lightsail resources can be reviewed and released using the idle-IP cleanup action.

Unbound historical slot pointers no longer prevent release by themselves. Current observed slots, linked slots and active/uncertain rotations still protect their referenced addresses. Cleanup admission shares the canonical IP lock with DNS A/AAAA publication and exposes unresolved cleanup steps to its guards, preventing new publication during an admitted release. Pending/running DNS operations also protect an address.

## Verification

Regression tests cover observed-current/stale-candidate visibility without granting health authority, incapable current public IP visibility, last-known search, partial DNS publication and TTL grace for system/user-origin addresses, migration preservation, release after takeover, historical/current/linked/active slot references, and DNS exclusion while release is unresolved. Independent review checked the display/authority split and cleanup locking. Cloud writes use test adapters only.

Deploy the migration before updated API/Worker and rebuild the web application. Synchronize the cloud account inventory after updating. This implementation does not modify live cloud resources during development.

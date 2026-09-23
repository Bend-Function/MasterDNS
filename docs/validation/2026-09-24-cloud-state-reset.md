# Cloud inventory synchronization and local reset

The AWS instance detail page now offers **同步云端并重置本地状态**. The owner or an administrator can confirm a reset for that instance. The API checks the enabled account scope and cloud identity, then inspects AWS while holding the normal local admission fences. Failed or mismatching reads roll back without clearing local state. This action does not allocate, attach, release, or delete cloud resources.

After a successful read, the transaction terminates previous rotation workflows, abandons unresolved steps, clears the instance's physical lease and unused reservations, and cancels its old DNS publication work and related idle-IP cleanup items. Receipts, audit history, consumed quota, vendor throttling, DNS bindings and saved automatic-rotation settings remain. Already-dispatched cloud requests cannot be retracted; the confirmation explains that another synchronization may be needed if those requests later change AWS.

Actual cloud addresses return to the existing canonical slots, preferring slots with bindings and health policies over historical duplicates. Old address rows remain as history with explicit inventory absence. The current observed address is also a new unverified candidate; fresh external health evidence is required before DNS publication. Existing endpoint/DNS addresses are preserved until that succeeds. A manually terminated automatic-rotation switch remains off; reset does not enable it.

Late receipts for reset workflows are appended as observations without changing the abandoned/applied steps or recreating blockers. Cancelled publication and DNS operation jobs cannot resume their local workflow. Ordinary idle-IP protection now matches the specific unresolved resource rather than blocking every static IP in its region; uncertain malformed evidence stays protected until an explicit reset.

Regression coverage includes rollback after cloud-read failure, wrong identity and ownership, admission locking even without a prior lease, stable bound-slot selection, preserving endpoint state and automatic-rotation settings, cancellation of publications without an incident, and scoped cleanup of newly discovered addresses. Additional coverage checks late cloud/DNS results, historical-IP reuse, explicitly absent-address authorization, and upgrade preservation.

Validation passed: 1,195 workspace tests, package builds, all workspace typechecks, web lint and whitespace checks. The final running-DNS-step cancellation adjustment additionally passed the 13 focused reset/cancellation tests and API typecheck.

Deploy migration `0027_cloud_state_reset.sql` before the updated API/Worker, and rebuild the web application. Development verification uses local PostgreSQL/Redis and test adapters; it does not reset production instances or modify AWS resources.

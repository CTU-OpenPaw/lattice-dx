# Duy — Native context bridge implementation plan

**Goal:** Complete the native-data → NGSI-LD foundation assigned to Duy in stage 5 (05–06/11), without editing Hưng's pages or Nhi's workflows/AI/n8n.

**Design:** Native Asset/Department/Location collections remain authoritative. A host repository transaction hook writes an immutable, minimal context snapshot into a private outbox in the same transaction. A root-only bounded dispatcher sends one ordered entity update per call to the deployment-configured broker. It holds a PostgreSQL row lock during a time-bounded request; concurrent dispatchers use SKIP LOCKED and cannot overtake an older undelivered event for the same entity. On crash/rollback the same snapshot is safe to resend; delivery is at least once, not exactly once. Failed predecessors block newer events until explicitly retried.

**Constraints:** No upstream CRUD/workflow replacement, no employee/customer/account data sent to broker, no browser-supplied tenant or URL, no .env/secrets reads, no teammate file changes beyond foundation entrypoint/schema registration. Keep all legacy adapters and data. No commit/push/merge/release. New integration dormant unless server broker URL is configured; no retrospective backfill of user data.

## Tasks

- [x] Verify host repository transaction semantics and current broker configuration; start existing services without resetting data.
- [x] Write failing unit tests for deterministic namespaced URNs, minimal projections, transaction requirement, ordering/retry policy, timeout and HTTP failure handling.
- [x] Implement private outbox collection and native afterSaveWithAssociations hooks for three source collections; use deterministic event identity and fail closed when transaction missing. Root/native workflow repository writes share the same hooks.
- [x] Implement server-configured broker upsert and bounded root-only dispatch/status/retry actions. Keep operations metadata separate from business ACL and return sanitized error codes.
- [x] Run real PostgreSQL + Orion acceptance: transaction rollback, hook enqueue, actual upsert and relationships, duplicate resend, failed broker preserves source/outbox, retry/recovery, concurrency/order and non-root rejection. Clean only disposable acceptance fixtures.
- [x] Build/install after backup, run targeted native regression checks, review scope and publish integration contract/evidence. Update Notion only for completed verified task; do not tick unrelated stage 5 work.

## Handoff

Native context IDs use `urn:ngsi-ld:<type>:<organization>:native:<recordId>` to avoid collision with legacy business IDs. Exposed fields: name/status/active/businessId/source/sourceEventId, updatedAt-derived observedAt, organization and Department/Location relationships. Future ingress/tools and complete logistics state configuration remain separate stage-5 tasks; no claim those are done by this adapter.

## Verified checkpoint — 05/11/2026

- foundation 0.24.0 installed after backup; runtime 2.2.38, 101 listed plugins, no incompatible checker entries. No commit/PR/merge.
- 242 foundation tests and 6 workspace installer tests passed. New context tests: 13. Real HTTP/PostgreSQL/Orion context acceptance: 14 checks; automatic native cron acceptance: 2 checks. Native identity 6, native workflow 22 and SSO 14 regressions passed.
- Independent review identified stale in-memory snapshot and missed association writes. Fixed by persisted reread in transaction plus native save/bulk-update hooks; real DB probe verifies stale disjoint-field writes and native association set/remove/bulk FK changes. Reviewer rechecked fixes with no further blocker in that scope.
- Organization namespace now immutable on native source updates; prevents orphan cross-organization context identity.
- Native CronJobManager enabled (one event / 10 seconds), no separate workflow/CRUD engine. Manual operator APIs remain root-only.
- Only stage-5 native-to-NGSI-LD checklist item ticked on Notion; remaining logistics/ingress/tools/AI/n8n work stays unchecked. Existing stage-4 note corrected to distinguish completed dependency/native SSO from pending legacy cutover.

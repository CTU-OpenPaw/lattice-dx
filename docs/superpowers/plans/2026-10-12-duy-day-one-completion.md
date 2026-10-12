# Duy — finish today's phase-one handoff

User requested a plan and autonomous execution of today's remaining work. Scope comes from the two unchecked Duy items in phase 1 (12–14 October), not all work through the 26 October presentation.

## Goal

Finish task/decision and file API handoff, define the shared logistics data/role/state contract, and provide a verified record association for tasks/files. Preserve generic engine boundaries. Hưng builds UI/collections and Nhi builds broker/n8n/agent adapters separately.

## Baseline and branch

Branch: `codex/phase-one-handoff-complete`, created from `origin/main`. PR #2 was merged into foundation and PR #3 into action-runtime, so origin/main did not contain those features. Merge the already-reviewed `origin/codex/action-runtime` into this branch before continuing; final PR targets main directly. Do not merge to main automatically or delete user files.

## Design

- Add optional `recordId` to task creation, file upload and tasks.create action. UUID format only; existing requests without it retain behavior.
- On linking, require the current signed owner+organization to own the record. Return 404 for missing/inaccessible record and 503 if record lookup is unavailable; no task/file write or scan may start after validation failure.
- Add `RecordRepository.find` and scoped SQL lookup. Add nullable record_id FK columns/indexes to existing task/file tables without deleting/relabeling old rows. Responses include recordId, null for historical/unlinked rows.
- Task decisions keep assignee/org/version checks; linking does not grant access to a parent record or change parent state. Same-unit managers still need the phase-two business policy. Directory assignee checks, create idempotency, durable outbox and full workflow remain explicitly pending.
- Logistics contract defines Warehouse, Vehicle, Order, Shipment and references/scope, plus states/actions for sales, warehouse, dispatch, driver, finance and manager. This is a validated fixture/config contract, not a deployed Order API. Generic recordId is the initial backing business-record link.
- Keep purchase UC1 states in the existing handoff. Clearly label proposed logistics roles/transitions as not yet provisioned/executed. File storage remains 1 MiB PostgreSQL/ClamAV bootstrap, not object storage.
- User subsequently prioritized recurring Docker startup failure. Add guarded socket recovery, verified local Desktop context, orderly restart cycles, persistent launcher/shortcut with backups and a runbook; do not represent this as an upstream bug fix or reset data.

## Execution steps

- [x] 1. Reconcile merged branch history and inspect Notion tasks, APIs and existing tests. Write this plan. Preserve CV.pdf, a.png and output/.
- [x] 2. Write failing API tests for record linking (task/action/file) with owned, missing, other-owner and other-org records, malformed IDs and dependency failure. Test file scan not called on denied link; legacy unlinked requests still work. Run targeted tests and confirm expected failure before implementation.
- [x] 3. Implement shared reference validation and scoped lookup; extend routes/action schema/parser/repositories; add nullable FK migration and indexes. Use the same validation helper for task/action/file. Run targeted tests to green and full pnpm check.
- [x] 4. Define logistics fixture/model/state/role contract in solutions/logistics with Apache notices and README. Write tests for valid relationships, missing references, mixed organization, duplicate IDs and unknown states. Keep shipping-specific config separate from core packages.
- [x] 5. Add a real smoke script that creates a record, linked task and linked clean file via authenticated Gateway, checks metadata/list/download/decision and cross-scope denial. No token/password output, no shared-data deletion. Re-run baseline foundation/actions/bridge smoke and scanner outage when available.
- [x] 6. Write an integration handoff with exact payloads, schema/model links, current vs planned roles, UC1/logistics states, startup/health and test commands. Update root phase-one handoff and verification with actual outcomes. Record remaining limitations.
- [x] 7. Independent review, resolve important findings, verify build/typecheck/tests, Compose and whitespace. Commit/push and create a single PR into main that includes recovered action/bridge history plus today's additions. Attach it; no release or automatic merge.
- [x] 8. Update only the two remaining Duy phase-one checkboxes after verification/review; add concise evidence and PR links, explicitly leave group integration/other people's tasks and overall phase acceptance unchecked. Mark this plan complete and report outcomes.

## Acceptance

Task/file endpoints, optional links and actual quarantine behavior pass real runtime tests. Hưng/Nhi can use checked examples and a consistent logistics contract without guessing scope or states. All Duy phase-one deliverables are evidenced; the group UI/broker/complete logistics workflow remain separate work. A new PR directly into main repairs the missing stacked merges.

## Result

PR: https://github.com/TrDuy-pan3000/LatticeDX/pull/4 (base main, awaiting merge). All eight steps completed. pnpm check passed with 96 tests; runtime smoke and independent review passed. Two Duy checkboxes updated in the existing Notion hub (5 checked of 96 total); other owners and phase acceptance unchanged. Docker restart recovery also verified; reboot/logon and upstream bug resolution remain unverified.

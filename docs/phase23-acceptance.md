# Duy phase 2–3 acceptance evidence

## Phase 2 — verified 2026-10-16

`pnpm test:workflows` passed against the running authenticated Gateway/API/PostgreSQL stack. Procurement fixture `19fa1a42-229b-427f-bf69-3f9b6c192138`, outbox event `4f20df61-c2ff-4c11-8a65-2b56e64e87b7` are retained local demo data.

The run verified submit/approve/reject roles and rejection reason, premature receive and handover rejection, clean versus quarantined/foreign files, authoritative recipient/department/location validation, successful acceptance/handover, six ordered actor/state/version audit events, concurrent approval (one success, one conflict), command replay and conflicting payload rejection. Audit mutation HTTP routes are unavailable and attempts leave history unchanged.

An isolated PostgreSQL schema and controlled receiver verified retry after HTTP 503, unchanged handed-over business state, two attempts with the same event ID and one effective receiver operation, concurrent claims, lease fencing and bounded failure. It asserted all pre-existing public queue rows were unchanged. Manual retry touched only the newly created fixture job and verified permissions and replay. The stale acceptance fixture was fixed to copy its required run/wait tables into that isolated schema.

`pnpm exec vitest run apps/api/src/workflows/history-reason.test.ts --maxWorkers=1` passed 5 tests, including rollback after a late receipt failure. This is a database-client regression test; the live smoke does not inject that SQL failure. Production transitions persist state, files, audit, outbox and receipt on one transaction client.

These results certify Duy's backend responsibilities. The receiver was a controlled local fixture; actual broker synchronization, Nhi's connector and Hung's complete UI remain shared integration acceptance. Audit HTTP immutability does not protect against database administrator mutation.

## Phase 3

Incident/agent completion is being verified against `docs/superpowers/plans/2026-10-16-phase23-completion.md`. Phase-3 boxes remain unchecked until the corresponding incident behavior, agent authorization, durable execution and human gate have executable evidence.

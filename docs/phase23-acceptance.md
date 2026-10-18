# Duy phase 2–3 acceptance evidence

## Phase 2 — verified 2026-10-16

`pnpm test:workflows` passed against the running authenticated Gateway/API/PostgreSQL stack. Procurement fixture `19fa1a42-229b-427f-bf69-3f9b6c192138`, outbox event `4f20df61-c2ff-4c11-8a65-2b56e64e87b7` are retained local demo data.

The run verified submit/approve/reject roles and rejection reason, premature receive and handover rejection, clean versus quarantined/foreign files, authoritative recipient/department/location validation, successful acceptance/handover, six ordered actor/state/version audit events, concurrent approval (one success, one conflict), command replay and conflicting payload rejection. Audit mutation HTTP routes are unavailable and attempts leave history unchanged.

An isolated PostgreSQL schema and controlled receiver verified retry after HTTP 503, unchanged handed-over business state, two attempts with the same event ID and one effective receiver operation, concurrent claims, lease fencing and bounded failure. It asserted all pre-existing public queue rows were unchanged. Manual retry touched only the newly created fixture job and verified permissions and replay. The stale acceptance fixture was fixed to copy its required run/wait tables into that isolated schema.

`pnpm exec vitest run apps/api/src/workflows/history-reason.test.ts --maxWorkers=1` passed 5 tests, including rollback after a late receipt failure. This is a database-client regression test; the live smoke does not inject that SQL failure. Production transitions persist state, files, audit, outbox and receipt on one transaction client.

These results certify Duy's backend responsibilities. The receiver was a controlled local fixture; actual broker synchronization, Nhi's connector and Hung's complete UI remain shared integration acceptance. Audit HTTP immutability does not protect against database administrator mutation.

## Phase 3 — verified 2026-10-16

`pnpm test:incident-agent` passed with generated RS256 identities, the real API handlers and production repositories against a guarded disposable PostgreSQL schema. The reference module installs, publishes and enables `incident-response` v1, `incident-asset` and editable `incident-rule` schemas. The fixture creates and edits rules through the existing entity API, checks stale revision rejection and historical source snapshots, and maps canonical notification IDs through authenticated ingress.

The signed lifecycle covers event replay/content conflict and source-role revocation; unknown assignee and wrong handler; assign/accept; deterministic agent enqueue and concurrent claims; current requester/Asset/clean-file authority; lease fencing, bounded retry and absolute timeout; proposal replay/conflict; worker denial at human approval and generic callbacks; human approve/reject/rework, resolution and close. Close updates only approved Asset status while preserving other attributes, with one correlated durable outbox event. A forced late SQL failure rolls back the Asset and case together. Reopening repositories verifies persistence. Paged history returns all 102 fixture jobs without duplication.

`node scripts/smoke-agent-jobs.mjs` separately passed the PostgreSQL regressions for unrelated callback compatibility, wrong-schema rejection and result/claim/context lock delays across expiry. Final signed regressions also deny completed-job worker GET after requester disablement or Asset-share revocation, without exposing proposal content. Valid access resumes after authority restoration.

Full `pnpm check` passed 109 files / 596 tests, typecheck and all builds at f25b0c5. The final ce33d40 read-authorization correction passed 36 affected files / 189 tests, API typecheck and both PostgreSQL suites; independent whole-branch review at ce33d40 has no unresolved findings. The source is in PR #19. [Incident/agent API handoff](incident-agent-runtime.md) contains commands, bodies, roles, errors and integration boundaries.

Fixture identities and the worker are simulated; their generated schemas are removed, so reported fixture IDs are evidence rather than retained demo data. These checks certify Duy's backend responsibilities, including durable jobs and synchronization events. Nhi's actual threshold executor, broker/n8n transport, model inference and Hung's UI remain separate shared integration acceptance. No external delivery or model success is inferred from an outbox acknowledgement.

## Local runtime and checklist

After final review, only the API container was rebuilt from ce33d40 and became healthy. Its protected agent route returned 401 without a token, and the agent persistence tables were present. Fresh `pnpm test:workflows` and `pnpm test:team-integration` passed against that running Gateway/API/PostgreSQL stack. Existing identities, NocoBase containers and volumes were preserved. A database-only backup and the previous API image tag were retained locally before the update; this is not a full disaster-recovery rehearsal.

The existing Notion project page was updated and read back: Duy phase 2 has 6/6 checked items and phase 3 has 7/7. The teammate sections and shared acceptance criteria were preserved. The page includes backend evidence and the remaining real broker/model/UI integration boundary.

## Review corrections — 18 October 2026

Incident creation and creation replay now require an active directory identity with current start roles, and reject worker roles in either the JWT or directory. Owner cancellation and task transfer use the same incident authority boundary. Generic workflow behavior is unchanged. Signed HTTP acceptance on a disposable PostgreSQL schema passed disabled/revoked creators, mixed worker roles, denied replay/cancellation and restored human cancellation, as well as the existing incident lifecycle.

Agent result requests have a bounded 144 KiB limit covering the proposal validator's maximum JSON-escaped content. Oversized bodies return a sanitized 413; malformed JSON returns 400. The route regression verifies maximal escaped proposals and that rejected input never reaches the repository.

Fresh `pnpm check` passed 110 files / 599 tests, typecheck and all builds. `pnpm test:incident-agent` passed using signed fixture identities, production handlers/repositories and isolated PostgreSQL; model/broker/UI delivery remains outside this backend test. No additional Notion tasks were ticked during this review.

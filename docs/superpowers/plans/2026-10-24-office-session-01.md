# Office Session 01 — Submission stabilization

**Goal:** repair confirmed team integration defects and produce one tested submission candidate.

**Roles:** Dad makes decisions, owns scope/review and GitHub integration. Baby (separate Codex chat, GPT-6-Luna/max) writes code and focused regression tests in the same checkout. No subagents. One writer at a time. Baby reports changed files, red/green verification and unresolved risks; Dad independently verifies before the next task.

**Base:** feat/submission-integration, initially 73e4955. Merge origin/main e3e7500 before fixes. Preserve contributor history, production canonical handover, separate sample export, Studio and agent bridge. No resets, force pushes, secret output or unrelated changes. Leave CV.pdf/a.png alone. No release tag or Notion completion.

## Task 1 — Existing Asset compatibility

Owner: Baby. Files: apps/api/src/uc1-integration/broker-sync.ts, scripts/lib/ngsi-ld-client.mjs, corresponding broker and context tests.

- [x] Merge the latest main into the integration branch, combining capabilities and updated documentation.
- [x] Reproduce missing relationship timestamp rejection with an existing Asset created by main.
- [x] Fall back to the valid status observation only for absent relationship timestamps; reject malformed present timestamps and preserve newer observations.
- [x] Append/upsert existing Asset attributes using POST /attrs, preserving unrelated attributes.
- [x] Normalize broker projection time conservatively to whole seconds while retaining original source time in persisted jobs/trace; reject same-second conflicting projections.
- [x] Run focused broker/context tests and API typecheck. Dad reviews actual diff and reruns focused tests before accepting.

## Task 2 — Live incident configuration

Owner: Baby after Task 1 review. Files: incident/rule-editor.js, incident/case-board.js, related tests.

- [x] Use query for list filters and body/schemaId/title/attributes for creates; preserve version/title/attributes for edits and use archive instead of unsupported delete.
- [x] Read actual published rule and Asset schemas, preserving attributes outside edited fields.
- [x] Create incidents only with real authorized notification context and exact workflow input fields; never invent notification IDs or display fallback cases after denied live reads.
- [x] Exercise real bridge request validation in tests; verify missing notification blocks creation with a clear message.

## Task 3 — Real agent evidence and safe completion

Owner: Baby after Task 2 review. Files: incident/evidence-proposal.js, agent-run.js, resolution.js and necessary board bindings/tests.

- [x] Resolve the immutable completed job/proposal from the selected run's job/proposal IDs through the authorized API.
- [x] Remove fabricated default proposals/evidence/confidence from live approval. Missing results fail closed.
- [x] Reset private state on identity, organization, run or job changes and ignore late responses.
- [x] Remove redundant malformed Asset updates from the UI; backend close remains authoritative.
- [x] Preserve uncertain command key/body and version rather than issuing fresh mutation keys on retry.

## Task 4 — Acceptance and delivery

Owner: Baby executes, Dad reviews. No expansion of scope.

- [x] Run workspace typecheck/test/build and all foundation/bridge Node tests; inspect failures rather than deleting tests to make them green.
- [x] Run existing disposable PostgreSQL Studio, UC1 and incident-agent acceptances; real Orion smoke with isolated fixtures if available. No live model calls unless necessary, and only combo.
- [x] Dad reviews diff/security/contracts, checks evidence and instructs any corrections.
- [ ] Commit verified changes, publish one PR with precise evidence, wait for CI. Merge only when eligible under the user's existing authorization.
- [ ] Update local runtime with the backup-enabled installer and give the user a concrete test path plus material remaining limits.


Verification: Dad independently reran pnpm check (130 files / 791 tests, typecheck/build passed), Foundation 138/138, bridge 15/15. Disposable PostgreSQL Studio, UC1 and incident-agent acceptances passed; incident worker was simulated. Real Orion isolated-tenant smoke passed existing Asset reconciliation, attribute append/readback, unrelated attribute preservation, millisecond source retention and duplicate replay. No live model calls. Manual incident creation remains blocked until an authorized notification selection is implemented; no notification IDs are fabricated.

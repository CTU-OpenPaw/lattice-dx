# Task lifecycle Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. Execute tests before production changes; local progress only, no Notion ticks.

Goal: add claim/reassign/cancel/deadline/history without weakening existing workflow/resource permissions.
Architecture: focused tasks module, shared SQL transactions and current directory resolution; register alongside foundation routes. No new packages.
Tech Stack: Fastify, TypeScript, pg, Vitest.

## Global Constraints

Exact contract docs/superpowers/specs/2026-10-14-task-lifecycle.md. Duy backend only. No upstream/UI/adapters/dependency/credentials/volume deletion/Notion ticks. Same working branch, no switch/push/merge by implementer. Preserve CV.pdf/a.png/output. New mutations require expectedVersion and Idempotency-Key. Workflow-linked tasks reject generic lifecycle409.

### Task 1: Production lifecycle module and signed APIs

Files: new apps/api/src/tasks/{types,policy,database,routes}.ts and tests; foundation.ts optional fields/options, foundation-database.ts initialization/current visibility; records database shared predicates; app.ts register new routes; database.ts connect lifecycle; index.ts forward repository. Implementer may add imports/option wiring in these files. Use additive columns/tables, no table replacement.

- [ ] Write RED strict payload/role/scope/replay/workflow guards tests. Example: parse cancellation with extra organizationId must throw400; missing key route400; nonowner reassign404; linked pending task409.
- [ ] Implement contracts from spec. Interface lifecycle {createQueue,queue,claim,reassign,cancel,setDeadline,history}; actor {subject,organizationId}; input exact spec; PageQuery pagination; optional repository in createApi yields503 for unavailable new endpoints.
- [ ] Implement SQL transaction: advisory command tuple lock, lock task, check current actor/directory and linked workflow guards, lookup fingerprint receipt, check expectedVersion for fresh command, update + audit + receipt, commit. No nested pool calls within transaction.
- [ ] Wire production and revoked/cancelled resource sharing. Mutations assert current authority before replay; claim replay current exact assignee or currently eligible unclaimed department member, reassign/cancel/deadline replay current creator.
- [ ] Run pnpm exec vitest run apps/api/src/tasks and affected existing tests; pnpm --filter @dx/api typecheck; git diff --check; commit only production/tests. Report full commands/output to output/reviews/task-lifecycle-implementation.md, return status/commit/summary only.

### Task 2: Live acceptance and handoff

Parent files: scripts/smoke-task-lifecycle.mjs, package.json test:task-lifecycle, docs/task-lifecycle.md, docs/verification.md and master progress.

- [ ] Private UUID schema through API container: seed directory and initialize record/foundation/workflow stores plus lifecycle; test all acceptance clauses in spec. Drop only verified task_smoke_[a-f0-9]{32} fixture.
- [ ] HTTP local creator Alice/warehouse/peer: queue create/claim, reassign, cancellation, deadline, metadata history and role denials; rebuild image and sync fixture only if capabilities required. Keep demo rows.
- [ ] Full pnpm check and meaningful foundation/actions/logistics/workflow regressions; rate limit unchanged.
- [ ] Independent review with spec/report/diff; fix errors and rerun covering tests; handoff endpoint/body/response/role/error examples.
- [ ] Commit and update current PR reviewable scope; no automatic merge/release.

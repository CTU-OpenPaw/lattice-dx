# Workflow waits and conditions implementation plan

> For agentic workers: use subagent-driven-development and independent spec/quality review. Observe RED before production behavior changes.

**Goal:** Durable task/connector completion advances configured workflows with simple data guards.

**Architecture:** Strict config predicate/wait helpers, PostgreSQL wait repository using existing transaction client, resource-scoped completion API and lightweight timeout poller. No privileged automatic action chain.

**Tech stack:** TypeScript, pg, Fastify, jose, Vitest. No new packages.

## Constraints

- Branch codex/workflow-waits-conditions, stacked on PR #8; do not merge/release/tick Notion.
- Signed task/connector scope; minimal replay receipts; no owner-role snapshot.
- Run lock then wait lock everywhere; no nested pool connection.
- Results cannot overwrite input/assignment fields; guards fail closed.

## Task 1 — Types and pure policy

Files: packages/contracts/src/workflows.ts, workflows/registry.ts, policy.ts, new completion policy/tests.

- [x] Add typed single predicates and wait config, validate declared fields/targets/final step/result collisions/timeout range.
- [x] Test malformed condition, nonnumeric gt, missing fields and condition-filtered action choices; preserve prior validation behavior.

## Task 2 — Lifecycle repository and resource authority

Files: workflows/schema.ts, block-database.ts, database.ts, types.ts, new waits-database.ts/tests; foundation-database.ts.

- [x] Persist pending wait from final task/job result in the same workflow transaction; reject early transitions before writes.
- [x] Complete under run-before-wait locks, verify exact task/connector authority and signed roles, validate bounded output and persistent replay fingerprint, update run/task/audit together.
- [x] Expose scoped paginated waits and minimal complete receipts; block generic task decision bypass and annotate wait-linked tasks.
- [x] Add safe timeout poller and restart behavior; no action execution from unsigned timeout actor.

## Task 3 — Live evidence and handoff

Files: workflows/routes.ts/index.ts wiring, gateway/identity fixture; docs/workflow-completion.md; scripts/smoke-workflow-completion.mjs.

- [x] Test task → condition → connector result across authenticated API; wrong tenant/actor/connector/result/replay/bypass rejected.
- [x] Test real SQL concurrency/rollback/timeout with one connection; existing suites/typecheck/build and old live regressions pass.
- [x] Independent review, fix issues and rerun affected checks. Commit and create reviewable PR; no merge/Notion ticks.

Baseline: 166 tests / 23 files, prior live Studio/blocks/Logistics/workflow suites and GitHub CI passed.

## Completed evidence
175 tests / 25 files, typecheck and build passed. Real completion/Studio/blocks/Logistics/source workflow suites passed. Completion smoke restarts API while pending and exercises the actual timeout poller; isolated one-connection SQL verifies races, failed/expired results, malformed numeric guards and authorized failure evidence. Independent final review passed spec/quality, 11 targeted tests. Completion advances configured state; subsequent action execution remains normally authorized. No Notion ticks or automatic merge/release.

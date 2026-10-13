# Workflow blocks and routing implementation plan

> For agentic workers: use subagent-driven-development, verify each deliverable and obtain independent spec/quality review.

**Goal:** Configured workflows execute authorized internal blocks and route tasks by person or department.

**Architecture:** Strict binding types/validator and a small SQL block executor invoked within the existing workflow transaction. Execution rows and connector events persist beside workflow audit; directory snapshot resolves assignment.

**Tech stack:** TypeScript, pg, Fastify, jose, Vitest. No new dependencies.

## Constraints

- Branch codex/workflow-blocks-routing, based on PR #7; no merge/release/Notion ticks.
- Preserve source definitions and all old routes; no upstream modifications.
- Only allowlisted actions/bindings; callers need signed action roles.
- Same transaction connection for all actions; complete rollback and stable replay.
- Multiple eligible department recipients means 409, never arbitrary selection.

## Task 1 — Contracts and strict validation

Files: packages/contracts/src/workflows.ts; apps/api/src/workflows/registry.ts; new block-policy.ts and tests.

- [ ] Write failing tests for valid ordered block bindings and invalid action, input, unsafe names, unknown references and forward result.
- [ ] Define bindings, block config/results and connector payload types. Validate configuration before storage/publication.
- [ ] Test person/department assignment policies, zero/ambiguous candidates and signed action-role requirements.

## Task 2 — Atomic block runtime and evidence

Files: workflows/block-database.ts, schema.ts, database.ts, types.ts, routes.ts plus tests.

- [ ] Observe missing block execution RED, implement internal records/tasks writes through the active client and directory snapshot.
- [ ] Enforce linked record actor ownership/same tenant; retain foundation task sharing policy. Persist results without inserting Logistics task links.
- [ ] Queue connector dispatch through fixed-server outbox and allowlisted connector ID; expose scoped executions endpoint.
- [ ] Verify rollback if any action fails, replay has no extra writes, immutable-version action config and concurrent transitions.

## Task 3 — Department API and handoff

Files: directory.ts, directory-database.ts, directory-routes.ts, gateway fixture, identity role fixture; docs/workflow-blocks.md; scripts/smoke-workflow-blocks.mjs.

- [ ] Add paginated active department catalogue filtered by role/query with directory:read permission.
- [ ] Run live configured record → department task → connector event and explicit-person routing; verify roles/isolation/paging/rollback.
- [ ] Run pnpm check and affected Studio/workflow/Logistics regressions, independent review, fix findings and rerun affected checks.
- [ ] Document block JSON, execution results, errors and limitations; create reviewable PR, do not merge or tick Notion.

## Baseline

Prior increment PR #7: 150 tests / 21 files and live Studio/Logistics/workflow smoke passed. This plan supersedes the prior increment's restriction on custom declarative block configuration while preserving its prohibition on executable code and arbitrary network endpoints.

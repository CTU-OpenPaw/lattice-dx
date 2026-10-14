# Configurable workflows implementation plan

> For agentic workers: use subagent-driven-development or executing-plans; keep each change testable and review before completion.

**Goal:** Publish tenant workflow configuration and execute immutable versions through the existing engine.

**Architecture:** PostgreSQL draft/published registry, strict pure validator, authenticated routes and organization-aware asynchronous definition resolver. Existing workflow policy and outbox remain the execution engine.

**Tech stack:** TypeScript, Fastify, pg, jose, Vitest; no added dependencies.

## Constraints

- Work on `codex/configurable-workflows` based on PR #6; do not merge or create release.
- Do not change upstream NocoBase or user files; do not tick Notion.
- Signed `workflow:design` permission for configuration; no tenant input from body.
- Built-in definitions reserved; published definitions immutable, running instances pinned.
- Custom configuration cannot execute code, choose network URLs or use task hooks yet.

## Task 1 — Registry and configuration validation

Files: new focused registry types/validator/database/routes/tests under `apps/api/src/workflows`; existing app/database/index wiring.

- [x] Write failing tests for unknown fields, invalid graph, reserved IDs, draft conflict, role denial and tenant isolation. Run `pnpm test` and observe the missing behavior.
- [x] Implement pure configuration validation, bounded input and safe field/role/transition names. Preserve JSON content without prototype-sensitive dictionary assignments.
- [x] Implement draft create/list/get/update and publish with optimistic revision, row locks, unique tenant/version keys, actor/timestamp audit and publication replay.
- [x] Expose authenticated draft API; missing services 503, JWT failure 401, role denial 403, invalid payload 400, hidden record 404 and conflict 409.

Interfaces: `DefinitionRegistry.get(organizationId,id,version?)` returns latest or pinned definition; `list(organizationId)` returns immutable published definitions needed by runtime policies. Runtime repository receives this registry explicitly, without process-global caching.

## Task 2 — Reuse registry throughout runtime

- [x] Write failing tests proving tenant definitions appear in catalogue and running v1 keeps its transitions after v2 publishes.
- [x] Replace source-only resolution in runtime SQL, route views, list/inbox, evidence and retry with tenant-aware resolution; preserve built-in fallback.
- [x] Start replay must resolve the stored version before applying changed configuration. No publication may change an already accepted idempotent command.
- [x] Add Gateway draft allowlist and local designer role fixture; no automatic production permission grants.

## Task 3 — Integration and handoff

- [x] Add live smoke script exercising create/update/publish/start/transition, v2 pinning, conflict, tenant isolation, restart persistence and list paging.
- [x] Run `pnpm check`, rebuild API and run applicable existing workflow/logistics smoke tests. Record actual results and limits.
- [x] Add Studio API contract and example HR/IT configuration; update verification evidence.
- [x] Request independent code review, fix findings and rerun affected checks. Commit changes, retain branch for review; no automatic merge/release.

## Baseline

13 October 2026: 145 tests / 18 files passed before implementation. Current main work is PR #6, so this feature depends on its branch until prior PRs merge.

## Execution evidence
Completed first deliverable: 150 tests / 21 files, typecheck and build passed. Live Studio smoke passed including 106-row SQL paging and pool-max-1 concurrency. Existing Logistics and workflow smoke passed. Independent full review approved spec and quality, 11 targeted tests passed. UI and connector/action blocks remain next increments; no Notion completion boxes updated.

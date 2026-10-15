# Team Integration Readiness Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the fixture implementation and independent reviews; keep teammate branches read-only.

**Goal:** Give Hưng and Nhi one executable, permission-correct shared integration path and actionable contract reviews.

**Architecture:** A declarative module uses existing entity/context/workflow APIs. Add signed HTTP seed and acceptance scripts with isolated resource names, reusable metadata artifacts and no account/directory rewrites. Independently compare the current teammate branches and document what is actually compatible.

**Tech Stack:** Existing Node24 ESM scripts, Fastify/TypeScript/PostgreSQL APIs, Keycloak JWT and Vitest; no new dependencies.

## Global Constraints

Use the exact constraints in the companion spec. One current branch, no teammate source edits/merge/deploy, preserve all user data and secrets, no auto merge/release/Notion ticks. Distinguish source inspection, tests actually run, and teammate-reported runtime evidence.

### Task 1: recorded branch and mapping review

Files: `docs/team-integration-readiness.md`.

- [ ] Record `origin/main` and all three teammate branch SHAs and CI status.
- [ ] Compare ID/tenant/relation/timestamp/source-of-truth rules with entity, workflow, directory and ingress contracts. Record exact blockers and proposed resolution; do not silently adopt an incompatible namespace.
- [ ] Compare UI list/detail/inbox/transition/field/binding and authentication contracts against merged API. Attribute reported browser tests separately.
- [ ] Execute exported plugin/bridge tests against the current checkout dependencies when feasible, retaining export under ignored output. State tests that cannot establish live integration.

### Task 2: shared asset-review module, seed and smoke

Files: `solutions/integration/asset-review.json`, `scripts/lib/team-integration.mjs`, `scripts/seed-team-integration.mjs`, `scripts/smoke-team-integration.mjs`, `tests/team-integration.test.ts`; parent registers package commands.

- [ ] Test before implementation: fixed declarative manifest validation, strict artifact UUID/slug/tenant schema and safe fixture namespace; no credentials in artifacts; new runs never reuse another run's namespace.
- [ ] Implement helpers with bounded fetch, content-type-aware errors, no token/error-body logs, fixed local default gateway/identity and explicit credential environment overrides. No arbitrary remote credential forwarding.
- [ ] Seed via signed HTTP using existing alice/warehouse/bob identities: install namespaced schema/workflow module, publish/enable, create typed Asset, explicitly share asset read to warehouse subject when requested, start workflow with entityContext. Workflow transitions use roles already present, UI-supported inputs and no implicit data grant. Retain IDs/URLs in generated local JSON.
- [ ] Smoke on a fresh seed: warehouse workflow inbox/detail and allowed action, unauthorized/cross-tenant attempts, current entity ACL/revoke behavior, same-key command replay and new-key stale-version conflict, ordinary task/approval distinctions. Never mutate directory/role state.
- [ ] Run meaningful unit tests, actual signed HTTP seed/smoke, inspect retained IDs and metadata artifact, source review before acceptance.

### Task 3: operator and team handoff

Files: `docs/team-integration-readiness.md`, `docs/backend-api-index.md`, `package.json`.

- [ ] Add `integration:seed` and `test:team-integration` commands; document exact actor responsibilities, expected HTTP statuses, seed/smoke distinction and retained artifacts.
- [ ] Supply UI/backend and broker/n8n acceptance checklists with concrete request paths and required outcomes; mention backend context endpoints do not automatically create a new UI context block.
- [ ] Include two boundaries: no live broker proof from a mocked event; no browser proof from HTTP/plugin unit tests. Identify items for Hưng/Nhi rather than implementing their services.

### Task 4: verification and delivery

- [ ] Run final `pnpm check`, signed integration smoke and relevant legacy module/context regression; investigate any failure before changes.
- [ ] Independent review of new tooling/contracts, fix findings, confirm no secrets/user artifacts staged and lockfile unchanged.
- [ ] Commit, push one branch, open and attach PR, verify latest-head CI; do not merge. Report what is running, retained IDs and remaining teammate gates.

## Execution ledger

| Task | Status | Evidence |
| --- | --- | --- |
| 1 | In progress | Read-only branch audit; new Nhi notification branch detected |
| 2 | Planned | Signed shared fixture and acceptance |
| 3 | Planned | Consolidated handoff |
| 4 | Planned | Review/CI delivery |

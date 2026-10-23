# System Studio lifecycle implementation plan

**Goal:** Let Duy manually test authoring, staged publication, administration and an employee → manager → assignee workflow entirely through the UI.

**Architecture:** Add a small authoring recipe/draft store, compile to the existing enterprise-module/workflow contracts, and attach safe presentation metadata. Additive authenticated bridge operations and an isolated Studio/runtime UI reuse the current NocoBase host. No new dependency or upstream change.

## Constraints
- Preserve existing routes, manifests, UI applications, UC1 auto-worker scope and teammate branches.
- Actor/tenant from verified identity; designer roles checked before reads/writes/replays.
- No arbitrary endpoint/code/credential in configuration; no automatic role grants.
- Durable draft revision and Idempotency-Key; immutable installed packages; explicit publish stages.
- Same backend policy for Studio and employee runtime; every list paginated.
- Keep README/Notion checkboxes untouched; unrelated CV.pdf/a.png remain untracked.

## Tasks
1. [x] **Recipe and presentation contract.** Add policy/compiler + tests in `apps/api/src/systems/`; extend module types/parser with optional presentation. Test old compatibility, malformed references/roles, ownership/namespace and prototype/URL injection before implementation.
2. [x] **Persistent drafts and runtime discovery.** Add draft store/routes and extend module store with a safe runtime projection; wire API/database/Gateway. Test signed roles/tenant, revision conflict/replay and real PostgreSQL persistence.
3. [x] **Authenticated bridge.** Add fixed `studio` operation mapping for draft/plan/module publication/catalog/runtime/audit. Test host/business session isolation, paths, payload caps and command keys; preserve existing bridge behavior.
4. [x] **Studio and generic runtime.** Add separate components/styles/routes to the existing plugin, with editor/preview/staged deployment/admin/import-export and definition-driven employee workflow. Test command retries, role/field handling, lifecycle status and package mapping. Avoid rewriting Hưng's Workspace.
5. [x] **Deploy and exercise.** Back up NocoBase/engine configuration, build/install reviewed plugin changes, recreate only required services with `.env.integration`, run real SQL/API and browser scenarios with demo accounts. Preserve volumes and existing systems.
6. [x] **Simplification/review/handoff.** Apply Code Simplification only to new/touched code after behavior passes. Run full check + plugin contracts, independent review, fix findings. Write a separate manual test guide with URLs/accounts/steps/limitations and proof; commit and create PR.

## Verification checkpoints
Each task starts with failing behavior tests, ends with relevant passing checks, and updates evidence here. Existing integration smoke scripts that assume workers off will not run concurrently with the scoped UC1 auto worker. Nothing is called complete merely because an endpoint or UI button exists.

## Execution evidence — 2026-10-21

- Policy/routes/bridge tests first failed for missing implementation, then passed. Focused API/module checks: 34 tests.
- `pnpm check`: typecheck, 650 tests across 120 files and all builds passed. After final type tightening, API typecheck/focused tests/SQL acceptance passed again.
- Foundation: 63 tests; Bridge: 10 tests passed. No new project dependency and no upstream NocoBase changes.
- `pnpm test:system-studio`: production repositories and signed HTTP against disposable PostgreSQL database. Includes concurrent receipt replay, competing revision updates, draft pagination, two-module compile/publish/runtime, exact assignee task completion, tenant isolation, disable/continued old work, reconnect persistence and independent imported system.
- Browser: authored/published `studio-proof-1021`; alice created and submitted, manager approved, warehouse completed. State `completed`, version 4, four history entries. Local screenshot `output/verification/system-studio-completed.png`.
- Independent review found and fixed package-hash mismatch, disabled-system discovery and portable-package consistency. Follow-up review found no blocker in those fixes.
- Installer backed up NocoBase database and installed Foundation 0.15.0 + Action Bridge 0.2.0. Core volumes, UC1 worker scope, teammate branches and Notion unchanged.
- Manual handoff: `docs/testing/system-studio-lifecycle.md`. Browser export/import and every denial variant remain available for manual exploration; core package/permission behavior has automated evidence.

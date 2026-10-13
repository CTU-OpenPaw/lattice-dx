# Workflow bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Safely reuse multiple workflow definitions across enterprise units through export, preview and atomic draft import.

**Architecture:** Use the existing definition registry and validator. Add a small bundle policy and route module; use one database transaction for draft insertion. No new dependencies or tables.

**Tech Stack:** TypeScript, Fastify, PostgreSQL/pg, Vitest, signed JWT.

## Global Constraints

- Format `latticedx.workflow-bundle`, formatVersion 1; 1–10 unique custom definitions, 12,288 UTF-8 JSON bytes each; HTTP body limit 131,072 bytes.
- Require signed workflow:design; tenant/actor from verified JWT only. Explicit published versions for export. Atomic insert-only import, no publish/overwrite/role grants.
- Reject literal task assigneeId/recordId and literal department/explicit department assignee bindings; preserve other configuration literals with documented review responsibility.
- No new dependencies, no NocoBase/license modifications, no Notion ticks, no merge/release; preserve CV.pdf, a.png and output/.

### Task 1: Policy, atomic persistence and API

**Files:** Create apps/api/src/workflows/bundles.ts, bundles.test.ts, bundle-routes.ts, bundle-routes.test.ts. Modify registry.ts, registry-database.ts, app.ts and the actual gateway config. Extend database-registry.test.ts only if useful for its current fixture; live atomicity belongs to Task 2.

**Interfaces:** `parseBundle(value:unknown)` returns the strict bundle; `bundlePreview(bundle)` returns workflowCount and definitions metadata; `DefinitionRegistry.createMany(definitions:unknown[], actor:WorkflowActor):Promise<WorkflowDraft[]>` performs insert-only transaction. Exports use existing registry.get(org,id,version).

- [ ] Write failing policy and signed-route tests before implementation. Include rejected duplicated IDs/unsafe source IDs, explicit version lookup, no tenant overrides, writes absent on preview, and missing configuration 503.
- [ ] Run `pnpm exec vitest run apps/api/src/workflows/bundles.test.ts apps/api/src/workflows/bundle-routes.test.ts`; observe missing feature failures.
- [ ] Implement strict keys/types/format/bounds with validateDefinition, portability checks and derived requiredRole/connector/inputFields preview. Validate entire import before opening transaction. Reuse draft INSERT helper and reject collisions with WorkflowError(409), rolling back/releasing clients.
- [ ] Register POST export/validate/import; map domain 400/404/409 and identity 401/403/503 consistently with draft routes. Forward through gateway with the same rate/auth policy.
- [ ] Run targeted tests and `pnpm typecheck`; adapt existing registry fixtures to new required createMany interface without weakening assertions.
- [ ] Commit implementation and tests; write report with RED/GREEN evidence and concerns to output/reviews/workflow-bundles-implementation.md.

### Task 2: Live verification and team handoff

**Files:** Create scripts/smoke-workflow-bundles.mjs and docs/workflow-bundles.md. Modify package.json test:workflow-bundles, README.md and docs/verification.md.

- [ ] Add real HTTP preview/export/import/publish/start smoke using local Keycloak users and unique demo IDs. Verify explicit published v1 export after v2 exists and unpublished imported definitions cannot start.
- [ ] Use a random, validated private PostgreSQL schema for two-tenant import, last-item conflict rollback, and simultaneous duplicate imports. Verify pool max 1 works without nested connection acquisition; drop only the generated private schema.
- [ ] Build/recreate API and gateway only if needed, preserving volumes and other services. Run `pnpm test:workflow-bundles`, `pnpm test:workflow-studio`, `pnpm test:workflow-completion` and `pnpm check`.
- [ ] Write handoff with exact endpoint/request/response/errors and explicit scope: workflow templates only; roles and external adapters are not provisioned; imported drafts still need review/publish.
- [ ] Independent spec/quality review, address important findings and rerun affected checks. Run git diff --check, commit, push feature branch and create/attach PR against codex/workflow-waits-conditions. Inspect CI without merging or releasing.

# General System Blocks Implementation Plan

> **For agentic workers:** Use subagent-driven-development and independent parallel tasks with explicit file ownership.

**Goal:** Configure and run data-only or mixed data/workflow systems in the existing Studio without domain-specific endpoints.

**Architecture:** Extend existing recipes with optional owned `schemas` and `entityPages`. Compile to the existing immutable enterprise module. Entity pages bind publication 1, configured fields, ordered blocks and allowlisted actions; all execution uses the existing entity API and its record ACLs. Workflow recipes retain identical output.

**Tech Stack:** TypeScript/Fastify/PostgreSQL; existing React/NocoBase plugin; Node test runner and Vitest. No new dependencies.

## Constraints and approved contract

- Work on `feat/general-system-blocks`, based on enterprise-console; do not touch teammate branches or unrelated untracked files.
- Entity page: `{id,title,schemaId,schemaVersion:1,blocks,fields,actions,query?}`.
- Blocks: `create`, `list`, `detail`, `relations`, `history`; actions: `create`, `update`, `archive`, `link`, `unlink`.
- Query contains optional existing entity `filters` and `sort`; it configures a view, never an authorization rule.
- Own schemas only. Installer publishes version 1 transactionally. Existing schema ID conflicts stay explicit; a new system version requiring schema changes uses new schema IDs.
- No arbitrary code, URLs, actor scope or credentials in configuration. Published configuration is immutable; old workflow-only recipes remain byte-compatible.
- Data-only modules may have an empty embedded workflow bundle; standalone workflow bundle import remains strict.
- Catalog visibility requires organization and `data:read`; every record action still enforces the existing backend ACL, idempotency and optimistic version checks.

## Task 1 — Backend contract and lifecycle

- [x] Add failing policy tests for data-only and mixed compilation, invalid schema/field/action/query references and legacy stability.
- [x] Extend system recipe/presentation parsers, guarded empty embedded bundles and pinned runtime schemas.
- [x] Include data pages in SQL catalog visibility and filter them independently of workflow roles.
- [x] Run `pnpm exec vitest run apps/api/src/systems apps/api/src/modules apps/api/src/blocks apps/api/src/workflows/registry.test.ts --maxWorkers=2`.

## Task 2 — Generic runtime

- [x] Test typed configured fields, preservation of unexposed attributes, pinned queries and action filtering.
- [x] Implement entity page form/list/detail/relations/history using existing session and immutable command controller.
- [x] Keep pagination server-side, retain exact command bodies for uncertain retries and disable mutations on disabled modules or insufficient capabilities.
- [x] Run `node --test plugins/nocobase/plugin-lattice-foundation/tests/entity-page*.test.cjs`.

## Task 3 — Studio editor and runtime wiring

- [x] Test reusable schema/page creation helpers, immutable editing and legacy recipe compatibility.
- [x] Add schema/page designer to Studio with field, block and action configuration.
- [x] Wire mixed/data-only runtime navigation and publishing; avoid workflow membership calls for users opening data-only systems.
- [x] Run new designer tests and existing system-model/runtime-layout tests.

## Task 4 — Bridge and integration (root)

- [x] Write red tests for entity query/relation allowlists and archive/link/unlink command routing.
- [x] Add bounded query and relation dispatch using fixed gateway paths; no dynamic URL or organization override.
- [x] Verify real PostgreSQL install, enable, runtime discovery and record CRUD for HR/contracts/assets configuration, including cross-organization denial and immutable publication.

## Task 5 — Review and delivery

- [x] Review all changes for spec compliance, ACLs, retry semantics and unnecessary complexity.
- [x] Run `pnpm check`, foundation and bridge Node tests, and disposable PostgreSQL acceptance.
- [x] Build/install local runtime with existing backup-enabled installers only after checks pass; verify reachable UI.
- [x] Record verified behavior and remaining limits; do not tick Notion or merge teammate work.

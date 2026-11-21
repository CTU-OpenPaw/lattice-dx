# `@latticedx/plugin-dxos-ai` v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `@latticedx/plugin-dxos-ai` from 8 surface tools to 11 deep Admin System Builder & dynamic Cross-Department Copilot tools, wire live LLM execution via `9router` (`:20128`), and verify + record Full HD live Showcase Use Cases on `http://localhost:13014`.

**Architecture:** Split `ai-tools-core.js` cleanly into shared scope/audit core + `ai-builder-tools.js` (7 Admin tools driving `FlowModelRepository`, `latticePortals:save`/`desktopRoutesUiLayouts`, `collections`/`CollectionModel`, `dataSourcesRoles`/`dataSourcesRolesResources` -> `writeToACL`, `workflows`/`flow_nodes`) + `ai-copilot-tools.js` (4 org-scoped/RBAC-enforced operational tools with dynamic `latticeCustom*` discovery and cross-department orchestration). Zod v4 schemas avoid `propertyNames` for 100% compatibility with `9router` Gemini/OpenAI tool-calling.

**Tech Stack:** Node.js 24 CJS, NocoBase `2.2.38`, `zod` (host optional in unit tests), `@nocobase/plugin-ai`, `9router`, Playwright + `ffmpeg`, `node --test`, Vitest.

**Spec:** [`docs/superpowers/specs/2026-11-21-dxos-ai-v2-architect-and-copilot-design.md`](../specs/2026-11-21-dxos-ai-v2-architect-and-copilot-design.md)

## Global Constraints
- All `.js`, `.mjs`, `.cjs` files MUST carry the exact 8-line CTU-OpenPaw `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` header (`node scripts/source-headers.mjs --check` & `pnpm pof:check`).
- Preserve NocoBase Clause 5.2 attribution (`Powered by NocoBase`); keep `sdkProvidedByHost: true`; keep `zod` optional in `node --test` unit runs.
- Never allow non-admin callers to list or execute any Admin Builder tool; never allow `dxos_manage_rbac_permissions` to target `root`, `admin`, or non-`ldx_*` roles, nor touch `SYSTEM_PROTECTED_COLLECTIONS`.
- Never write API keys/secrets to tracked files or echo them to logs (`AGENT_API_KEY` read only in-memory from `e:\pmnm2026\.env.agent`).

## Review Focus
- **FlowModels / DesktopRoutes schema mismatch against live Postgres:** Postgres `flowModels` stores only `(uid, name, options)` and `desktopRoutes` links layouts via `desktopRoutesUiLayouts` (`uiLayoutUid`); querying non-existent columns fails in production. Unit tests and implementation MUST use `FlowModelRepository` methods and `desktopRoutesUiLayouts` / `uiLayouts` associations while staying compatible with minimal mock DBs.
- **DataSourcesRolesResources ACL parent & live reload:** Creating `dataSourcesRolesResources` fails or skips ACL sync unless `dataSourcesRoles` `(roleName, dataSourceKey: 'main')` exists and updates trigger `writeToACL` / revoke cleans `acl.getRole(roleName).revokeResource(...)`.
- **RBAC field-lock bypass via Copilot or Orchestrator:** Both `dxos_execute_record_action` and `dxos_orchestrate_enterprise_case` (`executeCoordinatedResponse`) MUST share the exact same `enforceCallerRbacOnWrite` check so employees cannot bypass locked fields (e.g. `auditVerdict`) via orchestrated writes.
- **Zod v4 `propertyNames` breaking Gemini tool-calling on `9router`:** Using `z.record(z.any())` generates `propertyNames` which Gemini rejects; `schema-helper.js` MUST use `z.object({}).passthrough()` and typed array elements, plus auto-parse JSON strings when an LLM stringifies `object`/`array` args.
- **New `latticeCustom*` invisibility on non-admin portals:** Adding a page blueprint via `flowSurfaces:applyBlueprint` does not auto-assign `rolesDesktopRoutes`; `dxos_compose_page_blocks` (`composePageBlueprint`) and `dxos_manage_portal_and_acl` MUST propagate portal role grants across all routes linked to `ldx-portal-${slug}`.

---

### Task 1: Gemini/OpenAI-Safe Zod v4 Tool Schema Helper (`schema-helper.js`)
**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/schema-helper.js`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs`
- [ ] Write failing tests for array `items`, object schema without `propertyNames`, and JSON-string coercion for `object`/`array` arguments -> run `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs` (RED).
- [ ] Update `buildZodSchema` & `validate` in `schema-helper.js` -> run `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs` (GREEN).

### Task 2: Deep Admin System Builder Tools (`ai-builder-tools.js`)
**Files:**
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/ai-builder-tools.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-tools-core.js`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-builder-tools.test.cjs`
- [ ] Write failing unit tests covering `dxos_compose_page_blocks` v2 (`addBlock`, `listBlocks`, `composePageBlueprint`, `updateBlock`, `reorderBlocks`, `removeBlock`), `dxos_manage_portal_and_acl` (`grant`/`revoke`), `dxos_extend_collection_schema` v2 (`createCollection` + `select` + auto-fields, `addFields`, `inspectCollection`, system table rejection), `dxos_manage_rbac_permissions` (`inspectRole`, `ensureCustomRole`, `grantResource`, `lockFields`, `revokeResource`, `root`/`admin` & system collection rejection), `dxos_deploy_workflow` auto-crew binding, and `dxos_configure_workflow` (`inspectWorkflow`, `updateNodeConfig`, `addNode`, `buildCustomWorkflow`, `toggleWorkflow`).
- [ ] Verify RED (`node --test plugins/nocobase/plugin-dxos-ai/tests/ai-builder-tools.test.cjs`).
- [ ] Implement `ai-builder-tools.js` & integrate in `ai-tools-core.js` -> verify GREEN.

### Task 3: Dynamic Custom-Module & Cross-Department Copilot (`ai-copilot-tools.js`)
**Files:**
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/ai-copilot-tools.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/{ai-tools-core.js,ai-schemas.js}`, `plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-copilot-tools.test.cjs` & `plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs`
- [ ] Write failing tests covering dynamic `latticeCustom*` search/write, `enforceCallerRbacOnWrite` (`RBAC_FIELD_LOCKED` for `ldx_employee`, allowed for `ldx_manager`), and `dxos_orchestrate_enterprise_case` (`radar`, `correlateCase`, `executeCoordinatedResponse`, `dryRun`).
- [ ] Verify RED -> implement `ai-copilot-tools.js` + wire 11 tools in `ai-tools-core.js` + update `STARTER_AI_BLUEPRINTS` & `ai-studio-page.js` -> verify GREEN across all plugin tests.

### Task 4: Acceptance Script Upgrade, Build, Full Offline Quality Gates & Commit
**Files:**
- Modify: `scripts/acceptance-dxos-ai-and-mcp.mjs`, `scripts/tests/acceptance-dxos-ai-mcp.test.mjs`
- [ ] Update & pass `acceptance-dxos-ai-mcp.test.mjs`, `node scripts/source-headers.mjs --check`, `node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs`, `pnpm pof:check`, `pnpm check`.
- [ ] Commit all changes cleanly on `feat/dxos-ai-workforce-mcp`.

### Task 5: Live Container Sync (`localhost:13014`), Headless `9router` (`:20128`) & Live Acceptance
- [ ] Sync built `@latticedx/plugin-dxos-ai` into container (`node_modules` & `storage/plugins`), restart & confirm `HTTP 200`.
- [ ] Start `9router` headless (`--tray --skip-update -p 20128`), probe `/v1/models` + 1-turn tool-calling test, run `setup-dxos-ai-workforce.mjs` (`llm.configured: true`), and run live `acceptance-dxos-ai-and-mcp.mjs` + `acceptance-logistics-and-rbac.mjs` (`PASS`).

### Task 6: Live Showcase Video (`1920x1080`) of Both Large Use Cases & Final Verification
- [ ] Run Playwright + `ffmpeg` script executing live `9router` chat + Đại Use Case #1 (`latticeCustomColdAudits` + `/p/cold-qa` + RBAC + Workflow) + Đại Use Case #2 (`native.lab.employee` & `native.lab.manager` + field-lock `403` + Audit Log) -> `LatticeDX-AI-v2-Admin-Builder-And-Big-UseCases-1080p.mp4`.
- [ ] Extract frames & inspect via `read_file`; update `docs/dxos-ai-and-mcp-acceptance.md` and artifacts; commit docs; run final repo verification gates.

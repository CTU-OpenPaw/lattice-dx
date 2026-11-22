<!--
  @file LatticeDX — Open Digital Enterprise Platform
  @author CTU-OpenPaw
  @copyright (C) 2026 CTU-OpenPaw
  @license Apache-2.0
  @see https://github.com/CTU-OpenPaw/lattice-dx
  SPDX-License-Identifier: Apache-2.0
-->

# LatticeDX v0.2.0 — Wave 1 Implementation Plan (Critical Security & Split-Brain Cleanup)

> **Goal:** Eliminate all Critical security/RBAC/multi-tenant/SSRF/live-telemetry defects across the NocoBase plugins and `apps/api`, retire `apps/web` + raw EICAR literal, and verify both offline unit/contract tests (`0 Critical` audit) and live Docker `localhost:13014` gates.
> **Discipline:** Strict TDD (`superpowers:test-driven-development`), NocoBase Clause 5.2 attribution preserved, SPDX Apache-2.0 headers verified via `node scripts/source-headers.mjs --check`.

---

### Task 1.1: Foundation, P.A.R.A. & Studio Scope Hardening
- **Files:**
  - `plugins/nocobase/plugin-lattice-foundation/src/server/native-scope.js` (+ tests)
  - `plugins/nocobase/plugin-dxos-para/src/server/para-scope.js`, `para-resource.js` (+ tests)
  - `plugins/nocobase/plugin-dxos-studio/src/server/service-scope.js` (+ tests)
- **Fixes (RED -> GREEN):**
  1. Extend `native-scope.js` to enforce `organizationId` scoping on dynamic **`latticeCustom*`** collections (`CUSTOM_COLLECTION_RE`).
  2. Recursively inspect **`params.filter`** (plus `fields`/`appends`/`sort`) to reject dotted relation traversal & sensitive fields (`password`, `token`, `secret`, `identitySubject`, `user.*`, `users.*`) — blocking blind filter oracle attacks.
  3. Block `charts:queryData` SQL mode (non-`builder`) and private/non-business collections for non-`root` roles.
  4. Clamp list `pageSize` to safe maximum (`<= 200`, default safe fallback) across Foundation/PARA/Studio list queries.
  5. Enforce owner/manager ownership guard on `latticeParaDocuments:update` / `destroy` for non-directors, and replace full-table memory fetch in `para-resource.js` `summary` with database `count()`.

### Task 1.2: DX-OS AI, RBAC Engine & MCP Hardening
- **Files:**
  - `plugins/nocobase/plugin-dxos-ai/src/server/index.js`, `ai-tools-core.js`, `ai-copilot-tools.js`, `ai-builder-tools.js`, `ai-sync.js`, `ai-schemas.js`, `ai-resource.js`, `ai-surface-creative-tools.js`, `mcp-itot-tools.js`, `mcp-gateway.js` (+ tests)
- **Fixes (RED -> GREEN):**
  1. Make **`enforceCallerRbacOnWrite` fail-closed** (deny when policy rows missing for custom/protected collections or insufficient action grant); pass `ctx`/actor metadata on writes so NocoBase hooks fire cleanly.
  2. Enforce `ownScope` / `draftScope` (`createdById`, `employeeId`, draft status) on `performScopedRecordWrite` and read scope on `dxos_search_enterprise_context`, `dxos_orchestrate_enterprise_case`, and `get_sensor_and_incident_timeline`.
  3. Replace title-regex self-approval check in `dxos_my_tasks_copilot` with **structural guard** (check creator/requester/assignee ownership regardless of node title text).
  4. Preserve existing `scope`/`scopeId` in `dxos_manage_rbac_permissions(lockFields)` and invoke `writeToACL`.
  5. Enforce `organizationId` workflow trigger condition in `buildCustomWorkflow` and preserve downstream chain when `addNode` splices nodes.
  6. Honor **`X-Role` active role precedence** instead of unioning all DB roles when lowering privilege.
  7. Lock down **`latticeAiProfiles`** direct REST via scope middleware + `beforeValidate` role-lock/cross-tenant hooks.
  8. Harden MCP SSRF & secrets: drop client-supplied `defaultOrigin` bearer forwarding, tighten `validateMcpServerUrl` (block internal single-label HTTP unless explicit env allowlist, IPv6-mapped private CIDRs, `redirect: 'error'`), sanitize `resultSummary` & error messages via expanded `SENSITIVE_KEY_RE` (including `jwt`, `bearer`, `privateKey`), and enforce admin gate on `mcp-gateway` `resources/read` & `get_stack_connector_health`.
  9. Fix live IT/OT telemetry: query Orion-LD `/ngsi-ld/v1/entities?local=true&limit=50`, query/enqueue `latticeContextOutbox` using `state` + required `NOT NULL` columns (`eventId`, `collectionName`, `recordId`), and cap `surfaceRevisionStore` size with bounded TTL/LRU eviction.

### Task 1.3: DX-OS Blocks & Portal Agent Client Hardening
- **Files:**
  - `plugins/nocobase/plugin-dxos-blocks/src/server/blocks-api.js`, `src/client/creative-studio-block.js`, `src/client/block-models.js`
  - `plugins/nocobase/plugin-dxos-ai/src/client/portal-agent-launcher.js`, `ai-studio-page.js`
  - `plugins/nocobase/plugin-dxos-studio/src/client/studio-settings.js` (+ tests)
- **Fixes (RED -> GREEN):**
  1. Enforce caller `ownScope` in `dxosBlocks:proposals`.
  2. Sort/compare timestamps in `contextTelemetry` with `Date.parse(...)` instead of lexicographical string comparison.
  3. Align `creative-studio-block.js` with `blocks-api.js` live telemetry response payload and fix `NaN%` rendering.
  4. Sanitize DOM `readActivePageTitle()` (strip control/instruction characters, length cap) against indirect prompt injection; remove redundant `2.6s` polling loop & guard reload when tab hidden or form inputs active (`visibilityState`).
  5. Synchronize `ai-studio-page.js` unified tool catalog labels & clean colon split; render clean Vietnamese status/redirect cards on empty `/p/*` portals and avoid triggering spurious console `403` calls.

### Task 1.4: Retire `apps/web`, Clean EICAR, Fix `apps/api` Criticals & Verify Live Stack
- **Files:**
  - Remove `apps/web/`; update `package.json`, `pnpm-workspace.yaml`, `COPYRIGHT.txt`, `README.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`
  - `packages/contracts/src/workspace.ts` & tests
  - `apps/api/src/app.ts`, `foundation.ts`, `foundation.test.ts`, `database.ts`, `organization/database.ts`, `workflows/waits-database.ts`, `entities/data-tools-csv.ts` (+ tests)
- **Fixes & Verification:**
  1. Retire `apps/web/` and strip raw EICAR string from `@dx/contracts`; run `pnpm install` & verify `pnpm audit` reports **0 Critical**.
  2. Fix `apps/api`: auth + security headers + sanitized 500s on `POST /v1/agent/demo`; scan-before-DB-insert in `POST /v1/files` returning `409`/`503` with `writes === 0`; uniform `400` cross-tenant error + per-org `pg_advisory_xact_lock` in `organization/database.ts`; `FOR UPDATE SKIP LOCKED` + per-row `try/catch` in `waits-database.ts`; configurable pool `max: 20` + `pool.on('error')` in `database.ts`; CSV formula neutralization (`'=`, `'+`, `'-`, `'@`, tab/CR) in `data-tools-csv.ts`.
  3. Build updated plugins, sync `dist` bundles into live Docker `localhost:13014`, run full offline unit tests + `source-headers.mjs --check` + `pnpm pof:check` + live acceptance (`23/23`, `7/7` `403`, `get_live_ngsi_telemetry` `degraded: false`), commit cleanly, and hand back via `enter_plan_mode` for Wave 2.

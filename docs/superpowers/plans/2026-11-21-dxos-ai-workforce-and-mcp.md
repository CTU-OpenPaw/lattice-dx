# `@latticedx/plugin-dxos-ai` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement, build, integrate, and live-verify the 7th Apache-2.0 NocoBase plugin `@latticedx/plugin-dxos-ai` (0.1.0, `sdkProvidedByHost: true`) with Admin-configurable AI Employees, Admin Builder tools, operational/workflow tools, two-way Streamable HTTP MCP endpoints (`/api/dxos-mcp` & `/api/dxos-mcp/it-ot`), 6-plane Enterprise OS topology, dynamic Block Copilot strip, and full audit trail.

**Architecture:** One unified RBAC/org-scoped server execution core (`ai-tools-core.js` + `mcp-itot-tools.js`) powers both NocoBase native `ai.toolsManager` tools (`ALLOW`/`ASK`) and stateless JSON-RPC 2.0 Streamable HTTP MCP routes (`mcp-gateway.js`), backed by `latticeAiProfiles` (synced 2-way to `aiEmployees` & `aiMcpClients`) and `latticeAiAuditLogs`.

**Tech Stack:** Node.js 24 CJS NocoBase host runtime (`2.2.38`), `@nocobase/server`, `@nocobase/database`, `@nocobase/client`, `@nocobase/client-v2`, React 18, Ant Design 5, host `@modelcontextprotocol/sdk`, built-in `node --test`.

**Spec:** [`docs/superpowers/specs/2026-11-21-dxos-ai-and-mcp-design.md`](../specs/2026-11-21-dxos-ai-and-mcp-design.md)

## Global Constraints
- All first-party `.js`, `.mjs`, `.cjs` files MUST start with the exact 8-line CTU-OpenPaw `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` header (`node scripts/source-headers.mjs --check`).
- Preserve NocoBase Clause 5.2 attribution and Apache-2.0 `sdkProvidedByHost: true`; do NOT bundle upstream source or add unverified external keys to `scripts/lib/nocobase-externals.mjs`.
- Never trust LLM-supplied `organizationId`, `role`, or `requesterId`; never let non-admin users access Builder tools or see `isAdminBuilder` employees; never let AI self-approve user-initiated records; never embed secrets/API keys in code or fixtures (`AGENT_API_KEY` read only from env at runtime).
- Keep `zod` optional in unit tests (`schema-helper.js` resolves `zod` lazily so `node --test` works without root `zod`, while passing real Zod schemas to `toolsManager` inside NocoBase 2.2.38).

## Review Focus
- **Builder privilege escalation:** Creating a custom `latticeAiProfiles` record with `dxos_compose_page_blocks` enabled and `allowedRoles: ["ldx_staff"]` MUST fail validation or force-lock `allowedRoles = ["root", "admin"]` and strip `ldx_*` roles from `aiEmployees`.
- **Workflow self-approval / cross-user task hijack:** `dxos_my_tasks_copilot` submit MUST reject `task.userId !== actor.userId` and MUST reject approving a record where `requesterId === actor.employeeId`.
- **SSRF / unsafe MCP URLs & secret leakage:** `validateMcpServerUrl` MUST reject `http://169.254.169.254/...`, `file://`, `https://user:pass@host`, and unauthenticated `/api/dxos-mcp` calls MUST return HTTP `401` + `WWW-Authenticate` without leaking stack traces; `sanitizeAuditSummary` MUST redact token/password/key fields.
- **Unauthenticated / degraded IT-OT failure:** When Orion-LD or n8n returns timeout/502/connection refused, IT/OT MCP tools and `buildEnterpriseTopology` MUST return structured `{ degraded: true, service, reason }` without throwing unhandled rejections.
- **Plugin-disabled UI safety:** `plugin-dxos-blocks` pages on portals MUST render cleanly without console/UI errors when `plugin-dxos-ai` is disabled (`404`/`403`/`501` on `dxosAi:portalCopilot`).

---

### Task 1: Package Skeleton, Schemas (`latticeAiProfiles`, `latticeAiAuditLogs`), Role-Lock & 2-Way Sync Engine
- **Files:** `plugins/nocobase/plugin-dxos-ai/{package.json,LICENSE,README.md,build.mjs,server.js,client.js,client-v2.js}`, `src/server/{ai-schemas.js,ai-sync.js,collections/ai-profiles.js,collections/ai-audit-logs.js,migrations/20261121000100-dxos-ai-workforce.js}`
- **Test:** `plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs`
- **Steps:**
  - [ ] Write failing tests covering `STARTER_AI_BLUEPRINTS`, `validateAiProfilePayload`, `validateMcpServerUrl`, `sanitizeAuditSummary`, `enforceProfileRoleLock`, and `syncProfileToNocobaseAi` (mock `db`).
  - [ ] Run `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs` → confirm RED.
  - [ ] Implement package files, schemas, migrations, and sync helpers cleanly.
  - [ ] Run test → confirm GREEN.
  - [ ] Commit Task 1 on `feat/dxos-ai-workforce-mcp`.

### Task 2: Unified Execution & Admin Builder Tools Core (`schema-helper.js`, `ai-tools-core.js`)
- **Files:** `plugins/nocobase/plugin-dxos-ai/src/server/{schema-helper.js,ai-tools-core.js}`
- **Test:** `plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs`
- **Steps:**
  - [ ] Write failing tests covering all 8 tools, `dryRun` previews, admin gates, org isolation, self-approval blocking, system-collection schema protection, and audit logging.
  - [ ] Verify RED via `node --test`.
  - [ ] Implement `schema-helper.js` and `ai-tools-core.js`.
  - [ ] Verify GREEN via `node --test`. Commit Task 2.

### Task 3: Two-Way Streamable HTTP MCP Gateway (`/api/dxos-mcp` & `/api/dxos-mcp/it-ot`) & 6-Plane Topology
- **Files:** `plugins/nocobase/plugin-dxos-ai/src/server/{mcp-itot-tools.js,mcp-gateway.js}`
- **Test:** `plugins/nocobase/plugin-dxos-ai/tests/mcp-gateway.test.cjs`
- **Steps:**
  - [ ] Write failing tests for unauthenticated `401`, `initialize`, `notifications/initialized`, dynamic role-filtered `tools/list`, `tools/call` allow/deny + schema error, `resources/list` + `resources/read`, Orion-LD/n8n timeout `degraded` fallback, SSRF check, and `buildEnterpriseTopology` 6 planes.
  - [ ] Verify RED → implement → verify GREEN. Commit Task 3.

### Task 4: `dxosAi` Resource, Admin AI Workforce Studio UI, 7-Plugin DX-OS Studio & Dynamic Block Copilot Strip
- **Files:** `plugins/nocobase/plugin-dxos-ai/src/server/{ai-resource.js,index.js}`, `plugins/nocobase/plugin-dxos-ai/src/client/{ai-studio-page.js,index.js}`, `plugins/nocobase/plugin-dxos-ai/src/client-v2/index.js`, `plugins/nocobase/plugin-dxos-blocks/src/client/{blocks-helpers.js,block-models.js}`, `plugins/nocobase/plugin-dxos-studio/src/{server/studio-resource.js,client/studio-settings.js}`
- **Tests:** `plugins/nocobase/plugin-dxos-ai/tests/ai-studio-client.test.cjs`, plus updates in `plugin-dxos-blocks/tests/*.test.cjs` and `plugin-dxos-studio/tests/*.test.cjs`.
- **Steps:**
  - [ ] Write failing tests for `dxosAi` resource endpoints (`portalCopilot` role filtering, `bootstrapDefaults`, `saveProfile`, `enterpriseTopology`, `auditLogs`), AI Studio UI state helpers, Dynamic Copilot Strip graceful fallback, and 7-plugin catalog.
  - [ ] Verify RED → implement → build all 3 plugins (`node plugins/nocobase/<name>/build.mjs`) → verify GREEN. Commit Task 4.

### Task 5: Workspace, Compose, Clean-Install, CI, PoF Docs & Setup/Acceptance Scripts
- **Files:** `infra/compose/{nocobase.yml,native-rehearsal.yml}`, `scripts/{install-workspace.mjs,native-clean-install.mjs,setup-dxos-ai-workforce.mjs,acceptance-dxos-ai-and-mcp.mjs}`, `scripts/tests/{dxos-ai-workforce.test.mjs,acceptance-dxos-ai-mcp.test.mjs,oss-pof-audit.test.mjs}`, `.github/workflows/ci.yml`, `package.json`, `README.md`, `CHANGELOG.md`, `COPYRIGHT.txt`, `NOTICE`, `docs/{DEMO_PACK.md,system-report-and-guide.md}`
- **Steps:**
  - [ ] Write TDD tests for `setup-dxos-ai-workforce.mjs` and `acceptance-dxos-ai-and-mcp.mjs` (RED → implement → GREEN).
  - [ ] Wire 7th plugin across Compose, scripts, CI, and PoF governance files.
  - [ ] Run `node scripts/source-headers.mjs --check`, `pnpm pof:check`, `node --test`, `pnpm check`. Commit Task 5.

### Task 6: Live Docker Deployment (`localhost:13014`), Full E2E Acceptance & Release Archive Verification
- **Steps:**
  - [ ] Ensure Docker daemon task + 7 containers running (`localhost:13014` HTTP `200`).
  - [ ] Deploy updated `plugin-dxos-blocks`, `plugin-dxos-studio`, and new `plugin-dxos-ai` into running NocoBase container, enable `@latticedx/plugin-dxos-ai`, run `yarn nocobase upgrade`, restart container.
  - [ ] Execute live `pnpm setup:dxos-ai -- --origin=http://localhost:13014`, `pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014`, and `pnpm acceptance:logistics-rbac -- --origin=http://localhost:13014`.
  - [ ] Record exact verified output in `docs/dxos-ai-and-mcp-acceptance.md`.
  - [ ] Re-run final repo checks (`source-headers`, `pnpm pof:check`, `node --test`, `pnpm check`, `pnpm release:tarball`), verify zero forbidden entries, commit docs, and deliver final report.

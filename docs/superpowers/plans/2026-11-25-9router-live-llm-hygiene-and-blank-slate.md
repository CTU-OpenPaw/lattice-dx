# 9router Real-LLM E2E, Hygiene Patch & True Blank-Slate Volume Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Option A — Native Inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove real end-to-end Vietnamese natural-language app building via live `9router` LLM tool-calling, resolve all 10 non-blocking Minor findings from whole-branch review, verify true blank-slate clean-install (`LATTICE_SKIP_DEMO_SEED=1`) on an empty PostgreSQL volume, and re-verify all 8 OLP 2026 gates.

**Architecture:** Stay cleanly inside `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (`feat/v1.0.0-olp-championship`) preserving the exact 7 NocoBase plugins (`sdkProvidedByHost: true`) and never modifying `e:\pmnm2026`. Upgrade the MCP tool schema & `dxos-architect` prompt so real LLMs reliably emit valid Multi-Entity blueprints, add a live `/chat/completions` probe mode (`verifyCompletion: true`), apply the 10-item hygiene patch (upgrade role sync migration, teardown ordering, DAG `toObj`, frontend guards), and execute live `9router` E2E + empty-volume clean-install verification.

**Tech Stack:** Node.js 20+ (CommonJS + ESM scripts), React 18, PostgreSQL (`FORCE ROW LEVEL SECURITY`), NocoBase v2 FlowEngine, Docker Compose, `9router` OpenAI-compatible gateway, Playwright, `node:test`, `vitest`.

**Spec & Context:**
- `docs/superpowers/plans/2026-11-25-workflow-ux-and-blank-slate-app-builder.md`
- Whole-branch review findings (`10` triaged Minor issues)

## Global Constraints
- Work ONLY in `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (`feat/v1.0.0-olp-championship`).
- NEVER modify `e:\pmnm2026`.
- Keep exact **7 plugins** under `plugins/nocobase/` with `sdkProvidedByHost: true`.
- Preserve Apache-2.0 CTU-OpenPaw SPDX headers on every new/modified `.js`/`.mjs` file.
- Never print raw API keys or tokens from `9router` or `llmServices`.
- Leave the 8-container live Docker stack (`:13015`) + `9router` (`:20128`) running and healthy at the end.

---

### Task 1: Strict Nested LLM Tool Schema, `dxos-architect` Prompt Upgrade, Alias Tolerance & `verifyCompletion` Probe
- **Files:** `plugins/nocobase/plugin-dxos-ai/src/server/ai-tools-core.js`, `ai-schemas.js`, `app-builder-orchestrator.js`, `ai-resource.js`, tests.
- [ ] Add nested `items.properties` schema on `dxos_provision_role_workspace` (`collections`, `roles`, `portals`, `dmnTables`, `flowGraphs`).
- [ ] Update `dxos-architect` `systemPrompt` and `quickPrompts` with concise multi-entity `collections[]` (`belongsTo`/`hasMany`), dynamic Kanban/WebGIS binding, and built-app lifecycle (`list_built_apps`, `rebuild_enterprise_app`, `export_app_bundle`, `teardown_built_app`) instructions.
- [ ] Normalize harmless LLM aliases (`name -> collectionName`, `targetCollection -> target`, `enumValues -> enum`, `slug -> portalSlug`) before strict security/cycle guards in `app-builder-orchestrator.js`.
- [ ] Support optional `verifyCompletion: true` 1-token completion ping in `probeLlmHealth` / `checkLlmHealth` / `quickConnectLlm`, plus Docker container default `host.docker.internal:20128/v1` for `9router`.
- [ ] Add regression tests & pass `node --test plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs`.

### Task 2: Backend & DB Upgrade Hygiene Patch (Minor #4, #9, #10)
- **Files:** `plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261129000100-sync-role-presets.js` (new), `app-builder-orchestrator.js`, `solution-bundle.js`, tests.
- [ ] Create idempotent `afterSync` migration `20261129000100-sync-role-presets.js` running `installRolePresets(db)` so pre-existing DBs receive `ldx_operator`.
- [ ] Update `teardownBuiltApp` so `uiManageable: false` persistence & `resRepo`/`fieldsRepo`/`colsRepo` metadata destruction run before `DROP TABLE IF EXISTS` without swallowing update errors.
- [ ] Update `toObj` in `solution-bundle.js` with `try { ... } finally { visited.delete(row); }` and prototype-key filtering (`__proto__`, `constructor`, `prototype`).
- [ ] Add unit tests & pass targeted `node --test`.

### Task 3: Frontend UX & Auth Hygiene Patch (Minor #1, #2, #3, #5, #6, #7, #8)
- **Files:** `ai-studio-page.js`, `portal-agent-launcher.js`, `blocks-helpers.js`, `webgis-block.js`, `node-inspector.js`, `flow-studio-app.js`, `flow-pin-storage.js`, tests.
- [ ] Tighten `handleVerifyBuiltApp` (`ver.ok === true`) & `loadBuiltApps` deps; opt `handleCheckLlmHealth` into `verifyCompletion: true`.
- [ ] Gate `portalAgents` fetch on `resolveClientAuthToken(api)`, cancel `activeReader` in `portal-agent-launcher.js` SSE teardown, and handle external `latticedx:ai-chat-opening` without loops.
- [ ] Tighten `lat`/`lng` fallback regexes in `blocks-helpers.js` and reset `filterMode` on collection switch in `webgis-block.js`.
- [ ] Reset/advance `cursorRef` on JSON/raw insert in `node-inspector.js`, pop redundant `undo` entry in `handleUndoSseDiff`, and fall back to bare `localStorage` in `flow-pin-storage.js`.
- [ ] Add regression tests & pass `node --test plugins/nocobase/*/tests/*.test.cjs`.

### Task 4: Restart Live Stack (`9router` + Docker), Deploy Updates & Real-LLM E2E via `9router`
- **Files:** `scripts/acceptance-live-llm-app-builder.mjs` (new), `scripts/tests/acceptance-live-llm-app-builder.test.mjs` (new).
- [ ] Start `9router` (`:20128`) and Docker keepalive + 8-container stack (`:13015`).
- [ ] Build & deploy updated plugins into `lattice-v100-e2e-nocobase-1`, run upgrade/bootstrap, and drop pre-`5b99a7e` orphaned dev table `latticeCustomAccVendorsTJQFC`.
- [ ] Implement & execute live `9router` model discovery -> `quickConnectLlm` -> multi-turn Vietnamese prompt -> real LLM `dxos_provision_role_workspace` tool call -> verify/Kanban/rebuild v2/export v3/teardown + headless Playwright smoke (handing back if all `9router` upstream models fail).

### Task 5: True Blank-Slate Clean-Install Volume Verification (`LATTICE_SKIP_DEMO_SEED=1`)
- **Files:** `scripts/native-clean-install.mjs`, `scripts/tests/` test.
- [ ] Add `--blank-slate` (`LATTICE_SKIP_DEMO_SEED=1`) & `--keep` flags + blank-slate API/PG RLS/app-lifecycle assertions + disposable cleanup.
- [ ] Execute `node scripts/native-clean-install.mjs --blank-slate --port=13016` and confirm `PASS` and zero leftover disposable containers/volumes.

### Task 6: Final 8-Gate OLP 2026 Verification & Handover
- [ ] Re-verify all 8 gates on final `HEAD` and confirm all 4 live endpoints remain HTTP `200`.

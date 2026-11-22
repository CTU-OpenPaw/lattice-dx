<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX Open-Core 6-Plugin Suite & PoF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task following TDD.

**Goal:** Expand LatticeDX into a complete 6-plugin Apache-2.0 Open-Core DX-OS platform (H–P–D–I) configurable directly from NocoBase 2.2.38 UI, complete NukeViet-grade PoF compliance, and verify end-to-end via clean install and simulated admin usability testing.

**Architecture:** Keep the 3 existing plugins and legacy blocks untouched; add `@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-blocks`, and `@latticedx/plugin-dxos-studio`; wire all 6 plugins into Compose, workspace installer, clean install, multi-portal demo, CI, and `pnpm pof:check`.

**Tech Stack:** NocoBase `2.2.38`, PostgreSQL `16.13`, React 18, Ant Design 5, Node 24 (`node --test`), pnpm `10.23.0`, Vitest, Docker Desktop (`desktop-linux`).

**Spec:** `docs/superpowers/specs/2026-11-20-nocobase-dxos-plugin-suite-design.md`

---

### Task 0: Branch Setup, Spec & Plan Commit
- [ ] Branch `feat/dxos-plugin-suite-and-pof` from `integration/v0.1.0` (`935040e`).
- [ ] Commit spec + plan.

### Task 1: `@latticedx/plugin-dxos-para` (`[H]` P.A.R.A. Knowledge & Document Space)
- [ ] Write failing `plugins/nocobase/plugin-dxos-para/tests/para-space.test.cjs` covering collection schema (`uiManageable: true`), enum/URL validation, org/owner middleware isolation, 7-role ACL grants idempotency, and `latticePara:summary`.
- [ ] Implement `package.json`, `LICENSE`, `README.md`, `server.js`, `client.js`, `client-v2.js`, `build.mjs`, `src/server/{schema,para-roles,para-scope,para-resource,index}.js`, `src/server/migrations/20261120000100-dxos-para-init.js`, `src/client/index.js`, `src/client-v2/index.js`.
- [ ] Build & verify `node --test plugins/nocobase/plugin-dxos-para/tests/para-space.test.cjs` passes (`0` fail). Commit.

### Task 2: `@latticedx/plugin-dxos-blocks` (`[H][P][D][I]` 6 Configurable Native v2 BlockModels + 2 Org-Scoped APIs)
- [ ] Write failing server & client tests (`dxos-blocks-server.test.cjs`, `dxos-blocks-client.test.cjs`) covering `dxosBlocks:proposals`, `dxosBlocks:contextTelemetry`, all 6 `Dxos*BlockModel` registrations + `dxosBlockSettings` flows, `workflowManualTasks:listMine`, safe relative link filtering, and graceful degradation when `plugin-dxos-para` is disabled.
- [ ] Implement server & client modules + single-bundle `build.mjs` + `LICENSE` + `README.md`.
- [ ] Build & verify `node --test plugins/nocobase/plugin-dxos-blocks/tests/*.test.cjs` passes (`0` fail). Commit.

### Task 3: `@latticedx/plugin-dxos-studio` (`[P][H][D]` Admin Control Studio, 4 Poka-yoke Workflows, Composer & Second Domain `latticeServiceTickets`)
- [ ] Write failing tests (`workflow-templates.test.cjs`, `studio-resource.test.cjs`, `studio-client.test.cjs`) covering all 4 templates (incl. `logistics-5step` & `internal-service`), admin gating (`403` for non-admin), idempotent duplicate detection, non-destructive `composePortals` + `plugin-dxos-blocks` fallback, `latticeServiceTickets` org/ACL isolation, and Settings UI tabs.
- [ ] Implement server, migrations (`20261120000200-dxos-service-tickets.js`), client settings UI (`/admin/settings/dxos-studio`), `build.mjs`, `LICENSE`, `README.md`.
- [ ] Build & verify `node --test plugins/nocobase/plugin-dxos-studio/tests/*.test.cjs` passes (`0` fail). Commit.

### Task 4: Infrastructure, Installer, Clean-Install, Multi-Portal Demo & CI Integration
- [ ] Update `tests/workspace-install.test.ts`, `tests/native-clean-install.test.ts`, `scripts/tests/native-multi-portal-demo.test.mjs` for 6-plugin wiring, P.A.R.A./Service Tickets portal pages, and `dxosStudio:composePortals` fallback.
- [ ] Update `infra/compose/nocobase.yml`, `infra/compose/native-rehearsal.yml`, `scripts/install-workspace.mjs`, `scripts/native-clean-install.mjs`, `scripts/lib/multi-portal-demo-catalog.mjs`, `scripts/setup-native-multi-portal-demo.mjs`, `.github/workflows/ci.yml`.
- [ ] Run `pnpm check` & `node --test` over all 6 plugins + scripts. Commit.

### Task 5: NukeViet-Grade PoF Compliance & Clean Non-Git Tarball Rehearsal
- [ ] Update `scripts/tests/oss-pof-audit.test.mjs` for `COPYRIGHT.txt`, per-plugin `README.md`, and 6-plugin PoF rules.
- [ ] Create `COPYRIGHT.txt` and `docs/DEMO_PACK.md`, upgrade `scripts/source-headers.mjs` + `scripts/verify-pof-readiness.mjs`, normalize first-party copyright/SPDX headers, rewrite `README.md`, update `NOTICE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/*`.
- [ ] Verify `pnpm pof:check`, `node scripts/source-headers.mjs --check`, `pnpm check`, `node --test` across all 6 plugins + scripts, and full non-Git extracted tarball rehearsal (`pnpm install --frozen-lockfile`, `pnpm pof:check`, `pnpm check`). Commit.

### Task 6: Live Clean Install (`pnpm native:clean`) + Simulated Admin Usability E2E + Push & PR
- [ ] Run `pnpm native:clean --port=13014`, `setup-native-multi-portal-demo.mjs`, and `setup-native-workspace-demo.mjs`.
- [ ] Run live browser E2E (`browser` subagent) simulating an Admin opening `/admin/settings/dxos-studio`, installing workflows, composing portals, opening `Add block` -> adding & customizing DX-OS blocks -> hard reload persistence, verifying P.A.R.A./Services, and verifying employee ACL isolation. Fix any real bugs found.
- [ ] Push `feat/dxos-plugin-suite-and-pof`, open PR to `integration/v0.1.0`, watch CI green. Report results concisely in Vietnamese.

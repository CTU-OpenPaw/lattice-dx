<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Visual Automation Studio & AI Automation Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [x]`/`- [ ]`) tracking.

**Goal:** Upgrade Tab 8 Automation Builder into a 3-pane SVG branching Visual Flow Studio backed by dynamic metadata, dry-run live trace highlighting, 3 editable enterprise blueprints, and integrated full/node/suggest AI Copilot across Studio UI and the 17-tool MCP Agent.

**Architecture:** `automation-copilot.js` supplies the event catalog, 3 enterprise blueprints, live tenant metadata catalog builder, and deterministic-plus-context AI Copilot (`full`, `node`, `suggest`). `automation-engine.js` adds per-step `when` branching, `steps.<idx>` output interpolation, dry-run branch evaluation, and `builderCatalog` + `aiAssist` endpoints. `automation-studio-panel.js` renders the React + inline SVG branching canvas, per-action structured inspectors, and embedded AI Copilot while keeping all legacy `data-testid` hooks and zero new dependencies. `@latticedx/plugin-dxos-ai` extends `dxos_configure_workflow` (still 17 tools) and the Vietnamese NL router/eval suite.

**Tech Stack:** NocoBase `2.2.50`, Node.js CJS/ESM, React + inline SVG (`sdkProvidedByHost: true`), PostgreSQL RLS, Docker Compose.

**Spec:** [2026-11-24-visual-automation-builder-and-ai-copilot-design.md](../specs/2026-11-24-visual-automation-builder-and-ai-copilot-design.md)

## Global Constraints
- Worktree ONLY: `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (`feat/v1.0.0-olp-championship`). Never edit `e:\pmnm2026` or `upstream/nocobase`.
- Keep version `1.0.0` and ZERO new runtime npm deps in the 7 plugins (`sdkProvidedByHost: true`).
- Client bundling (`plugins/nocobase/plugin-dxos-studio/build.mjs`): never call `require('react')`/`require('antd')` or non-relative `require(...)` inside client modules.
- Preserve `adminMcpToolsListed17 === 17` (extend `dxos_configure_workflow` only), CTU-OpenPaw SPDX headers, NocoBase Clause 5.2 attribution, and stop before `git push`/PR/merge/release.

## Review Focus
1. Template/prototype injection in `action.when` and `aiAssist` prompts (`__proto__`, `constructor`, `prototype`, `process.env`, malformed regex/paths) -> pinned in `automation-engine.test.cjs`.
2. Secret exfiltration via `dxosAutomations:builderCatalog` or `dxosAutomations:aiAssist` (`encryptedSecretsJson` or raw connector tokens must NEVER leave server) -> pinned in `automation-engine.test.cjs` & `acceptance-broker-automation-builder.mjs`.
3. Non-admin (`ldx_employee`) or low-privilege PAT attempting `aiAssist`, `draftAutomation`, `patchAutomation`, `testAutomation` -> fail-closed 403 -> pinned in `ai-builder-tools.test.cjs`, `vietnamese-nl-eval.test.cjs`, & live acceptance.
4. Client bundler failure (`build.mjs` rejecting external `require(...)`) or missing `builderCatalog` in legacy UI test harness -> silent fallback & build test in `builder-broker-ui.test.cjs` + `pnpm -r build`.
5. Silent overwrite of `filterJson`/`cooldownSec`/`maxDepth` or regression on existing 64 Vietnamese NL cases / 17 MCP tool count -> verified via `eval-vietnamese-nl-agent.mjs` and `acceptance-dxos-ai-and-mcp.mjs`.

---

## Tasks
- [x] **Step 0**: Write design spec + implementation plan and commit (`docs(automation)`).
- [ ] **Wave 1 (3 Parallel `self` Subagents, zero file overlap)**:
  - **W1-A**: `automation-copilot.js`, `automation-engine.js`, `domain-builder.js`, `automation-engine.test.cjs`, `domain-builder.test.cjs`.
  - **W1-B**: `automation-studio-panel.js`, `builder-broker-panels.js`, `builder-broker-ui.test.cjs`.
  - **W1-C**: `ai-builder-tools.js`, `ai-nl-router.js`, `ai-schemas.js`, `eval-vietnamese-nl-agent.mjs`, `ai-builder-tools.test.cjs`, `vietnamese-nl-eval.test.cjs`.
- [ ] **Wave 2**: Update `seed-v100-championship-showcase.mjs` (3 flagship rules + idempotent initial live run so `/p/cmms` & Tab 8 are rich out-of-the-box) and `acceptance-broker-automation-builder.mjs` (verify `builderCatalog`, `when` branching in `testRule`, `aiAssist`, and `403` for employee); verify `source-headers`, `sbom`, `pof:check`.
- [ ] **Wave 3**: Fresh `self` whole-delta code & security reviewer on `git diff 029539a..HEAD`; fix & re-test any findings.
- [ ] **Wave 4**: Workspace build, pack `@latticedx/plugin-dxos-studio@1.0.0` & `@latticedx/plugin-dxos-ai@1.0.0`, reload Docker `2.2.50` (`lattice-v100-e2e`), double idempotent seed, run all 4 live acceptance suites, verify Tab 8 Visual Studio + AI Copilot + `/p/cmms` in Playwright (`feda1b56-2161-4427-9092-bc4a0000a2a0`).
- [ ] **Wave 5**: Full offline gate on final HEAD (`pnpm check`, `node --test`, `eval-vietnamese-nl-agent`, `release:sbom -- --check`, `pof:check`, `source-headers --check`, `pnpm audit`) and confirm clean `git status --short`; stop before push/PR/release.

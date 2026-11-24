# Workflow Automation Studio UX Redesign & Native Agent Chat Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task cleanly in parallel disjoint scopes inside `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof`.

**Goal:** Nest LatticeFlow v2 cleanly under NocoBase's left-sidebar **Workflow -> Workflow Automation** (`workflow.automation`), eliminate the duplicate `ArchitectDrawer` in favor of unified native NocoBase **Agent Chat (`dxos-architect`)** with live SSE canvas sync, and upgrade the Studio UI into a modern two-screen Precision Operational Studio (`List View` -> `100% Canvas-First Editor` with progressive disclosure and n8n/Broker quick links).

**Spec:** [2026-11-24-workflow-automation-ux-and-agent-chat-design.md](../specs/2026-11-24-workflow-automation-ux-and-agent-chat-design.md)

## Global Constraints
- Work strictly inside `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (`feat/v1.0.0-olp-championship`); never touch `e:\pmnm2026`.
- Every `.js` module under `plugins/nocobase/plugin-dxos-studio/src/client/flow/` and `src/server/flow/` MUST remain `<= 350` lines (`split('\n').length`) and preserve CTU-OpenPaw `SPDX-License-Identifier: Apache-2.0` headers.
- Zero `"copilot"` matches repo-wide outside `docs/superpowers/`.
- Preserve `adminMcpToolsListed17 === 17` and NocoBase Clause 5.2 attribution (`sdkProvidedByHost: true`).

## Review Focus
1. **Menu & Alias Compatibility:** Confirm `workflow.automation` renders cleanly inside live NocoBase `2.2.50`'s `Workflow` settings group AND `/admin/settings/dxos-flow-studio` alias route continues opening the Studio without broken links.
2. **Tenant Isolation on Live SSE Sync:** Ensure `latticedx:flow-updated` events carrying a different `organizationId` are silently ignored so cross-tenant state never leaks onto the canvas.
3. **Secret & HITL Token Redaction on Broadcast:** Ensure `publishFlowStudioUpdate` strips `resumeToken`, `resumeTokenHash`, API keys, and vault secrets before publishing over `dxosAi:surfaceEvents`.
4. **Native Agent Chat Lifecycle Without Canvas Blocking:** Confirm opening `✦ AI Architect` calls `aiCtx.triggerTask` with current `flowContext` (or falls back gracefully if headless/unavailable), while deleting `architect-drawer.js` leaves zero dangling imports in `flow-studio-app.js` or `build.mjs`.
5. **Line Budget & React Test Parity:** Keep `flow-list-view.js <= 280`, `flow-canvas.js <= 350`, `node-palette.js <= 240`, `node-inspector.js <= 345`, `playback-bar.js <= 260`, and `flow-studio-app.js <= 350` lines while migrating all Flow Studio unit tests in `flow-ui-studio.test.cjs` cleanly to List View -> Editor navigation.

---

### Task 1 (`B1`): Native Agent Chat Context & Realtime `flow-studio` SSE Sync (`plugin-dxos-ai`)
**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-builder-tools.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/client/portal-agent-launcher.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`, `ai-builder-tools.test.cjs`

**Interfaces:**
- Produces: SSE channel `portalSlug='flow-studio'` emitting `{ revision, type: 'flow-updated', organizationId, operation, ruleKey, applied, draftRule?, draftGraph?, simulation?, run?, message }` and `window.dispatchEvent(new CustomEvent('latticedx:flow-updated', { detail }))`; `readFlowStudioContext()` reading sanitized `window.__LATTICEDX_FLOW_CONTEXT__`.

- [ ] Emit sanitized `publishFlowStudioUpdate` notifications from `runDraftAutomation`, `runPatchAutomation`, `runSaveAutomation`, `runTestAutomation`, `runAutomationExecution`, and `runResumeAutomation` in `ai-builder-tools.js` using monotonic revisions and zero secret/token fields.
- [ ] Extend `portal-agent-launcher.js` with `isFlowStudioPath`, `readFlowStudioContext`, `flowContext` injection into `buildHiddenPageSystemContext`, SSE subscription for `flow-studio` dispatching `latticedx:flow-updated` (suppressing portal reload banners on studio paths), and bottom-right launcher visibility on `/admin/settings/workflow/automation` & `/admin/settings/dxos-flow-studio`.
- [ ] Add unit/integration tests verifying SSE emission/redaction, `readFlowStudioContext()`, context injection, and `latticedx:flow-updated` dispatch; build `@latticedx/plugin-dxos-ai` and pass all `plugin-dxos-ai/tests/*.test.cjs`.

### Task 2 (`B2`): Workflow Menu Integration & Precision Operational Studio UI (`plugin-dxos-studio`)
**Files:**
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/index.js`, `studio-settings.js`, `builder-broker-panels.js`, `src/server/flow/blueprints/partner-webhook-sync.json`
- Delete: `plugins/nocobase/plugin-dxos-studio/src/client/flow/architect-drawer.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-list-view.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-canvas.js`, `node-palette.js`, `node-inspector.js`, `playback-bar.js`, `flow-studio-app.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`, `builder-broker-ui.test.cjs`, `flow-build-bundle.test.cjs`

- [ ] Register `'workflow.automation'` under NocoBase `Workflow`, preserve backward-compatible alias route `/admin/settings/dxos-flow-studio`, support `?tab=` deep linking (`automation`, `broker`) in `studio-settings.js`, and point internal links to `/admin/settings/workflow/automation`.
- [ ] Build `flow-list-view.js` (`<= 280` lines) with search, status filter tabs, 6-blueprint gallery toggle, 1-click **`Connectors / n8n ↗`** and **`Broker ↗`** buttons, and clean workflow list cards.
- [ ] Upgrade `flow-canvas.js` (Live Config Preview cards, Contextual Mini-Toolbar on selected node, centered Floating Bottom Dock with Fit/Zoom/Auto-Layout/Undo/Redo/Map toggle, `fitViewOptions: { padding: 0.24, maxZoom: 1 }`), `node-palette.js` (collapsible floating drawer + Quick-Add mode), `node-inspector.js` (contextual floating overlay hidden unless node selected + collapsible `Nâng cao` section), `playback-bar.js` (collapsible 38px trace bar + persistent HITL banner when suspended), and `flow-studio-app.js` (List <-> Editor state, Settings Popover, `✦ AI Architect` -> native `triggerTask`, `window.__LATTICEDX_FLOW_CONTEXT__` + `latticedx:flow-updated` live sync, zero `ArchitectDrawer` imports).
- [ ] Update Studio tests, rebuild `@latticedx/plugin-dxos-studio`, verify every `src/client/flow/*.js` file is `<= 350` lines, and pass all Studio tests.

### Task 3 (Wave C): Documentation Sync & Full Offline Release Gates
- [ ] Update stale `dxos-flow-studio` / `ArchitectDrawer` mentions in `README.md`, `CHANGELOG.md`, `docs/FINALS_15MIN_SCRIPT.md`, `docs/olp-2026-architecture-matrix.md`, `docs/system-report-and-guide.md`, `docs/third-party.md`.
- [ ] Run `git grep -in "copilot"`, `pnpm check`, full `-Recurse` `node --test`, `eval-vietnamese-nl-agent.mjs --min-pass=95`, `pnpm release:sbom -- --check`, `pnpm pof:check`, `node scripts/source-headers.mjs --check`, and create clean atomic commits.

### Task 4 (Wave D): Live NocoBase `2.2.50` Verification & 1440x900 Showcase Video
- [ ] Boot disposable `lattice-v100-e2e` Docker stack, enable plugins, run `nocobase upgrade` + seeders, verify live **`Workflow -> Workflow Automation`** navigation & native Agent Chat trigger in Chromium, record `1440x900` E2E showcase video `workflow-automation-v2-demo.mp4`, inspect 6 extracted keyframes, and cleanly tear down Docker stack.

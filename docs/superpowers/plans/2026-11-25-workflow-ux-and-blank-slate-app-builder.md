# Workflow UX & Blank-Slate Multi-Entity App Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end Workflow & Automation Studio UX fixes, authenticated SSE + LLM error surfacing, dynamic `latticeCustom*` parity across Kanban/WebGIS/RecordWorkbench/Chatter, zero-config blank-slate AI onboarding with BYO LLM Key Quick-Connect, and a Multi-Entity Topological App Builder + `latticeBuiltApps` Rebuild/Export/Teardown engine.

**Architecture:** All changes stay cleanly inside the existing **7 LatticeDX NocoBase plugins** (`plugin-lattice-foundation`, `plugin-dxos-blocks`, `plugin-dxos-studio`, `plugin-dxos-ai`, `plugin-dxos-para`, `plugin-enterprise-auth`, `action-bridge`) using cross-plugin module resolution (`loadCrossPluginModule`) and REST API contracts (`dxosBlocks:*`, `dxosAutomations:*`, `dxosAi:*`). Client UI modules follow each plugin's bundler rules (relative `require('./...')` only, zero `React.useRef`, Apache-2.0 SPDX headers), while multi-entity schemas and the `latticeBuiltApps` registry enforce PostgreSQL `FORCE ROW LEVEL SECURITY` and deterministic topological validation before touching DB state.

**Tech Stack:** Node.js 20+ (CommonJS + ESM scripts), React 18 (`React.createElement` without JSX in plugin client code), `@xyflow/react`, NocoBase v2 FlowEngine (`BlockModel` / `pluginSettingsManager`), PostgreSQL (`FORCE ROW LEVEL SECURITY`), `node:test`, `vitest`, `esbuild`, Playwright.

**Spec:**
- `docs/superpowers/specs/2026-11-24-workflow-automation-ux-and-agent-chat-design.md`
- `docs/superpowers/specs/2026-11-24-workflow-studio-round2-ux-audit.md`
- `docs/superpowers/specs/2026-11-23-v100-builder-broker-automation-design.md`
- Approved 4-Wave / 11-Task Master Plan (`ORIGINAL_REQUEST.md`)

## Global Constraints

- Active Worktree: `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (branch `feat/v1.0.0-olp-championship`); NEVER modify `e:\pmnm2026`.
- Keep the existing **7 plugin** architecture intact for teammate compatibility (do NOT split into an 8th plugin).
- Preserve Apache-2.0 source headers (`node scripts/source-headers.mjs --check`), `sdkProvidedByHost: true`, zero `copilot` branding outside `docs/superpowers/*`.
- Maintain PostgreSQL `FORCE ROW LEVEL SECURITY` on every new tenant table (`latticeBuiltApps`).
- Zero regression across all 8 OLP 2026 verification gates (`pnpm check`, `node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs tests/nocobase-externals.test.mjs`, `node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95`, `pnpm pof:check`, `pnpm release:sbom -- --check`, `pnpm audit --prod --audit-level=low`, `node scripts/source-headers.mjs --check`).
- Live Stack already running (DO NOT tear down): Docker Compose `C:\Users\Truong Duy\.gemini\antigravity\brain\d2637698-9547-4913-a4ec-c8cf74fdf31d\scratch\v100-live-n8n-e2e.yml` (`nocobase:13015`, `n8n:5678`, `orion-ld:1026`, `mosquitto`, `nodered`, `nocobase-db`, `orion-mongo`, `redis`) + `9router` on `127.0.0.1:20128`. When rebuilding plugins for live browser verification, build all affected plugins, pack & re-install/upgrade into `lattice-v100-e2e-nocobase-1` (`npm ci --prefix plugins/nocobase/plugin-enterprise-auth --ignore-scripts --no-audit --no-fund` if packing enterprise-auth).

## Review Focus

1. **Unauthenticated pages (`NOCOBASE_TOKEN` empty):** must NOT open SSE `/api/dxosAi:surfaceEvents` causing console `401 EMPTY_TOKEN` spam. *(Pinned in Task 4)*
2. **Unsaved draft (`● Chưa lưu`) on Flow Canvas:** inserting `{ } Variables` into JSON fields must NOT corrupt JSON syntax; `← Danh sách` must warn before losing changes; `⚡ Chạy ngay` must auto-save or guard against `404 RULE_NOT_FOUND` / stale DB execution; `+ Tạo luồng mới` must clear prior rule's run traces from `PlaybackBar`. *(Pinned in Task 1 & Task 2)*
3. **Kanban / WebGIS / RecordWorkbench / Chatter pointed at dynamic `latticeCustom*` collections (even without `lat`/`lng` or with custom `status` enum values):** must render dynamically from metadata instead of falling back to `latticeOrders` or crashing. *(Pinned in Task 5, Task 6, & Task 7)*
4. **Fresh install (`0` LLM services or upstream `502`/`503`):** `dxos-architect` must auto-bootstrap on plugin `install`/`afterEnable`, Quick-Connect binds any user-entered API key cleanly, and `502`/`503` LLM errors surface clearly in chat UI instead of hanging `"is thinking..."`. *(Pinned in Task 4, Task 8, & Task 9)*
5. **Multi-Entity Blueprint cycles (`A -> B -> A`) or `SYSTEM_PROTECTED_COLLECTIONS` targets:** rejected at validation (`400`/`403`) before touching DB, preserving pre-build snapshot. *(Pinned in Task 10)*

---

## Wave 1 (P0) — Workflow & Automation Studio UX + SSE + AI Chat Error Fixes

### Task 1: Rule Lifecycle, Connectors Route, Unsaved Guards & 1280px Toolbar

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-list-view.js:95-190`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js:215-315`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-helpers.js:40-90,195-203`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs:225-239,360-362,1247-1258,1531`

**Interfaces:**
- Consumes: `dxosAutomations:deleteRule` (`POST { organizationId, ruleKey } -> { deleted: true, ruleKey }`), `dxosAutomations:toggleRule` (`POST { organizationId, ruleKey, active } -> { rule }`), `dxosAutomations:saveRule`, `dxosAutomations:runNow`.
- Produces:
  - `FlowListView` prop `onDeleteRule(rule)` + UI button `data-testid="dxos-flow-delete-rule-${ruleKey}"` with confirmation bar `dxos-flow-delete-confirm-${ruleKey}` (`Confirm` / `Cancel`).
  - `dxos-flow-goto-vault-btn` navigating to `'/admin/settings/workflow/connectors'`.
  - Unsaved guard overlay `data-testid="dxos-flow-unsaved-guard"` (`dxos-flow-guard-save-btn`, `dxos-flow-guard-discard-btn`, `dxos-flow-guard-cancel-btn`) triggered by `← Danh sách` when `doc.dirty === true`.
  - `handleRunNow()` auto-saving dirty drafts (`doc.dirty === true`) via `dxosAutomations:saveRule` before invoking `dxosAutomations:runNow` (aborting cleanly on empty `ruleKey`/`name` or save error).
  - `handleNewFlow()` resetting `data.runs` so `PlaybackBar` starts empty for unsaved new flows.
  - Note on `tests/flow-ui-studio.test.cjs:223-239`: keep `src/client/flow/` at **13 files** and keep pure helper logic in `flow-studio-helpers.js`; if any file exceeds its current cap (`flow-studio-app.js` 345, `flow-list-view.js` 280, `flow-studio-helpers.js` 220), keep helper extraction tight or adjust the numeric budget in `tests/flow-ui-studio.test.cjs:225-239` transparently.

- [ ] **Step 1: Write the failing tests (including Review Focus #2 guards)**

Add tests to `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs` and update the two obsolete assertions at lines `360-362` and `1247-1251`:

```js
// Update line 362:
assert.deepEqual(navigated, ['/admin/settings/workflow/connectors', '/admin/settings/dxos-studio?tab=broker']);

// Update lines 1247-1251:
await collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-toggle-active-${rules[0].ruleKey}`)[0].props.onClick();
tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
const toggleReq = requests.find((r) => r.url === 'dxosAutomations:toggleRule');
assert.ok(toggleReq);
assert.equal(toggleReq.data.ruleKey, rules[0].ruleKey);
assert.equal(toggleReq.data.active, false);

// New test at end of tests/flow-ui-studio.test.cjs:
test('Task 1: deleteRule, unsaved back guard, dirty Run Now auto-save, New Flow clears runs, and 1280px wrap toolbar', async () => {
  // 1. Delete rule flow: click dxos-flow-delete-rule-<key> -> confirm -> POST dxosAutomations:deleteRule
  // 2. Open rule, edit label so doc.dirty === true:
  //    - Click dxos-flow-back-to-list-btn -> stays in editor and renders dxos-flow-unsaved-guard
  //    - Click dxos-flow-guard-cancel-btn -> closes guard, keeps editor dirty
  //    - Click dxos-flow-back-to-list-btn -> click dxos-flow-guard-discard-btn -> returns to dxos-flow-list-view
  // 3. Create + Tạo luồng mới (dxos-flow-new-btn):
  //    - Verify PlaybackBar receives runs=[] (zero traces from prior rule)
  //    - Set ruleKey/name and click dxos-flow-run-now-btn while dirty -> asserts dxosAutomations:saveRule fires BEFORE dxosAutomations:runNow
  //    - Verify dxos-flow-toolbar style.flexWrap === 'wrap' (no horizontal clipping at 1280px)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`
Expected: FAIL on missing `dxos-flow-delete-rule-*`, old `/admin/settings/dxos-studio?tab=automation` route, `dxosAutomations:toggleRule` not called, and missing `dxos-flow-unsaved-guard`.

- [ ] **Step 3: Implement `flow-list-view.js`, `flow-studio-helpers.js`, and `flow-studio-app.js`**

1. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-helpers.js`:
   - Update `ROW` (`line 45`) to `{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }` so toolbar groups wrap cleanly at `1280px`.
   - Export `renderUnsavedGuardBar(h, { ruleKey, busy, onSaveAndBack, onDiscard, onCancel })` rendering `data-testid="dxos-flow-unsaved-guard"` with `dxos-flow-guard-save-btn`, `dxos-flow-guard-discard-btn`, `dxos-flow-guard-cancel-btn`.
2. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-list-view.js`:
   - Line `110`: change `onOpenRoute?.('/admin/settings/dxos-studio?tab=automation')` to `onOpenRoute?.('/admin/settings/workflow/connectors')`.
   - Accept `onDeleteRule` prop; add `confirmDeleteKey` state (`useState(null)`). Render `dxos-flow-delete-rule-${r.ruleKey}` (`'Xóa'`) per card; clicking sets `confirmDeleteKey(r.ruleKey)` and renders inline `dxos-flow-delete-confirm-${r.ruleKey}` (`'Xác nhận xóa'` / `'Hủy'`) calling `onDeleteRule?.(r)`.
3. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js`:
   - `handleToggleRuleActive(r)` (`line 223`): call `runAction('save', 'dxosAutomations:toggleRule', { ...orgPayload, ruleKey: r.ruleKey, active: r.active === false }, ...)`.
   - Add `handleDeleteRule(r)`: call `runAction('delete', 'dxosAutomations:deleteRule', { ...orgPayload, ruleKey: r.ruleKey }, ...)` updating `data.rules` and clearing `runs` for `r.ruleKey`.
   - `handleRunNow(targetRule, customEv)` (`line 222`): when `!targetRule && doc.dirty`: validate `p = buildSavePayload()` (`ruleKey` and `name` non-empty, else report error and return), await `dxosAutomations:saveRule` via `refs.api.request`, clear `doc.dirty = false`, then execute `dxosAutomations:runNow`.
   - `handleNewFlow()` (`line 260`): clear prior traces via `setData((s) => ({ ...s, runs: [] }))`, `setRunUi(FRESH_RUN)`, and reload full list runs when returning to `view === 'list'`.
   - `dxos-flow-back-to-list-btn` (`line 300`): if `doc.dirty`, set `ui.leaveGuardOpen = true`; otherwise switch to `view: 'list'` and call `loadAll()`. Render `renderUnsavedGuardBar` when `ui.leaveGuardOpen`.
   - `dxos-flow-toolbar` (`line 298`): set `flexWrap: 'wrap', rowGap: 6` (remove `overflowX: 'auto'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`
Expected: PASS (all tests including line budget and security checks).

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-list-view.js plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-helpers.js plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs
git commit -m "fix(dxos-studio): rule delete/toggle, connectors route, unsaved guards, and 1280px toolbar"
```

---

### Task 2: Branching Ports, Cursor/JSON-Safe Variables, Inspector UX, Pin Persistence & SSE Diff

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-canvas.js:185-235`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/node-inspector.js:90-290`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/playback-bar.js:180-222`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js:150-245,305-330`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-helpers.js:175-203`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/studio-settings.js:1-35`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/index.js:15-25,116-123`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs:225-239,1531`

**Interfaces:**
- Consumes: `dxosAutomations:aiAssist` (`POST { organizationId, mode: 'fix_error', ruleKey, graph, nodeId, error } -> { draftGraph?, message? }`), `studio-settings.js` `createFlowPinStorage()` (`{ getItem(key), setItem(key, val) }` isolating `window.localStorage` outside `src/client/flow/*` and `index.js` so `tests/flow-ui-studio.test.cjs:254` remains green).
- Produces:
  - Pure helpers in `flow-studio-helpers.js` (or `flow-validation.js` if `flow-studio-helpers.js` hits budget):
    - `insertVariableAtCursor(rawText, expr, selStart, selEnd, isJsonField) -> string`
    - `buildUpstreamPinnedInputs(graph, nodeId, selectedRun, sampleEvent) -> { event, data, dmn, steps }`
    - `computeGraphDiffSummary(prevGraph, nextGraph) -> { added, removed, changed, summaryText }`
  - `FlowCanvas`: multi-port append picker `dxos-node-append-menu-${nodeId}` with `dxos-node-append-${nodeId}-${port}` buttons whenever `outputs.length > 1`.
  - `NodeInspector`: resets `tab` to `'config'` on `nodeId` change (unless `externalTabSeq` changes); switches to `'output'` on `Test This Node`; persists `pinnedMap` via `pinStorage` under `latticedx:flow-pin:${organizationId}:${ruleKey}`; passes `pinStorage` from `createFlowStudioApp`.
  - `PlaybackBar`: `onFixErrorWithAi(trace)` + button `data-testid="dxos-flow-ai-fix-btn-${trace.nodeId}"` on failed steps (`[✦ Sửa lỗi bằng AI]`).
  - `FlowStudioApp`: `sseDiff` banner `data-testid="dxos-flow-sse-diff-banner"` with `dxos-flow-sse-undo-btn` and `dxos-flow-sse-dismiss-btn` when `latticedx:flow-updated` mutates the graph.

- [ ] **Step 1: Write the failing tests (including Review Focus #2 JSON variable insertion)**

Add tests to `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`:

```js
test('Task 2: branching multi-port append, JSON-safe cursor variable insertion, pin persistence, upstream hydration, AI fix, and SSE diff undo', async () => {
  // 1. Multi-port append on control.if (outputs: ['true','false','error']):
  //    click dxos-node-append-if_1 -> renders dxos-node-append-if_1-false -> click calls onAppendFromNode('if_1', 'false')
  // 2. JSON-safe variable insertion (Review Focus #2):
  //    select data.create node, focus JSON field `values` containing `{"code": ""}`, place cursor or end-of-text,
  //    click variable chip `{{data.code}}` -> JSON.parse(node.config.values) MUST succeed (never `{"code": ""}{{data.code}}`).
  //    Test plain text field with selectionStart=4, selectionEnd=4 inserts cleanly at cursor index 4.
  // 3. Switching nodeId resets Inspector tab from 'output' back to 'config'; clicking Test This Node switches tab to 'output'.
  // 4. Dry-Run populates upstream steps/dmn into QuickTestNode & defaultPinnedText, and pinStorage.setItem saves under `latticedx:flow-pin:org-a:<ruleKey>`.
  // 5. Failed step trace in PlaybackBar renders dxos-flow-ai-fix-btn-<nodeId> calling dxosAutomations:aiAssist with mode='fix_error'.
  // 6. Dispatching window CustomEvent('latticedx:flow-updated', { detail: { draftGraph: ... } }) shows dxos-flow-sse-diff-banner; clicking dxos-flow-sse-undo-btn restores pre-SSE graph.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`
Expected: FAIL on missing multi-port menu, corrupted JSON on variable insert, missing pinStorage persistence, missing AI fix button, and missing SSE diff banner.

- [ ] **Step 3: Implement Task 2 across canvas, inspector, playback bar, helpers, and app**

1. In `plugins/nocobase/plugin-dxos-studio/src/client/studio-settings.js` & `index.js`:
   - Export `createFlowPinStorage()` in `studio-settings.js` wrapping `window.localStorage` in `try/catch` (`{ getItem, setItem }`); pass `{ pinStorage: createFlowPinStorage() }` into `createFlowStudioApp(client, React, antd, this.app, { pinStorage })` from `index.js` without naming `localStorage` inside `index.js` or `src/client/flow/*`.
2. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-helpers.js` (or `flow-validation.js` to respect the 220-line budget, adjusting `tests/flow-ui-studio.test.cjs:225-239` budget caps cleanly if needed):
   - Implement `insertVariableAtCursor(rawText, expr, selStart, selEnd, isJsonField)`:
     - Non-JSON: splice `expr` at `[selStart, selEnd]` if numbers in `[0, rawText.length]`, else append.
     - JSON field (`isJsonField === true`): if `selStart != null` and inserting `expr` at `[selStart, selEnd]` still parses as valid JSON (e.g., cursor is inside `"..."` quotes), return spliced string. Otherwise parse/insert `"${expr}"` inside the JSON object/array *before* its closing `}` / `]` (e.g., inside `{"key": ""}` -> `{"key": "{{data.code}}"}`, or `{}` -> `{"value": "{{data.code}}"}`), guaranteeing valid JSON syntax.
   - Implement `buildUpstreamPinnedInputs(graph, nodeId, selectedRun, sampleEvent)`: walk reverse edges from `nodeId` via BFS, extract matching `output` from `selectedRun.traces` into `steps[trace.nodeId]` and `dmn` outputs into `dmn` when `trace.nodeType === 'logic.dmn'`, merged with `{ event, data: event.data || {} }`.
   - Implement `computeGraphDiffSummary(prevGraph, nextGraph)`: counts added, removed, and modified nodes by ID/config/position signature.
3. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-canvas.js`:
   - Track `appendMenuNodeId` in component state (`useState(null)`). When node `outputs.length > 1`, clicking `dxos-node-append-${nodeId}` toggles `dxos-node-append-menu-${nodeId}` rendering buttons `dxos-node-append-${nodeId}-${port}` for each port in `outputs`; clicking a port clears menu and calls `handlersRef.onAppendFromNode?.(nodeId, port)`.
4. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/node-inspector.js`:
   - Use `useState(() => ({ start: null, end: null, field: null }))` ref-box (never `React.useRef`) updated via `onSelect`/`onClick`/`onKeyUp` on parameter inputs/textareas.
   - Reset `tab` to `'config'` inside `useEffect` when `nodeId` changes (only overridden when `externalTabSeq` increments).
   - Switch `setTab('output')` when clicking `dxos-flow-test-node-btn`.
   - Load/save `pinnedMap` using `props.pinStorage` keyed `latticedx:flow-pin:${organizationId}:${ruleKey}`; initialize `defaultPinnedText` via `buildUpstreamPinnedInputs(graph, nodeId, props.selectedRun, rule?.sampleEvent)`.
5. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/playback-bar.js`:
   - On failed trace steps (`status === 'failed'` or `error`), render `data-testid="dxos-flow-ai-fix-btn-${trace.nodeId}"` (`[✦ Sửa lỗi bằng AI]`) calling `onFixErrorWithAi?.(trace)`.
6. In `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js`:
   - Update `handleQuickTestNode(nodeId)` to pass `buildUpstreamPinnedInputs(doc.graph, nodeId, runUi.selectedRun, sampleEvt(buildSavePayload()))`.
   - Implement `handleFixErrorWithAi(trace)` calling `dxosAutomations:aiAssist` (`mode: 'fix_error'`) and applying returned `draftGraph` via `commitGraph` (with feedback).
   - In `onFlowUpdated`, compute `computeGraphDiffSummary(refs.docGraph, g)` before `commitGraph`, storing `sseDiff` state (`dxos-flow-sse-diff-banner`) with Undo (`undoRedo(-1)` + clear banner) and Dismiss.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`
Expected: PASS (all tests including structural/security regex checks).

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-studio/src/client/ plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs
git commit -m "feat(dxos-studio): multi-port append, JSON-safe variables, pin storage, upstream hydration, AI fix, and SSE diff"
```

---

### Task 3: Origin-Aware URLs, Visual DMN Primary Mode, Auto-Context, Column Width & Role Sync

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/connected-apps-panel.js:90-150`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/n8n-setup-modal.js:35-60`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/governance-consoles.js:680-766,910-960`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/dmn-visual-editor.js:560-630,885-955`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/flow/architect.js:30-38`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/native-roles.js:29-38`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-sync.js:10-18`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js:30-36`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`, `plugins/nocobase/plugin-dxos-studio/tests/governance-consoles.test.cjs`, `plugins/nocobase/plugin-dxos-studio/tests/dmn-visual-editor.test.cjs`, `plugins/nocobase/plugin-lattice-foundation/tests/native-roles.test.cjs`

**Interfaces:**
- Consumes: `window.location.origin` / `window.location.hostname`, `DmnTable.inputsJson`.
- Produces:
  - `resolveConnectorsRedirectUri()` in `connected-apps-panel.js` returning `${origin}/admin/settings/workflow/connectors`.
  - `resolveN8nEditorUrl(rawBaseUrl, hostHeaderHostname)` in `n8n-setup-modal.js` preserving `window?.location?.hostname || 'localhost'` (retaining `'localhost'` when `window` is undefined so `tests/flow-ui-studio.test.cjs:1339,1371` pass; keep `n8n-setup-modal.js <= 250` lines).
  - Canonical unified `ldx_*` role set across `architect.js`, `native-roles.js`, `ai-sync.js`, and `ai-studio-page.js`:
    `['ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_operator', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_employee']` (+ `'ldx_viewer'` where catalog/builder allows read-only viewer).
  - `governance-consoles.js` `<details data-testid="dxos-dmn-raw-json-details">` (closed by default, no `open` attribute) wrapping `dxos-dmn-save-form` and `dxos-dmn-eval-form` so `tests/governance-consoles.test.cjs:755-764` continues locating `textareas[2]`.

- [ ] **Step 1: Write the failing tests**

1. In `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`:
   - Test `connected-apps-panel.js` uses `window.location.origin` (`https://erp.example.com/admin/settings/workflow/connectors`) instead of `http://localhost:13014/...`.
   - Test `resolveN8nEditorUrl('http://n8n:5678')` returns `'http://10.0.0.5:5678'` when `window.location.hostname === '10.0.0.5'` and `'http://localhost:5678'` when `window` is absent.
   - Test `DEFAULT_LDX_ROLES` in `architect.js` includes `ldx_operator`, `ldx_director`, `ldx_warehouse`, `ldx_driver`.
2. In `plugins/nocobase/plugin-dxos-studio/tests/governance-consoles.test.cjs` and `dmn-visual-editor.test.cjs`:
   - Test `dxos-dmn-raw-json-details` `<details>` exists without `open: true` while `dxos-dmn-save-form` remains inside it.
   - Test switching DMN table resets `simContextText` / `simContext` to keys derived from active `tbl.inputsJson` (never stale `{"temperature": 10}`).
   - Test `thMeta` (`Mô tả`) and `dmn-rule-desc-*` cell have `minWidth >= 140` (`160`) to prevent 1280px clipping.
3. In `plugins/nocobase/plugin-lattice-foundation/tests/native-roles.test.cjs:13,24` & `plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs`:
   - Update `rolePresets().length` expectation from `7` to `8` (adding `ldx_operator`) and verify `ALL_LDX_ROLES` and `DEFAULT_ROLE_OPTIONS` include `ldx_operator`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs plugins/nocobase/plugin-dxos-studio/tests/governance-consoles.test.cjs plugins/nocobase/plugin-dxos-studio/tests/dmn-visual-editor.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/native-roles.test.cjs`
Expected: FAIL on hardcoded `localhost:13014`, missing `ldx_operator` in `native-roles.js`, open raw JSON form, and stale `simContext`.

- [ ] **Step 3: Implement Task 3 changes**

1. `connected-apps-panel.js`: extract `const redirectUri = resolveConnectorsRedirectUri();` using `typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:13014'`, replacing lines `95` and `141`.
2. `n8n-setup-modal.js`: update `resolveN8nEditorUrl()` (`lines 38-53`) to resolve `const browserHost = (typeof window !== 'undefined' && window.location?.hostname) ? window.location.hostname : 'localhost';` and replace `'n8n'` or fallback URL host with `browserHost` (keeping total file lines `<= 250`).
3. `governance-consoles.js`: wrap `dxos-dmn-save-form` + `dxos-dmn-eval-form` inside `h('details', { 'data-testid': 'dxos-dmn-raw-json-details' }, h('summary', ..., 'Chỉnh sửa JSON & Mô phỏng nâng cao (Legacy)'), ...)`; initialize `simContextText` via `buildInitialSimContext` and update `simContextText` inside `selectTable(tbl)` from `tbl.inputsJson`.
4. `dmn-visual-editor.js`: in `useEffect` watching `props.table` (`lines 618-622`), also update `simContext`, `simJsonText`, and `simResult` via `buildInitialSimContext(next)`; set `minWidth: 160` on `thMeta` and rule description `<td>`/`<input>`.
5. Unify roles across `architect.js:33`, `native-roles.js:31` (add `operator: 'Vận hành'`), `ai-sync.js:13`, and `ai-studio-page.js:31-34`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs plugins/nocobase/plugin-dxos-studio/tests/governance-consoles.test.cjs plugins/nocobase/plugin-dxos-studio/tests/dmn-visual-editor.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/native-roles.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-studio/ plugins/nocobase/plugin-lattice-foundation/ plugins/nocobase/plugin-dxos-ai/
git commit -m "fix(studio,foundation,ai): origin-aware URLs, primary visual DMN, auto context, and unified ldx_* roles"
```

---

### Task 4: Authenticated SSE Streaming, Non-Overlapping AI Launcher, `&amp;` Fix & LLM `502`/`503` Health

**Files:**
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/client/notification-bell.js:80-110,265-325`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/client-v2/mobile-field-pwa.js:450-480,720-785`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/client/portal-agent-launcher.js:370-538`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js:280-310`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-schemas.js:120-255`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-resource.js:730-770,1500-1554`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/index.js:110-125`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js:580-660`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/notifications-and-sla.test.cjs:1529-1754`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/mobile-field-pwa.test.cjs:1776-1933`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs:1498-1630`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/surface-events.test.cjs`

**Interfaces:**
- Consumes: `NOCOBASE_TOKEN` via `resolveClientAuthToken(api)` (`api?.auth?.getToken?.() || api?.auth?.token || window?.localStorage?.getItem?.('NOCOBASE_TOKEN') || ''`).
- Produces:
  - `dxosAi:checkLlmHealth` (`GET`, ACL `'loggedIn'` in `plugin-dxos-ai/src/server/index.js`):
    - Returns `{ ok: boolean, status: number, code: 'OK' | 'NO_LLM_SERVICE' | 'LLM_BAD_GATEWAY' | 'LLM_UNAVAILABLE' | 'LLM_TIMEOUT' | 'LLM_AUTH_ERROR', llmService: string, modelName: string, message: string }` (never leaks `apiKey` or `options`; non-admin callers omit `baseURL`).
  - Authenticated `fetch()` SSE stream readers in `notification-bell.js`, `mobile-field-pwa.js`, and token-guarded `connectSurfaceEvents` in `portal-agent-launcher.js` (skipping SSE cleanly when `!token`).
  - Toolbar `✦ AI Architect` trigger (`dxos-flow-ai-architect-btn`) in `flow-studio-app.js` + hidden `dxos-portal-ai-float-btn` on `isFlowStudioPath` in `portal-agent-launcher.js`.

- [ ] **Step 1: Write the failing tests (including Review Focus #1 & #4)**

1. In `plugins/nocobase/plugin-lattice-foundation/tests/notifications-and-sla.test.cjs` (`1529-1754`) and `mobile-field-pwa.test.cjs` (`1776-1933`):
   - Replace `FakeEventSource` mocks with authenticated `fetch()` SSE `ReadableStream` mocks asserting `Authorization: Bearer <token>` header is sent.
   - **Review Focus #1 pinned test:** When `NOCOBASE_TOKEN` is empty and `api.auth?.getToken?.()` returns `''`, neither `notification-bell.js` nor `mobile-field-pwa.js` opens `/api/dxosAi:surfaceEvents` (`fetch` call count === 0).
2. In `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`:
   - **Review Focus #1 pinned test:** `createPortalAgentLauncher` with empty auth token does NOT call `fetch('/api/dxosAi:surfaceEvents...')`.
   - Update lines `1554-1583` to provide `auth: { getToken: () => 'test-token' }` on authenticated Flow Studio test AND assert `findBtn(adminTree) === null` on `/admin/settings/workflow/*` (no overlapping bottom-right float button occluding NocoBase's native button).
   - **Review Focus #4 pinned test:** `dxosAi:checkLlmHealth` returns `{ ok: false, status: 502, code: 'LLM_BAD_GATEWAY' }` / `{ status: 503, code: 'LLM_UNAVAILABLE' }` when upstream returns 502/503, never hangs, and `portal-agent-launcher.js` renders explicit `dxos-ai-health-warning` banner when unhealthy.
   - Verify `STARTER_AI_BLUEPRINTS` nicknames (`ai-schemas.js:124,180,247`) contain zero `'&'` characters (`!nickname.includes('&')`).
3. In `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`:
   - Verify `dxos-flow-ai-architect-btn` exists in `dxos-flow-toolbar` and opens native `app.flowEngine.context.ai.triggerTask` with `dxos-architect` + `flowContext`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-lattice-foundation/tests/notifications-and-sla.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/mobile-field-pwa.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`
Expected: FAIL on `EventSource` usage, unauthenticated SSE calls, overlapping float button, `'&'` in nicknames, and missing `dxosAi:checkLlmHealth`.

- [ ] **Step 3: Implement Task 4**

1. `notification-bell.js` (`86-98, 271-310`) & `mobile-field-pwa.js` (`456-469, 726-776`):
   - Tighten `isAuthenticatedClient` / `isAuthenticatedMobileClient` to require a non-empty auth token (`resolveToken(api)` checking `api?.auth?.getToken?.() || api?.auth?.token || localStorage.getItem('NOCOBASE_TOKEN')`).
   - Replace `new EventSourceCtor(...)` with `fetch(sseUrl, { headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, signal: controller.signal })` reading chunks via `res.body.getReader()` + `TextDecoder`, parsing `event:` / `data:` frames, aborting reconnect on `401`/`403`, and exponential backoff on transient drops.
2. `portal-agent-launcher.js`:
   - In `connectSurfaceEvents`, return early before `fetch()` if `!resolveAuthToken(api)`.
   - Line `441`: set `showFloatButton = Boolean(portalSlug && !onFlowStudio && defaultEmployee && !dialogOpen)` so it never overlaps NocoBase's native button on `/admin/settings/workflow/*`.
   - Call `dxosAi:checkLlmHealth` when opening chat or on Studio load; if `!health.ok`, render an explicit `data-testid="dxos-ai-health-warning"` status banner showing the `502`/`503`/provider diagnostic message instead of failing silently.
3. `flow-studio-app.js`: add `['dxos-flow-ai-architect-btn', '✦ AI Architect', handleOpenAiArchitect, 'ai', false]` to `tools` in `dxos-flow-toolbar` triggering `app?.flowEngine?.context?.ai?.triggerTask` (or dispatching `latticedx:open-ai-architect`).
4. `ai-schemas.js` (`lines 124, 180, 247`): replace `&` in `nickname` values with `' - '` / `'và'` (`'Kiến trúc sư Hệ thống - Block AI'`, `'Chuyên viên Kho lạnh - Sự cố IoT AI'`, `'Trợ lý Nội bộ, Mua sắm và P.A.R.A. AI'`).
5. `ai-resource.js` & `plugin-dxos-ai/src/server/index.js`: implement `checkLlmHealth(ctx, next)` (`acl.allow('dxosAi', 'checkLlmHealth', 'loggedIn')`) inspecting `dxos-architect`'s `llmService` -> `llmServices` row, probing `${baseURL}/models` (or Ollama `/api/tags`, Gemini `/v1beta/models`) with `AbortSignal.timeout(5000)`, classifying `502`/`503`/network/timeout cleanly, and omitting `baseURL`/`options` for non-admin callers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-lattice-foundation/tests/notifications-and-sla.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/mobile-field-pwa.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-lattice-foundation/ plugins/nocobase/plugin-dxos-ai/ plugins/nocobase/plugin-dxos-studio/
git commit -m "fix(foundation,ai,studio): authenticated fetch SSE, non-overlapping AI launcher, nickname entity fix, and checkLlmHealth"
```

---

## Wave 2 (P1) — Dynamic `latticeCustom*` Block Parity (Frappe DocType Model)

### Task 5: `dxosBlocks:collectionsMeta` Endpoint & `DxosKanbanScheduleBlockModel` Dynamic `latticeCustom*` Parity

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/server/blocks-api.js:33-50,940-998`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/server/index.js:64-78`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/blocks-helpers.js:1-35,280-314`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/kanban-schedule-block.js:11-95,188-560`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/block-models.js:1083-1117`
- Test: `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`
- Test: `plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs`

**Interfaces:**
- Consumes: `hasViewPermission(db, ctx, collection, 'view')`, `CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/`, standard `${collection}:list` and `${collection}:update`.
- Produces:
  - Server action `dxosBlocks:collectionsMeta` (`GET`, `loggedIn`): returns `{ collections: [{ name, title, isCustom, fields: [{ name, type, interface, title, enumValues: [{ value, label }] }] }] }` filtered by caller `hasViewPermission` and excluding internal/secret collections.
  - Client helpers in `blocks-helpers.js`:
    - `fetchCollectionsMeta(api) -> Promise<Array<CollectionMeta>>`
    - `inferCollectionFieldsMeta(collectionMeta) -> { statusField, stages, dateFields, titleField, latField, lngField }`
  - `kanban-schedule-block.js`:
    - `normalizeKanbanCollection(raw)` accepting built-in Kanban collections AND any `CUSTOM_COLLECTION_RE` / `SAFE_COLLECTION_RE` string (never falling back to `'latticeOrders'` for valid `latticeCustom*`).
    - `inferKanbanStages(meta, records, cfg)` deriving stages from `cfg.stages` -> `statusField` `enumValues` -> distinct live record values -> `KANBAN_STAGE_ORDER` fallback.
    - Drag-and-drop (`draggable`, `onDragStart`, `onDragOver`, `onDrop`) + stage select/move buttons calling `latticeVoucher:*` for `VOUCHER_COLLECTIONS` and `${collection}:update` (`filterByTk`, `values: { [statusField]: nextStage }`) for `latticeCustom*`.
  - `DxosKanbanScheduleBlockModel` `uiSchema` adds optional `statusField`, `dateField`, `titleField` while keeping existing `['title', 'collection', 'viewMode', 'pageSize']` intact.

- [ ] **Step 1: Write the failing tests (including Review Focus #3)**

Add tests to `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs` and `dxos-blocks-client.test.cjs`:

```js
test('Task 5 (Review Focus #3): Kanban on latticeCustomMaintenanceOrders renders custom enum stages & updates via REST', async () => {
  // Mock dxosBlocks:collectionsMeta returning latticeCustomMaintenanceOrders with
  // fields: [{ name: 'ticketState', type: 'string', interface: 'select', enumValues: [{ value: 'new', label: 'Mới' }, { value: 'dispatched', label: 'Đã điều' }, { value: 'closed', label: 'Đóng' }] }, { name: 'scheduledAt', type: 'datetime' }]
  // Mock latticeCustomMaintenanceOrders:list returning 2 records with ticketState='new' and 'dispatched'
  // Assert:
  // 1. latticeOrders:list is NEVER called
  // 2. Columns render 'new', 'dispatched', 'closed' (not 'draft'/'approved')
  // 3. Triggering stage move / drop calls latticeCustomMaintenanceOrders:update with { filterByTk: id, values: { ticketState: 'dispatched' } }
});

test('dxosBlocks:collectionsMeta filters collections by caller RBAC view permission and extracts enumValues', async () => {
  // Server unit test calling collectionsMeta action for non-admin role with access to 1 custom collection
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs`
Expected: FAIL because `normalizeKanbanCollection` falls back to `'latticeOrders'` and `dxosBlocks:collectionsMeta` does not exist.

- [ ] **Step 3: Implement Task 5**

1. `blocks-api.js` & `plugin-dxos-blocks/src/server/index.js`: implement `collectionsMeta(ctx, next)` querying `collections` + `fields` repos + `db.collections`, filtering out protected/internal tables and checking `hasViewPermission(db, ctx, name, 'view')`, and register `'collectionsMeta'` in `acl.allow('dxosBlocks', [...], 'loggedIn')`.
2. `blocks-helpers.js`: implement `fetchCollectionsMeta(api)` (with in-flight/per-api memoization) and `inferCollectionFieldsMeta(meta)` extracting `statusField`, `stages`, `dateFields`, `titleField`, `latField`, `lngField` (zero non-relative `require()`).
3. `kanban-schedule-block.js`: update `normalizeKanbanCollection`, `resolveRecordStage`, `groupRecordsByKanbanStage`, `parseRecordScheduleDate`, and `createKanbanScheduleBlockView` to fetch `collectionsMeta`, use dynamic `statusField` / `dateField` / `titleField` / `stages`, populate `<select aria-label="Chọn phân hệ Kanban">` with accessible `latticeCustom*` collections, and wire HTML5 drag/drop + stage transition `<select>`/`<button>` calling `${activeCollection}:update`.
4. `block-models.js`: add optional `statusField`, `dateField`, `titleField` fields to `DxosKanbanScheduleBlockModel` `uiSchema` and wire dynamic collection selector options.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-blocks/
git commit -m "feat(dxos-blocks): collectionsMeta endpoint and dynamic latticeCustom* Kanban parity"
```

---

### Task 6: `DxosWebGisBlockModel` Dynamic `latticeCustom*` Geo Parity

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/webgis-block.js:19-85,230-265,598-865,1105-1120`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/block-models.js:1065-1081`
- Test: `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`

**Interfaces:**
- Consumes: `fetchCollectionsMeta`, `inferCollectionFieldsMeta` from `blocks-helpers.js`; `${cfg.collection}:list`.
- Produces:
  - `DxosWebGisBlockModel` optional props & `uiSchema`: `collection`, `latField`, `lngField`, `labelField`, `statusField` (preserving existing 5 `uiSchema` fields checked by `tests/ui-v100-blocks.test.cjs:588-589`).
  - Dynamic custom-collection mode in `webgis-block.js`: when `cfg.collection` is set, loads `${cfg.collection}:list` (respecting `defaultOrganizationId`), resolves coordinates via `cfg.latField`/`cfg.lngField` or inferred fields, and renders explicit `data-testid="dxos-webgis-unmapped-notice"` when empty or lacking coordinates instead of substituting `DEFAULT_VIETNAM_GEO_MARKERS`.

- [ ] **Step 1: Write the failing test (including Review Focus #3)**

Add tests to `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`:

```js
test('Task 6 (Review Focus #3): WebGIS on latticeCustomFleet without lat/lng shows unmapped notice and never injects demo Vietnam hubs', async () => {
  // 1. Mount WebGIS with collection='latticeCustomFleet', records=[{ id: 1, code: 'TRK-01', state: 'active' }] (no lat/lng)
  //    Assert: latticeCustomFleet:list called; latticeAssets:list NOT called; DEFAULT_VIETNAM_GEO_MARKERS ('Kho Lạnh Cần Thơ' etc.) NOT rendered; dxos-webgis-unmapped-notice rendered.
  // 2. Mount WebGIS with collection='latticeCustomSites', latField='geoLat', lngField='geoLng', labelField='siteName', statusField='healthState'
  //    Assert: custom marker rendered with siteName and projected coordinates.
  // 3. Mount WebGIS with collection='' (unset) -> preserves default Twin view (latticeAssets + latticeLocations).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`
Expected: FAIL because `loadGeoData` ignores `cfg.collection` and falls back to `DEFAULT_VIETNAM_GEO_MARKERS`.

- [ ] **Step 3: Implement Task 6**

1. `block-models.js`: add `collection`, `latField`, `lngField`, `labelField`, `statusField` optional fields to `DxosWebGisBlockModel` `uiSchema` and `defaultParams` (`collection: ''`, `latField: ''`, `lngField: ''`, `labelField: ''`, `statusField: ''`).
2. `webgis-block.js`:
   - In `loadGeoData`: if `SAFE_COLLECTION_RE.test(String(cfg.collection || '').trim())`, query `${cfg.collection}:list` (filtered by `organizationId` when `cfg.defaultOrganizationId` is set) and optional `collectionsMeta` to infer `latField`/`lngField`/`labelField`/`statusField`.
   - Partition records into valid geo-projected markers vs `unmappedCount` (records missing finite `lat`/`lng`). Do NOT run `VIETNAM_CITY_COORDS` / `DEFAULT_VIETNAM_GEO_MARKERS` fallback when `cfg.collection` is set; render `data-testid="dxos-webgis-unmapped-notice"` and skip Twin `dxosBlocks:twinSetDesired` controls when markers lack `assetId`.
   - When `cfg.collection` is unset/empty, retain the existing `latticeAssets` + `latticeLocations` + `latticeIncidentCases` Twin view.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-blocks/src/client/webgis-block.js plugins/nocobase/plugin-dxos-blocks/src/client/block-models.js plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs
git commit -m "feat(dxos-blocks): unlock DxosWebGisBlockModel for dynamic latticeCustom* collections"
```

---

### Task 7: `DxosRecordWorkbenchBlockModel`, Chatter, Governed Export, PKI/Lineage & `solution-bundle.js`

**Files:**
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/record-chatter.js:20-35,190-240`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/server/governed-export.js:100-145`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/chatter-panel.js:197-240,415-448`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/block-models.js:89-96,681-870,1036-1063`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/solution-bundle.js:47-64`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/chatter-and-lineage.test.cjs` (or matching foundation chatter test)
- Test: `plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs`, `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/solution-bundle-v3.test.cjs`

**Interfaces:**
- Consumes: `CUSTOM_COLLECTION_RE` (`/^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/`), `fetchCollectionsMeta` from `blocks-helpers.js`.
- Produces:
  - `isChatterCollectionAllowed(name)` in `record-chatter.js` returning `ALLOWED_CHATTER_COLLECTIONS.has(name) || CUSTOM_COLLECTION_RE.test(name)`.
  - `resolveAllowedExportColumns` in `governed-export.js` inspecting `db.getCollection(collection)?.fields` (excluding sensitive fields matching `SENSITIVE_EXPORT_FIELD_RE`) when `requestedFields` is omitted and no explicit role field restriction exists.
  - `VoucherLifecycleBar` in `chatter-panel.js`: `validRecordTarget = SAFE_COLLECTION_RE.test(col) && id > 0` renders PKI & Lineage badges for any `latticeCustom*` record; `validVoucherTarget = VOUCHER_COLLECTIONS.has(col) && id > 0` gates voucher workflow actions (`submit`/`cancel`/`amend`).
  - `DxosRecordWorkbenchBlockModel`: keeps exact `defaultParams` (`dxos-blocks-client.test.cjs:365-372`!) while dynamically appending `latticeCustom*` collections from `fetchCollectionsMeta(api)` into `DxosRecordWorkbenchView`'s `<select aria-label="Lọc phân hệ nghiệp vụ">`.
  - `ALLOWED_FLOW_MODEL_USES` in `solution-bundle.js:47-64` includes `'DxosWmsOpsBlockModel'`.

- [ ] **Step 1: Write the failing tests (including Review Focus #3)**

1. In `plugins/nocobase/plugin-lattice-foundation/tests/` (chatter test file): verify `latticeChatter:list`, `latticeChatter:post`, and `recordFieldDiffChatter` succeed on `latticeCustomInspections` (with valid org scope & RBAC) and still reject invalid names.
2. In `plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs` & `ui-v100-blocks.test.cjs`:
   - Verify `DxosRecordWorkbenchBlockModel` `cfgStep.defaultParams` still passes `assert.deepEqual` at line `365`.
   - **Review Focus #3 pinned test:** Mount `DxosRecordWorkbenchView` / `createVoucherLifecycleBar` on `collection='latticeCustomInspections'`, `recordId='9'` -> asserts PKI badge (`dxosLedger:entries`), Data Lineage (`dxosDataGov:lineageTrace`), Chatter (`latticeChatter:list`), and Export (`dxosBlocks:exportReport`) all render while voucher-only `submit`/`cancel` buttons stay hidden; `<select>` includes `latticeCustomInspections` from `collectionsMeta`.
   - Verify `executeGovernedExport` on `latticeCustomInspections` includes custom fields (e.g. `inspectorNote`, `passScore`) from `db.getCollection('latticeCustomInspections').fields` when `fields` param is omitted.
3. In `plugins/nocobase/plugin-dxos-studio/tests/solution-bundle-v3.test.cjs`:
   - Verify `exportSolutionBundle` + `validateSolutionBundle` + `importSolutionBundle` accept `use: 'DxosWmsOpsBlockModel'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs plugins/nocobase/plugin-dxos-studio/tests/solution-bundle-v3.test.cjs`
Expected: FAIL on `VoucherLifecycleBar` returning `null` for `latticeCustomInspections`, missing custom export columns, and `DxosWmsOpsBlockModel` rejected in `solution-bundle.js`.

- [ ] **Step 3: Implement Task 7**

1. `record-chatter.js`: add `CUSTOM_COLLECTION_RE` check in `resolveVerifiedTarget` and `recordFieldDiffChatter` (`lines 20-27, 195, 218`).
2. `governed-export.js`: in `resolveAllowedExportColumns` (`lines 104, 135-139`), when `!requestedFields && !roleFields?.length`, read `db?.getCollection?.(collection)?.fields` (filtering sensitive/virtual fields) before falling back to `DEFAULT_FALLBACK_COLUMNS`.
3. `chatter-panel.js`: split `validRecordTarget` (`SAFE_COLLECTION_RE.test(col) && Number(targetRecordId) > 0`) from `validVoucherTarget` (`VOUCHER_COLLECTIONS.has(col) && Number(targetRecordId) > 0`); render PKI badge + Lineage drawer for `validRecordTarget` and voucher actions only for `validVoucherTarget`.
4. `block-models.js`: inside `DxosRecordWorkbenchView`, call `fetchCollectionsMeta(api)` and merge returned collections into the `<select aria-label="Lọc phân hệ nghiệp vụ">` options (preserving `WORKBENCH_COLLECTION_ENUM` as defaults and keeping `DxosRecordWorkbenchBlockModel` `defaultParams` untouched).
5. `solution-bundle.js`: add `'DxosWmsOpsBlockModel'` to `ALLOWED_FLOW_MODEL_USES` (`lines 47-64`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/*.test.cjs plugins/nocobase/plugin-dxos-studio/tests/solution-bundle-v3.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-lattice-foundation/ plugins/nocobase/plugin-dxos-blocks/ plugins/nocobase/plugin-dxos-studio/
git commit -m "feat(blocks,foundation,studio): unlock RecordWorkbench, Chatter, Export, PKI/Lineage for latticeCustom* and DxosWmsOpsBlockModel in bundle v3"
```

---

## Wave 3 (P1/P2) — Zero-Config Blank-Slate Onboarding & Bring-Your-Own LLM Key

### Task 8: Auto-Bootstrap `dxos-architect` on `install`/`afterEnable` & `LATTICE_SKIP_DEMO_SEED=1`

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-resource.js:1139-1205,1548-1554`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/index.js:22-30,120-132`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/seed.js:24-48`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/index.js:135-145`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261013000100-foundation-seed.js:10-20`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/seed.test.cjs`

**Interfaces:**
- Consumes: `STARTER_AI_BLUEPRINTS`, `resolveDefaultOrganizationId`, `upsertAndSyncProfile`, `ensureLocalLlmServiceRecord`.
- Produces:
  - `ensureDefaultAiWorkforce(db, { env = process.env, actorUser = null, defaultOrigin = '', forceUpdate = false } = {})` exported from `ai-resource.js`:
    - Safely no-ops (`{ seeded: [], skipped: true, reason: 'REPOS_NOT_READY' }`) if `latticeAiProfiles` repo is absent.
    - Runs under `runWithSystemRlsBypass`; when `forceUpdate === false`, checks existing `latticeAiProfiles` by `username` and **preserves** customized `llmService`/`modelName` bindings (only creating missing starter profiles such as `dxos-architect`, while calling `ensureLocalLlmServiceRecord(db, env)` best-effort without failing when `0` LLM services exist).
  - `DxosAiPlugin.install()` and `DxosAiPlugin.afterEnable()` calling `ensureDefaultAiWorkforce(this.db, { env: process.env, forceUpdate: false })`.
  - `seedFoundation(db, transaction, { env = process.env } = {})` short-circuiting with `{ skipped: true, reason: 'LATTICE_SKIP_DEMO_SEED' }` when `env?.LATTICE_SKIP_DEMO_SEED === '1'`.

- [ ] **Step 1: Write the failing tests (including Review Focus #4)**

1. In `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`:
   - **Review Focus #4 pinned test:** Instantiate `DxosAiPlugin` with mock `db`/`app` containing `0` `llmServices` rows and call `await plugin.install()` then `await plugin.afterEnable()` -> asserts `dxos-architect` and all 5 starter profiles exist in `latticeAiProfiles` and `aiEmployees`.
   - Verify idempotency: customize `dxos-architect.llmService = 'user-openai'` and re-run `await plugin.afterEnable()` -> asserts `dxos-architect.llmService` stays `'user-openai'` (not overwritten back to `'local-9router'`).
2. In `plugins/nocobase/plugin-lattice-foundation/tests/seed.test.cjs`:
   - Verify `seedFoundation(db, null, { env: { LATTICE_SKIP_DEMO_SEED: '1' } })` performs zero inserts (`DEMO-UNIT-01`/`02` not created) and returns `{ skipped: true }`, while default `seedFoundation(db)` still seeds demo units.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/seed.test.cjs`
Expected: FAIL because `DxosAiPlugin` has no `install`/`afterEnable` and `seedFoundation` ignores `LATTICE_SKIP_DEMO_SEED`.

- [ ] **Step 3: Implement Task 8**

1. `ai-resource.js`: extract `ensureDefaultAiWorkforce(db, opts)` from `bootstrapDefaults` (`lines 1139-1198`); when `forceUpdate === false`, skip `upsertAndSyncProfile` for usernames already present in `latticeAiProfiles` (still calling `syncProfileToNocobaseAi` only for newly created profiles); `bootstrapDefaults` calls `ensureDefaultAiWorkforce(targetDb, { env: process.env, actorUser, defaultOrigin, forceUpdate: true })`; export `ensureDefaultAiWorkforce`.
2. `plugin-dxos-ai/src/server/index.js`: add `async install()` and `async afterEnable()` invoking `await ensureDefaultAiWorkforce(this.db, { env: process.env, forceUpdate: false })`.
3. `seed.js`, `plugin-lattice-foundation/src/server/index.js`, `20261013000100-foundation-seed.js`: accept `{ env = process.env }` in `seedFoundation`, return `{ skipped: true, reason: 'LATTICE_SKIP_DEMO_SEED' }` immediately if `env?.LATTICE_SKIP_DEMO_SEED === '1'`, and pass `{ env: process.env }` from callers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/seed.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-ai/ plugins/nocobase/plugin-lattice-foundation/
git commit -m "feat(ai,foundation): auto-bootstrap starter AI workforce on install/enable and add LATTICE_SKIP_DEMO_SEED gate"
```

---

### Task 9: `dxosAi:quickConnectLlm`, `llmServices.afterSave` Auto-Bind & Quick-Connect UI

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-sync.js:120-201`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-resource.js:730-820,1500-1554`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/index.js:40-75`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js:38-55,600-815`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs`

**Interfaces:**
- Consumes: `checkLlmHealth` helper from Task 4; host `llmServices` schema (`{ name, title, provider, options, enabledModels, enabled }`).
- Produces:
  - `rebindStarterAgentsToService(db, { llmService, modelName, actorUser = null, defaultOrigin = '' })` in `ai-sync.js` / `ai-resource.js`: updates `dxos-architect` and any starter profile whose `llmService` points to a missing/disabled service, syncing `aiEmployees.modelSettings`.
  - `dxosAi:quickConnectLlm` (`POST`, `requireAdmin`): accepts `{ provider, apiKey, baseURL?, modelName, serviceName?, title?, testConnection? }`, supports `['openai', 'openai-completions', 'google-genai', 'anthropic', 'deepseek', 'ollama']`, validates `baseURL` (no SSRF to private metadata IPs `169.254.169.254` while allowing loopback `127.0.0.1:20128`/`11434` & `host.docker.internal`), upserts `llmServices` (`enabled: true`, `enabledModels: { mode: 'custom', models: [...] }`), calls `rebindStarterAgentsToService`, and returns `{ service: { name, title, provider, modelName, enabled }, reboundAgents, health }` with `apiKey` completely omitted from response & audit logs.
  - `db.on('llmServices.afterSave', ...)` in `DxosAiPlugin.load()` calling `rebindStarterAgentsToService` when an enabled `llmServices` row is saved.
  - Quick-Connect LLM Key card (`data-testid="dxos-quick-connect-llm-card"`) + Health Check probe button (`dxos-llm-health-btn`) in `ai-studio-page.js` (`/admin/settings/dxos-ai`).

- [ ] **Step 1: Write the failing tests (including Review Focus #4)**

Add tests to `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs` & `ai-profiles-sync.test.cjs`:

```js
test('Task 9 (Review Focus #4): dxosAi:quickConnectLlm upserts llmServices, auto-binds dxos-architect, never leaks apiKey, and triggers on llmServices.afterSave', async () => {
  // 1. Non-admin call -> 403 DXOS_ADMIN_REQUIRED
  // 2. Admin POST dxosAi:quickConnectLlm { provider: 'openai', apiKey: 'sk-secret-1234', modelName: 'gpt-4o-mini' }
  //    Assert: llmServices row created/updated; dxos-architect latticeAiProfiles + aiEmployees.modelSettings rebound to new service & gpt-4o-mini;
  //    JSON.stringify(res.body).includes('sk-secret-1234') === false; audit log redacts apiKey.
  // 3. Emit db.on('llmServices.afterSave') for enabled Gemini service when dxos-architect points to missing 'local-9router' -> auto-rebinds dxos-architect.
  // 4. Mount createDxosAiStudioPage -> renders dxos-quick-connect-llm-card, provider select, masked apiKey input, connect button calling dxosAi:quickConnectLlm, and health badge via dxosAi:checkLlmHealth.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs`
Expected: FAIL on missing `quickConnectLlm`, missing `llmServices.afterSave` listener, and missing `dxos-quick-connect-llm-card`.

- [ ] **Step 3: Implement Task 9**

1. `ai-sync.js`: implement `rebindStarterAgentsToService(db, { llmService, modelName, defaultOrigin })` checking `llmServices` enabled names, updating `dxos-architect` and any starter profile whose current `llmService` is missing/disabled, and calling `syncProfileToNocobaseAi`.
2. `ai-resource.js`: implement `quickConnectLlm(ctx, next)` (`requireAdmin`, POST validation, provider preset defaults for `openai`, `openai-completions`, `google-genai`, `anthropic`, `deepseek`, `ollama`, `baseURL` safety check, `llmServices` upsert, `rebindStarterAgentsToService`, optional `probeLlmHealth`, redacted audit log & response).
3. `plugin-dxos-ai/src/server/index.js`: register `this.db.on('llmServices.afterSave', async (instance) => ...)` inside `load()` to auto-rebind unbound starter agents when an enabled `llmServices` row is saved.
4. `ai-studio-page.js`: add `dxos-quick-connect-llm-card` (Provider dropdown, API Key password input, Base URL optional input, Model ID input with provider presets, `Kết nối & Gắn cho AI` button, `Kiểm tra kết nối` button + health status pill) on `/admin/settings/dxos-ai` (`build.mjs` constraint: relative requires only).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-profiles-sync.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-ai/
git commit -m "feat(dxos-ai): quickConnectLlm endpoint, llmServices.afterSave auto-bind, and Quick-Connect LLM Key UI"
```

---

## Wave 4 (P2) — Multi-Entity App Builder Orchestrator + Built-App Manifest & Rebuild Engine

### Task 10: `latticeBuiltApps` Registry + PG RLS + Multi-Entity Topological Orchestrator + Rebuild/Export/Teardown

**Files:**
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/collections/built-apps.js`
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/migrations/20261128000100-built-apps-registry-rls.js`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js:31-75`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/app-builder-orchestrator.js:76-85,104-120,1046-1284`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-tools-core.js:64-72,298-303,408-475`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-builder-tools.js:4070-4189`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-nl-router.js:313-379`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-resource.js:1500-1554`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/solution-bundle.js:75-86`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/app-builder-orchestrator.test.cjs`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/sibling-rls-migrations.test.cjs:215`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/data-governance.test.cjs:407`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/pg-rls-and-observability.test.cjs:52`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/vault-and-event-bus.test.cjs:275`

**Interfaces:**
- Consumes: `attachTableRls` / `attachRlsPolicyToTable` (`pg-rls.js`), `loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'solution-bundle')`.
- Produces:
  - Collection `latticeBuiltApps` (`organizationId`, `appKey`, `name`, `version`, `status`, `sourceSpecJson`, `artifactRefsJson`, `bundleSnapshotUid`, `lastVerifiedAt`, `lastVerificationJson`, `createdBy`) with PG `FORCE ROW LEVEL SECURITY` and unique `(organizationId, appKey)`.
  - `TENANT_RLS_TABLES` length `42 -> 43`; `SYSTEM_PROTECTED_COLLECTIONS` includes `'latticeBuiltApps'` in all 3 files (`app-builder-orchestrator.js`, `ai-tools-core.js`, `solution-bundle.js`).
  - `topologicalSortCollections(collections)` in `app-builder-orchestrator.js`: Kahn's algorithm ordering `belongsTo`/`hasMany` targets before dependents, throwing `400 BLUEPRINT_CYCLE_DETECTED` on cycles and `403 SYSTEM_COLLECTION_FORBIDDEN` on `SYSTEM_PROTECTED_COLLECTIONS` before snapshot or DB writes.
  - `orchestrateEnterpriseAppBuild(ctx, db, actor, spec, deps)` supporting both legacy single-table `spec.collectionName` and Multi-Entity `spec.collections[]`, `roles[]`, `portals[]`, `dmnTables[]`, `flowGraphs[]`, `n8nWorkflows[]`, upserting `latticeBuiltApps`.
  - `listBuiltApps`, `rebuildEnterpriseApp`, `exportAppBundle` (`solution-bundle.js` v3), `teardownBuiltApp` (`keepData: true` default) exported from `app-builder-orchestrator.js`, exposed via `dxos_provision_role_workspace` (`skipOuterTx` updated in `ai-tools-core.js`) AND admin REST endpoints (`dxosAi:listBuiltApps`, `dxosAi:rebuildBuiltApp`, `dxosAi:exportBuiltAppBundle`, `dxosAi:teardownBuiltApp`) in `ai-resource.js`.
  - `dxos_extend_collection_schema` extended with `updateFieldMeta` & `deprecateField`.

- [ ] **Step 1: Write the failing tests (including Review Focus #5)**

1. Update the 4 hardcoded `42 -> 43` assertions in `sibling-rls-migrations.test.cjs:215`, `data-governance.test.cjs:407`, `pg-rls-and-observability.test.cjs:52`, `vault-and-event-bus.test.cjs:275`, and assert `'latticeBuiltApps'` is in `TENANT_RLS_TABLES` and `SYSTEM_PROTECTED_COLLECTIONS` in all 3 files.
2. In `plugins/nocobase/plugin-dxos-ai/tests/app-builder-orchestrator.test.cjs`:
   - **Review Focus #5 pinned tests:**
     - Cyclic multi-entity blueprint (`latticeCustomAlpha` `belongsTo` `latticeCustomBeta` AND `latticeCustomBeta` `belongsTo` `latticeCustomAlpha`) throws `{ status: 400, code: 'BLUEPRINT_CYCLE_DETECTED' }` BEFORE creating any snapshot or collection.
     - Blueprint targeting `users` or `latticeBuiltApps` throws `{ status: 403, code: 'SYSTEM_COLLECTION_FORBIDDEN' }` BEFORE creating any snapshot or collection.
   - Multi-Entity happy path: `[latticeCustomOrders -> belongsTo latticeCustomVendors]` creates `latticeCustomVendors` BEFORE `latticeCustomOrders`, builds `roles[]`, `portals[]`, `dmnTables[]`, `flowGraphs[]`, writes `latticeBuiltApps` (`version: 1`).
   - `rebuildEnterpriseApp` bumps `version: 2`, reconciles artifacts, runs 2-round self-healing.
   - `exportAppBundle` returns `latticedx.solution-bundle/v3` JSON.
   - `teardownBuiltApp({ appKey, keepData: true })` preserves custom collection rows while tearing down portals/flows/bindings; `keepData: false` drops custom collection when explicitly requested.
   - Single-table `orchestrateEnterpriseAppBuild` backward-compatibility test passes unchanged.
3. In `plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs`:
   - Test `dxos_extend_collection_schema` `updateFieldMeta` and `deprecateField` + `skipOuterTx` for new `dxos_provision_role_workspace` operations + `ai-nl-router.js` intents for multi-entity build, rebuild, export, teardown.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/app-builder-orchestrator.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-tools-core.test.cjs plugins/nocobase/plugin-dxos-ai/tests/sibling-rls-migrations.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/data-governance.test.cjs`
Expected: FAIL on missing `latticeBuiltApps`, missing cycle detection, and `TENANT_RLS_TABLES.length` mismatch.

- [ ] **Step 3: Implement Task 10**

1. Create `collections/built-apps.js` & `migrations/20261128000100-built-apps-registry-rls.js` (with Apache-2.0 header, `Migration` `on = 'afterSync'`, PG `CREATE TABLE IF NOT EXISTS "latticeBuiltApps"`, unique index `(organizationId, appKey)`, `attachTableRls`, and `down()`).
2. Add `'latticeBuiltApps'` to `TENANT_RLS_TABLES` (`pg-rls.js`) and `SYSTEM_PROTECTED_COLLECTIONS` in `app-builder-orchestrator.js`, `ai-tools-core.js`, and `solution-bundle.js`.
3. In `app-builder-orchestrator.js`: implement `topologicalSortCollections(collections)`, upgrade `orchestrateEnterpriseAppBuild` for multi-entity arrays while keeping single-table `spec` 100% compatible, persist `latticeBuiltApps` rows, and implement `listBuiltApps`, `rebuildEnterpriseApp`, `exportAppBundle`, `teardownBuiltApp` (keep outbound n8n HTTP calls outside DB transactions!).
4. In `ai-tools-core.js`, `ai-builder-tools.js`, `ai-nl-router.js`, `ai-resource.js`: wire new operations in `dxos_provision_role_workspace` (`skipOuterTx`), `updateFieldMeta`/`deprecateField` in `dxos_extend_collection_schema`, NL router patterns, and admin-only `dxosAi:listBuiltApps` / `rebuildBuiltApp` / `exportBuiltAppBundle` / `teardownBuiltApp` REST actions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs plugins/nocobase/plugin-dxos-studio/tests/solution-bundle-v3.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/nocobase/plugin-dxos-ai/ plugins/nocobase/plugin-lattice-foundation/ plugins/nocobase/plugin-dxos-studio/
git commit -m "feat(ai,foundation): add latticeBuiltApps FORCE RLS registry, multi-entity topological orchestrator, and rebuild/export/teardown engine"
```

---

### Task 11: Built Apps Manager UI, Vietnamese NL Eval Expansion, Acceptance Script & 8-Gate + Live Docker Verification

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js:560-660,1030-1094`
- Modify: `scripts/eval-vietnamese-nl-agent.mjs`
- Create: `scripts/acceptance-blank-slate-app-builder.mjs`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/vietnamese-nl-eval.test.cjs`

**Interfaces:**
- Consumes: `dxosAi:listBuiltApps`, `dxosAi:rebuildBuiltApp`, `dxosAi:exportBuiltAppBundle`, `dxosAi:teardownBuiltApp` (Task 10), `dxosAi:quickConnectLlm`, `dxosAi:checkLlmHealth` (Task 9/4), `dxosBlocks:collectionsMeta` (Task 5).
- Produces:
  - `Built Apps` management tab (`data-testid="dxos-tab-built-apps"`, `data-testid="dxos-built-apps-panel"`) in `ai-studio-page.js` with `View`, `Rebuild`, `Export Bundle v3`, `Verify`, and `Teardown` (`keepData: true` default) buttons.
  - Expanded `VIETNAMESE_NL_EVAL_CASES` in `scripts/eval-vietnamese-nl-agent.mjs` covering Multi-Entity Build, Rebuild, Export Bundle v3, List/Teardown Built Apps, and Dynamic Kanban/WebGIS cases.
  - `scripts/acceptance-blank-slate-app-builder.mjs` accepting `--origin=http://127.0.0.1:13015` verifying RBAC (`401`/`403`), blank-slate `dxos-architect` presence, `checkLlmHealth`, multi-entity build -> dynamic Kanban/WebGIS/Chatter -> rebuild -> export v3 -> teardown.

- [ ] **Step 1: Write the failing tests**

1. In `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`:
   - Mount `createDxosAiStudioPage`, click `dxos-tab-built-apps`, assert `dxosAi:listBuiltApps` is called, built app row renders with `version` & `status`, clicking `Rebuild` posts `dxosAi:rebuildBuiltApp`, clicking `Export` posts `dxosAi:exportBuiltAppBundle`, clicking `Teardown` posts `dxosAi:teardownBuiltApp` with `keepData: true`.
2. Add Multi-Entity Build / Rebuild / Export / Dynamic Kanban+WebGIS cases to `scripts/eval-vietnamese-nl-agent.mjs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-dxos-ai/tests/vietnamese-nl-eval.test.cjs`
Expected: FAIL on missing `dxos-tab-built-apps` UI and new eval cases.

- [ ] **Step 3: Implement Built Apps Manager UI, NL Eval cases, and `scripts/acceptance-blank-slate-app-builder.mjs`**

1. `ai-studio-page.js`: add `'built-apps'` tab (`Built Apps`) displaying `latticeBuiltApps` list, artifact counts, last verification badge, and `Rebuild` / `Export v3` / `Verify` / `Teardown (Giữ dữ liệu)` actions.
2. `scripts/eval-vietnamese-nl-agent.mjs`: add Multi-Entity Build, Rebuild, Export Bundle v3, Teardown, and Dynamic Kanban+WebGIS Vietnamese NL test cases.
3. `scripts/acceptance-blank-slate-app-builder.mjs` (with Apache-2.0 header, `assertSafeLabOrigin`): sign in as `root` & `employee`, verify non-admin `403` on admin builder/quick-connect/built-apps endpoints, verify unauthenticated `/api/dxosAi:portalAgents` returns `401`, run `checkLlmHealth`, run Multi-Entity Build -> `collectionsMeta` + Kanban/WebGIS/Chatter checks -> Rebuild -> Export v3 -> Teardown (`keepData: true`), clean up test artifacts in `finally`, print `{ result: 'PASS', ... }`.

- [ ] **Step 4: Run all 8 OLP 2026 verification gates**

Run from `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof`:
```powershell
pnpm check
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs tests/nocobase-externals.test.mjs
node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95
pnpm pof:check
pnpm release:sbom -- --check
pnpm audit --prod --audit-level=low
node scripts/source-headers.mjs --check
```
Expected: ALL 8 gates PASS with 0 errors and `>= 95%` NL eval pass rate.

- [ ] **Step 5: Rebuild, pack & upgrade live container `lattice-v100-e2e-nocobase-1` and run live acceptance + browser E2E**

1. Rebuild all affected plugins (`pnpm -r build`; if packing `plugin-enterprise-auth`, run `npm ci --prefix plugins/nocobase/plugin-enterprise-auth --ignore-scripts --no-audit --no-fund`).
2. Pack updated plugins (`npm pack --offline --ignore-scripts`), install/enable/upgrade inside `lattice-v100-e2e-nocobase-1` (`yarn nocobase pm add`, `yarn nocobase pm enable`, `yarn nocobase upgrade`) — keeping Docker Compose stack and `9router` (`127.0.0.1:20128`) running.
3. Run `node scripts/acceptance-blank-slate-app-builder.mjs --origin=http://127.0.0.1:13015` -> Expected `{ result: "PASS" }`.
4. Run headless Playwright browser smoke check against `http://127.0.0.1:13015`:
   - Unauthenticated landing page: **0** `401 EMPTY_TOKEN` console/network errors on `/api/dxosAi:surfaceEvents`.
   - `/admin/settings/workflow/automation` & `/admin/settings/workflow/connectors` & `/admin/settings/dxos-ai`: Workflow Studio UX, non-overlapping AI button, `&amp;` absent in AI status, Quick-Connect LLM card, and Built Apps panel all render cleanly with 0 `401`/`404` errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs scripts/eval-vietnamese-nl-agent.mjs scripts/acceptance-blank-slate-app-builder.mjs
git commit -m "feat(ai,scripts): Built Apps Manager UI, NL eval expansion, blank-slate acceptance script, and live 8-gate verification"
```

# Round 1 Live Dogfooding Audit & Competitive Deep-Research Synthesis (Workflow Automation Studio UX)

- **Branch:** `feat/v1.0.0-olp-championship`
- **Target Host:** NocoBase `2.2.50` (`lattice-v100-e2e` live container @ `http://localhost:13015`, viewport `1440x900`)
- **Audit Method:** Direct end-to-end operator usage on live `Workflow -> Workflow Automation` (screenshots `probe_01`–`probe_04` + Playwright probe `task-18861` & `task-18892`) combined with deep benchmarking against **n8n, Dify, Retool Workflows, Windmill, Pipedream, Activepieces, Zapier, Make.com, LangFlow, and `@xyflow/react` v12**.

---

## 1. Honest & Impartial Live Dogfooding Critique (Observed in Live NocoBase `2.2.50`)

What worked well in Round 1:
- **Menu & Tab Architecture (Approach A):** Promoting `workflow` to an `Outlet` container renders two clean horizontal tabs (`Workflow` + `Workflow Automation`), keeps `@nocobase/plugin-workflow`'s native table intact, hides `dxos-flow-studio` from sidebars while preserving redirect, and puts **Precision Operational Studio** one click away inside NocoBase Settings.
- **Connectors / n8n & Broker Deep Links:** `?tab=automation` and `?tab=broker` deep links navigate accurately.
- **Native Agent Chat + Live Canvas Foundations:** Toolbar `✦ AI Architect` and bottom-right `dxos-portal-ai-float-btn` (`zIndex: 1052`) both open `dxos-architect` natively with live `flowContext`.

Where Round 1 fell short in real hands-on usage (7 concrete UX & engineering gaps):
1. **Viewport Height Overflow (`calc(100vh - 110px)`):** Inside NocoBase `AdminSettingsLayout` (46px topbar + ~98px Settings PageHeader & horizontal tabs + 48px content padding = ~192px chrome), `calc(100vh - 110px)` pushed the collapsible **Playback & Execution Trace Bar** below the `900px` fold, requiring outer page scrolling to see `▶ Chạy thử` traces or HITL banners.
2. **Competing Right Sidebars & Toolbar Wrapping during AI Chat:** Clicking `✦ AI Architect` opened NocoBase's native AI drawer while keeping floating `NodeInspector` (`356px`) open on top of the graph AND wrapped `dxos-flow-toolbar` onto two lines (`probe_04`), squeezing usable canvas space instead of auto-refitting.
3. **No Sample Payload Runner / Scenario Presets for Dry-Run & HITL:** Clicking `▶ Chạy thử` or `⚡ Chạy ngay` unconditionally reused `{ type, data: {} }`. When testing `auto_procurement_hitl_approval` (`if amount > 50,000,000 -> control.approval`), default `{ data: {} }` silently routed to the `false` branch (`completed`), giving operators no UI way to inject `{ data: { amount: 120000000 } }` and trigger a real `suspended` HITL approval gate from the Studio.
4. **Disconnected Manual-Wiring Friction on Leaf Nodes:** Adding the next step required opening top-left `+ Thêm Node` (which drops an unattached node on the canvas) or hunting for small edge `+` handles on existing wires. There was no `+` quick-append button on leaf/output nodes to append + auto-connect in 1 click.
5. **No Pre-Flight Validation Badges or Click-to-Fix Checklist:** Required fields (such as missing `tableKey`, `connectorKey`, or orphan nodes) were only caught server-side on `Lưu`, with no red/amber node indicator badges on canvas and no summary checklist to jump straight to invalid nodes.
6. **Card-Only List View Missing Operational KPIs & Quick Controls:** `FlowListView` listed cards neatly but lacked top-level KPIs (total flows, active count, HITL pending, run success rate), inline Active/Pause switches, and 1-click flow duplication without entering the canvas.
7. **Missing Power-User Ergonomics & Minor Polish:** Empty JSON fields (e.g. `Event Filter (JSON)`) rendered literal `"null"` in textareas; no `● Chưa lưu` unsaved indicator; no trace chip -> canvas auto-focus; no keyboard shortcuts (`Ctrl+S`, `Ctrl+Z` / `Ctrl+Shift+Z`, `Ctrl+K`, `Escape`, `Delete`).

---

## 2. Deep-Research Benchmarking Summary (2025–2026 Industry Leaders)

| Reference Platform | Pattern Studied | Concrete Adaptation for LatticeDX Round 2 |
|---|---|---|
| **n8n / Dify** | Leaf `+` quick-append handle + contextual search popup | Render a `+` quick-append button on node output edges (`onAppendFromNode`) that opens the Quick-Add palette in `"Nối tiếp sau: <Node>"` mode and stitches the new node + edge in one click. |
| **n8n / Retool / Pipedream** | Scenario payload runner + per-step trace pan/focus | Add `🧪 Test Data` popover (`flow-test-runner.js`) that auto-synthesizes realistic trigger payloads (e.g. `> threshold` HITL vs `<= threshold` standard) + editable JSON for Dry-Run & Live Run, plus trace-chip click -> `fitView` focus on the executed node. |
| **Windmill / Activepieces** | Dense operational KPI strip + inline Active/Pause + clone | Add 4-card KPI strip (`Tổng quy trình`, `Đang bật`, `Chờ duyệt HITL`, `Tỷ lệ thành công`), inline Active/Pause toggle, and 1-click `Nhân bản` on every list card. |
| **`@xyflow/react` v12** | Real-time validation badges + `ResizeObserver` `fitView` + shortcuts | Render red/amber validation badges on nodes (`flow-validation.js`), clickable toolbar `✓ Hợp lệ` / `⚠ N lỗi` popover, `ResizeObserver` auto-`fitView` when AI drawer resizes the viewport, and `Ctrl+S` / `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+K` / `Escape` / `Delete` shortcuts. |

---

## 3. Round 2 Scope & File Budget

- Every `.js` module under `src/client/flow/` strictly remains `<= 350` lines with CTU-OpenPaw `SPDX-License-Identifier: Apache-2.0` headers.
- Split helpers cleanly into `flow-studio-helpers.js`, `flow-validation.js`, and `flow-test-runner.js` while upgrading `flow-list-view.js`, `flow-canvas.js`, `node-palette.js`, `node-inspector.js`, `playback-bar.js`, and `flow-studio-app.js`.

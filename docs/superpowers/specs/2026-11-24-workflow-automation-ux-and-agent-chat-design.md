# Workflow Automation Studio UX Redesign, Menu Integration & Native Agent Chat Unification

**Date:** 2026-11-24  
**Worktree:** `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (`feat/v1.0.0-olp-championship`)  
**Scope:** `@latticedx/plugin-dxos-ai` + `@latticedx/plugin-dxos-studio` (`v1.0.0`)

## 1. Problem Statement & User Critique
1. **Fragmented Navigation:** Adding a separate top-level `DX-OS Flow Studio` item in NocoBase's left sidebar splits workflows away from the built-in **Workflow** section (`workflow`), and users ask where **n8n** and **Broker** live.
2. **Duplicate AI Chat Surface:** A standalone `ArchitectDrawer` duplicates NocoBase's native bottom-right **Agent Chat** (`dxos-architect` + `dxos_configure_workflow` MCP tool), splitting conversation history and starving canvas width.
3. **Cramped "Sandwich" Layout:** Permanently mounting `NodePalette` (`248px`), `NodeInspector` (`340px`), global rule settings, duplicate toolbars (`Auto-Layout` x2, `Dry-Run` x2), and `PlaybackBar` shrinks the React Flow canvas below usable dimensions.

## 2. Market UX Deep-Search Benchmark (7 Leading Workflow Studios)

| Platform | Adopted UX Pattern | LatticeDX Precision Studio Adaptation |
| :--- | :--- | :--- |
| **n8n** | Canvas-first infinite graph + hover quick actions + contextual node details overlay | Canvas fills 100% by default; contextual mini-toolbar appears above selected node (`▶ Test`, `⎘ Duplicate`, `✕ Delete`); Inspector opens only on node click |
| **Dify Studio** | Two-stage app workspace (`List` -> `Canvas`) + live card summaries + compact category badges | Clean `flow-list-view.js` home with 1-click n8n/Broker links -> uncluttered Canvas Editor with Live Config Preview inside each node card |
| **Make.com** | Direct field-mapping variable tokens + clear branch port badges | Colored port pills (`true`/`approved` green, `false`/`rejected`/`error` red) + `{ } Variables` tree picker inside Inspector |
| **Activepieces** | Clean linear/tree clarity + natural-language flow drafting directly beside workflow | Unified native NocoBase `dxos-architect` chat (`dxos_configure_workflow`) synced via live SSE without adding a second chat drawer |
| **Retool Workflows** | Compact expression previews + per-node Test JSON sandbox | Isolated **Test This Node** (`Input / Pin` -> `Output` JSON) paired with quick inline node card summary |
| **Windmill** | Fast execution trace timeline scrubber & per-node status/duration pills | Collapsible 38px bottom Execution/HITL strip that expands automatically on `Dry-Run` or `suspended` HITL approval |
| **Langflow / xyflow** | Collapsible floating left component library (`+ Thêm Node`), floating bottom-center HUD dock, toggleable MiniMap | Floating collapsible `NodePalette` (+ edge `+` Quick-Add popover), centered Canvas Dock (`− / + / Fit / Dàn đều / Undo / Redo / Map`), MiniMap hidden by default |

## 3. Infrastructure Map (`n8n` & `Broker`)
- **UI Location (Control Studio `/admin/settings/dxos-studio`):**
  - **MQTT Dynamic Security & FIWARE Orion-LD Broker:** Tab `7. Broker & Sự kiện` (`?tab=broker`) in `builder-broker-panels.js`.
  - **n8n Orchestrator Credentials & Webhook Subscriptions:** Tab `8. Vault & Automation` (`?tab=automation`) + CloudEvents webhook bus.
- **Container Endpoints (External OCI Services in `infra/compose/*.yml` & `v100-live-e2e.yml`):**
  - **n8n:** `n8nio/n8n:2.48.1` (`http://n8n:5678` internal; `127.0.0.1:5678` in `integration.yml`, webhook secret via AES-256-GCM Connector Vault).
  - **Mosquitto MQTT Broker:** `eclipse-mosquitto:2.0.21` (`mosquitto:1883` with DynSec + `nodered:1880` bridge).
  - **FIWARE Orion-LD Context Broker:** `fiware/orion-ld:1.12.0` (`http://orion-ld:1026` / `127.0.0.1:1026`).
- **One-Click Shortcuts in List View:** Add `🔗 Connectors / n8n ↗` (`?tab=automation`) and `📡 Broker (MQTT / Orion-LD) ↗` (`?tab=broker`) directly in `Workflow Automation` List View (`flow-list-view.js`), supported by URL `?tab=` initialization in `studio-settings.js`.

## 4. Target Architecture

### 4.1 Menu Integration (Approach A)
- Register **`workflow.automation`** via `app.pluginSettingsManager.add('workflow.automation', { title: 'Workflow Automation', icon: 'ApartmentOutlined', Component: FlowPage, aclSnippet: 'pm', sort: 20 })` under NocoBase's existing **Workflow** sidebar item (`/admin/settings/workflow/automation`).
- Remove standalone top-level `'dxos-flow-studio'` registration from `pluginSettingsManager` while registering a router alias `/admin/settings/dxos-flow-studio` -> `FlowPage` so existing deep links remain backward-compatible.

### 4.2 Native Agent Chat Unification (`dxos-architect` + SSE `flow-studio`)
- Retire `src/client/flow/architect-drawer.js`.
- **Context Bridge:** `FlowStudioApp` writes sanitized live workspace state (`organizationId`, `ruleKey`, `ruleName`, `selectedNodeId`, `selectedNodeType`, `selectedNodeLabel`, `selectedRunUid`, `selectedRunStatus`, `nodeCount`, `nodeSummary`) to `window.__LATTICEDX_FLOW_CONTEXT__` (cleaned up on unmount).
- **Unified Launcher (`portal-agent-launcher.js`):** Detects `/admin/settings/workflow/automation` and `/admin/settings/dxos-flow-studio`, connects to `dxosAi:surfaceEvents?portalSlug=flow-studio`, injects `flowContext` into `buildHiddenPageSystemContext` when opening native NocoBase `dxos-architect` chat (either from the toolbar `✦ AI Architect` button calling `aiCtx.triggerTask` or the bottom-right launcher emblem), and dispatches `CustomEvent('latticedx:flow-updated', { detail })` on SSE frames (without showing portal page reload banners).
- **Server Broadcast (`ai-builder-tools.js`):** Whenever `dxos_configure_workflow` completes `draftAutomation`, `patchAutomation`, `saveAutomation`, `testAutomation`, `runAutomation`, or `resumeAutomation`, emit `publishSurfaceUpdate('flow-studio', ...)` with sanitized graph/rule/simulation/run payloads (never leaking secrets or `resumeToken`/`resumeTokenHash`).
- **Canvas Live Sync:** `FlowStudioApp` listens to `latticedx:flow-updated`, checks strict `organizationId === effectiveOrg`, applies `draftGraph`/`draftRule` via `commitGraph` (full Undo support!), updates active trace if `simulation`/`run` arrived, and reloads lists when `applied` is true.

### 4.3 Two-Screen Operational Studio UI (`plugin-dxos-studio/src/client/flow/*`)
1. **Screen 1 — List View (`flow-list-view.js`, `<= 280` lines):** Header (`Workflow Automation`, org selector, search, `✦ Tạo bằng AI`, `Mẫu sẵn có (6)`, `+ Tạo luồng mới`), filter pills (`Tất cả`, `Đang bật`, `Tạm dừng`, `Chờ duyệt HITL`) + 1-click infra buttons (`Connectors / n8n ↗`, `Broker ↗`), optional Blueprints gallery, clean workflow cards (`Mở Canvas`, `▶ Chạy`).
2. **Screen 2 — Canvas-First Editor (`<= 350` lines/file):**
   - **Single 52px Toolbar:** `← Danh sách` | Flow Name + status pill | `⚙️ Cài đặt` Popover (`Rule Key`, `Name`, `Cooldown`, `Max Depth`, `Active`, `Blueprints`) || `{ } DSL` | `✦ AI Architect` | `▶ Chạy thử` | `Lưu` | `⚡ Chạy ngay`. Zero duplicate buttons.
   - **Collapsible Left Palette (`node-palette.js`):** Closed by default -> compact top-left `+ Thêm Node` button; expands to floating `264px` palette card or activates automatically in edge `+` Quick-Add mode.
   - **Precision Node Cards & Canvas Dock (`flow-canvas.js`):** `borderRadius: 12`, 4px category accent bar, **Live Config Preview** lines, **Contextual Mini-Toolbar** on selected node (`▶ Test`, `⎘ Nhân bản`, `✕ Xóa`), and centered bottom **Canvas Dock** (`− / + / ⊡ Fit`, `⊞ Dàn đều`, `↶`, `↷`, `🗺 Map` off by default). `fitViewOptions: { padding: 0.24, maxZoom: 1 }`.
   - **Contextual Slide-Over Inspector (`node-inspector.js`):** Hidden unless a node is selected; floats on right (`356px`, `borderRadius: 12`) with `×` Close, 3 tabs, Variable Picker, and collapsed **Nâng cao** accordion.
   - **Collapsible Execution & HITL Drawer (`playback-bar.js`):** Compact `38px` footer strip when collapsed, always showing `dxos-flow-hitl-banner` when `suspended`, and auto-expanding when `Dry-Run` or `Run Now` produces traces.

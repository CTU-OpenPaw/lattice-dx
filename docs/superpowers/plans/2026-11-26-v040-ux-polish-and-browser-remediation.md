<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Implementation Plan — LatticeDX v0.4.0 UX/UI Polish & Deep Browser Audit Remediation

> **Scope:** Remediate every P0 bug, P1 UX/usability gap, and P2 visual/i18n/version polish item uncovered during the live Stage 2 browser audit of `http://127.0.0.1:13015` (`HEAD = 4c63731`), strictly maintaining `< 1.0.0` (`0.4.0`), 7 Apache-2.0 plugins, PG `FORCE RLS`, and Pure-OSI compliance.

## Audit Issues Resolved

### P0 Bugs & Integrity Contradictions
1. **Broken `Main > latticeOrders` Block & `ERR_INSUFFICIENT_RESOURCES` (`/p/logistics/zhfwr9j7i78`):** Clean residual stale `flowModels` block on live stack, mount default `DxosBiChartBlockModel` in `portal-composer.js`, and deduplicate SSE connections via `window.__LATTICEDX_SSE_HUB__` + catch `AbortError` cleanly.
2. **Unauthenticated `/v/track/:code` `401` Console/Network Errors & Missing Token Box:** Add standalone nonce-CSP HTML shell (`public-track-html.js`) via `Gateway.registerRequestHandler` + Nginx `location ^~ /v/track`, proper `<title>`, interactive Code + Token input form, live Ed25519 signature verification button, and zero-PII localized display.
3. **Public Form Submit vs Status Contradiction (`/v/form/:slug`):** Ensure `dxosForms:submit` sets initial business record `status: 'submitted'` (matching receipt) so `dxosForms:status` immediately agrees (`submitted`).
4. **Workflow Version History Contradiction:** When `publishedVersion >= 1` and `latticeAutomationRuleVersions` has 0 rows (seeded baseline), return a synthetic baseline entry (`v1 — Live Baseline`) instead of claiming `"Chưa có phiên bản đã publish nào."`.
5. **DX-OS AI Studio Plane #3 `activeWorkflowsCount: 0` Contradiction:** Aggregate active count from both `latticeAutomationRules` (`active: true`) and native `workflows` (`enabled: true`).
6. **`DxosBiChartBlockModel` Pivot HTTP `400` & Clipped Modal:** Auto-select distinct `secondaryGroupBy` or show inline prompt before querying, expose live viewer controls (collection/metric/groupBy/chartType), add `maxGroups` input, and clamp modal height (`maxHeight: 78vh`, `overflowY: auto`).
7. **`< 1.0.0` Version Leaks in Seeded Demo Data:** Replace `(v1.0.0)` labels in seeded order titles (`seed-v100-championship-showcase.mjs` + live DB) with `(v0.4.0)`.

### P1 High UX/Functional Polish
1. **Left-Rail Categorized Navigation (Directus/Odoo style):** Replace 9-tab horizontal overflow in `ai-studio-page.js` and 11-tab overflow in `studio-settings.js` with responsive grouped left-rail navigation (`1280x800` & `1440x900` zero clipping).
2. **Tab 7 Built Apps Quick-Start (Lovable style):** Provide 3 starter blueprints + inline NL prompt calling `dxosAi:planBuiltApp` directly from the empty state.
3. **Workflow Canvas & Webhook Ergonomics:** Single-row toolbar at `1280px+`, shift floating AI launcher out of inspector/Play button zone, normalize Webhook Copy-cURL display, and fix `ai.agent` inspector EN/VI labels.
4. **Visual DMN & Unified Approval Inbox:** Fix DMN clipped column headers + accept plain unquoted string inputs; surface `diffPreview` (`old -> new`) on Unified Approval Inbox cards (`Tab 11`).
5. **Mobile-First `/v/mobile` PWA:** Put compact touch-friendly approval/task/order/incident cards above the fold instead of burying approvals beneath full-screen AI chat or desktop horizontal tables.

### P2 Polish & Docs Sync
- Human-friendly Vietnamese labels/enums across BI, WMS Ops, Chatter, WebGIS, AI Studio, and Public Form (including 1-click Copy Token button and localized timestamps); bottom padding (`56px`) avoiding `"Powered by NocoBase"` footer pill overlap; duplicate notification bell guard; and sync `README.md` (`54` static / `56` total `FORCE RLS` tables).

## Verification Plan
- Unit + build + `nocobase-externals` tests inside each plugin (`build.mjs` + `node --test`).
- Rebuild & deploy updated plugins + Nginx config into live Docker `:13015`, run `yarn nocobase upgrade`, clean stale live `latticeOrders` placeholder & `v1.0.0` order title, seed active BI Chart & Public Form.
- Pass all 8 OLP host gates (`source-headers`, `pof:check`, `release:sbom -- --check`, `audit --prod`, `pnpm check`, full `node --test --test-concurrency=4`, `eval-vietnamese-nl-agent.mjs`) + live `acceptance-blank-slate-app-builder.mjs` + live `acceptance-live-llm-app-builder.mjs --model=oc/big-pickle`.
- Stage 4 live headless browser re-verification across all fixed journeys at `1440x900` & `1280x800`.

<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX AI Workforce v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng cấp `@latticedx/plugin-dxos-blocks` & `@latticedx/plugin-dxos-ai` lên v3 (Phương án C) với Khung Block Sáng tạo `DxosCreativeStudioBlockModel`, 15 Unified Tools (gồm Deep `flowSurfaces`, Advisor, Time-Machine Rollback, Role-to-Workspace Provisioner), Visual Block Picker + Live Canvas Sync trên trình duyệt, và quay kiểm chứng video Full HD 1080p live.

**Architecture:** Kết hợp NocoBase `flowSurfaces` API cho block chuẩn/đa cột/linkage rules với bộ khung JSON DSL an toàn `DxosCreativeStudioBlockModel` (`@latticedx/plugin-dxos-blocks`), lưu snapshot khôi phục vào `latticeUiSnapshots` và đồng bộ live giữa khung chat `@dxos-architect` (`9router` `ag/gemini-3.8-flash`) với giao diện trang portal đang mở.

**Tech Stack:** Node.js `node:test`, CommonJS NocoBase 2.2.38 SDK (`@nocobase/server`, `@nocobase/database`, `@nocobase/client`, `@nocobase/client-v2`), React, Ant Design, Zod v4 schema helper, `9router` (`ag/gemini-3.8-flash`), Playwright + `ffmpeg`.

**Spec:** [docs/superpowers/specs/2026-11-21-dxos-ai-v3-creative-block-and-surface-architect-design.md](../specs/2026-11-21-dxos-ai-v3-creative-block-and-surface-architect-design.md)

## Global Constraints
- Công tác strictly trong worktree `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof`, nhánh `feat/dxos-ai-workforce-mcp`.
- Giữ nguyên header 8 dòng `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` và Clause 5.2 (`Powered by NocoBase`).
- Trong `plugins/nocobase/plugin-dxos-blocks/src/client/`, chỉ `index.js` được `require` dependency ngoài (`react`, `antd`, `@nocobase/client`, `@nocobase/client-v2`); các file con chỉ `require('./...')`.
- Không hardcode hay in API key ra log/commit; khi setup live Docker `:13014`, truyền `AGENT_BASE_URL=http://host.docker.internal:20128/v1`.

## Review Focus
1. **Employee Isolation:** `dxos-architect` có `portalBindings: ['*']` ở v3 để Admin dùng ở mọi portal, nhưng `portalCopilot` MUST vẫn lọc nghiêm theo role và không bao giờ trả `dxos-architect` cho `ldx_employee` thường; Admin bar `dxos-admin-architect-bar` MUST ẩn với `ldx_employee`.
2. **Unsafe DSL & URL Injection:** `parseCreativeBlueprint` MUST chuẩn hóa theme/columns, giới hạn query (`<=6` & limit `<=50`) và widget (`<=12`), chặn `javascript:`/`http://external` trong `quick-actions` qua `isSafeAppPath`.
3. **Host `flowSurfaces` vs Mock DB:** Cả `addBlock`/`configureNativeBlock` và snapshot/rollback MUST chạy mượt khi host `flowSurfaces` resource vắng mặt (fallback `FlowModelRepository`) lẫn khi có mặt trên NocoBase 2.2.38 live.
4. **Role Escalation Guard in Provisioner:** `dxos_provision_role_workspace` MUST từ chối `root`/`admin`/role không khớp `/^ldx_[a-z][a-z0-9_]{1,40}$/` và bắt buộc `isAdminBuilder: false` cho AI assistant đi kèm role mới.
5. **Cold-Start Table Sync without Upgrade CLI:** `ensureUiSnapshotsReady(db)` MUST sync collection `latticeUiSnapshots` lười (lazy) trên container đang chạy để không 500 trên PostgreSQL sau `docker restart`.

---

### Task 1: `@latticedx/plugin-dxos-blocks` v3 — Creative Studio Block, Visual Picker & Live Sync
**Files:**
- Create: `plugins/nocobase/plugin-dxos-blocks/src/client/creative-studio-block.js`
- Create: `plugins/nocobase/plugin-dxos-blocks/src/client/canvas-architect-bridge.js`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/block-models.js`
- Test: `plugins/nocobase/plugin-dxos-blocks/tests/dxos-blocks-client.test.cjs`, `plugins/nocobase/plugin-dxos-blocks/tests/dxos-creative-and-bridge.test.cjs`

**Interfaces:**
- Produces `createCreativeStudioView(client, React, antd, app)` & `parseCreativeBlueprint(raw)` & `evaluateQueryStats(rows, opts)` from `creative-studio-block.js`.
- Produces `createAdminArchitectBarElement(React, opts)`, `fetchPageSurfaceState(api, params)`, `fetchInspectPageBlocks(api, params)`, `requestPageRollback(api, params)`, `formatTargetBlockPrompt(blockMeta, portalSlug)` from `canvas-architect-bridge.js`.

- [x] Step 1: Viết test RED trong `dxos-blocks-client.test.cjs` & `dxos-creative-and-bridge.test.cjs` và chạy xác nhận fail.
- [ ] Step 2: Hiện thực `creative-studio-block.js`, `canvas-architect-bridge.js`, đăng ký `DxosCreativeStudioBlockModel` + Admin bar + Live Canvas Sync trong `block-models.js`.
- [ ] Step 3: Chạy `node --test plugins/nocobase/plugin-dxos-blocks/tests/*.test.cjs` & `node plugins/nocobase/plugin-dxos-blocks/build.mjs` xác nhận PASS.

### Task 2: `@latticedx/plugin-dxos-ai` v3 — 15 Unified Tools, `latticeUiSnapshots` & Deep `flowSurfaces`
**Files:**
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/ai-surface-creative-tools.js`
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/collections/ui-snapshots.js`
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/migrations/20261121000200-dxos-ui-snapshots.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/{ai-builder-tools,ai-tools-core,ai-schemas,ai-resource,index}.js`, `plugins/nocobase/plugin-dxos-ai/src/client/ai-studio-page.js`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/{ai-creative-and-surface,ai-resource-and-ui}.test.cjs`

**Interfaces:**
- Produces `createSurfaceAndCreativeTools(deps)`, `bumpSurfaceRevision(portalSlug, pageTitle, blockUid)`, `getSurfaceRevisionState(portalSlug, pageTitle)`, `capturePageSnapshot(db, actor, args)`, `restorePageSnapshot(db, actor, args)` từ `ai-surface-creative-tools.js`.

- [ ] Step 1: Viết test RED trong `ai-creative-and-surface.test.cjs` + cập nhật `ai-resource-and-ui.test.cjs`, chạy xác nhận fail.
- [ ] Step 2: Hiện thực schema `uiSnapshots`, migration, `ai-surface-creative-tools.js` (`dxos_recommend_page_blueprint`, `dxos_design_creative_block`, `dxos_snapshot_or_rollback_page`, `dxos_provision_role_workspace`), nâng cấp `dxos_compose_page_blocks` (`addBlock` inline, `setGridLayout`, `configureNativeBlock`), thêm endpoints `pageSurfaceState`/`inspectPageBlocks`/`rollbackPageSnapshot`.
- [ ] Step 3: Chạy `node --test plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs` & `node plugins/nocobase/plugin-dxos-ai/build.mjs` xác nhận PASS.

### Task 3: Acceptance `23/23` & Full Quality Gates + Commit
**Files:**
- Modify: `scripts/acceptance-dxos-ai-and-mcp.mjs`, `scripts/tests/acceptance-dxos-ai-mcp.test.mjs`
- [ ] Step 1: Mở rộng kiểm tra 15 tools + 4 tool mới v3 (`23/23` checks).
- [ ] Step 2: Chạy `source-headers --check`, `pnpm pof:check`, `node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs`, `pnpm check` -> 0 lỗi.
- [ ] Step 3: Commit trên `feat/dxos-ai-workforce-mcp`.

### Task 4: Live Docker Deployment (BOTH Plugins) & Acceptance (`localhost:13014`)
- [ ] Step 1: Sync `dist/` cả `plugin-dxos-blocks` & `plugin-dxos-ai` vào container, restart, chờ HTTP 200.
- [ ] Step 2: Chạy `setup-dxos-ai-workforce.mjs` (`AGENT_BASE_URL=http://host.docker.internal:20128/v1`), `acceptance-dxos-ai-and-mcp.mjs` (`23/23`), `acceptance-logistics-and-rbac.mjs` (`7/7` 403).

### Task 5: Full HD 1080p Live Video & Visual/Release Verification
- [ ] Step 1: Tạo & chạy `record_v3_creative_architect.py` quay trực tiếp `@dxos-architect` chọn block, gợi ý blueprint, sáng tạo block `industrial-cockpit` 2 cột live từ khung chat, tạo role + trang + AI assistant `dxos-cold-inspector`, và test Rollback `⏪ Hoàn tác trang`.
- [ ] Step 2: Kiểm tra `ffprobe` + trích PNG + đọc từng PNG bằng `read_file`, copy 4 preview PNGs vào `<Artifact Directory Path>`.
- [ ] Step 3: Cập nhật `docs/dxos-ai-and-mcp-acceptance.md`, commit, chạy lại trọn bộ gate cuối (`source-headers`, `pof:check`, `node --test`, `pnpm check`, live scripts), hoàn tất báo cáo `<Artifact Directory Path>/dxos-ai-v3-creative-architect-report.md` & `task.md`.

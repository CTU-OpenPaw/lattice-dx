<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Kế hoạch Triển khai v3.1: Single Native Agent Button & Natural Vietnamese Commands

**Goal:** Gỡ bỏ mọi nút AI thừa trên mặt trang, gắn duy nhất 1 nút Agent nổi sử dụng khung chat gốc NocoBase cho `/p/*`, và cho phép `@dxos-architect` hiểu + thực thi trọn vẹn mọi lệnh tiếng Việt đời thường.  
**Spec:** [2026-11-22-dxos-ai-v3-1-single-native-agent-and-natural-language-design.md](../specs/2026-11-22-dxos-ai-v3-1-single-native-agent-and-natural-language-design.md)

## Danh sách Task (TDD)
- [x] **Task 0:** Lưu & commit spec + plan v3.1 (SPDX Apache-2.0).
- [ ] **Task 1 (TDD):** Gỡ `createCopilotStripElement` & `createAdminArchitectBarElement` khỏi `DxosPortalHeroView` (`plugin-dxos-blocks/src/client/block-models.js`) + kiểm thử trong `dxos-blocks-client.test.cjs`.
- [ ] **Task 2 (TDD):** Tạo `plugin-dxos-ai/src/client/portal-agent-launcher.js`, đăng ký qua `this.app.use` trong `src/client/index.js` (ẩn ở `/admin/*`, mở khung chat gốc + hidden system page context + silent Live Sync) + kiểm thử trong `ai-resource-and-ui.test.cjs`.
- [ ] **Task 3 (TDD):** Bổ sung helper tiếng Việt (`stripVietnameseDiacritics`, `slugifyVietnameseToLdxRole`, `inferPortalPrimaryCollection`, `resolveBlockUidByHint`, `resolveFieldNamesByNaturalLabels`, `synthesizeNaturalCreativeBlueprint`) vào `ai-surface-creative-tools.js` + nâng cấp `systemPrompt` của `@dxos-architect` trong `ai-schemas.js` + kiểm thử trong `ai-creative-and-surface.test.cjs`.
- [ ] **Task 4:** Sync live vào Docker (`localhost:13014`) + `setup-dxos-ai-workforce.mjs` (`9router`) + quay & kiểm tra từng frame video `record_v3_1_natural_agent.py` dùng **100% tiếng Việt bình thường**.
- [ ] **Task 5:** Cập nhật `docs/dxos-ai-and-mcp-acceptance.md` (Mục 7), commit sạch và chạy lại đủ 7 cổng kiểm định cuối (`source-headers`, `pnpm pof:check`, `node --test`, `pnpm check`, live setup + `23/23` + `logistics-rbac` `7/7` HTTP `403`).

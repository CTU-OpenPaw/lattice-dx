<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết kế Kỹ thuật v3: `@latticedx/plugin-dxos-blocks` & `@latticedx/plugin-dxos-ai` — Deep Surface Architect, Guardrailed Creative Block Chassis & Visual Live Canvas

**Ngày chốt thiết kế:** 2026-11-21  
**Trạng thái:** Đã duyệt (Phương án C)  
**Nhánh phát triển:** `feat/dxos-ai-workforce-mcp` (công tác trên nền commit `50be4ed`)  
**Vị thế hệ thống:** LatticeDX Enterprise Digital OS 6 Phân hệ — NocoBase `2.2.38` đóng vai trò Plane #6 (`appDataSubstrate`), giữ nguyên attribution Điều 5.2 (*Powered by NocoBase*).

---

## 1. Intent & Vấn đề cần giải quyết từ bản v2

Ở v2 (`50be4ed`), `@dxos-architect` đã chỉnh được `Dxos*` props và RBAC qua API/MCP, nhưng còn 3 khoảng trống lớn khi Quản trị viên tương tác trực tiếp trong UI:
1. **Không sửa sâu & trực tiếp block chuẩn NocoBase:** `dxos_compose_page_blocks(addBlock)` còn tạo trang phụ thay vì chèn trực tiếp block (`table`, `kanban`, `chart`, `filterForm`, `details`, `markdown`...) vào trang đang mở; chưa chia lưới nhiều cột (`12:12`, `8:16`), chưa cấu hình sâu cột/trường/nút/luật phản ứng (`flowSurfaces`).
2. **Thiếu không gian sáng tạo block mới an toàn:** Khi quản trị viên muốn 1 block đặc thù (ví dụ *Đồng hồ đo nhiệt độ kho lạnh + Radar SLA + Tiến độ 5 chặng + Nút hành động RBAC*), Agent chưa có bộ khung chuẩn hóa để sáng tạo tự do trong khuôn khổ mà không dùng `eval`/HTML thô hoặc đụng 17 luật AST gắt của `js-block`.
3. **Thiếu vòng tương tác trực quan tại chỗ:** Quản trị viên chưa thể bấm chọn thẳng block trên màn hình để chat với AI sửa đúng block đó, giao diện chưa tự cập nhật/highlight khi AI vừa sửa trong khung chat (`Live Canvas Sync`), và chưa có nút **Snapshot / Rollback 1 bước** (`Time-Machine`).

---

## 2. Phương án kiến trúc & Trade-offs

| Phương án | Cách tiếp cận | Lý do chọn / loại |
| --- | --- | --- |
| **A — Thuần `flowSurfaces` + `js-block`** | Chỉ dùng action gốc NocoBase & sinh JS tùy biến | **Loại:** LLM hay vướng 17 luật AST `js-block`, thiếu Visual Picker, Live Canvas Sync & Rollback |
| **B — Thuần JSON DSL sáng tạo** | Chỉ tạo block DSL riêng, bỏ qua block chuẩn | **Loại:** Không thêm/sửa sâu cột `Table`, trường `Form` hay luật ẩn/hiện chuẩn |
| **C — Kiến trúc Kép (ĐÃ CHỌN)** | **Deep Native `flowSurfaces` + Khung Sáng tạo `DxosCreativeStudioBlockModel` + Visual Block Picker, Live Sync & Time-Machine Rollback** | Vừa làm được hầu hết thao tác quản trị con người trên block/trang/role/workflow/AI, vừa cho phép AI sáng tạo block đặc thù 100% an toàn, đồng bộ giao diện tức thì |

---

## 3. Thiết kế Chi tiết các Thành phần

### 3.1. Khung Sáng tạo Đa năng (`DxosCreativeStudioBlockModel` trong `@latticedx/plugin-dxos-blocks`)
- Không dùng `eval`, không `dangerouslySetInnerHTML`, không script từ ngoài.
- Dữ liệu cấu hình chuẩn hóa qua `parseCreativeBlueprint(raw)` (`blueprintJson`):
  - **Themes rõ nét:** `'industrial-cockpit'` (`#0f172a` slate cockpit), `'emerald-ops'`, `'amber-alert'`, `'royal-indigo'`, `'clean-light'`.
  - **Bố cục lưới:** `columns` (`1..4`).
  - **Data Queries (`<= 6` queries):** `id`, `kind` (`'collection' | 'telemetry' | 'tasks'`), `collection`, `filter`, `limit` (`<= 50`), hỗ trợ tính toán live `count`, `sum`, `avg`, `min`, `max`, `groupBy`.
  - **Composable Widgets (`<= 12` widgets):** `gauge`, `thermometer` (ngưỡng min/max/warning/critical), `stage-pipeline`, `distribution-bars`, `rule-callout` (điều kiện `gt`/`lt`/`gte`/`lte`/`eq`), `status-matrix`, `quick-actions` (`navigate` với `isSafeAppPath`, `createRecord` qua API chuẩn có RBAC, `askAi` qua `triggerDxosCopilot`).

### 3.2. Bộ 15 Unified Tools (`@latticedx/plugin-dxos-ai` v3 — 11 Admin Builder + 4 Operational)
1. **`dxos_recommend_page_blueprint` (`ALLOW`, Admin only):** Đọc metadata trường của collection mục tiêu và gợi ý Creative Block + Native Blocks + bố cục lưới theo vai trò.
2. **`dxos_design_creative_block` (`ASK` default, `'ALLOW'` cho `@dxos-architect`):** Sanitize & gắn/cập nhật `DxosCreativeStudioBlockModel` lên trang, hỗ trợ `placeBesideBlockUid` để tự động xếp **2 cột `12:12`** cạnh block có sẵn.
3. **`dxos_compose_page_blocks` v3:**
   - `addBlock`: chèn trực tiếp block `Dxos*` hoặc block chuẩn `flowSurfaces` (`table`, `kanban`, `chart`, `filterForm`, `createForm`, `details`, `markdown`, v.v.) lên đúng grid trang hiện tại.
   - `setGridLayout`: sắp xếp hàng/cột với tỷ lệ `span` (`12:12`, `8:16`...).
   - `configureNativeBlock`: gọi `flowSurfaces` (`addField`, `addAction`, `addRecordAction`, `updateSettings`, `setFieldLinkageRules`, `setFieldValueRules`).
   - Tự động lưu snapshot trước khi thay đổi & tăng `surfaceRevision`.
4. **`dxos_snapshot_or_rollback_page` (`ASK` default):** Hỗ trợ `snapshot`, `listSnapshots`, `rollback` khôi phục `rows`, `sizes`, `rowOrder`, toàn bộ block `props`/`use` từ `latticeUiSnapshots`.
5. **`dxos_provision_role_workspace` (`ASK` default):** Tạo role `ldx_*` mới → gán RBAC cấp bảng & trường (`lockedFields`) → tạo Trang/Portal gắn role → dựng Creative Block + Native Table 2 cột → gắn Workflow tùy chọn → tự tạo Nhân sự AI `latticeAiProfiles` chuyên trách phục vụ đúng role mới (`isAdminBuilder: false`).

### 3.3. Visual Block Picker, Time-Machine & Live Canvas Sync (`@latticedx/plugin-dxos-blocks`)
- Hiển thị thanh `AdminArchitectBar` (`data-testid="dxos-admin-architect-bar"`) chỉ cho Admin (`allowAll` / `allowConfigUI` / có quyền `dxos-architect`), ẩn hoàn toàn với `ldx_employee` thường:
  - **`🎯 Chọn Block sửa với AI`:** Đọc `dxosAi:inspectPageBlocks`, viền chọn tương tác từng block, bấm chọn sẽ mở `@dxos-architect` kèm ngữ cảnh `[Target Portal: /p/<slug> · Block UID: <uid>]`.
  - **`⏪ Hoàn tác trang`:** Gọi `dxosAi:rollbackPageSnapshot` khôi phục bản gần nhất.
  - **Live Canvas Sync:** Poll `dxosAi:pageSurfaceState` (mở rộng cho `loggedIn`), khi `revision` tăng từ lần mount ban đầu sẽ đồng bộ props `Dxos*` tại chỗ + bật banner `data-testid="dxos-live-canvas-sync-banner"` + reload mượt nếu số lượng/thứ tự block thay đổi.

---

## 4. Constraints, Non-Goals & Security Guardrails

- **Không phá RBAC & Isolation:** Toàn bộ 11 Admin tool chặn 403/JSON-RPC `-32003` nếu không phải `root`/`admin`. `dxos_provision_role_workspace` cấm tạo/sửa `root`/`admin` hoặc role không khớp `/^ldx_[a-z][a-z0-9_]{1,40}$/`, và trợ lý AI sinh cho role mới luôn có `isAdminBuilder: false`.
- **Không XSS / RCE / External Network từ DSL:** Mọi URL điều hướng trong `quick-actions` lọc qua `isSafeAppPath`, mọi ghi dữ liệu vẫn qua NocoBase REST RBAC, không cho phép nhúng HTML/JS thô hay URL ngoài.
- **Bundler Rule của `plugin-dxos-blocks`:** Mọi module phụ trợ dưới `plugins/nocobase/plugin-dxos-blocks/src/client/` không được `require` gói ngoài (chỉ relative `./...` và nhận `(client, React, antd, app)` từ entrypoint).
- **PoF & Apache-2.0:** Mọi file mới giữ nguyên header `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` và Clause 5.2 attribution.

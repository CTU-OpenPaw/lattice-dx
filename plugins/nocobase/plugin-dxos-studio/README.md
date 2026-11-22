# `@latticedx/plugin-dxos-studio`

Trung tâm quản trị **DX-OS Admin Control Studio** (`/admin/settings/dxos-studio`) và phân hệ nghiệp vụ mẫu thứ hai (`latticeServiceTickets`) cho NocoBase 2.2.38.

## Năng lực chính
- **Tab 1 — Quy trình Poka-yoke:** Cài 1-click 4 mẫu quy trình native NocoBase (`procurement`, **`logistics-5step` liên phòng ban 5 bước**, `incident-uc2`, và `internal-service`) và mở chỉnh tiếp trực tiếp trong Workflow Designer.
- **Tab 2 — Dựng cổng đa-block:** Gọi `dxosStudio:composePortals` tạo trang dữ liệu + trang Tổng quan kết hợp sẵn các block DX-OS (giữ nguyên mọi trang quản trị viên đã chỉnh sửa).
- **Tab 3 — Hệ sinh thái 6 Plugin Open-Core:** Theo dõi trạng thái bật/tắt của toàn bộ 6 plugin `@latticedx/*` và mở nhanh Plugin Manager của NocoBase.
- **Tab 4 — Sẵn sàng PoF & Hệ thống:** Thống kê trực tiếp collections, portals, workflows, tài liệu P.A.R.A. và phiếu dịch vụ nội bộ.
- **Collection thứ hai `latticeServiceTickets` (`uiManageable: true`):** Hỗ trợ mẫu quy trình Dịch vụ nội bộ / Nghỉ phép & Hỗ trợ IT với ACL 7 vai trò và cô lập theo tổ chức.

## Giấy phép & Kiểm thử
- Giấy phép: Apache-2.0 ([`LICENSE`](LICENSE)). Host NocoBase cung cấp SDK tại runtime (`sdkProvidedByHost: true`).
- Kiểm thử: `node --test plugins/nocobase/plugin-dxos-studio/tests/*.test.cjs`
- Build: `node plugins/nocobase/plugin-dxos-studio/build.mjs`

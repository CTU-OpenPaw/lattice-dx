<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Kịch bản Trình diễn & Kiểm chứng Trực tiếp (15 phút Demo Pack)

Tài liệu này hướng dẫn Giám khảo / Quản trị viên tự kiểm chứng toàn bộ nền tảng **LatticeDX DX-OS Open-Core** trực tiếp từ môi trường cài sạch NocoBase `2.2.38`, không cần sửa mã nguồn thủ công.

---

## Phút 0–3: Cài sạch hoàn toàn & Kiến trúc 7 Plugin Open-Core (6 Phân hệ DX-OS)

1. Bảo đảm Docker Desktop đã khởi động, sau đó dựng một môi trường NocoBase trắng (0 bảng ban đầu) cùng toàn bộ **7 plugin Apache-2.0**:
   ```sh
   pnpm native:clean --port=13014
   ```
2. Nạp 4 Cổng nghiệp vụ đa vai trò (Mua sắm, Sự cố IoT, Logistics, Dịch vụ Nội bộ & P.A.R.A.), trang Tổng quan Đa-Block, dữ liệu mẫu và bộ 5 Starter AI Workforce + 2-Way IT/OT MCP:
   ```sh
   node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
   node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"
   pnpm setup:dxos-ai -- --origin=http://localhost:13014
   ```
3. Mở trình duyệt tại `http://localhost:13014`, đăng nhập quản trị (`admin@nocobase.com` / `admin123`) và truy cập `/admin/pm/list` để kiểm tra đủ 7 plugin `@latticedx/*` đang bật (`@latticedx/plugin-action-bridge`, `@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-enterprise-auth`, `@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-blocks`, `@latticedx/plugin-dxos-studio`, `@latticedx/plugin-dxos-ai`).
4. Kiểm tra chân trang giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.38`, `License settings`).

---

## Phút 3–7: Xây dựng Hệ thống từ NocoBase với DX-OS Control Studio

1. Mở `/admin/settings/dxos-studio` (**DX-OS Control Studio — Xây dựng Hệ thống từ NocoBase**).
2. Tại tab **`1. Quy trình Poka-yoke`**:
   - Chọn mẫu **`Điều phối Logistics 5 bước Poka-yoke (latticeOrders)`** hoặc **`Quy trình Phiếu Dịch vụ Nội bộ (latticeServiceTickets)`**.
   - Kiểm tra danh sách nhân sự theo đơn vị đã gán sẵn cho từng vai trò (`Kho`, `Điều phối`, `Tài xế`, `Quản lý`), bấm **`Cài đặt quy trình vào NocoBase`**.
   - Bấm lại lần nữa để kiểm chứng tính idempotent (`Quy trình "..." đã tồn tại`), rồi bấm **`Mở Workflow Designer`** để xem đồ thị node nối tiếp `upstreamNode -> downstreamId` trong trình thiết kế Workflow native của NocoBase.
3. Tại tab **`2. Dựng cổng đa-block`**:
   - Bấm **`Dựng Cổng Đa-Block ngay`** để bảo đảm 4 cổng (`/p/procurement`, `/p/incidents`, `/p/logistics`, `/p/services`) đều có trang Tổng quan kết hợp các Block tùy biến mà không ghi đè trang đã chỉnh tay.
4. Tại tab **`3. Hệ sinh thái 7 Plugin`** và **`4. Sẵn sàng PoF & Hệ thống`**:
   - Quan sát trạng thái 7 plugin, chỉ số thực tế (`Portals đang quản lý`, `Workflow native`, `Tài liệu P.A.R.A.`, `Phiếu dịch vụ nội bộ`, `AI Workforce`, `Audit logs`) và đường dẫn tới **`/admin/settings/dxos-ai`** (**AI Workforce & 6-Plane Center**) hoặc Plugin Manager (`/admin/pm/list`).
5. Mở **`/admin/settings/dxos-ai`**: kiểm tra **Bản đồ 6 Phân hệ Enterprise OS** (Keycloak SSO, Orion-LD Digital Twin, n8n Bus, Portals + P.A.R.A., AI Workforce + `/api/dxos-mcp`, NocoBase `2.2.38` Plane #6), thử tạo/nhân bản 1 AI Employee động và bật chip **Trợ lý AI ngữ cảnh** ngay trên `/p/services`.

---

## Phút 7–11: Tùy biến Trực tiếp qua NocoBase UI Editor (`Add block`) & P.A.R.A.

1. Chuyển tới `/p/services` (hoặc `/p/logistics` / `/p/procurement`) và kiểm tra trang Tổng quan DX-OS.
2. Bật chế độ chỉnh sửa giao diện (UI Editor) của NocoBase trên trang, mở **`Add block`** và kiểm tra sự hiện diện của **6 DX-OS configurable BlockModels**:
   - `DX-OS Portal Hero & Quick Actions`
   - `DX-OS KPI Metric Grid`
   - `DX-OS NGSI-LD Context & Telemetry`
   - `DX-OS AI Proposal & Evidence`
   - `DX-OS Workflow & My Tasks`
   - `DX-OS P.A.R.A. Knowledge Vault`
3. Thêm hoặc chỉnh cấu hình một block (ví dụ đổi `Tiêu đề Hero`, `Mã màu nhấn (Hex)` hoặc `Số cột (1-4)` trong **`Tùy biến Block DX-OS`** / `dxosBlockSettings`), lưu cấu hình, tắt UI Editor, nhấn **Ctrl+Shift+R** tải lại trang để kiểm chứng cấu hình lưu bền trong PostgreSQL.
4. Mở trang **`Tài liệu P.A.R.A.`** (`latticeParaDocuments`) và **`Phiếu Dịch vụ Nội bộ`** (`latticeServiceTickets`), tạo mới 1 bản ghi mẫu từ giao diện.

---

## Phút 11–13: Phân tách Quyền Vai trò (Nhân viên vs Quản trị)

1. Đăng xuất tài khoản quản trị và đăng nhập tài khoản Nhân viên demo (`native.lab.employee@example.invalid` / `NativeLab-2026!`).
2. Quan sát menu chuyển cổng chỉ hiển thị các cổng được phép (`Mua sắm & Tài sản`, `Dịch vụ Nội bộ & Danh bạ`), ẩn cổng Vận hành/Logistics và các trang cấu hình quản trị `/admin/settings/*`.
3. Xác nhận các block `DX-OS Workflow & My Tasks` (`workflowManualTasks:listMine`) và `DX-OS P.A.R.A. Knowledge Vault` tải mượt mà theo đúng phạm vi tổ chức, không phát sinh lỗi `403` / `5xx`.

---

## Phút 13–15: Kiểm toán Nguồn mở (PoF) & Tái tạo từ Gói Nguồn (Non-Git Tarball)

Trên terminal tại thư mục gốc (hoặc trong thư mục giải nén từ gói `.tar.gz` không chứa `.git`):

```sh
node scripts/source-headers.mjs --check
pnpm pof:check
pnpm release:tarball
```

Giải nén `output/release/latticedx-0.1.0-src.tar.gz` sang thư mục tạm ngoài workspace (không có `.git/`), kiểm tra `COPYRIGHT.txt`, `NOTICE`, `LICENSE` và chạy lại:

```sh
pnpm install --frozen-lockfile
pnpm pof:check
pnpm check
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs
```

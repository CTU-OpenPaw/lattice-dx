<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Kịch bản Trình diễn & Kiểm chứng Trực tiếp (`v1.0.0` · 15 phút Demo Pack)

Tài liệu này hướng dẫn Giám khảo / Quản trị viên tự kiểm chứng toàn bộ nền tảng **LatticeDX `v1.0.0` (DX-OS Open-Core Championship Edition)** trực tiếp từ môi trường cài sạch NocoBase `2.2.50`, không cần sửa mã nguồn thủ công. (Xem thêm kịch bản thuyết trình chi tiết từng phút cho Vòng Chung kết tại [FINALS_15MIN_SCRIPT.md](FINALS_15MIN_SCRIPT.md)).

---

## Phút 0–3: Cài sạch hoàn toàn, 7 Plugin `1.0.0` & Dữ liệu Showcase `v1.0.0`

1. Bảo đảm Docker Desktop đã khởi động, sau đó dựng một môi trường NocoBase `2.2.50` trắng (0 bảng ban đầu) cùng toàn bộ **7 plugin Apache-2.0 (`1.0.0`)**:
   ```sh
   pnpm native:clean --port=13014
   ```
2. Nạp 4 Cổng nghiệp vụ đa vai trò (Mua sắm, Sự cố IoT, Logistics, Dịch vụ Nội bộ & P.A.R.A.) + cổng di động **`/v/mobile`**, trang Tổng quan Đa-Block, bộ 5 Starter AI Workforce + 17 Tools + 2-Way IT/OT MCP và dữ liệu trình diễn `v0.3.0` + `v1.0.0`:
   ```sh
   node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
   node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"
   pnpm setup:dxos-ai -- --origin=http://localhost:13014
   NOCOBASE_ADMIN_PASSWORD="<admin-password>" node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
   NOCOBASE_ADMIN_PASSWORD="<admin-password>" pnpm seed:v100-showcase -- --origin=http://localhost:13014
   ```
3. Mở trình duyệt tại `http://localhost:13014`, đăng nhập quản trị (`admin@nocobase.com` / `admin123`) và truy cập `/admin/pm/list` để kiểm tra đủ 7 plugin `@latticedx/*` đều đang bật ở phiên bản **`1.0.0`**:
   - `@latticedx/plugin-action-bridge` (`1.0.0`)
   - `@latticedx/plugin-lattice-foundation` (`1.0.0`)
   - `@latticedx/plugin-enterprise-auth` (`1.0.0`)
   - `@latticedx/plugin-dxos-para` (`1.0.0`)
   - `@latticedx/plugin-dxos-blocks` (`1.0.0`)
   - `@latticedx/plugin-dxos-studio` (`1.0.0`)
   - `@latticedx/plugin-dxos-ai` (`1.0.0`)
4. Kiểm tra chân trang giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`).

---

## Phút 3–7: DX-OS Control Studio (6 Tab + 6 Governance Consoles) & AI Workforce Center

1. Mở `/admin/settings/dxos-studio` (**DX-OS Control Studio — Xây dựng Hệ thống từ NocoBase**).
2. Tại tab **`1. Quy trình Poka-yoke`**:
   - Chọn mẫu **`Logistics liên phòng ban 5 bước (Đơn vận chuyển) (latticeOrders)`** hoặc **`Miền thứ 2 — Dịch vụ Nội bộ & Nghỉ phép (latticeServiceTickets)`**, bấm **`Cài đặt quy trình vào NocoBase`**.
   - Bấm lại lần nữa để kiểm chứng tính idempotent (`Quy trình "..." đã tồn tại`), rồi bấm **`Mở Workflow Designer`** xem đồ thị node nối tiếp `upstreamNode -> downstreamId`.
3. Tại tab **`2. Dựng cổng đa-block`** & **`6. GitOps Bundle`**:
   - Bấm **`Dựng Cổng Đa-Block ngay`** để bảo đảm 4 cổng (`/p/procurement`, `/p/incidents`, `/p/logistics`, `/p/services`) và `/v/mobile` đồng bộ đủ block tùy biến.
   - Chuyển sang tab **`6. GitOps Bundle`**: bấm **`Xuất Bundle JSON`** xem gói **`latticedx.solution-bundle/v3`** (bao gồm `roles`, `portals`, `routesAndBlocks`, `governance`, `workflows`, `customCollections`, `aiProfiles` đã lọc sạch secret + mã băm SHA-256), sau đó thử **`Kiểm tra Diff (Dry-Run)`**.
4. Mở thanh **`Quản trị DX-OS v1.0:`** ngay dưới thanh tab để kiểm chứng **6 Governance Consoles**:
   - `1. Khóa API Phạm vi (PaaS PAT)` (`ldx_pat_*`), `2. Sổ cái Mật mã Ed25519 & Merkle` (Verify chain), `3. Phân tầng Dữ liệu, Reading Room, Cách ly & MKT` (tính Arrhenius MKT & Freeze Cold Snapshot), `4. Kho lạnh FEFO, Tạm giữ MKT & Chứng từ ePOD` (`ORD-V100-001`, `LOT-V100-FEFO-A`, `LOT-V100-MKT-HOLD`), `5. Bảng Quyết định DMN` (`cold_chain_approval_v1`), `6. Ủy quyền Vai trò Có Phạm vi & Thời hạn`.
5. Mở **`/admin/settings/dxos-ai`**: kiểm tra **Tab 1 (`1. Hệ điều hành 6 Phân hệ`)**, **Tab 2 (`2. Quản trị Nhân sự AI Động` — 17 Unified Tools: 11 Admin Builder + 6 Operational)**, **Tab 3 (`3. Cổng Enterprise MCP 2 Chiều`)**, **Tab 5 (`5. Hạn mức & Chi phí AI`)**, và **Tab 6 (`6. Duyệt AI (HITL)`)** kèm kết quả quét chủ động (`dxosAi:triageScan`).

---

## Phút 7–11: 10 Native v2 BlockModels, WebGIS, Kanban, PKI/Lineage & Mobile PWA

1. Mở **`/p/logistics`**: kiểm tra **`DxosKanbanScheduleBlockModel`** (chuyển đổi giữa chế độ Kanban 6 cột & Lịch biểu 7 ngày) và **`DxosRecordWorkbenchBlockModel`** (huy hiệu **Ed25519 PKI**, ngăn **Phả hệ dữ liệu Lineage**, nút **In chứng từ** dùng `<iframe sandbox="" srcDoc>`, và xuất **CSV/XLSX/PDF Unicode** kiểm soát RBAC).
2. Mở **`/p/incidents`**: kiểm tra **`DxosWebGisBlockModel`** (bản đồ chuỗi lạnh Việt Nam hiển thị các bản ghi DB đã seed gồm `COLD-CHILLER-CT-01`, `REEFER-TRUCK-HCM-02`, `COLD-HUB-DN-03` tại `LOC-CT-COLD-01`, `LOC-HCM-HUB-02`, `LOC-DN-HUB-03` kèm trạng thái **Digital Twin Shadow**; `HUB-CT` chỉ xuất hiện làm marker dự phòng khi DB trống chưa seed), **`DxosContextTelemetryBlockModel`**, **`DxosAiProposalBlockModel`**, và mở nút Agent nổi duy nhất góc dưới phải (`PortalAgentLauncher`) để thử tra cứu GraphRAG `#16 dxos_graph_impact_analysis`.
3. Mở **`/p/services`**: kiểm tra **`DxosParaVaultBlockModel`** (`latticeParaDocuments`), thử bật **UI Editor -> `Add block`** và kiểm tra sự hiện diện của toàn bộ **10 Native v2 BlockModels**:
   - `DxosPortalHeroBlockModel` (`DX-OS Portal Hero & Quick Actions`)
   - `DxosKpiMetricBlockModel` (`DX-OS KPI Metric Grid`)
   - `DxosContextTelemetryBlockModel` (`DX-OS NGSI-LD Context & Telemetry`)
   - `DxosAiProposalBlockModel` (`DX-OS AI Proposal & Evidence`)
   - `DxosWorkflowTasksBlockModel` (`DX-OS Workflow & My Tasks`)
   - `DxosParaVaultBlockModel` (`DX-OS P.A.R.A. Knowledge Vault`)
   - `DxosCreativeStudioBlockModel` (`DX-OS Creative Studio Micro-App [AI]`)
   - `DxosRecordWorkbenchBlockModel` (`DX-OS Chatter, Chứng từ & Xuất báo cáo`)
   - `DxosWebGisBlockModel` (`DX-OS Bản đồ Giám sát WebGIS [D]`)
   - `DxosKanbanScheduleBlockModel` (`DX-OS Bảng Kanban & Lịch [H]`)
4. Mở **`/v/mobile`**: kiểm tra tuyến **Mobile Field PWA** (`/api/dxos:manifest`, `/api/dxos:sw.js`, hàng đợi ngoại tuyến cho `dxosWms:epodCapture` & `dxosBlocks:twinSetDesired`).

---

## Phút 11–13: Phân tách Quyền Vai trò (Nhân viên vs Quản trị) & Nghiệm thu Headless PaaS

1. Đăng xuất tài khoản quản trị và đăng nhập tài khoản Nhân viên demo (`native.lab.employee@example.invalid` / `NativeLab-2026!`).
2. Quan sát menu chuyển cổng chỉ hiển thị các cổng được phép (`Mua sắm & Tài sản`, `Dịch vụ Nội bộ & Danh bạ`, `Logistics · Đơn của tôi`), ẩn cổng Vận hành/Sự cố và các trang cấu hình quản trị `/admin/settings/*`.
3. Trên terminal, chạy bộ nghiệm thu Headless PaaS & AI/MCP tự động:
   ```sh
   pnpm acceptance:headless-paas -- --origin=http://localhost:13014
   pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
   pnpm acceptance:logistics-rbac -- "<path-to-report.json>"
   ```

---

## Phút 13–15: Kiểm toán Nguồn mở (PoF), SBOM CycloneDX 1.5 & Tái tạo từ Gói Nguồn

Trên terminal tại thư mục gốc (hoặc trong thư mục giải nén từ gói `.tar.gz` không chứa `.git`):

```sh
node scripts/source-headers.mjs --check
pnpm pof:check
node scripts/generate-sbom.mjs --check
pnpm release:tarball
```

Giải nén `output/release/latticedx-1.0.0-src.tar.gz` sang thư mục tạm ngoài workspace (không có `.git/`), kiểm tra `COPYRIGHT.txt`, `NOTICE`, `LICENSE`, `docs/sbom-cyclonedx.json` (`209` thành phần) và chạy lại:

```sh
pnpm install --frozen-lockfile
pnpm pof:check
pnpm check
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs tests/nocobase-externals.test.mjs
```

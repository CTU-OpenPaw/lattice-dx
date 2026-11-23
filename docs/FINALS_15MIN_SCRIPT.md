<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Kịch bản Trình diễn Chung kết 15 Phút — OLP PMNM 2026 (`v1.0.0`)

Kịch bản tác chiến từng phút (**0:00–15:00**) dành cho đội **CTU-OpenPaw** trình diễn **LatticeDX `v1.0.0` (DX-OS Open-Core Championship Edition)** trước Hội đồng Giám khảo Chung kết VFOSSA.

---

## 0. Chuẩn bị Trước giờ G (T-5 Phút)

### Khởi động & Nạp Showcase `v1.0.0` (trên cổng cô lập `13014`)
```sh
pnpm native:clean --port=13014
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"
pnpm setup:dxos-ai -- --origin=http://localhost:13014
NOCOBASE_ADMIN_PASSWORD="<admin-password>" node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
NOCOBASE_ADMIN_PASSWORD="<admin-password>" pnpm seed:v100-showcase -- --origin=http://localhost:13014
```

### Danh sách Tài khoản & Màn hình Mở sẵn (Browser Tabs)
- **Tài khoản Demo Cục bộ** (tuyệt đối không dùng ngoài môi trường lab):
  - **Quản trị / Root:** `admin@nocobase.com` / `admin123` (hoặc `NOCOBASE_ADMIN_PASSWORD`)
  - **Nhân viên (Negative RBAC):** `native.lab.employee@example.invalid` / `NativeLab-2026!`
  - **Đội ngũ Logistics 5 bước:** `native.lab.manager@example.invalid`, `native.lab.worker@example.invalid`, `native.lab.dispatcher@example.invalid`, `native.lab.driver@example.invalid` (mật khẩu chung `NativeLab-2026!`)
- **Các Tab Trình duyệt Chuẩn bị sẵn:**
  1. `http://localhost:13014/admin/settings/dxos-ai` (Trung tâm 6 Phân hệ, AI Workforce & HITL)
  2. `http://localhost:13014/admin/settings/dxos-studio` (Control Studio, 6 Governance Consoles & GitOps Bundle v3)
  3. `http://localhost:13014/p/logistics` (Logistics 5 bước, Kanban/Schedule, PKI & Printable Voucher)
  4. `http://localhost:13014/p/incidents` (WebGIS Chuỗi lạnh, IIoT Digital Twin & GraphRAG Copilot)
  5. `http://localhost:13014/v/mobile` (Mobile Field PWA ngoại tuyến)

---

## 1. Diễn tiến Từng phút (0:00 – 15:00)

### 0:00 – 2:00 · Mở bài: DX-OS Open-Core 6 Phân hệ & Tuân thủ Chuẩn Mở
- **Màn hình:** `/admin/settings/dxos-ai` (Tab `1. Hệ điều hành 6 Phân hệ`) -> `/admin/pm/list` -> chân trang hệ thống.
- **Thao tác & Thông điệp:**
  1. Định vị bài toán: Doanh nghiệp Việt cần **Hệ điều hành Doanh nghiệp Số (H–P–D–I)** chứ không chỉ một công cụ CRUD rời rạc. LatticeDX điều phối **6 phân hệ** với **NocoBase `2.2.50`** làm **Plane #6 (`appDataSubstrate`)**.
  2. Chỉ rõ **7 plugin Apache-2.0 (`1.0.0`)** bật/tắt sống trong `/admin/pm/list` (`sdkProvidedByHost: true`), giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`).
  3. Nhấn mạnh **Cam kết Thuần khiết Giấy phép OSS**: 0% BSL-1.1 (loại bỏ ThingsBoard/EMQX), thay hoàn toàn bằng Mosquitto, Node-RED, TimescaleDB `-oss`, Prometheus, OTel Collector.

### 2:00 – 5:30 · Trình diễn Plug-and-Play: Chuỗi lạnh OMS/WMS/FEFO/ePOD, PKI & DMN
- **Màn hình:** `/p/logistics` -> `/admin/settings/dxos-studio` (Governance Consoles).
- **Thao tác & Thông điệp:**
  1. Trên **`/p/logistics`**, giới thiệu **`DxosKanbanScheduleBlockModel`** (vận đơn `ORD-V100-001` Cần Thơ -> TP.HCM, chuyển nhanh qua chế độ Lịch 7 ngày).
  2. Trên **`DxosRecordWorkbenchBlockModel`**:
     - Bấm xác minh huy hiệu **Ed25519 PKI & Merkle Ledger** (`dxosLedger:verify`).
     - Mở ngăn **Phả hệ dữ liệu (Lineage)** (`dxosDataGov:lineageTrace`).
     - Bấm **In chứng từ** (`dxosWms:printVoucher` hiển thị an toàn trong `<iframe sandbox="" srcDoc>` kèm mã QR xác thực).
  3. Chuyển sang **`/admin/settings/dxos-studio`** thanh **`Quản trị DX-OS v1.0:`**:
     - Mở Console **`Kho FEFO & ePOD`**: chỉ ra lô `LOT-V100-FEFO-A` đã phân bổ FEFO và lô `LOT-V100-MKT-HOLD` bị khóa bởi **Arrhenius MKT**.
     - Mở Console **`Bảng Quyết định DMN`**: chạy thử đánh giá bảng `cold_chain_approval_v1` (`maxTempC: 9.5` -> `quality_hold_director`, SLA 15 phút) — không dùng `eval()`.
     - Lướt nhanh Console **`Sổ cái Mật mã Ed25519 & Merkle`** & **`Dữ liệu Ấm/Lạnh & MKT`** (Cold Frozen Snapshot đã niêm phong chữ ký).

### 5:30 – 9:00 · IT/OT WebGIS, 2-Way Digital Twin, Proactive Triage & GraphRAG #16 / HITL
- **Màn hình:** `/p/incidents` -> Floating `PortalAgentLauncher` -> `/admin/settings/dxos-ai` (Tab `6. Duyệt AI (HITL)`).
- **Thao tác & Thông điệp:**
  1. Trên **`/p/incidents`**, chỉ vào **`DxosWebGisBlockModel`**: bản đồ các kho lạnh Việt Nam hiển thị trực tiếp từ các bản ghi DB đã seed (`COLD-CHILLER-CT-01`, `REEFER-TRUCK-HCM-02`, `COLD-HUB-DN-03` gắn tọa độ `LOC-CT-COLD-01`, `LOC-HCM-HUB-02`, `LOC-DN-HUB-03`; `HUB-CT` chỉ là marker dự phòng khi DB trống chưa seed) cùng trạng thái **Digital Twin Shadow** (`synced` / `pending_hitl` / `dispatched`).
  2. Chỉ **`DxosContextTelemetryBlockModel`** (telemetry nhiệt độ chuỗi thời gian có ngưỡng cảnh báo `8.9°C > 8°C`) và **`DxosAiProposalBlockModel`**.
  3. Mở **1 nút Agent nổi duy nhất (`PortalAgentLauncher`)** góc dưới phải -> nhập câu tiếng Việt tự nhiên:
     > *"Phân tích ảnh hưởng dây chuyền nếu kho lạnh COLD-CHILLER-CT-01 gặp sự cố quá nhiệt trên toàn bộ chuỗi"*
     - Hệ thống gọi **`#16 dxos_graph_impact_analysis`** (`collection: 'latticeAssets'`, `recordCode: 'COLD-CHILLER-CT-01'`, `maxDepth: 3`) truy vết từ `latticeAssets` -> `latticeStockLots` -> `latticeOrderLines` -> `latticeOrders` -> `latticeEpodRecords` (có redaction PII).
  4. Chuyển sang **`/admin/settings/dxos-ai` -> Tab `6. Duyệt AI (HITL)`**:
     - Bấm **Quét Sự cố Chủ động (`dxosAi:triageScan`)** để thấy agent tự đối chiếu Twin/Kho/Đơn hàng và đẩy đề xuất `dxos_wms_hold_lot` hoặc `dxos_twin_set_desired` (khi lệch setpoint `> 2.0°C`) vào hàng chờ phê duyệt con người.
     - Giải thích cơ chế an toàn: **AI chỉ đề xuất, người có thẩm quyền ACL bấm Duyệt (`dxosAi:approveAction`) mới thực thi xuống CSDL & Node-RED MQTT downlink (`latticedx/<orgId>/<assetKey>/command`)**.

### 9:00 – 11:30 · Mobile Field PWA (`/v/mobile`) & Tri thức P.A.R.A. / Office OCR Autofill
- **Màn hình:** `/v/mobile` (bật DevTools Mobile Viewport ~`390px`) -> `/p/services`.
- **Thao tác & Thông điệp:**
  1. Mở **`/v/mobile`**: trình diễn giao diện hiện trường PWA (`/api/dxos:manifest`, `/api/dxos:sw.js`), nhấn mạnh bất biến bảo mật **`NetworkOnly` cho mọi `/api/*`** và **Hàng đợi ngoại tuyến (`localStorage`)** cho `dxosWms:epodCapture` & `dxosBlocks:twinSetDesired`.
  2. Quay lại **`/p/services`**: chỉ **`DxosParaVaultBlockModel`** (tìm kiếm lai `pgvector` HNSW + RRF) và giới thiệu API trích xuất tự động từ PDF/DOCX/XLSX/PPTX & OCR điền biểu mẫu (`POST /api/latticePara:extractFormFields`).

### 11:30 – 13:30 · Headless PaaS, 2-Way MCP, GitOps Bundle v3 & PoF / SBOM
- **Màn hình:** `/admin/settings/dxos-studio` (Tab `6. GitOps Bundle`) + Terminal.
- **Thao tác & Thông điệp:**
  1. Trên Tab **`6. GitOps Bundle`**, bấm **`Xuất Bundle JSON`** (`latticedx.solution-bundle/v3`) chứa đồng bộ Roles, Portals, `routesAndBlocks`, `governance` (DMN/SLA/Rules), Workflows & AI Profiles đã gỡ sạch mọi secret.
  2. Trên Terminal, chạy nhanh các lệnh chứng minh **Headless PaaS + PoF + SBOM**:
     ```sh
     curl -s http://localhost:13014/api/dxos:health
     pnpm acceptance:headless-paas -- --origin=http://localhost:13014
     node scripts/generate-sbom.mjs --check
     pnpm pof:check
     ```
     - Nêu rõ: **8 suite Headless PaaS PASS** (PAT `ldx_pat_*`, Ed25519 Merkle verify, Cold Snapshot, FEFO/ePOD + Public Track zero-PII, DMN, Twin HITL gate, OCR Autofill + Triage, Bundle v3); **SBOM CycloneDX 1.5** (`209` components: `workspace=12, npm=177, oci=20`, 0 BSL-1.1); **PoF `PASS`**.

### 13:30 – 15:00 · Chứng minh Negative RBAC & Kết luận
- **Màn hình:** Đăng xuất `admin@nocobase.com` -> đăng nhập **`native.lab.employee@example.invalid` / `NativeLab-2026!`**.
- **Thao tác & Thông điệp:**
  1. Chứng minh cô lập giao diện & API: thanh chuyển cổng ẩn `/p/incidents` và `/admin/settings/*`, chỉ giữ cổng thuộc thẩm quyền (`Mua sắm & Tài sản`, `Dịch vụ Nội bộ & Danh bạ`, `Logistics · Đơn của tôi`); mọi lời gọi trái quyền sang Admin Builder AI hoặc cross-org trả `HTTP 403`.
  2. Chốt thông điệp: **LatticeDX `v1.0.0`** đạt đồng thời **50 điểm PoF chuẩn mực** và **kiến trúc Enterprise Digital OS 6 phân hệ hoàn chỉnh**, cài sạch 100% từ gói nguồn `latticedx-1.0.0-src.tar.gz`.

---

## 2. Lệnh Dự phòng Offline (Fallback Commands khi Mạng / LLM Gateway Gián đoạn)

Nếu kết nối LLM ngoài hoặc Docker container phụ gặp trục trặc trong phòng thi, chuyển ngay sang bộ kiểm chứng độc lập không phụ thuộc mạng ngoài:

```sh
# 1. Chứng minh toàn bộ PoF, SPDX headers, Compose digests & CycloneDX 1.5 SBOM
node scripts/source-headers.mjs --check
pnpm pof:check
node scripts/generate-sbom.mjs --check
node --test scripts/tests/oss-pof-audit.test.mjs scripts/tests/generate-sbom.test.mjs scripts/tests/infra-compose-security.test.mjs

# 2. Chứng minh AI Intent Router + Security Refusal + GraphRAG offline (64/64 ca)
node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95

# 3. Chứng minh toàn bộ unit & integration tests của 7 plugin (không cần LLM API key)
node --test plugins/nocobase/*/tests/*.test.cjs

# 4. Chứng minh Headless PaaS & AI/MCP nếu runtime localhost:13014 đang chạy
pnpm acceptance:headless-paas -- --origin=http://localhost:13014
pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
```

---

## 3. Ngân hàng Trả lời Phản biện Giám khảo (Q&A Defense Points)

1. **Hỏi: Dùng NocoBase làm nền tảng thì có vi phạm bản quyền hoặc bị phụ thuộc (vendor lock-in) không?**
   - **Đáp:** Không. Toàn bộ mã nguồn của nhóm đặt trong 7 plugin `Apache-2.0` độc lập với `"sdkProvidedByHost": true` — không sửa một dòng nào trong `upstream/nocobase`, loại trừ hoàn toàn khỏi workspace build và `latticedx-1.0.0-src.tar.gz`, đồng thời bảo toàn tuyệt đối **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`). Lõi nghiệp vụ, hợp đồng `@dx/contracts`, Headless API (`apps/api`, `dxosApiKeys`, `dxosLedger`, `dxosDataGov`, `dxosWms`, `dxosDmn`) chạy độc lập qua OpenAPI 3.1 / AsyncAPI 3.0 / MCP mà không khóa chặt vào UI.
2. **Hỏi: Tại sao hệ thống không dùng ThingsBoard hay EMQX cho phần IIoT?**
   - **Đáp:** ThingsBoard (bản mới) và EMQX Enterprise sử dụng giấy phép **BSL-1.1 / điều khoản thương mại hạn chế** không đạt chuẩn OSI. Để bảo đảm **100% OSS License Purity**, CTU-OpenPaw sử dụng **Eclipse Mosquitto `2.0.21` (`EPL-2.0 OR BSD-3-Clause`)**, **Node-RED `4.0.9` (`Apache-2.0`)**, **TimescaleDB OSS `2.19.3-pg16-oss` (`Apache-2.0`)**, **Prometheus `v3.3.0` (`Apache-2.0`)** và **OTel Collector `0.123.0` (`Apache-2.0`)**, có script `scripts/generate-sbom.mjs` tự động chặn cứng từ khóa `BSL-1.1`/`thingsboard`/`emqx`.
3. **Hỏi: Nếu một lập trình viên quên lọc `organizationId` ở tầng plugin thì dữ liệu đa công ty có rò rỉ không?**
   - **Đáp:** Hệ thống áp dụng **phòng thủ nhiều tầng (Defense-in-Depth)**: ngoài middleware scope `before: 'latticeNativeScope'` ở tầng ứng dụng, PostgreSQL bật **Row-Level Security (`lattice_tenant_isolation`) trên cả 34 bảng `lattice*`** (`pg-rls.js` + `AsyncLocalStorage` transaction bridge với `set_config('app.current_org', ..., true)`), chặn triệt để rò rỉ chéo tổ chức ngay tại tầng CSDL.
4. **Hỏi: AI Agent có thể tự ý sửa nhiệt độ kho lạnh hay tự phê duyệt đơn hàng do ảo giác (hallucination) không?**
   - **Đáp:** Không thể. Mọi tool ghi/điều khiển (`dxos_execute_record_action`, `dxos_alarm_action`, `dxos_twin_set_desired`, `dxos_wms_hold_lot`) bị khóa sau **Hàng chờ HITL (`latticeAiApprovalQueue`)** và kiểm tra chống tự duyệt (`requesterUserId !== approver`). Riêng Digital Twin tự động chặn cứng mọi thay đổi setpoint lệch **`> 2.0°C`** để bắt buộc con người có quyền ACL xác nhận trước khi Node-RED phát lệnh MQTT downlink. Mọi tham số và đầu ra đều qua bộ che PII Việt Nam và kiểm soát hạn mức PostgreSQL.
5. **Hỏi: Tài xế mất sóng 4G trong hầm kho lạnh thì thao tác ePOD trên `/v/mobile` xử lý thế nào?**
   - **Đáp:** Tuyến `/v/mobile` PWA (`mobile-field-pwa.js`) đóng gói Service Worker `/api/dxos:sw.js` (chỉ cache shell tĩnh, giữ bất biến `NetworkOnly` cho `/api/*` để tránh lộ token), lưu an toàn yêu cầu `dxosWms:epodCapture` hoặc `dxosBlocks:twinSetDesired` vào hàng đợi ngoại tuyến giới hạn dung lượng & làm sạch khóa prototype, rồi tự động đồng bộ lại khi có kết nối.

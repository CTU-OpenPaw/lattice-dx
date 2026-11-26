<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Kịch bản Trình diễn Chung kết 15 Phút — OLP PMNM 2026 (`v0.4.2`)

Kịch bản tác chiến từng phút (**0:00–15:00**) dành cho đội **CTU-OpenPaw** trình diễn **LatticeDX `v0.4.2` (DX-OS Open-Core Championship Edition)** trước Hội đồng Giám khảo Chung kết VFOSSA.

---

## 0. Chuẩn bị Trước giờ G (T-5 Phút)

### Khởi động & Nạp Showcase `v0.4.2` (trên cổng cô lập `13014`)
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
  2. `http://localhost:13014/admin/settings/dxos-studio` (Control Studio **11 Tabs**, 6 Governance Consoles & GitOps Bundle v3) & `http://localhost:13014/admin/settings/workflow/automation` (**Workflow -> Workflow Automation**: LatticeFlow v2 Canvas-First Studio — 24 node types, HITL Pause/Resume & **Agent Chat gốc `dxos-architect`** đồng bộ SSE)
  3. `http://localhost:13014/p/logistics` (Logistics 5 bước, **`DxosWmsOpsBlockModel`**, Kanban/Schedule, PKI, In chứng từ **QR ISO SVG** & `/v/track/:code` Ed25519)
  4. `http://localhost:13014/p/incidents` (**WebGIS MapLibre**, IIoT Digital Twin & GraphRAG Enterprise Agent)
  5. `http://localhost:13014/p/cmms` & `http://localhost:13014/p/partner-claims` (CMMS & Partner Settlement `CLM-V100-001` từ Business Packs 1-nhấp)
  6. `http://localhost:13014/v/mobile` (Mobile Field PWA **IndexedDB outbox + camera ảnh ePOD**)

---

## 1. Diễn tiến Từng phút (0:00 – 15:00)

### 0:00 – 1:45 · Mở bài: DX-OS Open-Core 6 Phân hệ & Thuần khiết Chuẩn Mở
- **Màn hình:** `/admin/settings/dxos-ai` (Tab `1. Hệ điều hành 6 Phân hệ`) -> `/admin/pm/list` -> chân trang hệ thống.
- **Thao tác & Thông điệp:**
  1. Định vị bài toán: Doanh nghiệp Việt cần **Hệ điều hành Doanh nghiệp Số (H–P–D–I)** chứ không chỉ CRUD rời rạc. LatticeDX điều phối **6 phân hệ** với **NocoBase `2.2.50`** làm **Plane #6 (`appDataSubstrate`)**.
  2. Chỉ rõ **7 plugin Apache-2.0 (`0.4.2`)** bật/tắt sống trong `/admin/pm/list` (`sdkProvidedByHost: true`), giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`).
  3. Nhấn mạnh **Cam kết Thuần khiết Giấy phép Pure-OSI**: 0% BSL-1.1 (loại bỏ ThingsBoard/EMQX và các image cache nguồn hạn chế), dùng **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause`)**, **Mosquitto `2.0.21` Dynamic Security (`EPL-2.0 OR BSD-3-Clause`)**, **Node-RED `4.0.9` (`Apache-2.0`)** và **PostgreSQL `16` (`latticeTelemetryPoints`, không cần container `timescaledb` tách rời)**, cùng Prometheus & OTel Collector.

### 1:45 – 4:15 · Plug-and-Play Chuỗi lạnh OMS/WMS/FEFO/ePOD, Ed25519 PKI & DMN
- **Màn hình:** `/p/logistics` -> `/admin/settings/dxos-studio` (thanh `Quản trị DX-OS v0.4.2:`).
- **Thao tác & Thông điệp:**
  1. Trên **`/p/logistics`**, giới thiệu **`DxosKanbanScheduleBlockModel`** (vận đơn `ORD-V100-001` Cần Thơ -> TP.HCM, chuyển nhanh Lịch 7 ngày), **`DxosWmsOpsBlockModel`** (tác vụ FEFO/MKT/2-phase bulk import trực tiếp trên `/p/logistics`), và **`DxosRecordWorkbenchBlockModel`**: bấm xác minh **Ed25519 PKI & Merkle Ledger** (`dxosLedger:verify`), mở ngăn **Phả hệ dữ liệu (Lineage)** (`dxosDataGov:lineageTrace`), và **In chứng từ QR ISO/IEC 18004 SVG** an toàn (`<iframe sandbox="" srcDoc>`) kèm link tra cứu công khai **`/v/track/:code`** (`dxosWms:verifyTrackSignature` không PII).
  2. Chuyển sang **`/admin/settings/dxos-studio`** thanh **`Quản trị DX-OS v0.4.2:`**:
     - Console **`Kho FEFO & ePOD`**: chỉ lô `LOT-V100-FEFO-A` đã phân bổ FEFO và lô `LOT-V100-MKT-HOLD` bị khóa bởi **Arrhenius MKT**.
     - Console **`Bảng Quyết định DMN`**: trình diễn **Visual Interactive DMN** & đánh giá bảng `cold_chain_approval_v1` (`maxTempC: 9.5` -> `quality_hold_director`, SLA 15 phút, zero-`eval`).

### 4:15 – 8:45 · Closed-Loop Cold-Chain: LWT/Alarm -> Event Bus -> Native Automation + DMN -> CMMS (`/p/cmms`) + Live 2-Way `n8n` & Digital Twin HITL
- **Màn hình:** `/p/incidents` -> `/admin/settings/dxos-studio` (Tabs `7`, `8`) -> `/p/cmms` -> `PortalAgentLauncher` -> `/admin/settings/dxos-ai` (Tab `6. Duyệt AI (HITL)`).
- **Thao tác & Thông điệp:**
  1. Trên **`/p/incidents`**, chỉ **`DxosWebGisBlockModel`** (`COLD-CHILLER-CT-01`, `REEFER-TRUCK-HCM-02`, `COLD-HUB-DN-03`) và **`DxosContextTelemetryBlockModel`** (nhiệt độ cảnh báo `8.9°C > 8°C`).
  2. Chuyển **`/admin/settings/dxos-studio`**:
     - **Tab `7. Broker & Sự kiện`**: chỉ thiết bị đã cấp phát **Mosquitto DynSec** (`$CONTROL/dynamic-security/v1`, `allow_anonymous false`, ACL `latticedx/<orgId>/<deviceKey>/*`) & đồng bộ 2 chiều **FIWARE Orion-LD** (`/ngsi-ld/v1/subscriptions` đẩy về `dxosBroker:orionNotify` -> `latticeTelemetryPoints` + `orion.notification`). Kích hoạt hoặc chỉ sự kiện **`DEATH` LWT (`device.offline`) / `alarm.triggered`** đi qua **Unified CloudEvents 1.0 + Standard Webhooks (`dxosEvents`)** (PG Outbox `SKIP LOCKED`, chữ ký HMAC `webhook-id`/`webhook-timestamp`/`webhook-signature`, backoff + jitter, Circuit Breaker 5 lỗi/120s, DLQ Replay).
     - **Tab `8. Vault & Automation`**: chỉ **Connector & Secrets Vault (`dxosVault`, AES-256-GCM + OAuth2 PKCE S256 & single-flight refresh cho 11 app + SSRF allowlist + `testConnection`)**, **Stock `n8n` Public REST API v1 (`dxosN8n`, `ConnectedAppsPanel`/`N8nSetupModal`)** và **Native Automation Engine (`dxosAutomations`)**: rule `auto_cmms_on_coldchain_fault` nhận sự kiện `alarm.triggered` -> đánh giá DMN `cmms_priority_routing_v1` -> chạy chuỗi actions (gọi `ai.agent` LLM thật, ghi nhận `stepTracesJson` có `replayRun`, chống lặp `maxDepth: 8`).
  3. Mở **`/p/cmms`** (`cmms-maintenance`) & **`/p/partner-claims`** (từ gói **1-Click `coldchain-partner-settlement`**, mẫu `CLM-V100-001`): chỉ **CMMS Work Order mới** và luồng **`dxos-enterprise-compliance-orchestrator.json` (`26` node)** + Error Trigger trên `n8n` xác thực HMAC-SHA256 và gọi ngược `:13014` via `dxos-external-app-inbound-callback.json` bằng token `ldx_pat_*` (`dxosAutomations:runNow` / `dxosLedger:signDocument`).
  4. Quay lại **`/p/incidents`** -> chỉ **Chuông Thông báo SSE Topbar** & mở **1 nút Agent nổi duy nhất (`PortalAgentLauncher`)** (hoặc **App Builder Agent** `dxos_provision_role_workspace` dựng + `verify_app` tự sửa 2 vòng):
     > *"Phân tích ảnh hưởng dây chuyền nếu kho lạnh COLD-CHILLER-CT-01 gặp sự cố quá nhiệt trên toàn bộ chuỗi"*
     - Hệ thống gọi **`#16 dxos_graph_impact_analysis`** (cùng `#17 dxos_alarm_action` và `dxos_configure_workflow` hỗ trợ `listAutomations`/`runAutomation`), rồi vào **`/admin/settings/dxos-ai` -> Tab `6. Duyệt AI (HITL)`** bấm `dxosAi:triageScan` và giải thích cơ chế **HITL Digital Twin gate** (mọi thay đổi setpoint lệch `|delta| > 2.0°C` buộc người có quyền ACL duyệt `dxosAi:approveAction` mới đẩy MQTT downlink qua Node-RED).

### 8:45 – 10:45 · Visual Domain Builder, 1-Click Tenant Provisioning (`Tab 9`), Mobile PWA (`/v/mobile`) & P.A.R.A. OCR
- **Màn hình:** `/admin/settings/dxos-studio` (Tab `9. Domain Builder & Tenant`) -> `/v/mobile` -> `/p/services`.
- **Thao tác & Thông điệp:**
  1. Trên **Tab `9. Domain Builder & Tenant`**: tạo nhanh một thực thể nghiệp vụ động `latticeCustom*` (hoặc trình diễn `cmms-maintenance` vừa cài) -> nhấn mạnh hệ thống tự tạo bảng + gắn **PostgreSQL RLS**, tự cập nhật đặc tả sống **`/api/dxos:openapi`**, cấp RBAC theo vai trò và sinh trang `/p/*`; chỉ tiếp nút **1-Click `provisionTenant` (`dxosBuilder:provisionTenant`)** khởi tạo trọn bộ tổ chức mới + Ed25519 key + SLA mặc định + tài khoản `ldx_admin`.
  2. Mở **`/v/mobile`** (viewport `390px`): chỉ Service Worker `/api/dxos:sw.js` giữ bất biến `NetworkOnly` cho `/api/*` và **IndexedDB outbox (`mobile-offline-db.js`) + camera ảnh ePOD 512KB + QR fallback** cho `epodCapture` / `twinSetDesired`. Lướt nhanh `/p/services` (`DxosParaVaultBlockModel` + giải mã PDF `ToUnicode` CMap + OCR Form Autofill) và `/admin/settings/dxos-para`.

### 10:45 – 13:15 · Headless PaaS, GitOps Solution Bundle v3 & PoF / SBOM
- **Màn hình:** `/admin/settings/dxos-studio` (Tab `6. GitOps Bundle`) + Terminal.
- **Thao tác & Thông điệp:**
  1. Trên Tab **`6. GitOps Bundle`**, bấm **`Xuất Bundle JSON`** (`latticedx.solution-bundle/v3` — `Schema · RBAC · Portals · Workflows · AI · Governance` gồm DMN, SLA, Incident Rules, **`automationRules`** và **`webhookSubscriptions` đã che sạch secret**).
  2. Trên Terminal chạy trực tiếp vào `:13014`:
     ```sh
     curl -s http://localhost:13014/api/dxos:health
     curl -s http://localhost:13014/api/dxos:openapi | head -n 30
     pnpm acceptance:headless-paas -- --origin=http://localhost:13014
     pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
     pnpm acceptance:broker-automation-builder -- --origin=http://localhost:13014
     pnpm release:sbom -- --check
     pnpm pof:check
     ```
     - Nêu rõ: **Headless PaaS (QR SVG + Ed25519 + Delegation), AI/MCP (20 Tools + App Builder + HITL) & Broker/n8n/PKCE PASS**; `/api/dxos:openapi` phản chiếu sống cả `latticeCustomWorkOrders` & `latticeCustomPartnerClaims`; **SBOM CycloneDX 1.5** (`257` components: `workspace=12, npm=226, oci=19`, `257/257` resolved (`fsevents@2.3.3 = MIT`, 0 `NONE`, 0 BSL-1.1)); **PoF `PASS`**.

### 13:15 – 15:00 · Chứng minh Negative RBAC (`403`) & Kết luận
- **Màn hình:** Đăng xuất `admin@nocobase.com` -> đăng nhập **`native.lab.employee@example.invalid` / `NativeLab-2026!`**.
- **Thao tác & Thông điệp:**
  1. Chứng minh cô lập giao diện & API: thanh chuyển cổng ẩn `/p/incidents` và `/admin/settings/*`, chỉ giữ cổng thuộc thẩm quyền (`Mua sắm & Tài sản`, `Dịch vụ Nội bộ & Danh bạ`, `Logistics · Đơn của tôi`); mọi lời gọi trái quyền sang Admin Builder, Vault/Broker/Builder hoặc cross-org trả `HTTP 403`.
  2. Chốt thông điệp: **LatticeDX `v0.4.2`** đạt đồng thời **50 điểm PoF thuần OSI** và **Hệ điều hành Doanh nghiệp Số 6 Phân hệ hoàn chỉnh**, cài sạch 100% từ `latticedx-0.4.2-src.tar.gz`.

---

## 2. Lệnh Dự phòng Offline (Fallback Commands khi Mạng / LLM Gateway Gián đoạn)

Nếu kết nối LLM ngoài hoặc Docker container phụ gặp trục trặc trong phòng thi, chuyển ngay sang bộ kiểm chứng độc lập không phụ thuộc mạng ngoài:

```sh
# 1. Chứng minh toàn bộ PoF, SPDX headers, Compose digests & CycloneDX 1.5 SBOM
node scripts/source-headers.mjs --check
pnpm pof:check
pnpm release:sbom -- --check
node --test scripts/tests/oss-pof-audit.test.mjs scripts/tests/generate-sbom.test.mjs scripts/tests/infra-compose-security.test.mjs

# 2. Chứng minh AI Intent Router + App Builder + Security Refusal + GraphRAG + Flow Architect offline (163/163 ca)
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
   - **Đáp:** Không. Toàn bộ mã nguồn của nhóm đặt trong 7 plugin `Apache-2.0` độc lập với `"sdkProvidedByHost": true` — kho mã nguồn Git và `latticedx-0.4.2-src.tar.gz` là **100% thuần chuẩn OSI**, hoàn toàn không chứa Git submodule `upstream/nocobase` hay `.gitmodules` (host `nocobase/nocobase:2.2.50` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài kho Git), đồng thời bảo toàn tuyệt đối **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`). Lõi nghiệp vụ, hợp đồng `@dx/contracts`, Headless API (`apps/api`, `dxosApiKeys`, `dxosLedger`, `dxosDataGov`, `dxosWms`, `dxosDmn`) chạy độc lập qua OpenAPI 3.1 / AsyncAPI 3.0 / MCP mà không khóa chặt vào UI.
2. **Hỏi: Tại sao hệ thống không dùng ThingsBoard, EMQX hay các dịch vụ cache nguồn hạn chế cho phần IIoT và session/rate-limit?**
   - **Đáp:** ThingsBoard (bản mới), EMQX Enterprise và các bản cache nguồn đóng/hạn chế không đạt chuẩn OSI. Để bảo đảm **100% Pure-OSI License Purity**, CTU-OpenPaw sử dụng **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause`, tương thích giao thức `PUBSUB_ADAPTER=redis`)**, **Eclipse Mosquitto `2.0.21` Dynamic Security (`EPL-2.0 OR BSD-3-Clause`)**, **Node-RED `4.0.9` (`Apache-2.0`)**, lưu chuỗi thời gian IIoT trực tiếp trên **PostgreSQL `16` (`latticeTelemetryPoints`, không cần container `timescaledb` tách rời)**, cùng **Prometheus `v3.3.0` (`Apache-2.0`)** và **OTel Collector `0.123.0` (`Apache-2.0`)**, có `scripts/generate-sbom.mjs` tự động chặn cứng từ khóa `BSL-1.1`/`thingsboard`/`emqx`.
3. **Hỏi: Nếu một lập trình viên quên lọc `organizationId` ở tầng plugin thì dữ liệu đa công ty có rò rỉ không?**
   - **Đáp:** Hệ thống áp dụng **phòng thủ nhiều tầng (Defense-in-Depth)**: ngoài middleware scope `before: 'latticeNativeScope'` ở tầng ứng dụng, PostgreSQL chạy qua vai trò không đặc quyền superuser **`nocobase_app`** và bật **`FORCE ROW LEVEL SECURITY` (`lattice_tenant_isolation`, `20261127000100`) trên cả 56 bảng tĩnh `lattice*` + mọi bảng động `latticeCustom*`** (`pg-rls.js` + `AsyncLocalStorage` transaction bridge với `set_config('app.current_org', ..., true)` fail-closed và kiểm chứng `pg_class.relrowsecurity` trong `domain-builder.js`), chặn triệt để rò rỉ chéo tổ chức ngay tại tầng CSDL.
4. **Hỏi: AI Agent có thể tự ý sửa nhiệt độ kho lạnh hay tự phê duyệt đơn hàng do ảo giác (hallucination) không?**
   - **Đáp:** Không thể. Mọi tool ghi/điều khiển (`dxos_execute_record_action`, `dxos_alarm_action`, `dxos_twin_set_desired`, `dxos_wms_hold_lot`) bị khóa sau **Hàng chờ HITL (`latticeAiApprovalQueue`)** và kiểm tra chống tự duyệt (`requesterUserId !== approver`). Riêng Digital Twin tự động chặn cứng mọi thay đổi setpoint lệch **`> 2.0°C`** để bắt buộc con người có quyền ACL xác nhận trước khi Node-RED phát lệnh MQTT downlink. Mọi tham số và đầu ra đều qua bộ che PII Việt Nam và kiểm soát hạn mức PostgreSQL.
5. **Hỏi: Tài xế mất sóng 4G trong hầm kho lạnh thì thao tác ePOD trên `/v/mobile` xử lý thế nào?**
   - **Đáp:** Tuyến `/v/mobile` PWA (`mobile-field-pwa.js`) đóng gói Service Worker `/api/dxos:sw.js` (chỉ cache shell tĩnh, giữ bất biến `NetworkOnly` cho `/api/*` để tránh lộ token), lưu an toàn yêu cầu `dxosWms:epodCapture` hoặc `dxosBlocks:twinSetDesired` vào hàng đợi ngoại tuyến giới hạn dung lượng & làm sạch khóa prototype, rồi tự động đồng bộ lại khi có kết nối.

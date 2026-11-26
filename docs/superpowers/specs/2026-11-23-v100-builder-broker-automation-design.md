<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết Kế Kiến Trúc Hoàn Thiện LatticeDX `v1.0.0` — Unified Broker, Connector Vault, Native Automation, Domain Builder & Multi-Tenant Provisioning

## 1. Bối cảnh & Mục tiêu
Hoàn thiện **LatticeDX `v1.0.0`** trên nhánh `feat/v1.0.0-olp-championship` (không tách `v1.1.0`) nhằm lấp 6 khoảng trống thực chiến đối chiếu với [Đề thi OLP PMNM 2026 (`798.html`)](https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html) và [Thể lệ PoF (`760.html`)](https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html). Mọi thành phần giữ lại đều phải có **vai trò sống còn rõ rệt**, cắt bỏ container/cấu hình thừa.

## 2. Cắt bỏ thừa & Thanh lọc Giấy phép OSI
- **Loại bỏ `timescaledb`** (service & volume) khỏi `infra/compose/iiot.yml`: dữ liệu chuỗi thời gian dùng trực tiếp `latticeTelemetryPoints` trên PostgreSQL chính.
- **Không bổ sung Kafka/Redpanda/NATS/Stellio**: sử dụng **PostgreSQL Transactional Outbox** (`latticeEventBus` + `latticeWebhookDeliveries`, `FOR UPDATE SKIP LOCKED`) làm trục sự kiện duy nhất không mất tin.
- **Thay `redis:7.4-alpine` (`RSALv2/SSPL`) bằng `valkey/valkey:8.1-alpine@sha256:...` (`BSD-3-Clause`, OSI thuần)** trong `infra/compose/nocobase.yml` và `infra/compose/prod.yml`, cập nhật `scripts/generate-sbom.mjs`.
- **Nâng runtime chuẩn xác lên NocoBase `2.2.50`** đồng bộ với `testedRuntime` của 7 plugin, sửa nhãn `GitOps Solution Bundle v2 -> v3`, và loại bỏ các lời gọi 400/403 nền trên giao diện.

## 3. Sáu Khối Trụ Cột & Mạch Vận Hành Khép Kín
```text
[MQTT Sensor] ──(Mosquitto Dynamic Security + ACL/orgId + LWT)──► [Node-RED]
                                                                       │
                                  ┌────────────────────────────────────┴───────────────────────┐
                                  ▼                                                            ▼
                      [NocoBase Telemetry & Twin]                              [FIWARE Orion-LD Broker]
                                  │                                             (2-Way Subscription)
                                  └──────────────────────► [Unified Event Bus (PG Outbox · CloudEvents 1.0)]
                                                                         │
                                      ┌──────────────────────────────────┴──────────────────────────────────┐
                                      ▼                                                                     ▼
                     [Native Automation Engine]                                         [Outbound Webhook Broker (HMAC-SHA256)]
                      • Evaluate DMN Table                                               • Secrets from Connector Vault (AES-256-GCM)
                      • CMMS Work Order (`latticeCustom*`) / Notify                      • Standard Webhooks + Circuit Breaker + DLQ
                      • Twin Setpoint (-> HITL if |delta| > 2C)                          • Calls Live n8n -> n8n calls back via ldx_pat_*
```

### Trách nhiệm từng khối
1. **Mosquitto Dynamic Security + Device Registry/LWT (`dxosBroker`):** Tắt `allow_anonymous`, dùng `$CONTROL/dynamic-security/v1` cấp/thu hồi credential & ACL topic theo tổ chức (`latticedx/<orgId>/<deviceKey>/*`), ghi nhận trạng thái `online/offline` qua `BIRTH`/`DEATH` LWT và tự sinh cảnh báo + sự kiện `device.offline`. Đưa `mosquitto` và `nodered` vào `infra/compose/prod.yml` (`profiles: ["iiot"]`).
2. **FIWARE Orion-LD 2 chiều (`dxosBroker`):** Live Entity Explorer đối chiếu `latticeAssets`/`latticeLocations` với Orion-LD; quản lý NGSI-LD Subscriptions (`/ngsi-ld/v1/subscriptions`) đẩy ngược thông báo vào `POST /api/dxosBroker:orionNotify` (xác thực `X-Lattice-Edge-Token`), vừa ghi `latticeTelemetryPoints` vừa phát `orion.notification` CloudEvent.
3. **Unified Event & Outbound Webhook Bus (`dxosEvents`):** Chuẩn **CloudEvents 1.0** + **Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,...`), backoff exponential có jitter, **Circuit Breaker** (`>= 5` lỗi liên tiếp mở mạch 120s), và DLQ Replay trên UI.
4. **Connector & Secrets Vault (`dxosVault`):** Lưu thông tin kết nối (`n8n`, `webhook`, `mqtt`, `orion_ld`, `http_api`, `smtp_notify`) mã hoá `AES-256-GCM` theo `organizationId`, chống SSRF (chỉ cho phép tên dịch vụ nội bộ trong allowlist hoặc HTTPS hợp lệ), có **Test Connection** thật và không bao giờ trả secret qua API/Bundle.
5. **Native Automation Engine + Live 2-Way n8n (`dxosAutomations`):** Quy trình 3 bước `Event Trigger -> DMN Table -> Actions` (`create_record`, `update_record`, `notify_role`, `call_connector`, `twin_set_desired`, `trigger_ai_triage`), giới hạn độ sâu chống lặp (`maxDepth = 8`), **Execution Trace** từng bước và **Replay**; tích hợp vào `dxos_manage_workflows` (giữ nguyên 17 AI tools) và đồng bộ qua Solution Bundle v3. Bổ sung 2 flow n8n sống xác thực HMAC-SHA256 và gọi ngược NocoBase bằng `ldx_pat_*`.
6. **Visual Domain Builder + 1-Click Tenant Provisioning + Gói CMMS (`dxosBuilder`):** Cho phép từ Studio tạo phân hệ động `latticeCustom*` (tự sync bảng, gắn **PG RLS**, tạo index, cập nhật động `/api/dxos:openapi`, cấp quyền RBAC & trang portal), cài 1-click gói **Bảo trì Thiết bị CMMS (`cmms-maintenance`)** (`latticeCustomWorkOrders`, DMN `cmms_priority_routing_v1`, automation `auto_cmms_on_coldchain_fault`, `/p/cmms`), và cấp phát nhanh công ty con mới (`provisionTenant`: phòng ban, vị trí, khóa PKI Ed25519, SLA VN, tài khoản `ldx_admin`).

## 4. An toàn & Tuân thủ CSDL
- Toàn bộ 8 bảng mới (`latticeConnectors`, `latticeEventBus`, `latticeWebhookSubscriptions`, `latticeWebhookDeliveries`, `latticeIotDevices`, `latticeBrokerSubscriptions`, `latticeAutomationRules`, `latticeAutomationRuns`) được đưa vào `TENANT_RLS_TABLES` và gắn policy PG RLS ngay trong các migration thuận nghịch `20261125000100`–`20261125000300`.
- Không thêm dependency npm mới trong 7 plugin (`sdkProvidedByHost: true`), giữ nguyên nhận diện **Điều 5.2 NocoBase**.

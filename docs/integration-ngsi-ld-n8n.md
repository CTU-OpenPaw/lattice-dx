# Tích hợp NGSI-LD và n8n

Cập nhật: **16/10/2026**. Phạm vi kiểm chứng: môi trường Docker local, tenant `org-a`.

Tài liệu tổng hợp năm nhóm công việc tích hợp, kết quả đã chạy và giới hạn bàn giao.
Các kết quả local không đồng nghĩa đã hoàn tất triển khai production hoặc thống nhất mọi contract nghiệp vụ.

## 1. Phạm vi và ranh giới dữ liệu

- **Orion-LD** lưu trạng thái và ngữ cảnh dùng chung của tài sản, phòng ban, địa điểm và fixture logistics.
- **Backend nghiệp vụ** quản lý đơn hàng, dữ liệu giao dịch/kế toán, danh tính và quyền truy cập.
- **n8n** tiếp nhận yêu cầu mẫu, kiểm tra payload và gọi API tạo đơn logistics.
- **Receiver NGSI-LD** nhận notification và lưu bản chiếu `Asset.status` vào PostgreSQL.

Luồng n8n và luồng subscription hiện được kiểm chứng riêng. Chưa có đồng bộ toàn bộ Order ↔ broker.
Không suy ra `Shipment.delivered` từ `Order.received`; `warehouseAssigneeId` là subject người nhận việc,
không phải Warehouse ID. Không mặc định business ID, backend record ID, workflow run ID và URN là một.

## 2. Tổng hợp năm nhóm công việc

| Mục | Kết quả hiện tại | Phạm vi/điểm cần bàn giao |
| --- | --- | --- |
| 1. Chạy broker và n8n, khóa phiên bản, credential và hồ sơ nguồn | Runtime đã chạy; ba image integration đã khóa tag và digest; cấu hình secret tách khỏi Git | Cần bổ sung đủ nguồn/license của ba thành phần integration vào hồ sơ third-party |
| 2. Mô hình dữ liệu, JSON-LD context và mapping ID | Đã định nghĩa sáu loại entity; tạo/đọc fixture cơ bản và logistics thành công | Nguồn ID thực tế, enum và contract cuối cùng vẫn chờ Duy/nhóm xác nhận |
| 3. Connector Asset và dữ liệu mẫu | Đã viết và kiểm chứng create → get → update → read-back | Chưa thực thi đầy đủ mọi quy tắc trong data contract |
| 4. Webhook n8n → API logistics | Đã kiểm chứng auth, validation, tạo đơn và retry cùng key; đã export workflow | Token sales còn cập nhật thủ công; mới kiểm chứng test webhook |
| 5. Broker subscription → backend | Đã kiểm chứng notification thật, đọc lại PostgreSQL và các bài thử lỗi | Receiver hiện xử lý Asset.status; smoke dùng độ phân giải giây |

## 3. Mục 1 — Runtime, phiên bản và credential

### Môi trường

| Thành phần | Phiên bản | Truy cập từ máy host |
| --- | --- | --- |
| Orion-LD | 1.10.0 | http://localhost:1026 |
| MongoDB của broker | 4.4.29 | Chỉ trong mạng Docker |
| n8n | 2.42.7 | http://localhost:5678 |
| API gateway | Theo core Compose | http://localhost:8080 |
| Keycloak | Theo core Compose | http://localhost:8081 |
| PostgreSQL nghiệp vụ/bản chiếu | Theo core Compose | Chỉ trong mạng Docker |

- Integration stack: [infra/compose/integration.yml](../infra/compose/integration.yml).
- Core backend: [infra/compose/core.yml](../infra/compose/core.yml).
- Orion-LD, MongoDB và n8n đã được pin bằng cả tag và `sha256` trong integration Compose.
- `GET /version`: Orion-LD trả phiên bản 1.10.0.
- `GET /healthz` của n8n: HTTP 200.
- Khi kiểm chứng subscription, API và PostgreSQL healthy; gateway và integration stack đang chạy.

### Credential và nguồn/license

- `.env.integration` chứa cấu hình nhạy cảm local, gồm khóa mã hóa n8n và token broker khi đã cấu hình.
- Token webhook và Bearer token sales nằm trong credential store của n8n; không ghi trực tiếp vào Code/HTTP node.
- `NGSILD-Tenant` chọn tenant, không thay thế xác thực.
- Không đưa env file, token hoặc bản export credential vào Git.
- Hồ sơ nguồn/license: [third-party.md](third-party.md). Tại thời điểm đối chiếu, tài liệu này chưa liệt kê
  đủ Orion-LD, MongoDB và n8n; cần bổ sung trước khi đóng gói/bàn giao hồ sơ giấy phép.
- Khóa image digest không thay thế việc kiểm tra điều khoản phân phối của từng thành phần.

Hai file Compose dùng chung project `lattice-dx`. Không thêm `--remove-orphans` khi thao tác riêng từng stack;
không dùng `down -v` để xử lý cảnh báo orphan.

## 4. Mục 2 — Data model, context và mapping

### Tài nguyên

- Context: [context.jsonld](../infra/config/ngsi-ld/context.jsonld).
- Fixture cơ bản: [seed.json](../infra/config/ngsi-ld/seed.json).
- Fixture logistics: [seed-logistics.json](../infra/config/ngsi-ld/seed-logistics.json).
- Đặc tả: [NGSI-LD Data Contract](ngsi-ld-data-contract.md).

Đã định nghĩa `Asset`, `Department`, `Location`, `Vehicle`, `Shipment`, `Warehouse`.
Namespace `https://latticedx.example/ns/` là đề xuất của nhóm.
`belongsToDepartment` ánh xạ đến `https://latticedx.example/ns/department`, tránh xung đột
`Department`/`department` khi đọc JSON bằng Windows PowerShell.
`observedAt` biểu diễn thời điểm nguồn quan sát thuộc tính, sử dụng ISO 8601 UTC.

### Mapping fixture đã thử

| Entity | Organization | Business ID | URN |
| --- | --- | --- | --- |
| Department | org-a | it | urn:ngsi-ld:Department:org-a:it |
| Location | org-a | office-1 | urn:ngsi-ld:Location:org-a:office-1 |
| Asset | org-a | laptop-001 | urn:ngsi-ld:Asset:org-a:laptop-001 |
| Vehicle | org-a | truck-001 | urn:ngsi-ld:Vehicle:org-a:truck-001 |
| Warehouse | org-a | warehouse-001 | urn:ngsi-ld:Warehouse:org-a:warehouse-001 |
| Warehouse | org-a | warehouse-002 | urn:ngsi-ld:Warehouse:org-a:warehouse-002 |
| Shipment | org-a | shipment-demo-001 | urn:ngsi-ld:Shipment:org-a:shipment-demo-001 |

### Kết quả kiểm chứng — 15/10/2026

- Tạo Department, Location và Asset: mỗi entity trả HTTP 201.
- Đọc lại Asset đúng businessId, organizationId, name, status, observedAt và quan hệ phòng ban/địa điểm.
- Tạo và đọc lại 6 entity trong fixture logistics thành công.
- Kiểm tra ID, type, businessId, organizationId và name.
- Kiểm tra status/observedAt của Vehicle, Warehouse và Shipment.
- Kiểm tra Warehouse/Vehicle → Location và Shipment → Vehicle/kho nguồn/kho đích.

Fixture logistics chưa phải dữ liệu lấy từ backend thực tế. Các quan hệ fixture đã chạy được,
nhưng chưa có bằng chứng Duy xác nhận nguồn ID, enum hoặc mapping cuối cùng.
Chỉ ghi “đã thống nhất ID” sau khi nhóm xác nhận trên contract.

## 5. Mục 3 — Asset connector

### Implementation

- Module: [ngsi-ld-client.mjs](../scripts/lib/ngsi-ld-client.mjs).
- API: `createAsset`, `getAsset`, `updateAsset`.
- Smoke: [smoke-ngsi-ld.mjs](../scripts/smoke-ngsi-ld.mjs).
- Đầu vào mẫu: `infra/config/ngsi-ld/seed.json`.
- Có kiểm tra tenant, Asset ID và mapping businessId; timeout mặc định 10 giây.
- `BrokerError` giữ HTTP status và chi tiết lỗi; HTTP 207 không được coi là cập nhật hoàn tất toàn bộ.

### Bằng chứng — 15/10/2026

| Thao tác | Kết quả |
| --- | --- |
| createAsset | HTTP 201 |
| getAsset | status=ready |
| updateAsset | HTTP 204 |
| Read-back | status=in_use, observedAt matched |

Asset kiểm chứng: `urn:ngsi-ld:Asset:org-a:connector-b70eda60-3fc4-4dc1-8c5a-6f1d01370b2f`.
Smoke tạo Asset demo riêng và giữ lại; không sửa fixture `laptop-001`.

Connector chưa tích hợp trực tiếp vào backend/n8n, chưa kiểm tra đầy đủ schema/enum hoặc đích quan hệ,
và chưa có chống event cũ, deduplicate hay tự retry. Quy tắc ordering đã kiểm chứng ở receiver mục 5
không có nghĩa connector này đã thực thi các quy tắc đó.

## 6. Mục 4 — Webhook n8n và API tạo đơn logistics

Workflow: **LatticeDX - Logistics Order Intake**.

Luồng hợp lệ:

`Webhook → Validate Logistics Order → If (true) → Create Logistics Order → Return Order Result`

Luồng payload sai:

`Webhook → Validate Logistics Order → If (false) → Respond to Webhook`

- Webhook dùng Header Auth với `X-Lattice-Webhook-Token`.
- Validation kiểm tra JSON object, các trường cho phép, kiểu/giới hạn dữ liệu,
  `warehouseAssigneeId`, UUID attachment tùy chọn và `Idempotency-Key`.
- `quantity` phải là số nguyên từ 1 đến 1.000.000.
- HTTP Request gọi `POST http://gateway:9080/v1/logistics/orders`, dùng credential sales riêng.
- Response node chuyển tiếp body và HTTP status của backend; dấu tích xanh của HTTP node không đủ để kết luận thành công.
- Đã chạy sync identity, directory snapshot (15 scoped identities) và workflow demo references.
- Người nhận kho được lấy qua directory trong phạm vi `org-a`; không hard-code subject làm ID dùng chung mọi máy.

### Kết quả — 15/10/2026

| Trường hợp | Kết quả |
| --- | --- |
| Payload hợp lệ, giai đoạn chỉ validation | 200 validated_only |
| quantity=0 | 400 invalid_payload |
| Thiếu/sai token webhook | 403 |
| Credential backend không hợp lệ | Chuyển tiếp 401 |
| Tạo đơn qua toàn bộ workflow | 201, state=draft, organizationId=org-a |
| Gửi lại cùng key và payload | 201, cùng Order ID, createdAt và version=1 |

Order kiểm chứng: `e17fd484-e9b3-4a9c-98e3-2192ce2d1f0f`.
`validated_only` là kết quả giai đoạn trước khi nối API; workflow hiện trả kết quả backend.
Retry đã thử không tạo đơn mới; chưa kết luận cho request đồng thời hoặc cùng key nhưng khác payload.

### Workflow export

- File: [logistics-order-webhook.json](../logistics-order-webhook.json).
- Bản đã rà soát có `pinData: {}`, không có `shared` metadata cá nhân và không chứa giá trị token trực tiếp.
- Credential trong export chỉ là tham chiếu tên/ID; môi trường khác phải tạo/gán credential riêng.
- Workflow đang `active: false`; mới kiểm chứng URL `/webhook-test/latticedx/logistics/orders`.
- Access token sales còn được cập nhật thủ công; chưa có tự động cấp/làm mới token.
- Receiver/subscription ở mục 5 dùng token broker riêng, không dùng token sales hoặc token webhook.

## 7. Mục 5 — Subscription và receiver Asset.status

### Thành phần

- Hướng dẫn: [ngsi-ld-subscription.md](ngsi-ld-subscription.md).
- Receiver: `POST /v1/integrations/ngsi-ld/notifications`.
- Đọc lại bản chiếu: `GET /v1/integrations/ngsi-ld/context?entityId=<URN>`.
- Storage: bảng `ngsi_ld_asset_context` trong PostgreSQL.
- Subscription: `urn:ngsi-ld:Subscription:latticedx:org-a:asset-context-v1`.
- Theo dõi `Asset.status`; notification kèm businessId, organizationId và status theo dạng normalized.

Receiver kiểm tra token broker, tenant header, subscription ID, entity type/URN và organizationId.
`status.observedAt` phải hợp lệ; không thay bằng notifiedAt hoặc thời điểm nhận request.

### Bằng chứng hoàn thành — 16/10/2026

Smoke thành công trên code `a5ec081`, fixture:
`urn:ngsi-ld:Asset:org-a:subscription-a1137a4a-c514-4515-bf86-65590b1b1cf1`.

| Đường kiểm chứng | Trường hợp | Kết quả |
| --- | --- | --- |
| Broker thật → gateway → receiver → PostgreSQL | Tạo Asset | PASS, đọc lại đúng status/observedAt |
| Broker thật → gateway → receiver → PostgreSQL | Cập nhật status với observedAt mới hơn | PASS |
| Gọi trực tiếp receiver | Thiếu/sai token hoặc sai tenant | 403 |
| Gọi trực tiếp receiver | Subscription không được phép | 403 |
| Gọi trực tiếp receiver | Observation trùng hoặc cũ | Bỏ qua, không ghi đè |
| Gọi trực tiếp receiver | Cùng observedAt nhưng khác status | 409 |
| Gọi trực tiếp receiver | Thiếu/sai trường bắt buộc hoặc observedAt | Từ chối; bản chiếu đã nhận không đổi |

Hai hàng đầu chứng minh delivery thật từ broker. Các bài thử lỗi gọi trực tiếp receiver,
không được mô tả là toàn bộ lỗi đều phát sinh qua broker.
Đơn nghiệp vụ và workflow transition không thay đổi trong bài thử.

### Các vấn đề đã xử lý và giới hạn

- Header tenant cũ bị lặp dù đã PATCH subscription; tạo lại đúng subscription demo đã giải quyết lỗi.
  Bộ đếm notification của subscription đó reset; các entity và dữ liệu nghiệp vụ được giữ nguyên.
- Broker local từng gửi timestamp `.428Z` thành `.000Z`. Smoke đã dùng mốc giây tròn,
  vẫn yêu cầu so khớp chính xác; chưa chứng minh bảo toàn mili giây end-to-end.
- Ordering áp dụng cho status đã nhận; chưa có bằng chứng runtime cho request đồng thời hoặc batch xung đột.
- Receiver hiện chỉ chiếu Asset.status, chưa chiếu Vehicle/Shipment/Warehouse, name hoặc quan hệ.
- Shared token xác thực bên giữ secret; subscription ID hoặc tenant tự khai không đủ chứng minh nguồn gửi.

## 8. Chạy lại phần subscription

Chạy tại thư mục gốc repo. Hướng dẫn dưới dùng Node có hỗ trợ `--env-file`; full build/check của repo dùng Node 24.

```powershell
node .\scripts\configure-ngsi-ld-local.mjs
docker compose --env-file .env.integration -f infra/compose/core.yml config --quiet
docker compose --env-file .env.integration -f infra/compose/core.yml up -d --build api
docker compose --env-file .env.integration -f infra/compose/core.yml up -d --force-recreate gateway
docker compose --env-file .env.integration -f infra/compose/core.yml ps api
```

Khi API healthy và integration stack đang chạy:

```powershell
node --env-file=.env.integration .\scripts\register-ngsi-ld-subscription.mjs
node --env-file=.env.integration .\scripts\smoke-ngsi-ld-subscription.mjs
```

Chỉ khi cần sửa subscription demo còn giữ header cũ:

```powershell
node --env-file=.env.integration .\scripts\register-ngsi-ld-subscription.mjs --recreate
```

Đọc [hướng dẫn subscription](ngsi-ld-subscription.md) trước khi dùng recreate.
Không chia sẻ toàn bộ JSON subscription vì receiverInfo chứa credential.

## 9. Việc tiếp theo sau phạm vi local

- Chốt nguồn ID, enum, mapping và nguồn cập nhật từng thuộc tính với Duy/nhóm.
- Bổ sung đầy đủ hồ sơ nguồn/license của integration stack và kiểm tra điều kiện đóng gói/phân phối.
- Tự động cấp/làm mới token n8n và kiểm chứng production webhook khi kích hoạt.
- Mở rộng bản chiếu Vehicle/Shipment/Warehouse theo contract đã thống nhất.
- Kiểm tra bảo toàn phần mili giây, concurrent/batch delivery, retry/reconciliation và lưu vết notification.
- Hoàn thiện validation/quan hệ/ordering của Asset connector nếu dùng nó cho dữ liệu vận hành thực tế.


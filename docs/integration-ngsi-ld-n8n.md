# Tích hợp NGSI-LD và n8n

## Phạm vi

Broker lưu trạng thái và ngữ cảnh dùng chung.

Backend nghiệp vụ quản lý dữ liệu giao dịch, kế toán và quyền truy cập.

Workflow n8n tiếp nhận yêu cầu, kiểm tra payload và gọi API nghiệp vụ. Đơn logistics được tạo trong backend; luồng hiện tại chưa đồng bộ đơn sang broker.

## Môi trường đã chạy

### Integration stack

- Orion-LD: 1.10.0 — http://localhost:1026
- MongoDB: 4.4.29 — chỉ truy cập trong mạng Docker.
- n8n: 2.42.7 — http://localhost:5678
- Compose: `infra/compose/integration.yml`.
- Cấu hình môi trường integration sử dụng `.env.integration`; không đưa secret vào tài liệu hoặc Git.
- Token bảo vệ webhook và token sales được cấu hình qua credential của n8n, không viết trực tiếp trong workflow.

### Core backend phục vụ kiểm chứng logistics

- Compose: `infra/compose/core.yml`.
- PostgreSQL, API và ClamAV đã được ghi nhận healthy khi khởi động.
- Keycloak và gateway đã chạy.
- Keycloak từ máy host: http://localhost:8081
- Gateway từ máy host: http://localhost:8080
- Gateway từ container n8n: `http://gateway:9080`.
- Integration stack tiếp tục hoạt động sau khi khởi động core backend.

## Tổng hợp tiến độ — 15/10/2026


| Hạng mục                                                     | Trạng thái                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Chạy Orion-LD, MongoDB và n8n                                | Đã kiểm chứng                                            |
| Mô hình và fixture NGSI-LD                                  | Đã kiểm chứng dữ liệu mẫu; contract chờ nhóm review |
| Connector Asset                                                | Đã kiểm chứng tạo → đọc → cập nhật → đọc lại  |
| Webhook n8n có xác thực và validation                      | Đã kiểm chứng                                            |
| n8n gọi API tạo đơn logistics                              | Đã kiểm chứng                                            |
| Retry cùng idempotency key và payload                        | Đã kiểm chứng trả lại cùng đơn                      |
| Export workflow                                                | Đã export và sao chép về repo local                     |
| Loại bỏ metadata cá nhân, cập nhật tài liệu và commit | Đã kiểm chứng                                            |
| Broker subscription → backend                                 | Chưa triển khai                                            |

## Kết quả broker đã kiểm chứng

- `GET /version`: Orion-LD trả về phiên bản 1.10.0.
- `GET` n8n `/healthz`: HTTP 200.
- Tạo Department, Location và Asset: cả ba trả HTTP 201.
- Đọc lại Asset: trả đúng businessId, organizationId, tên, trạng thái, observedAt và quan hệ đến Department, Location.
- Tenant sử dụng trong các request: `org-a`.
- Header `NGSILD-Tenant` chọn không gian dữ liệu; không thay thế xác thực.

## Mô hình dữ liệu hiện có

- Context: `infra/config/ngsi-ld/context.jsonld`.
- Dữ liệu mẫu cơ bản: `infra/config/ngsi-ld/seed.json`.
- Dữ liệu mẫu logistics: `infra/config/ngsi-ld/seed-logistics.json`.
- Đã định nghĩa Asset, Department, Location, Vehicle, Shipment và Warehouse.
- Namespace `https://latticedx.example/ns/` là đề xuất của nhóm.
- `Department` là loại entity.
- `belongsToDepartment` là tên quan hệ trong context, ánh xạ đến `https://latticedx.example/ns/department`.
- Đổi tên quan hệ để tránh xung đột `Department`/`department` khi đọc JSON bằng Windows PowerShell.
- `observedAt` sử dụng thời gian UTC theo ISO 8601.

### Mapping đã thử nghiệm


| Loại      | Organization | Business ID | URN                                 |
| ------------ | -------------- | ------------- | ------------------------------------- |
| Department | org-a        | it          | urn:ngsi-ld:Department:org-a:it     |
| Location   | org-a        | office-1    | urn:ngsi-ld:Location:org-a:office-1 |
| Asset      | org-a        | laptop-001  | urn:ngsi-ld:Asset:org-a:laptop-001  |

Đây là mapping đã chạy thử, chưa phải contract đã thống nhất với cả nhóm.

Không mặc định business ID, ID bản ghi backend và workflow run ID là một.

### Thiết kế bổ sung

- Đặc tả: [NGSI-LD Data Contract](ngsi-ld-data-contract.md).
- Bổ sung mô hình đề xuất Vehicle, Shipment và Warehouse.
- Định nghĩa quy tắc ID, quan hệ, dữ liệu thiếu và ranh giới dữ liệu.
- Phân biệt `Order.received` với `Shipment.delivered`.
- Phân biệt `warehouseAssigneeId` — subject của người nhận kho — với Warehouse ID.

### Kiểm chứng fixture logistics

- Tạo và đọc lại 6 entity logistics thành công.
- Kiểm tra ID, type, businessId, organizationId và name.
- Kiểm tra status và observedAt của Vehicle, Warehouse và Shipment.
- Kiểm tra Warehouse/Vehicle → Location.
- Kiểm tra Shipment → Vehicle, kho nguồn và kho đích.
- Dữ liệu là fixture demo, chưa đồng bộ với backend.
- Contract và nguồn ID thực tế vẫn chờ nhóm review.

## Asset connector

### Implementation

- Module: `scripts/lib/ngsi-ld-client.mjs`.
- Các hàm: `createAsset`, `getAsset`, `updateAsset`.
- Smoke test: `scripts/smoke-ngsi-ld.mjs`.
- Fixture đầu vào: `infra/config/ngsi-ld/seed.json`.
- Có kiểm tra tenant, định dạng Asset ID và mapping businessId.
- Request timeout mặc định 10 giây.
- `BrokerError` giữ HTTP status và nội dung lỗi broker.
- HTTP 207 được coi là cập nhật chưa hoàn thành toàn bộ.

### Cách chạy bằng Docker

Chạy tại thư mục gốc repo, khi integration stack đang hoạt động:

```powershell
docker run --rm `
    --network lattice-dx_default `
    --mount "type=bind,source=$($PWD.Path),target=/work,readonly" `
    --workdir /work `
    --env NGSI_LD_URL=http://orion-ld:1026 `
    node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f `
    node scripts/smoke-ngsi-ld.mjs
```

Dùng Node 24 trong container; Node 20 trên Windows giữ nguyên.

### Bằng chứng — 15/10/2026

- PASS createAsset: HTTP 201.
- PASS getAsset: status=ready.
- PASS updateAsset: HTTP 204.
- PASS read-back: status=in_use, observedAt matched.
- Asset kiểm chứng: `urn:ngsi-ld:Asset:org-a:connector-b70eda60-3fc4-4dc1-8c5a-6f1d01370b2f`.

Mỗi lần chạy tạo một Asset demo mới và giữ lại trên broker. Không sửa fixture `laptop-001`.

### Giới hạn hiện tại

- Chưa tích hợp connector vào backend hoặc n8n.
- Chưa thực thi đầy đủ schema và enum trong data contract.
- Chưa kiểm tra sự tồn tại/tenant của entity đích trong quan hệ.
- Chưa chống event cũ, deduplicate hoặc tự retry.
- Chưa kiểm chứng các tình huống lỗi bằng test riêng.
- Connector dùng broker nội bộ; chưa có xác thực broker.

## Workflow n8n — Logistics Order Intake

### Cấu hình và luồng xử lý

- Tên workflow: `LatticeDX - Logistics Order Intake`.
- Webhook sử dụng POST và Header Auth.
- Test URL: `http://localhost:5678/webhook-test/latticedx/logistics/orders`.
- Workflow export hiện có `active: false`; chưa kiểm chứng production webhook.

Luồng hợp lệ:

`Webhook → Validate Logistics Order → If (true) → Create Logistics Order → Return Order Result`

Luồng payload không hợp lệ:

`Webhook → Validate Logistics Order → If (false) → Respond to Webhook`

Request thiếu hoặc sai token webhook đã bị từ chối với HTTP 403.

### Xác thực

Hai credential có mục đích riêng:


| Credential                  | Mục đích                                                       |
| ----------------------------- | ------------------------------------------------------------------- |
| LatticeDX Logistics Webhook | Kiểm tra header`X-Lattice-Webhook-Token` của request đầu vào |
| LatticeDX Local Sales API   | Gửi header`Authorization: Bearer …` khi gọi backend            |

Token webhook là secret cấu hình tĩnh, không có cơ chế tự hết hạn trong cấu hình hiện tại.

Token sales là access token do Keycloak cấp và có hạn sử dụng. Hiện phải lấy token mới và cập nhật credential thủ công.

### Chuẩn bị identity và dữ liệu tham chiếu

Đã chạy thành công, theo thứ tự:

```powershell
node .\scripts\sync-local-realm.mjs
node .\scripts\sync-local-directory.mjs
node .\scripts\seed-workflow-demo.mjs
```

Kết quả:

- Đồng bộ identity local thành công.
- Directory snapshot đồng bộ 15 scoped identities.
- Thêm workflow membership và dữ liệu tham chiếu phòng ban/địa điểm.
- Lấy người nhận kho thuộc `org-a` từ directory bằng token sales.
- Subject người nhận kho là ID theo môi trường local, không coi là ID cố định dùng chung cho mọi máy.
- Token sales mới đã được backend chấp nhận khi gọi directory, HTTP 200.

### Kiểm tra payload

Node `Validate Logistics Order` kiểm tra:

- Body phải là JSON object.
- `title`: chuỗi không rỗng, tối đa 200 ký tự.
- `customerName`, `deliveryAddress`, `sku`: chuỗi không rỗng, mỗi trường tối đa 2.000 ký tự.
- `quantity`: số nguyên từ 1 đến 1.000.000.
- `warehouseAssigneeId`: chuỗi không rỗng, tối đa 255 ký tự.
- `attachmentId`: không bắt buộc; nếu có phải đúng định dạng UUID.
- Header `Idempotency-Key`: từ 1 đến 128 ký tự, theo mẫu `[A-Za-z0-9._:-]`.
- Từ chối các trường ngoài danh sách cho phép.

Validation của n8n không thay thế kiểm tra quyền, phạm vi tổ chức và dữ liệu nghiệp vụ tại backend.

### Gọi API backend

Node `Create Logistics Order`:

- Method: POST.
- URL: `http://gateway:9080/v1/logistics/orders`.
- Authentication: Header Auth qua credential sales.
- Header `Idempotency-Key`: lấy từ kết quả validation.
- JSON body: lấy từ `payload` đã kiểm tra.
- Bật Include Response Headers and Status.
- Bật Never Error.
- Response Format: JSON.

Node `Return Order Result` trả lại `body` và `statusCode` của backend.

Do bật Never Error, dấu tích xanh của HTTP Request không đủ để kết luận tạo đơn thành công; phải kiểm tra mã HTTP và body.

Bản JSON đã rà soát chưa cấu hình timeout 10 giây cho HTTP Request.

### Kết quả đã kiểm chứng — 15/10/2026


| Trường hợp                                                 | Kết quả                                           |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| Đúng token, payload hợp lệ ở giai đoạn chỉ validation | HTTP 200,`status=validated_only`                    |
| Đúng token, quantity=0                                      | HTTP 400,`status=invalid_payload`                   |
| Thiếu token webhook                                          | HTTP 403                                            |
| Sai token webhook                                             | HTTP 403                                            |
| Gọi backend với credential sales không hợp lệ            | Nhận và chuyển tiếp lỗi HTTP 401               |
| Tạo đơn qua toàn bộ workflow với token sales hợp lệ   | HTTP 201, đơn ở trạng thái draft, thuộc org-a |
| Gửi lại cùng idempotency key và payload                   | HTTP 201, trả lại cùng ID đơn                  |

`validated_only` là kết quả ở giai đoạn trước khi nối API. Nhánh hợp lệ hiện trả kết quả thật từ backend.

### Bằng chứng tạo đơn và retry

- Order ID: `e17fd484-e9b3-4a9c-98e3-2192ce2d1f0f`.
- Definition: `logistics_order`, version 1.
- Organization: `org-a`.
- State: `draft`.
- Quantity: 4.
- CreatedAt: `2026-10-15T10:05:33.359Z`.

Lần gửi lại cùng idempotency key và payload:

- Trả lại cùng Order ID.
- Giữ nguyên createdAt.
- Giữ nguyên version 1.
- Backend trả HTTP 201 cho replay.
- Không tạo đơn mới trong trường hợp retry đã thử.

Kết quả này chưa bao quát request đồng thời, cùng key nhưng khác payload hoặc thời hạn lưu idempotency key.

### Export workflow

Đã export thành công một workflow và sao chép về:

`logistics-order-webhook.json` tại thư mục gốc repo local.

Cách thực hiện:

```powershell
$workflowId = "SoRWzfgoduJD8nEa"

docker exec lattice-dx-n8n-1 n8n export:workflow --id=$workflowId --pretty --output=/tmp/logistics-order-webhook.json

docker cp lattice-dx-n8n-1:/tmp/logistics-order-webhook.json .\logistics-order-webhook.json
```

Workflow ID trên chỉ áp dụng cho môi trường local đã kiểm chứng.

Kết quả rà soát nội dung JSON được cung cấp:

- `pinData` rỗng.
- Không thấy JWT hoặc giá trị token webhook.
- Credential chỉ chứa tên và ID tham chiếu.
- Trường `shared` có metadata project và thông tin cá nhân; cần loại bỏ khỏi bản đưa vào Git.
- Chưa xác nhận đã loại bỏ `shared` và commit thành công.

Khi import trên môi trường khác, cần tạo/gán lại hai credential phù hợp.

### Giới hạn hiện tại

- Chưa tự động lấy hoặc làm mới token sales.
- Workflow đang inactive; mới kiểm chứng test webhook.
- Chưa cấu hình timeout 10 giây trong bản export đã rà soát.
- Chưa xử lý riêng lỗi kết nối, timeout hoặc response không phải JSON; Never Error hiện được dùng để chuyển tiếp HTTP response từ backend.
- Chưa kiểm chứng idempotency với payload khác, request đồng thời hoặc sau khi hết thời hạn lưu key.
- Mới tạo đơn draft; chưa kiểm chứng chuyển trạng thái nghiệp vụ.
- Chưa đồng bộ dữ liệu logistics giữa backend và broker.
- Chưa hoàn tất xác nhận bản export sạch metadata cá nhân và commit.

## Công việc còn lại

- Chốt data contract với nhóm: quy tắc ID, trường bắt buộc và nguồn cập nhật từng thuộc tính.
- Chốt mapping Vehicle, Shipment và Warehouse với ID thực tế của backend.
- Hoàn thiện ghi nhận giấy phép và đối chiếu image digest đã khóa trong Compose.
- Bổ sung validation và kiểm thử tình huống lỗi cho Asset connector.
- Hoàn tất làm sạch workflow export, cập nhật tài liệu và commit.
- Bổ sung timeout, xử lý lỗi kết nối và cơ chế cấp/làm mới token cho n8n.
- Kiểm chứng production webhook khi kích hoạt workflow.
- Triển khai broker subscription đến endpoint backend.
- Kiểm tra nguồn sự kiện, tenant, observedAt, trường thiếu và chống cập nhật cũ khi nhận notification.

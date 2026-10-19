# Bàn giao API cho Hưng — đơn Logistics và công việc kho

Phần bổ sung cho PR #5 chạy được kinh doanh tạo draft → gửi đơn và giao đúng người kho → kho nhận việc. Một đơn hiện gồm một SKU/số lượng, chưa có Shipment, tồn kho, xe hoặc đối soát. Order là workflow run `logistics_order`, record nền cùng ID; trạng thái dùng chung engine.

## Khởi động

```powershell
pnpm local:up
pnpm identity:sync-local
pnpm directory:sync-local
pnpm workflow:seed-local
pnpm test:logistics
```

Gateway `http://localhost:8080`; JWT realm lattice/client dx-local/audience dx-api. Nếu Gateway đang chạy trước khi thay config, restart Gateway để nạp routes. Nếu recreate API khiến Gateway còn IP container cũ, xem runbook `workflow-runtime.md`. Chạy các smoke batch cách nhau 60 giây để tránh Gateway 120 request/phút. Local dùng credential PUBLIC, không triển khai Internet bằng cấu hình này.

Directory là **snapshot admin đồng bộ từ tài khoản Keycloak thật**, chưa kiểm tra user trực tiếp với Keycloak trên từng lần giao việc. Chạy directory sync sau khi đổi user/role/đơn vị/enabled; tài khoản vừa bị tắt còn được snapshot cũ nhận diện cho đến lần sync tiếp theo. Runtime không nhận dữ liệu danh tính từ trình duyệt; self-registration không cấp directory membership. Xem `directory.md`.

## Tài khoản và mapping

| Actor local | Role chính |
| --- | --- |
| `alice`, `sales2` | logistics:sales + workflow:start; directory/read, records/read-write, tasks/assign-read, files/read-write; org-a |
| `warehouse`, `warehouse2` | logistics:warehouse, tasks:read/decide, records:read, files:read; org-a |
| `warehouse-b` | Kho org-b để thử cách ly |
| `disabled-demo` | Disabled, không được chọn/giao việc sau sync |

Password fixture mới `local-<username>-password`; sync không reset mật khẩu đã đổi. JWT cần giữ ở server connector NocoBase theo cơ chế bridge. PR backend chưa tự thêm workflow/Logistics proxy hoặc block UI của Hưng.

Dropdown dùng `directory.items[].subject` (Keycloak sub), không dùng username hoặc UUID row Employee trong NocoBase. Mapping đề xuất: `Employee.identitySubject=subject`, `Employee.organizationId=organizationId`, `Employee.departmentId=departmentId`. Department dùng ID danh mục trong đơn vị; snapshot local lấy từ thuộc tính admin quản lý hoặc role department:* duy nhất. Chưa tự đồng bộ collections Employee/Department của NocoBase. Tên hiển thị chỉ phục vụ chọn trên UI, quyền dựa vào signed organization và roles.

## Directory và phân trang

```http
GET /v1/directory/people?role=logistics%3Awarehouse&department=warehouse&limit=50&offset=0
Authorization: Bearer <sales-token>
```

```json
{"items":[{"subject":"<keycloak-sub>","displayName":"warehouse Demo","organizationId":"org-a","departmentId":"warehouse","roles":["logistics:warehouse","department:warehouse"]}],"page":{"limit":50,"offset":0,"hasMore":false,"nextOffset":null}}
```

Cần directory:read; chỉ active members cùng đơn vị. REST `POST /v1/tasks` và action tasks.create dùng chung xác minh người nhận active/cùng đơn vị. Task chung không đòi role kho; đơn Logistics bắt buộc người được giao có logistics:warehouse. Không có directory hoặc lookup lỗi thì fail closed 503.

Danh sách dùng `limit` 1–100, mặc định 50; `offset` số nguyên không âm; `q` tìm literal không phân biệt hoa thường trên title/displayName, tối đa 200 ký tự. Response giữ items, thêm page; tiếp tục với nextOffset đến khi null. Visibility lọc trước phân trang, sort có ID tie-breaker. Offset không giữ snapshot cố định khi dữ liệu thay đổi giữa các lần tải.

| Danh sách | Bộ lọc thêm | Visibility |
| --- | --- | --- |
| `/v1/directory/people` | role, department | Active cùng đơn vị; directory:read |
| `/v1/logistics/orders` | state | Chủ đơn; đúng kho được giao ở submitted/received |
| `/v1/workflows` | definitionId, state, inbox=true/false | Policy từng định nghĩa; inbox chỉ bước được phép |
| `/v1/tasks` | status, recordId | Chỉ task giao cho actor cùng đơn vị |
| `/v1/records` | Không thêm | Chủ record hoặc assignee task chung hợp lệ; không mở workflow record qua đường này |

## API Order

| Endpoint | Role và hành vi |
| --- | --- |
| `POST /v1/logistics/orders` | logistics:sales + workflow:start, tạo draft, 201 |
| `GET /v1/logistics/orders` | Sales/kho, paged list theo visibility |
| `GET /v1/logistics/orders/:id` | Sales/kho, detail theo visibility |
| `POST /v1/logistics/orders/:id/submit` | Chủ đơn có logistics:sales, draft → submitted |
| `POST /v1/logistics/orders/:id/receive` | Đúng assignee có logistics:warehouse, submitted → received |

Mọi POST Order cần Idempotency-Key 1–128 ký tự chữ/số/`._:-`. Ý định mới dùng key mới; retry mạng giữ key/body. Replay trả snapshot đã lưu, không tạo thêm task/audit. GET detail để hiện trạng mới nhất.

```http
POST /v1/logistics/orders
Authorization: Bearer <sales-token>
Idempotency-Key: order-create-001
Content-Type: application/json

{"title":"Giao 4 thùng cho CTU","customerName":"CTU","deliveryAddress":"Cần Thơ","sku":"BOX-1","quantity":4,"warehouseAssigneeId":"<directory-sub>","attachmentId":"<optional-clean-file-uuid>"}
```

Quantity là JSON number nguyên dương ≤1.000.000, không nhận chuỗi. Title tối đa 200 code points; customerName/deliveryAddress/sku tối đa 2.000. Có thể bỏ attachmentId; nếu có phải clean, cùng đơn vị và actor được đọc. Không nhận trường quyền/định danh khác.

Response là workflow run cùng trường nghiệp vụ phẳng và availableTransitions. Ví dụ rút gọn:

```json
{"id":"<order-uuid>","recordId":"<same-order-uuid>","definitionId":"logistics_order","state":"draft","version":1,"ownerId":"<sales-sub>","organizationId":"org-a","quantity":4,"warehouseAssigneeId":"<warehouse-sub>","availableTransitions":[{"id":"submit","from":"draft","to":"submitted","role":"logistics:sales","ownerOnly":true,"fields":{},"task":"assign"}]}
```

Gửi `POST /:id/submit`, body `{"expectedVersion":1}`. Backend tạo đúng một task có recordId=order.id, lưu run submitted/version2, link, audit và command result trong transaction. Response có taskId; kho gọi `/v1/tasks?status=pending` hoặc workflow inbox để thấy việc.

Nhận `POST /:id/receive`, body `{"expectedVersion":2,"receiptNote":"Kho đã tiếp nhận"}` bằng warehouse token. Backend đổi received/version3 và task completed/version2 cùng transaction. Đây là **nhận việc xử lý đơn**, chưa chứng minh xuất kho/giao khách. Hai lệnh cùng version chỉ một thành công. Task này không được approve riêng qua `/v1/tasks/:id/decisions` (409); dùng receive hoặc generic workflow transition để trạng thái không lệch.

## Hồ sơ, task và tệp

GET `/v1/tasks/:id` cần tasks:read, chỉ creator/assignee cùng đơn vị. Với Logistics, từ task.recordId gọi Order/workflow detail; generic record detail không mở workflow vì cần policy state/role. Kho không thấy draft; kho khác không thấy đơn/task/tệp dù cùng organization.

Task chung gắn recordId vẫn chỉ tạo bởi chủ record. Assignee được đọc GET `/v1/records/:id` (records:read) và tệp gắn record do chủ record sở hữu. Quyền này giữ sau task hoàn thành để tra cứu; chưa có API thu hồi/reassignment. Task không recordId không cấp quyền hồ sơ/tệp.

Upload `POST /v1/files` `{filename,contentBase64}`; với đơn mới bỏ recordId rồi truyền UUID lúc tạo Order để liên kết workflow. Với task chung, owner upload kèm recordId. Metadata GET `/v1/files/:id`; content GET `/v1/files/:id/content`; cần files:read, content chỉ khi scanStatus clean. Tệp tối đa 1 MiB PostgreSQL/ClamAV. Shared read không cấp quyền link/upload vào record của người khác.

## Mã lỗi và nối UI

| HTTP | Ý nghĩa |
| --- | --- |
| 400 | Body/query/key/UUID/quantity sai; assignee unknown/disabled/foreign/wrong role; evidence không hợp lệ |
| 401 | Thiếu/sai token |
| 403 | Thiếu role/signed organization hoặc thao tác trái quyền |
| 404 | Object không tồn tại hoặc không được đọc |
| 409 | Sai state/version/key; task workflow không được quyết định riêng |
| 413 | Upload quá lớn |
| 429 | Gateway rate limit |
| 503 | Dependency chưa cấu hình hoặc directory lookup lỗi |

Hưng nối dropdown directory → form create → submit → task/inbox → detail/tệp → receive → refresh. Dùng availableTransitions hiển thị nút; server kiểm tra lại. Chưa có broker/n8n/UI end-to-end trong PR này. Không đổi task/dates/checkbox Notion; evidence backend ở `verification.md`.

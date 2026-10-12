# Bàn giao API task/tệp và hợp đồng logistics — 12/10/2026

## Những gì chạy được

Gateway → JWT Keycloak → API → PostgreSQL: tạo bản ghi, tạo task, quyết định theo version, upload/đọc metadata/tải tệp đã quét. Task/tệp và action `tasks.create` nhận **`recordId` tùy chọn**, trỏ tới bản ghi thật do người gọi sở hữu trong đơn vị của token. Scope không lấy từ body.

Ví dụ dưới dùng `<record-id>` từ `POST /v1/records` và `<keycloak-sub>` từ token; không dùng tên đăng nhập làm assigneeId. Mọi request `/v1/*` gửi `Authorization: Bearer <access_token>`.

```json
{"title":"Chuẩn bị đơn hàng logistics"}
```

POST `/v1/records` trả 201 `{id,title,ownerId,organizationId,createdAt}`. Dùng `id` cho các request sau:

```json
{"title":"Kho kiểm tra và chuẩn bị hàng","assigneeId":"<keycloak-sub>","recordId":"<record-id>"}
```

POST `/v1/tasks` trả 201 `{id,title,assigneeId,createdBy,organizationId,status:"pending",version:1,recordId}`. GET `/v1/tasks` trả `{items:[...]}` của assignee và đơn vị token, tối đa 100. Chưa có phân trang/cross-department policy; không coi đây là inbox cả công ty.

POST `/v1/actions/tasks.create/run` dùng cùng input trong envelope:

```json
{"version":1,"input":{"title":"Kho kiểm tra và chuẩn bị hàng","assigneeId":"<keycloak-sub>","recordId":"<record-id>"}}
```

Trả 200 `{actionId:"tasks.create",version:1,status:"succeeded",result:<task>}`. Hưng lấy schema từ GET `/v1/actions`; Nhi gọi action qua token được cấp quyền. Hiện chỉ có records.create/tasks.create; chưa có agent tool, business transitions hoặc webhook nhận sự kiện.

POST `/v1/tasks/<task-id>/decisions`:

```json
{"decision":"approve","expectedVersion":1}
```

Trả task `approved`, version 2, giữ recordId. `reject` phải có `reason`. SQL kiểm tra assignee, đơn vị, pending, version; hai quyết định cùng version chỉ một thành công. Task decision **không** đổi trạng thái bản ghi/đơn hàng và không cấp quyền đọc bản ghi cho người nhận task.

POST `/v1/files`:

```json
{"filename":"delivery-evidence.txt","contentBase64":"YQ==","recordId":"<record-id>"}
```

Trả 201 `{id,filename,ownerId,organizationId,size,scanStatus,recordId}`. GET `/v1/files/<id>` trả metadata; GET `/v1/files/<id>/content` trả attachment chỉ khi clean và đúng chủ sở hữu/đơn vị. Tệp tối đa 1 MiB lưu PostgreSQL bytea, pending trước scan; scanner lỗi/không cấu hình → error; rejected/pending/error → download 409. Không có worker quét lại hoặc object storage.

## Quyền và mã lỗi

| Năng lực | Role hiện có |
| --- | --- |
| Đọc/tạo bản ghi | records:read / records:write |
| Đọc/tạo/quyết định task | tasks:read / tasks:assign / tasks:decide |
| Đọc/upload tệp | files:read / files:write |

Liên kết bản ghi dùng scope chủ sở hữu + đơn vị. Tệp vẫn giữ quyền của uploader; không tự chia sẻ theo task. Directory xác nhận assignee thuộc đơn vị, quyền quản lý đọc hồ sơ người khác, idempotency, outbox và workflow nhiều bước vẫn cần xây tiếp.

| HTTP | Ý nghĩa |
| --- | --- |
| 400 | payload/UUID sai; action có trường ngoài schema |
| 401 | thiếu/sai/hết hạn token |
| 403 | thiếu role hoặc scope đã ký |
| 404 | bản ghi liên kết không tồn tại hoặc không được phép; tệp sai scope |
| 409 | quyết định không khả dụng/sai version; tệp chưa clean |
| 413 | tệp lớn hơn giới hạn |
| 503 | thiếu dependency/cấu hình hoặc tra cứu bản ghi tạm lỗi |

Lỗi JSON `{error:string}`. API task/file cũ không truyền recordId vẫn dùng được. Migration thêm FK/index nullable, không xóa dữ liệu cũ; hàng không liên kết trả recordId:null. Liên kết bị từ chối không ghi task/tệp và không gọi scanner.

## Trạng thái và mô hình bàn giao tiếp

UC1 mua sắm vẫn giữ hợp đồng `draft → submitted → approved → received → accepted → handed_over`, nhánh submitted → rejected. Đây là trạng thái **dự kiến của workflow**, chưa được task API tự thực thi.

Logistics: xem [model/fixture và role/action](../solutions/logistics/README.md) và [contract.ts](../solutions/logistics/contract.ts). Order có nhiều Shipment, tham chiếu Warehouse; Shipment gắn Vehicle. Bản đầu Shipment là một lô/chuyến giao của một đơn; nhiều đơn/lô trên một chuyến cần Lot/Trip/TripItem sau. Các trạng thái/role logistics là hợp đồng cấu hình, chưa có collections/API/role triển khai. Dữ liệu ngữ cảnh xe/kho/lô giao do Nhi ánh xạ vào broker; trạng thái giao dịch do API kiểm soát. Hưng dùng cùng ID/contract khi tạo collections và block.

## Khởi động và kiểm tra

Windows: `pnpm local:up` chạy bộ khởi động Docker có phục hồi socket rồi core và NocoBase. Máy khác có Engine sẵn: `pnpm infra:up` rồi `pnpm nocobase:up`. Đợi Keycloak/ClamAV sẵn sàng; chạy `pnpm identity:sync-local` và `pnpm nocobase:bridge:install` khi cài mới. Không dùng `down -v` hoặc `--remove-orphans` giữa hai Compose.

```sh
pnpm test:infra
pnpm test:foundation
pnpm test:actions
pnpm test:record-links
pnpm test:nocobase
pnpm test:nocobase:bridge
pnpm check
```

Gateway localhost:8080; Keycloak localhost:8081; NocoBase localhost:13000. `docker compose -f infra/compose/core.yml ps` kiểm tra container; API `/health` là liveness nội bộ, `test:infra` xác nhận đường JWT/database thật. Fixture/health chi tiết: [core-local](core-local.md), [bridge](nocobase-action-auth.md), [Docker recovery](docker-desktop-recovery.md).

`pnpm test:scanner-outage` cố ý dừng scanner local và khởi động lại trong finally; tránh chạy khi người khác đang upload. Smoke giữ dữ liệu demo, không xóa dữ liệu dùng chung. Kết quả đã chạy được ghi tại [verification](verification.md).

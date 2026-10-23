# Workflow runtime — bàn giao backend giai đoạn 2

Engine này thực thi các bước được khai báo trong `solutions/workflows/definitions.ts`. Hai cấu hình dùng chung policy, API, transaction, lịch sử và outbox; không có backend riêng cho từng quy trình. Đây là backend đầu tiên, chưa phải toàn bộ hệ điều hành doanh nghiệp hoặc trình thiết kế no-code.

## Chạy và thử

Từ root repo, với Node 24, pnpm và Docker Linux containers:

```powershell
pnpm local:up
pnpm identity:sync-local
pnpm directory:sync-local
pnpm workflow:seed-local
pnpm test:workflows
```

Core Gateway ở `http://localhost:8080`, Keycloak ở `http://localhost:8081`; PostgreSQL/API nằm trong mạng Compose. Sync bổ sung role/user thiếu, giữ mật khẩu user đã tồn tại. Claim `organization_id` là thuộc tính do admin quản lý; người dùng không được tự đổi đơn vị. Seed đăng ký thành viên bằng JWT của chính họ và thêm Department/Location local, không xóa dữ liệu.

Smoke tạo dữ liệu demo và giữ lại. Phần worker dùng PostgreSQL thật trong schema thử riêng cùng receiver HTTP local, kiểm tra lỗi/phục hồi và gửi lặp. Nó chưa kết nối n8n hoặc NGSI-LD broker thật. Schema thử được dọn sau kiểm tra; các job nghiệp vụ thật không bị worker thử gửi đi.

Gateway giới hạn 120 request/phút theo IP. Chạy smoke workflow riêng; nếu vừa chạy liên tiếp toàn bộ smoke cũ, đợi ít nhất 60 giây trước bài này để tránh HTTP 429.

Nếu restart riêng PostgreSQL/API để thử persistence, sau khi database healthy hãy restart Keycloak và Gateway: Keycloak có thể còn connection pool cũ, Gateway có thể còn địa chỉ IP API trước restart. Với local dùng `docker --context desktop-linux compose -f infra/compose/core.yml restart keycloak gateway`, rồi chờ Keycloak sẵn sàng trước đăng nhập. Chưa có orchestration phục hồi production tự động cho tình huống này.

| Tài khoản local | Vai trò dùng trong workflow |
| --- | --- |
| `alice` | Employee, tạo/gửi mua sắm của mình, org-a |
| `manager` | Duyệt/từ chối, đọc lịch sử, retry đồng bộ, org-a |
| `warehouse`, `warehouse2` | Nhận hàng, nghiệm thu, bàn giao, tệp, org-a |
| `hr-demo` | Tạo/gửi onboarding của mình, org-a |
| `it-demo` | Cấp tài khoản trong onboarding, org-a |
| `administration` | Hoàn thành onboarding, tệp, org-a |
| `receiver` | Thành viên nhận bàn giao; không tự được quyền đọc run |
| `bob` | Fixture org-b để kiểm tra cách ly |

Mật khẩu fixture mới là `local-<username>-password`. Đây là thông tin PUBLIC cho local. Sync không đặt lại mật khẩu đã đổi. Lấy token qua client `dx-local` trong realm `lattice`; gửi `Authorization: Bearer <token>` khi gọi Gateway. Không đưa token vào log hoặc frontend tùy ý.

## Hai cấu hình version 1

| Cấu hình | Bước và trường bắt buộc trong `input` |
| --- | --- |
| `procurement` | Tạo draft `{}` → `submit` `{}` → `approve` `{}` hoặc `reject` `{reason}` → `receive` `{receiptAttachmentId}` → `accept` `{acceptanceNote}` → `handover` `{assetId, recipientId, departmentId, locationId, attachmentId}` |
| `onboarding` | Tạo draft `{recipientId}` → `submit` `{}` → `approve` `{}` hoặc `reject` `{reason}` → `provision` `{accountRef}` → `complete` `{locationId, attachmentId}` |

`submit` chỉ cho người tạo; bước khác kiểm tra role tương ứng. `approve` onboarding hiện dùng cùng role manager với mua sắm trong fixture. Tên role này có thể tách ở phiên bản cấu hình tiếp theo.

Một run tạo một record nền có cùng UUID trong transaction. Run là công việc đang chờ: inbox trả các run có bước actor được phép xử lý, không tạo thêm task nền thứ hai. Gọi API quyết định task cũ không chuyển trạng thái workflow. Quyền hiện theo nhóm/role trong đơn vị, chưa có nhận việc độc quyền hoặc ủy quyền cá nhân.

Các version định nghĩa phải được giữ nguyên để run cũ tiếp tục chạy. Khi thay đổi quy trình, cần bổ sung version và cơ chế chọn phiên bản mới; chưa có endpoint upload định nghĩa hoặc designer. Hai mẫu hiện tại đều ở version 1.

## Hợp đồng API cho Hưng

Mọi endpoint cần JWT hợp lệ với claim đơn vị đã ký. Body không được tự truyền actor, organization hoặc trường lạ.

| Endpoint | Kết quả |
| --- | --- |
| `GET /v1/workflow-definitions` | `{items}` các cấu hình actor có role phù hợp |
| `POST /v1/workflow-members/me` | Đăng ký signed subject vào đơn vị; body `{}` hoặc không body |
| `GET /v1/workflow-references` | `{items}` các `{kind,id,name}` Department/Location trong đơn vị |
| `POST /v1/workflows` | Tạo run, HTTP 201 |
| `GET /v1/workflows` | `{items}` các run được đọc, tối đa 100 |
| `GET /v1/workflows?inbox=true` | `{items}` các run có bước được xử lý, tối đa 100 |
| `GET /v1/workflows/:id` | Run cùng `availableTransitions` |
| `POST /v1/workflows/:id/transitions` | Run sau chuyển bước cùng `availableTransitions` |
| `GET /v1/workflows/:id/history` | `{items}` audit theo version, tối đa 100 |
| `GET /v1/workflows/:id/sync` | `{items}` job có `id,status,attempts,lastError`, tối đa 100 |
| `POST /v1/workflows/:id/sync/retry` | `{retried}` số job failed được đưa lại pending |

POST tạo/chuyển bước/retry cần `Idempotency-Key`: 1–128 ký tự trong `A-Z a-z 0-9 . _ : -`. Mỗi ý định mới dùng key mới; retry mạng giữ nguyên key và body. Lặp yêu cầu hợp lệ trả kết quả đã lưu, không ghi thêm audit hoặc event. Dùng lại key với dữ liệu/actor khác trả 409. Kết quả replay là snapshot của lệnh cũ: tải lại detail nếu cần trạng thái mới nhất. Self-registration là ngoại lệ không cần key vì unique signed organization/subject đã bảo đảm idempotence.

Ví dụ Alice tạo rồi gửi yêu cầu (mỗi lệnh dùng key riêng):

```http
POST /v1/workflows
Authorization: Bearer <alice-token>
Idempotency-Key: procurement-create-001
Content-Type: application/json

{"definitionId":"procurement","title":"Trang bị máy tính cho phòng IT","input":{}}
```

```http
POST /v1/workflows/<run-id>/transitions
Authorization: Bearer <alice-token>
Idempotency-Key: procurement-submit-001
Content-Type: application/json

{"action":"submit","expectedVersion":1,"input":{}}
```

Sau manager approve, kho receive/accept, lấy version mới nhất để bàn giao:

```json
{
  "action": "handover",
  "expectedVersion": 5,
  "input": {
    "assetId": "laptop-001",
    "recipientId": "<signed-subject-da-dang-ky>",
    "departmentId": "it",
    "locationId": "office-1",
    "attachmentId": "<uuid-tep-clean>"
  }
}
```

Run bắt đầu version 1, mỗi bước tăng 1. SQL khóa row và kiểm tra version nên hai người duyệt cùng lúc chỉ một người thành công. 400: input/key/reference sai; 401: token sai; 403: thiếu quyền; 404: không tồn tại hoặc không được đọc; 409: sai bước/version hoặc key xung đột; 503: dependency chưa cấu hình.

Hưng có thể dựng form từ định nghĩa và nút từ `availableTransitions`, nhưng server luôn kiểm tra lại quyền. Bridge NocoBase hiện có action catalog/execute, chưa proxy workflow endpoints; cần bổ sung đường gọi được allowlist ở server plugin và giữ JWT ở server theo cơ chế bridge hiện có. Chưa có block workflow UI được tích hợp sẵn.

## Tệp, thành viên và tham chiếu

Upload tệp qua `POST /v1/files` với `{filename,contentBase64}` bằng actor có `files:write`. Với kho/hành chính, upload không truyền `recordId`: API liên kết record cũ chỉ dành cho chủ record. Sau đó gửi UUID tệp trong bước workflow để engine kiểm tra và liên kết.

Tệp phải clean, cùng đơn vị và actor được đọc: chủ tệp hoặc participant của workflow đã liên kết. Sau liên kết, participant đọc metadata/content qua `GET /v1/files/:id` và `GET /v1/files/:id/content`, vẫn cần `files:read`. Người ngoài workflow không được đọc dù cùng đơn vị; rejected/error không tải được. Tệp tối đa 1 MiB, lưu PostgreSQL bytea và quét ClamAV; chưa object storage.

`recipientId` là signed subject đã self-register, không phải username. Membership chỉ kiểm tra người nhận thuộc đơn vị, không tự cấp quyền đọc hồ sơ. Registry local có department `warehouse`, `it`, `hr`, `administration` và location `office-1` ở org-a. Đây là bootstrap, chưa có directory UI hoặc CRUD danh mục production; adapter collections thật là việc tích hợp tiếp theo.

## Outbox và hợp đồng cho chị Nhi

Bàn giao/hoàn thành lưu run, audit, liên kết tệp, kết quả idempotent và event trong cùng transaction. Lỗi hệ thống ngoài không hủy bước đã hoàn thành. Bước `handover` tạo `asset.handed_over`; `complete` tạo `employee.onboarded`.

```json
{
  "eventId": "<uuid-co-dinh>",
  "eventType": "asset.handed_over",
  "organizationId": "org-a",
  "runId": "<uuid>",
  "recordId": "<cung-uuid-run>",
  "definitionId": "procurement",
  "version": 6,
  "occurredAt": "<ISO-8601>",
  "data": {"assetId":"laptop-001","recipientId":"<subject>","departmentId":"it","locationId":"office-1","attachmentId":"<uuid>","receiptAttachmentId":"<uuid>","acceptanceNote":"Đã kiểm tra"}
}
```

Đặt `WORKFLOW_EVENT_URL`, `WORKFLOW_EVENT_TOKEN` và `WORKFLOW_OUTBOX_WORKER=true` trong môi trường Compose, recreate API để bật worker sau khi receiver và backlog đã được rà soát. Chỉ đặt URL/token không tự bật worker. URL phải truy cập được từ container, chẳng hạn endpoint n8n trong mạng chung hoặc `host.docker.internal` nếu receiver chạy trên host. Đây là cấu hình server cố định, không nhận URL từ trình duyệt. Worker tắt thì job giữ pending; cặp URL/token thiếu một giá trị làm startup báo lỗi. Xem [bàn giao producer UC1](uc1-backend-handoff.md) để xuất payload thật và phân biệt acknowledge với broker đã đồng bộ.

Worker POST JSON, `Authorization: Bearer <configured-token>`, `Idempotency-Key: <eventId>`, timeout 10 giây, không theo redirect. Receiver cần xác minh token, lưu event bền vững trước khi trả 2xx, khử lặp theo eventId và ánh xạ entity NGSI-LD theo organization/assetId. HTTP 2xx chỉ xác nhận receiver đã nhận; không chứng minh broker đã đồng bộ nếu receiver còn xử lý bất đồng bộ.

Delivery là **at least once**: có thể gửi lại khi receiver xử lý xong nhưng response/completion bị mất. Claim dùng SQL `SKIP LOCKED`, lease 60 giây và lease token để worker cũ không ghi đè worker mới. Tối đa 5 lần, backoff tăng từ 5 giây, giới hạn 300 giây. Manual retry chỉ role `workflow:sync`, chỉ reset job failed; giữ eventId. Gọi lại cùng retry key không reset ngân sách thêm lần nữa, kể cả job đã fail lại.

## Phạm vi và nghiệm thu

Đã có API/quyền/version/idempotency, hai cấu hình, giao dịch/audit và durable outbox. Audit không có endpoint sửa/xóa, nhưng chưa là sổ cái chống can thiệp của quản trị database. Chưa có migration framework, phân trang đầy đủ, individual assignment, workflow designer, n8n/broker thật, agent nghiệp vụ hoặc UI end-to-end.

Sáu task backend của Duy được đối chiếu bằng unit/integration tests và smoke SQL thật trong `docs/verification.md`. Giữ nguyên **mọi ô tick Notion** theo yêu cầu Duy; kết quả backend không thay nghiệm thu UI/broker của cả nhóm.

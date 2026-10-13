# Workflow blocks và giao việc phòng ban

Backend mở rộng Workflow Studio: một bước chuyển có thể chạy các block được cấu hình, thay vì phải viết một endpoint nghiệp vụ mới cho mỗi use case. Hưng dùng cấu hình này cho Studio; chị Nhi xử lý adapter bên ngoài.

## Các block

| Action | Quyền người chạy | Kết quả |
| --- | --- | --- |
| `records.create` | `records:write` | Tạo hồ sơ thuộc người chạy, đúng đơn vị; trả `id` |
| `tasks.create` | `tasks:assign` | Giao việc cho người đang hoạt động, liên kết hồ sơ được phép; trả `id` |
| `connectors.dispatch` | `workflow:integrate` | Ghi yêu cầu vào outbox cho `n8n`, `ngsi-ld` hoặc `agent`; trả `eventId` |

Role của bước chuyển và role của block đều được kiểm tra từ JWT. Cấu hình không tự cấp quyền. Tối đa 10 block/bước; chạy theo thứ tự. Ghi hồ sơ, task, sự kiện, lịch sử và kết quả block nằm trong cùng giao dịch PostgreSQL. Nếu block sau thất bại, mọi thay đổi trước đó của bước bị rollback. Request được chấp nhận khi gửi lại cùng Idempotency-Key không chạy lại block.

`GET /v1/workflow-blocks` cung cấp danh mục block người dùng có quyền chạy để Studio dựng bộ chọn. Danh mục chỉ mô tả khả năng; không tự cấp role hoặc thực thi action.

Hưng cần nối các route mới qua connector/proxy NocoBase bằng JWT của người dùng đang đăng nhập. Increment này chỉ đổi backend/Gateway, chưa thêm block giao diện hoặc tự cập nhật proxy UI của nhánh Hưng.

## Binding dữ liệu

Không dùng JavaScript, biểu thức thực thi hoặc đường dẫn JSON tùy ý. Mỗi đầu vào chọn một nguồn rõ ràng:

```json
{"source":"literal","value":"Chuẩn bị tài khoản"}
{"source":"data","field":"departmentId"}
{"source":"input","field":"approvalNote"}
{"source":"context","field":"title"}
{"source":"result","stepId":"handoff","field":"id"}
```

`data` đọc dữ liệu workflow đã lưu; `input` đọc dữ liệu bước hiện tại đã kiểm tra; `context` chỉ hỗ trợ `recordId`, `title`, `ownerId`, `actorId`; `result` chỉ đọc ID của block tạo record/task trước đó trong cùng bước. Thiếu giá trị tại thời điểm chạy trả lỗi và rollback. Kết quả block không tự ghi đè các trường dữ liệu workflow.

## Ví dụ ghép block

Trong một transition đã có `id/from/to/role/fields`, thêm:

```json
{
  "steps": [
    {"id":"handoff","action":"records.create","input":{"title":{"source":"context","field":"title"}}},
    {
      "id":"assign","action":"tasks.create",
      "input":{
        "title":{"source":"literal","value":"Chuẩn bị chỗ làm và tài khoản"},
        "recordId":{"source":"result","stepId":"handoff","field":"id"}
      },
      "assignment":{
        "kind":"department",
        "department":{"source":"data","field":"departmentId"},
        "role":"department:it"
      }
    },
    {
      "id":"notify","action":"connectors.dispatch",
      "input":{
        "connectorId":{"source":"literal","value":"n8n"},
        "operation":{"source":"literal","value":"employee.provision"},
        "payload":{
          "recordId":{"source":"result","stepId":"handoff","field":"id"},
          "taskId":{"source":"result","stepId":"assign","field":"id"}
        }
      }
    }
  ]
}
```

`departmentId` phải được khai báo trong dữ liệu workflow. Với loại field `department`, danh mục reference cũng cần tồn tại. Khi muốn chọn người cụ thể, bỏ `assignment` và thêm `input.assigneeId` binding. Hai cách không được dùng đồng thời.

## Giao việc và quyền đọc

API `GET /v1/directory/departments?role=department%3Ait&limit=50&offset=0` cần `directory:read`. Trả `{items:[{id,name,memberCount}],page}`; chỉ đếm thành viên đang hoạt động của đúng đơn vị, lọc role/query trước phân trang. Tên lấy từ danh mục phòng ban khi có, nếu không dùng ID. Đây là danh mục từ snapshot quản trị, chưa có sơ đồ tổ chức phân cấp hoặc quan hệ quản lý tự động.

Giao việc theo phòng ban lọc active + đúng đơn vị + department + role. Một người phù hợp: giao người đó. Không ai phù hợp: 400. Nhiều người phù hợp: 409. Để giải quyết ngay trên hồ sơ đang chạy, cấu hình một transition thay thế từ cùng trạng thái với field người nhận và `assignment.assigneeId` binding. Người được chọn vẫn phải đúng phòng ban/vai trò và đang hoạt động; chọn người ngoài tập hợp trả 400. Ví dụ binding `{"source":"input","field":"chosenId"}` với `fields:{"chosenId":"subject"}`. Studio lấy `availableTransitions` để hiển thị bước chọn này, không sửa cấu hình phiên bản của hồ sơ đang chạy. Quy tắc này không phải cân bằng tải hoặc tự tìm trưởng phòng.

Task được tạo là task foundation. Nếu liên kết record, backend kiểm tra quyền sở hữu record của người tạo task; record vừa tạo bằng block trước đáp ứng điều kiện này. Với record foundation độc lập, người nhận đọc đúng record qua cơ chế task sharing hiện có. Nếu liên kết record nền của workflow bằng context.recordId, người nhận vẫn cần quyền đọc workflow; task không tự mở quyền này. Nhận task không tự cấp quyền đọc toàn bộ workflow hay lịch sử block. Hoàn thành task foundation chưa tự chuyển trạng thái workflow; muốn phối hợp hai trạng thái cần cấu hình/adapter nghiệp vụ tiếp theo. Logistics vẫn giữ liên kết và hành vi riêng đã có.

Đợt [Workflow completion](workflow-completion.md) cho phép khai báo `wait` trên task/connector block cuối. Khi đó task và workflow được hoàn thành đồng thời qua API completion; task không khai báo wait vẫn giữ hành vi foundation ở trên.

## Kết quả chạy và adapter

`GET /v1/workflows/:id/executions?limit=50&offset=0` trả `{items:[...],page}` với `runId`, `version`, `stepId`, `stepIndex`, `actorId`, `action`, `input`, `result`, `occurredAt`. Thứ tự theo version và stepIndex thực thi, không theo tên block. Chỉ người có quyền đọc workflow được xem. Đọc trạng thái outbox bằng endpoint `/sync` hiện có; retry vẫn cần `workflow:sync`.

Connector payload gửi đến endpoint máy chủ cố định chứa `eventId`, `connectorId`, `operation`, ngữ cảnh workflow/đơn vị và `data` là payload được chọn. Studio không cấu hình URL hoặc token. Adapter của chị Nhi nên phân tuyến theo connectorId/operation, kiểm tra token, deduplicate theo eventId và xác nhận HTTP thành công sau khi tiếp nhận bền vững. Worker hiện bảo đảm at-least-once, không bảo đảm bên ngoài chỉ thực thi một lần.

Backend kiểm thử hợp đồng bằng receiver HTTP local cho cả ba ID; chưa xác nhận n8n, broker hoặc model agent thực tế đã xử lý. `workflow:integrate` local cấp cho alice, không tự cấp ở production.

## Khởi động và kiểm thử

```powershell
pnpm local:up
pnpm identity:sync-local
pnpm directory:sync-local
pnpm workflow:seed-local
pnpm test:workflow-blocks
```

Chạy các batch smoke cách nhau ít nhất 60 giây nếu chạm giới hạn Gateway. Xem script và verification để biết dữ liệu demo được giữ lại. Không đổi giấy phép nguồn nền hoặc tick task Notion trong increment này.

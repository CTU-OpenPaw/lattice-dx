# Workflow Studio — cấu hình và xuất bản

Phần backend này giúp tạo quy trình mới qua cấu hình, không phải sửa `solutions/workflows/definitions.ts` rồi build lại. Hưng làm giao diện Studio sử dụng các API dưới đây. Đây là cấu hình quy trình và biểu mẫu đầu vào, chưa phải bộ tạo toàn bộ giao diện ứng dụng hoặc trình kéo thả.

## Quyền và phiên bản

JWT cần signed `organization_id` và role `workflow:design` để đọc/ghi cấu hình. Không nhận đơn vị hoặc định danh quản trị từ body. Tài khoản local `alice` được cấp role này sau `pnpm identity:sync-local`; production phải cấp bằng quản trị danh tính.

Mỗi bản nháp có `revision` để tránh hai người ghi đè nhau. Mỗi lần xuất bản một revision mới tạo một `version` bất biến. Gửi lại cùng revision không tạo thêm version. Hồ sơ đang chạy giữ `definitionVersion` ban đầu; hồ sơ mới lấy phiên bản mới nhất. Các tên `procurement`, `onboarding`, `logistics_order` dành cho mẫu nguồn hiện có.

## API cho Hưng

Gateway: `http://localhost:8080`. Header `Authorization: Bearer <JWT>`.

| API | Body / mục đích |
| --- | --- |
| `POST /v1/workflow-drafts` | `{definition}`; tạo bản nháp, HTTP 201 |
| `GET /v1/workflow-drafts?limit=50&offset=0` | Danh sách bản nháp của đơn vị; đọc `page.nextOffset` |
| `GET /v1/workflow-drafts/:id` | Đọc cấu hình và revision |
| `PUT /v1/workflow-drafts/:id` | `{expectedRevision, definition}`; lưu revision tiếp theo |
| `POST /v1/workflow-drafts/:id/publish` | `{expectedRevision}`; trả định nghĩa với version đã xuất bản |
| `GET /v1/workflow-definitions` | Danh mục quy trình người dùng được sử dụng |
| `POST /v1/workflows` | `{definitionId,title,input}`; cần `Idempotency-Key`, `workflow:start` và startRole |
| `POST /v1/workflows/:id/transitions` | `{action,expectedVersion,input}`; cần `Idempotency-Key` và quyền bước |

Draft trả `id`, `revision`, `definition`, người tạo/cập nhật và thời gian. Definition không chứa version khi gửi; server gán version khi publish. Input hồ sơ và bước hiện là dictionary chuỗi, kể cả `positiveInteger` truyền dưới dạng `"2"`; facade Logistics giữ contract số riêng.

Ví dụ định nghĩa để Studio gửi trong `{definition: ...}`:

```json
{
  "id": "employee-intake",
  "title": "HR và IT tiếp nhận nhân viên",
  "startRole": "department:hr",
  "initialState": "draft",
  "startFields": {"employeeName": "text"},
  "readerRoles": ["department:hr", "department:it"],
  "transitions": [
    {"id": "submit", "from": "draft", "to": "submitted", "role": "department:hr", "ownerOnly": true, "fields": {}},
    {"id": "provision", "from": "submitted", "to": "completed", "role": "department:it", "fields": {"accountRef": "text"}, "eventType": "employee.onboarded"}
  ]
}
```

Trạng thái được suy ra từ `initialState` và các cạnh `from/to`. Mọi cạnh phải tới được từ trạng thái bắt đầu. Hỗ trợ field `text`, `positiveInteger`, `subject`, `department`, `location`, `file`; các tham chiếu vẫn phải tồn tại và được quyền truy cập như workflow cũ. Role không tự tạo tài khoản hay cấp quyền; người dùng vẫn phải có role ký trong JWT.

Mã lỗi: 400 payload/cấu hình sai; 401 token sai; 403 thiếu quyền; 404 không có dữ liệu trong phạm vi; 409 trùng ID hoặc revision cũ; 503 thiếu dịch vụ. UI gặp 409 nên tải lại cấu hình và cho người dùng xem khác biệt trước khi lưu lại.

## Phạm vi hiện tại

- Xuất bản cấu hình được phép là quyết định quản trị: `readerRoles` xác định ai trong đơn vị đọc được quy trình đó. Không trao `workflow:design` cho mọi nhân viên.
- Event đi qua outbox và URL connector do máy chủ cấu hình. Payload không được chứa mã thực thi, URL tùy ý hay bí mật. Sự kiện pending chưa chứng minh n8n/broker đã xử lý.
- Custom definition chưa nhận task hook `assign/complete`; các hook Logistics nguồn hiện có giữ nguyên. Đợt mở rộng [workflow blocks](workflow-blocks.md) bổ sung `steps` tạo hồ sơ/task và gửi yêu cầu connector; task block foundation chưa tự chuyển trạng thái workflow.
- Chưa có canvas Studio, phát sinh page/collection NocoBase, role editor, xóa định nghĩa, rollback publication hoặc đồng bộ nguồn cấu hình Git. Người dùng có thể sửa bản nháp và publish phiên bản mới để thay đổi quy trình tương lai.

## Chạy kiểm chứng local

```powershell
pnpm local:up
pnpm identity:sync-local
pnpm directory:sync-local
pnpm test:workflow-studio
```

Gateway cần restart sau khi đổi allowlist hoặc API container IP: `docker --context desktop-linux compose -f infra/compose/core.yml restart gateway`. Các smoke batch chạy cách nhau ít nhất 60 giây do giới hạn 120 request/phút theo IP. Smoke giữ lại bản nháp, hai phiên bản và hồ sơ demo để kiểm tra sau restart.

# Action runtime — bàn giao Duy → Hưng / Nhi

Ngày 12/10/2026. Đây là lát đầu của engine: catalog các action phía server và thực thi đồng bộ có kiểm tra quyền. Chưa có graph nối block, lịch chạy, journal action hoặc workflow tổng quát.

## Chạy và kiểm chứng

```powershell
cd E:\pmnm2026
pnpm infra:up
pnpm identity:sync-local
pnpm test:actions
```

Gateway: `http://localhost:8080`. Script kiểm tra bằng Keycloak, Gateway và PostgreSQL thật, tạo một record và một task mỗi lần. Dữ liệu thử được giữ lại; không xóa volume. Cấu hình/password local công khai không dùng cho môi trường chia sẻ/production.

## Catalog cho Studio

`GET /v1/actions`, header `Authorization: Bearer <access_token>`.

```json
{
  "items": [
    {
      "id": "records.create",
      "version": 1,
      "title": "Tạo bản ghi",
      "requiredRole": "records:write",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title"],
        "properties": {
          "title": {"type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\S"}
        }
      }
    }
  ]
}
```

Danh sách chỉ chứa action có dependency được cấu hình và caller có role phù hợp. Alice local nhìn thấy cả hai action; Bob local không có role tạo nên nhận `{items:[]}`. Catalog hỗ trợ UI, không thay việc kiểm tra quyền lúc thực thi. Registry hiện định nghĩa trong code server; không có API để người dùng upload handler hoặc thay requiredRole.

Giới hạn độ dài input action đếm Unicode code points theo JSON Schema (emoji tính một code point); endpoint REST cũ vẫn giữ cách kiểm tra UTF-16 code units. Đây không phải giới hạn byte hay số ký tự hiển thị theo grapheme.

| Action | Role | Input bắt buộc | Kết quả |
| --- | --- | --- | --- |
| `records.create`, version 1 | `records:write` | `title`: chuỗi 1–200 ký tự, không toàn khoảng trắng | Record hiện có, gồm id/title/ownerId/organizationId/createdAt |
| `tasks.create`, version 1 | `tasks:assign` | `title` như trên; `assigneeId`: subject Keycloak, 1–100 ký tự, không toàn khoảng trắng | Task hiện có, gồm id/title/assigneeId/createdBy/organizationId/status/version |

`title` được trim. `assigneeId` là định danh opaque, giữ nguyên. Không nhận trường ngoài schema: ownerId/organizationId/createdBy không phải input của client. Scope lấy từ JWT đã xác minh. Task assignment hiện chỉ dành cho caller đáng tin; chưa kiểm chứng assignee thuộc cùng đơn vị bằng directory.

## Thực thi

`POST /v1/actions/records.create/run`, cùng bearer token, `Content-Type: application/json`:

```json
{"version":1,"input":{"title":"Bản ghi thử từ Studio"}}
```

HTTP 200:

```json
{
  "actionId":"records.create",
  "version":1,
  "status":"succeeded",
  "result":{
    "id":"<uuid>",
    "title":"Bản ghi thử từ Studio",
    "ownerId":"<subject>",
    "organizationId":"org-a",
    "createdAt":"<timestamp>"
  }
}
```

`POST /v1/actions/tasks.create/run`:

```json
{"version":1,"input":{"title":"Kiểm tra thiết bị","assigneeId":"<subject người nhận>"}}
```

Kết quả `status:"succeeded"` nói action đã tạo task thành công; **task bên trong vẫn `pending`**, chưa được duyệt. `version` của action là phiên bản hợp đồng (1); `result.version` của task là phiên bản cập nhật task. Task này đọc/duyệt qua API task hiện có; chưa liên kết với recordId.

| HTTP | Client xử lý |
| --- | --- |
| 400 | Sửa input/envelope/version; không tự retry |
| 401 | Đăng nhập/lấy token hợp lệ qua cơ chế auth của client |
| 403 | Không có quyền hoặc thiếu scope đơn vị; không tự retry |
| 404 | Action ID không tồn tại |
| 413 | JSON vượt body limit API (16 KiB) |
| 429 | Gateway giới hạn lưu lượng |
| 503 | Thiếu cấu hình identity hoặc dependency của action |
| 500 / mất kết nối | Không khẳng định chưa ghi dữ liệu; kiểm tra trạng thái trước khi thử lại |

Lỗi dự kiến của API có `{error:string}`; Gateway/framework có thể có cấu trúc lỗi khác. Client dùng HTTP status, không phụ thuộc câu thông báo. Version sai hiện trả 400, không là cơ chế negotiation.

## Hưng: block NocoBase đầu tiên

1. Qua adapter phía server/BFF đã có identity hợp lệ, đọc catalog và chọn action.
2. Dựng form theo inputSchema, lưu `actionId`, `version` và mapping input trong cấu hình block.
3. Khi nhấn nút, gọi action, chặn bấm lặp khi đang chờ, hiển thị result/lỗi.
4. Không nhúng password Alice/admin vào browser. NocoBase login và Keycloak vẫn riêng; chưa có SSO, CORS hoặc BFF tự chuyển danh tính. Phải triển khai adapter auth hợp lệ trước khi tuyên bố người dùng NocoBase gọi action đúng danh tính.

## Nhi: connector n8n

HTTP Request node gọi cùng endpoint/envelope; cấu hình bearer credential trong vùng credential của n8n. Production cần danh tính dịch vụ đúng đơn vị và role giới hạn; không triển khai service-account tự chọn organization bằng body. Password grant `dx-local` chỉ dùng thử local, chưa phải phương án cấp credential production.

Không bật automatic retry cho action tạo dữ liệu: chưa có idempotency key. Nếu timeout sau khi server đã ghi, gọi lại có thể tạo bản sao. Chưa có n8n workflow chạy trong repo; đây là hợp đồng bàn giao.

## Phạm vi mở rộng

Các action tiếp theo đăng ký handler server, schema/version/role và kiểm thử quyền trước khi đưa vào catalog. Cần bổ sung idempotency, lịch sử thực thi, điều phối graph và adapter sự kiện để đi từ action runtime này tới engine nối block. Không mặc định registry đồng bộ này đã giải quyết mọi năng lực đó.

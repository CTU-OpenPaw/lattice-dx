# Workflow bundles — bàn giao Studio

Một bộ mẫu đóng gói **1–10 cấu hình workflow** để tái sử dụng. Đây là cấu hình của engine: trường dữ liệu, trạng thái, điều kiện, block và cơ chế chờ kết quả. Bộ mẫu chưa chứa bố cục NocoBase, biểu mẫu UI, tài khoản, tệp, bản ghi đang chạy hoặc cài đặt dịch vụ ngoài.

## Cách dùng

1. Người thiết kế chọn các workflow **đã publish** và phiên bản cụ thể để xuất.
2. Tại đơn vị đích, tải JSON và gọi validate để xem trước các workflow, trường nhập, role và connector cần dùng.
3. Đổi ID trong JSON nếu trùng cấu hình hiện có; gọi import. Toàn bộ workflow được tạo thành bản nháp revision 1, hoặc không có cái nào được nhập nếu có lỗi/xung đột.
4. Kiểm tra các role, người nhận, phòng ban và adapter của đơn vị đích. Dùng API draft hiện có để điều chỉnh rồi publish riêng từng workflow.
5. Người dùng tạo/chạy workflow qua API thông thường. Dữ liệu người nhận/phòng ban được chọn theo tham chiếu hợp lệ tại đơn vị đích khi chạy.

Import không cấp role, không cài connector, không khởi động workflow và không ghi đè bản nháp/phiên bản đang dùng. Lặp lại import sau thành công trả 409; có thể kiểm tra các ID bằng GET draft nếu mất phản hồi. Không có cơ chế ghi đè hoặc idempotency-key cho import ở bản này.

## API

Ba endpoint POST yêu cầu JWT có `workflow:design` và `organization_id` đã ký. Client không gửi tenant/actor trong body. Gateway áp dụng xác thực và giới hạn request như API Studio.

| Endpoint | Request | Response |
| --- | --- | --- |
| `/v1/workflow-bundles/export` | `{definitions:[{id,version}]}` | 200, JSON bundle trực tiếp |
| `/v1/workflow-bundles/validate` | `{bundle}` | 200, preview; không ghi dữ liệu |
| `/v1/workflow-bundles/import` | `{bundle}` | 201, `{items:WorkflowDraft[]}` |

Version xuất là số nguyên dương trong phạm vi PostgreSQL integer. Luôn chọn rõ phiên bản; không mặc định latest. Xuất v1 vẫn giữ nội dung v1 dù đã có v2. Chỉ xuất workflow custom, chưa xuất định nghĩa builtin có ID dành riêng.

Ví dụ export:

```json
{"definitions":[{"id":"employee-intake","version":1}]}
```

Ví dụ body validate/import:

```json
{
  "bundle": {
    "format": "latticedx.workflow-bundle",
    "formatVersion": 1,
    "definitions": [{
      "id": "employee-intake",
      "title": "Tiếp nhận nhân viên",
      "startRole": "employee",
      "initialState": "draft",
      "startFields": {"employeeName":"text"},
      "readerRoles": [],
      "transitions": [{
        "id":"submit", "from":"draft", "to":"submitted",
        "role":"employee", "ownerOnly":true, "fields":{}
      }]
    }]
  }
}
```

Preview tương ứng:

```json
{
  "workflowCount":1,
  "definitions":[{
    "id":"employee-intake",
    "title":"Tiếp nhận nhân viên",
    "requiredRoles":["employee","workflow:start"],
    "connectors":[],
    "inputFields":{
      "start":{"employeeName":"text"},
      "optionalStart":{},
      "transitions":{"submit":{}}
    }
  }]
}
```

`requiredRoles` là tập role liên quan ở nhiều vai trò: người tạo, người đọc, người xử lý, người nhận task và tài khoản callback. **Không cấp toàn bộ tập đó cho một người.** Preview chưa kiểm tra role tồn tại hay adapter đang chạy; quản trị viên cần đối chiếu cấu hình identity và việc triển khai. Trường subject/department/file/location vẫn được runtime kiểm tra theo đơn vị, quyền và dữ liệu thật.

## Giới hạn và lỗi

- Mỗi definition tối đa 12,288 byte JSON UTF-8; toàn bộ HTTP request tối đa 131,072 byte. Bộ mẫu chỉ có cấu hình declarative được validator hiện tại hỗ trợ; không nhận mã thực thi/URL tùy ý.
- ID phải là custom slug hợp lệ, không trùng trong bundle. Literal ở `tasks.create.input.assigneeId`, `recordId`, `assignment.department` và `assignment.assigneeId` bị từ chối, để tránh mang ID cụ thể của nguồn. Dùng binding data/input/context/result phù hợp với validator và runtime hiện có.
- Các literal khác như tiêu đề, điều kiện so sánh và payload connector **được giữ nguyên**. Người xuất phải xem lại nội dung để tránh chia sẻ thông tin bí mật; export không phải công cụ tự phát hiện hoặc làm sạch bí mật.
- Bundle không chứa server version, actor hoặc thời gian tạo draft. Khi import, server gán tenant, createdBy/updatedBy của người nhập. Chỉnh sửa ở đích không ảnh hưởng cấu hình gốc.

| HTTP | Ý nghĩa |
| --- | --- |
| 400 | Body/format/version/ID/cấu hình/portability không hợp lệ |
| 401 | JWT thiếu hoặc không hợp lệ |
| 403 | Không có workflow:design hoặc đơn vị ký trong token |
| 404 | Không có published version trong đơn vị hiện tại |
| 409 | Đã tồn tại ID đích; cả lần import được rollback |
| 413 | Request vượt body limit |
| 503 | Identity hoặc registry chưa được cấu hình |

Hưng nối các nút **Xuất mẫu → Kiểm tra → Nhập thành nháp**, sau đó dùng màn hình draft/publish hiện có. Chị Nhi đối chiếu danh sách connector và operation trong cấu hình để nối adapter thật. Tính năng này chưa thay thế bộ dựng app/biểu mẫu hay cơ chế phân quyền cơ cấu doanh nghiệp.

Smoke local: `pnpm test:workflow-bundles`. Các hợp đồng liên quan: [Studio](workflow-studio.md), [blocks](workflow-blocks.md), [completion](workflow-completion.md).

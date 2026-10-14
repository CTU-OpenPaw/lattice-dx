# API tạo record/task — chống gửi lặp

Ngày 14/10/2026. Áp dụng cho API độc lập:

- `POST /v1/records`
- `POST /v1/tasks`
- `POST /v1/actions/records.create/run`
- `POST /v1/actions/tasks.create/run`

## Cách gọi

Gửi `Idempotency-Key` khi muốn retry an toàn cùng một thao tác. Ví dụ:

```http
POST /v1/records
Authorization: Bearer <access-token>
Content-Type: application/json
Idempotency-Key: 48b73591-b209-4a87-8096-b9c5624fa971

{"title":"Yêu cầu cấp thiết bị"}
```

Lần đầu trả201 và record mới. Gửi lại với cùng key/nội dung trả201 và chính kết quả tạo cũ. Gửi cùng key nhưng title khác trả409. Action tương ứng vẫn trả200 với envelope `{actionId,version,status,result}`.

REST và action chia sẻ một logical operation: nếu record đã được tạo bằng REST, gọi action `records.create` với cùng key và input tương đương trả cùng record. Task hoạt động tương tự. **Giữ key khi retry; sinh key mới khi người dùng chủ ý tạo một công việc mới.** Key nên là UUID. Tạo key mới cho mỗi lần retry sẽ mất tác dụng chống trùng.

Key tùy chọn để giữ client cũ. Request không gửi key vẫn tạo như trước; hai request thành công có thể tạo hai entity. Key đã gửi phải là một header duy nhất, 1–128 ký tự chữ/số hoặc `._:-`; array, comma, khoảng trắng và duplicate header bị từ chối400. Không tự retry POST không-key khi chưa rõ request trước đã lưu hay chưa.

## Dữ liệu và quyền

REST và action dùng cùng parser. Record chỉ nhận `{title}`; task nhận `{title,assigneeId,recordId?}`. Không nhận tenant/owner/createdBy hoặc field lạ. Thay đổi này **siết kiểm tra REST**: payload từng được bỏ qua field thừa nay trả400. Các caller phải bỏ field đó, không chuyển quyền qua request body.

Title được trim, tối đa200 Unicode code points; assignee tối đa100 code points, giữ nguyên opaque subject. UUID recordId được chuẩn hóa lowercase khi liên kết. Thứ tự field JSON không ảnh hưởng fingerprint. Task assignee phải đang enabled trong directory của đơn vị; record liên kết phải thuộc quyền owner và đúng đơn vị.

Mỗi lần gửi/replay vẫn xác minh JWT, role và tham chiếu hiện tại. Token mất role, assignee bị disable hoặc record không còn thuộc quyền caller thì replay bị chặn; key không thay quyền truy cập. Directory vẫn là admin snapshot hiện có, cần sync sau thay đổi identity; đây không phải kiểm tra trực tiếp Keycloak ở mỗi request.

Key được tách theo **đơn vị + người gọi + loại hành động + key**. Hai người/đơn vị dùng cùng chuỗi key không dùng kết quả nhau. Record và task cũng có namespace riêng. Không có API đọc trực tiếp bảng receipt.

## Kết quả và lưu bền

Kết quả chống trùng và entity được lưu PostgreSQL trong cùng giao dịch. Gửi đồng thời cùng key chỉ tạo một entity; lỗi trong write/receipt khiến cả giao dịch rollback. Lỗi không giữ key thành công, nên có thể sửa nguyên nhân và gửi lại.

Replay trả **snapshot lúc tạo**, không cập nhật theo trạng thái task hiện tại. Task lúc tạo là pending; sau khi đã approve, replay tạo vẫn trả pending với ID cũ. Dùng `GET /v1/tasks/:id` để đọc trạng thái mới. Kết quả không mất khi process/pool kết nối lại.

Không cam kết exactly-once side effect ở hệ thống ngoài. Đợt này không thêm chống trùng cho upload tệp, task decision độc lập hoặc thay đổi cơ chế idempotency của workflow. Workflow blocks vẫn dùng command transaction hiện có.

## Lỗi và tích hợp

| HTTP | Ý nghĩa |
| --- | --- |
| 400 | Body/key sai, assignee không hợp lệ hoặc bị tắt |
| 401 | Token thiếu/không hợp lệ |
| 403 | Thiếu role hoặc phạm vi đơn vị ký |
| 404 | Record liên kết không tồn tại/không có quyền; action không tồn tại |
| 409 | Cùng key nhưng input khác |
| 503 | Dịch vụ/identity/khả năng keyed-create chưa cấu hình |

Hưng và chị Nhi chỉ cần bổ sung việc truyền key ổn định tại client/proxy/connector của mình khi retry. Backend này **chưa thay plugin bridge hoặc adapter** để chúng tự gửi header. Requests qua những đường chưa truyền key vẫn dùng hành vi không-key. Không tự bật retry hàng loạt trước khi client giữ được key của thao tác.

Bảng kết quả tạo chưa có TTL/dọn tự động. Key phải đại diện thao tác mới và không được tái sử dụng trong cùng namespace; cần đánh giá retention riêng khi triển khai production. Việc prune receipt có thể thay đổi bảo đảm replay nên không đưa vào đợt này.

Kiểm chứng: `pnpm test:create-reliability`, `pnpm check`; xem bằng chứng thực tế trong [verification](verification.md).

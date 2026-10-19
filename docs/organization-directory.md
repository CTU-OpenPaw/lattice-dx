# Tổ chức và directory snapshot

Keycloak giữ account/JWT/role; engine lưu directory snapshot cho membership hiện tại. API này không tạo account, đổi mật khẩu hoặc tự cấp JWT role. Quan hệ phòng ban/người phụ trách không làm phát sinh quyền entity/task/workflow.

| API | Role | Body |
| --- | --- | --- |
| GET `/v1/organization/departments?limit=50&offset=0&q=…` | directory:read | Trả metadata đã cấu hình |
| POST `/v1/organization/departments` | directory:manage | `{id,name,parentId:null|string,managerId:null|string}` |
| PATCH `/v1/organization/departments/:id` | directory:manage | `{expectedVersion,name,parentId,managerId}` |
| GET `/v1/organization/departments/:id/history` | directory:manage | Metadata version/actor, phân trang |
| GET `/v1/organization/directory-state` | directory:manage | `{revision,updatedAt}` |
| POST `/v1/organization/directory-snapshot` | directory:manage | `{expectedRevision,people:[{subject,displayName,departmentId?,roles,enabled}]}` |

Mutation yêu cầu Idempotency-Key, tenant từ JWT. Parent phải cùng đơn vị; không cycle/self và depth tối đa20. Manager phải active cùng đơn vị. Metadata department được cấu hình riêng; snapshot cũ có departmentId vẫn hoạt động nếu chưa tạo metadata. Không có department delete trong bản này.

Snapshot replacement là thao tác quản trị có quyền cao, tối đa200 identities. Người bị bỏ khỏi danh sách được disable trong snapshot tenant hiện tại; không xóa account. Revision/key/audit cùng transaction, rows membership khóa đúng để phối hợp entity/task shared writes. Input được canonical theo exact subject và role; Unicode subject không bị tự normalize hoặc gộp identity.

Trước khi khóa từng người, snapshot lấy table lock `EXCLUSIVE` trên directory. Nó chờ các giao dịch đang giữ membership lock hoàn tất, tránh khóa chéo giữa nguồn sự kiện/service và người nhận khác. Plain reads vẫn hoạt động; locking reads/writes của directory phải chờ trong thời gian snapshot. Đây là lựa chọn đơn giản cho snapshot quản trị giới hạn 200 người; snapshot ở các đơn vị khác cũng được tuần tự hóa. Kiểm tra bằng `pnpm test:directory-concurrency`.

Roles trong snapshot là metadata để assignment kiểm tra; không trở thành JWT capabilities của caller. Service tự động cần authority được provisioning rõ, không dựa vào installer JWT. Snapshot audit/receipt chỉ trả revision/change count/time, không trả password/token hoặc toàn bộ people.

401 token,403 role,400 input/reference,404 resource ngoài phạm vi,409 cycle/version/revision/key conflict,503 unavailable. API source và script directory:sync-local không được chạy cạnh tranh như hai producer không phối hợp: script admin local hiện không tăng API revision. Khi dùng thật cần chọn một producer authoritative; không coi account federation đã được triển khai.

Nghiệm thu replacement thực hiện trong PostgreSQL fixture riêng, không thay danh sách live làm mất account đồng đội. Hưng dùng metadata và current directory cho dropdown; Nhi không tự gửi authority từ adapter. Command `pnpm test:organization-operations`.

# Chia sẻ thực thể và thu hồi quyền

Engine hỗ trợ grant đọc/sửa cho **người hoặc phòng ban trong cùng đơn vị**. Identity/roles vẫn lấy từ JWT; grant không tự cấp data:read/data:write/data:share. Directory là admin snapshot và phải sync sau membership/department/disable changes.

## Chủ sở hữu quản lý grant

Role data:share và exactowner+tenant bắt buộc cho cả ba endpoints:

| API | Body / kết quả |
| --- | --- |
| GET `/v1/entities/:id/shares?limit=50&offset=0&q=…` | `{items,page}` grant listing |
| POST `/v1/entities/:id/shares` | `{expectedVersion,principal:{kind:"person"|"department",id},permission:"read"|"edit"}` |
| DELETE `/v1/entities/:id/shares/:kind/:principalId` | `{expectedVersion}` |

Mutations yêu cầu Idempotency-Key, trả Entity với entityVersion. POST upsert một grant theo principal, thay permission khi cần. Person phải active trong đơn vị; department có active member trong directory. Revoke không đòi target còn active để vẫn gỡ được người đã tắt. Exact grant lặp hoặc revoke absent với key mới/current expectedVersion là no-op, không tăng version/audit nhưng lưu receipt; staleVersion vẫn409.

Grant/revoke có audit và transaction với entity version/receipt. Chủ sở hữu có thể xem grant đã lưu; người nhận không được xem danh sách grant của người khác. Archived entity không nhận mutation mới; acceptedkey replay vẫn kiểm currentaccess và trả historical snapshot như hợp đồng dữ liệu nền.

## Quyền người nhận

| Hành vi | read grant | edit grant | Owner |
| --- | --- | --- | --- |
| Detail/list/quan hệ readable | Có | Có | Có |
| Cập nhật title/attributes | Không | Có | Có |
| Link/unlink từ entity nguồn | Không | Có | Có |
| Archive | Không | Không | Có |
| Cấp/thu hồi/liệt kê grant | Không | Không | Có, cần data:share |
| History | Chỉ metadata | Chỉ metadata | Đầy đủ input/result |

Shared người nhận phải active trong directory và đúng tenant. Department grant dựa trên **membership hiện tại**, không lưu một bản copy của danh sách thành viên. Người chuyển khỏi phòng ban mất quyền ở lượt đọc/ghi sau; quay lại có thể nhận quyền nếu grant còn. Owner vẫn giữ quyền sở hữu như trước; kiểm tra account disable trực tiếp Keycloak không được thêm trong đợt này.

Quan hệ không lan truyền quyền: edit source cần read target ở cùng đơn vị để link/unlink. Được đọc một entity không tự được đọc các target. Relation query chỉ trả target có quyền trước phân trang. New link cần target active, unlink được dọn target đã archive.

Shared history không có `input`/`result`, chỉ `{id,entityId,actorId,operation,fromVersion,toVersion,occurredAt}`. Chủ sở hữu có quyền vẫn xem full audit. Điều này tránh lộ attributes/lịch sử grant/targetID cũ qua audit khi người nhận chỉ được chia sẻ thực thể hiện tại. Chưa có field-level ACL hoặc quyền truy cập lịch sử riêng.

## Thu hồi và request đồng thời

Detail/list/update/relation/history/replay đều áp dụng cùng policy. Sau khi quyền bị thu hồi, request mới và replay mutation của người nhận bị chặn404; không đọc receipt để vượt quyền. Nếu còn một grant khác (person hoặc phòng ban) thì quyền hiệu lực vẫn tồn tại; revoke một grant không phủ định những grant còn lại. Edit cũng bao gồm quyền đọc.

Shared writes khóa entity, rồi kiểm grant và membership trong cùng transaction; directory row FOR SHARE bảo vệ việc đã chấp nhận trước thay đổi snapshot. Revoke khóa cùng entity. Write đã được nhận trước lúc revoke commit có thể hoàn thành; request sau revoke bị chặn. Request đang đọc là một snapshot dữ liệu tại thời điểm query, không thể thu hồi nội dung đã trả về hoặc file/copy bên ngoài.

Entity.version cũng thay đổi khi quyền thay đổi; UI phải tải lại sau409. Sharededit không được tự đổi owner/org, schemaVersion, grant hoặc archive bằng body. Token role vẫn là trần quyền; validgrant mà JWT thiếu role vẫn403. Resource không có quyền trả404, malformed400, state/version/key conflicts409, missingservice503.

## Bàn giao

Hưng nối UI share/revoke bằng danh bạ hiện có, giữ key khi retry và version trước khi submit. Không sửa plugin/UI trong backendPR này. Chị Nhi dùng danh tính dịch vụ, capabilities và grants được cấp rõ ràng, không tự chọn tenant qua payload. Original record/task sharing và workflows không đổi.

Kiểm chứng: `pnpm test:entity-sharing`, `pnpm test:enterprise-data`, `pnpm check`. Đây là increment quyền chia sẻ dữ liệu của nhóm tổ chức/quyền; phân cấp tổ chức, trưởng phòng, delegation nghiệp vụ và fieldACL vẫn là việc tiếp theo.

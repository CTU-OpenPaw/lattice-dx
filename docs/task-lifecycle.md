# Task lifecycle — hợp đồng backend

Task cá nhân cũ vẫn dùng `/v1/tasks` và `/decisions`. Các API dưới đây bổ sung hàng đợi phòng ban, chuyển giao, hủy và deadline. Nhận việc không tự cấp role; người gọi vẫn cần JWT đúng đơn vị/vai trò.

| API | Role | Body / kết quả |
| --- | --- | --- |
| POST `/v1/task-queues` | tasks:assign | `{title,departmentId,recordId?,dueAt?}` → 201 Task |
| GET `/v1/task-queues?limit=50&offset=0&q=…` | tasks:read | `{items,page}` việc pending chưa được nhận, thuộc phòng ban hiện tại |
| POST `/v1/tasks/:id/claim` | tasks:assign | `{expectedVersion}` |
| POST `/v1/tasks/:id/reassign` | tasks:assign + creator | `{expectedVersion,assigneeId,reason}` |
| POST `/v1/tasks/:id/cancel` | tasks:assign + creator | `{expectedVersion,reason}` |
| POST `/v1/tasks/:id/deadline` | tasks:assign + creator | `{expectedVersion,dueAt}`; null để bỏ hạn |
| GET `/v1/tasks/:id/history?limit=50&offset=0` | tasks:read + current task visibility | `{items,page}` lịch sử metadata |

Các mutation mới bắt buộc `Idempotency-Key`, giữ nguyên key/body khi retry. DTO không nhận organization/actor/role từ browser. Task trả thêm `departmentId` và `dueAt`; hàng đợi chưa nhận có `assigneeId: ""`. `departmentId` được giữ như nguồn giao việc sau claim, không cho toàn phòng tiếp tục đọc task đã nhận.

Claim yêu cầu membership active từ directory snapshot; creator tạo việc phòng ban nhưng chưa tự cấp quyền đọc hồ sơ/tệp cho cả phòng. Sau claim, người nhận chính xác được đọc evidence theo policy task hiện có. Reassign đổi assignee và tăng version; người cũ mất quyền qua task. Cancel đặt status cancelled và thu hồi chia sẻ evidence qua task; quyền owner hoặc grant khác không bị xóa.

Deadline nhận timestamp UTC kết thúc Z, chuẩn hóa ISO; ngày thực, ở tương lai và không quá366 ngày. Việc quá hạn chưa tự bị hủy hoặc tự hoàn tất; worker workflow có timeout riêng. Không biến deadline thành quy tắc nghiệp vụ ngầm.

Task thay đổi trạng thái hoặc version trả409 khi dùng expectedVersion cũ. Hai thành viên claim đồng thời chỉ một người thắng; người thua409. Replay claim của người đã bị chuyển giao trả404. Creator có thể replay snapshot hủy hợp lệ; current creator/org vẫn phải đúng. Mutations, lịch sử và receipt cùng transaction; receipt failure rollback toàn bộ.

Task đã gắn workflow qua legacy task link hoặc workflow wait trả409 ở generic lifecycle. Điều phối chuyển/hủy task–wait–run thuộc đợt workflow; các route này không cập nhật một nửa workflow. Quyết định `/decisions` cũ giữ nguyên guard.

History chỉ `{id,taskId,actorId,operation,fromVersion,toVersion,occurredAt}`, không có snapshot hồ sơ, recipient cũ hoặc tệp. Người nhận cũ không có quyền task hiện tại không được đọc history. Owner/recipient checks không mở quyền cho mọi người cùng đơn vị.

Mã lỗi: 400 input/key/directory recipient sai; 401 token; 403 thiếu role; 404 resource/owner/membership không có quyền; 409 version/state/key/workflow conflict; 503 repository chưa cấu hình. Hiện directory là snapshot, cần sync sau đổi phòng/tắt tài khoản; Keycloak account lifecycle không được tự động hóa bởi API task này.

Kiểm chứng: `pnpm test:task-lifecycle`. Hưng dùng dropdown directory/department, giữ Task.version khi submit và tải lại sau409. Nhi gọi cùng API bằng danh tính dịch vụ có quyền. Backend này không sửa UI hoặc adapter.

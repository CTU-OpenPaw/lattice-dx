# Điều kiện và vòng đời workflow

Điều kiện cũ `{field,operator,value?}` vẫn dùng được. Có thể kết hợp `{all:[...]}` hoặc `{any:[...]}`: tối đa3 tầng,20 node,1–10 phần tử mỗi nhóm. Chỉ leaf eq/gt/exists với field đã khai báo; không chạy script. Inbox, availableTransitions và transition API dùng cùng quy tắc, kể cả field thiếu hoặc chuỗi số không hợp lệ.

`POST /v1/workflows/:id/cancel` nhận `{expectedVersion,reason}`, cần workflow:start và exact owner trong đơn vị. Idempotency-Key bắt buộc. Run giữ state nghiệp vụ cũ, thêm status cancelled và cancellation metadata; version tăng, waits/pending tasks/jobs kết thúc trong cùng transaction. Worker đã cầm lease cũ không thể ghi succeeded/fail để phục hồi job đã hủy. Cancel không thể thu hồi side effect đã gửi ra ngoài.

`POST /v1/workflows/:id/task-transfer` nhận `{taskId,expectedVersion,assigneeId,reason}`, cần workflow:start +tasks:assign và exact owner. Hỗ trợ pending task wait và legacy assigned-reader task. Kiểm người nhận active cùng đơn vị, cập nhật task assignee, wait assignee/version và run.version đồng thời. Với legacy task, assigned-reader data đổi theo người nhận mới. Người cũ không hoàn thành wait đang chờ; người mới có thể xử lý nếu có role.

Transfer response và receipt giữ waiting/taskId projection để UI không hiển thị transition trong lúc vẫn có wait. Các endpoint generic task lifecycle tiếp tục chặn task linked workflow409. Completion receipt đã commit có thể là acknowledgement lịch sử theo current completion authority; cancellation không viết lại kết quả đã kết thúc.

Reason bắt buộc, trim và tối đa500 codepoints; subject tối đa100, không whitespace ngoài/control; UUID normalize; DTO không nhận authority keys. Current owner/roles được kiểm trước receipt replay; samekey khác payload409, hiddenowner404, thiếu role403, malformed/key400. Các mutation staleversion/state409.

History/read dữ liệu cũ giữ pinned publication và quyền reader hiện tại; cancelled runs không có transition/inbox action hoặc manual job retry. Luồng thực thi lock run trước wait/task/job, không lồng pool transactions.

Kiểm chứng: `pnpm test:workflow-lifecycle`, completion/bundles regressions. Đã kiểm signed HTTP nestedconditions/inbox/direct一致, transferoldrecipientdenial, cancelcallbacklate409; privatePG receiptrollback, cancel/completion race, pending/nonwaittasks cancellation, stale lease fencing vàmax1 restart. Timer/service authority và typed entity execution bên trong workflow vẫn thuộc các task tiếp theo.

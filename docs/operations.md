# Core readiness và diagnostics

`GET /health` là liveness, không cần DB. `GET /ready` trả200 khi core store/identity đã cấu hình và DB probe thành công;503 khi chưa sẵn sàng. Public response chỉ status/service, không có connection string hoặc counts.

`GET /v1/operations/diagnostics` cần platform:operate trong signed JWT. Trả riêng reachability của DB và booleans các core store, kết hợp để tính ready; adapter n8n/broker/agent không được chứng nhận ready chỉ vì core ready.

`GET /v1/operations/retention-preview?before=2020-01-01T00:00:00Z` cùng role, chỉ đếm archived entities/settled waits/terminal tasks/audit trong tenant hiện tại trước cutoff. `{dryRun:true,warning:"review_only"}`; không trả row payload và không có delete/apply endpoint. Receipts không bị purge vì xóa có thể làm retry sinh lại side effect. Đây là xem xét dữ liệu, chưa policy retention tự động.

API tự sinh UUID cho X-Request-Id, không lấy ID do client gửi làm correlation của API. Không dùng nó làm identity. Lỗi contracts cũ giữ nguyên. DB query có timeout, diagnostics không lộ lỗi nội bộ hoặc secrets.

`GET /v1/operations/metrics` cần signed `platform:operate` và organization. Counters/latency chỉ thuộc process hiện tại, reset khi restart. Nhãn chỉ gồm route template, method/status class và năm worker/result cố định; không có actor, tenant, token, body, object key hay query khách gửi. Unknown URL gộp thành `unmatched`; tối đa128 route template.

`GET /v1/operations/queues` cùng quyền, chỉ trả số lượng theo trạng thái và thời điểm pending cũ nhất của bốn hàng đợi trong tenant hiện tại (outbox, timers, wait timeouts, automations). Có năm cờ worker; filesystem offload không có hàng đợi durable riêng. Query dùng một connection/transaction, timeout3s và trả lỗi503 cố định. Cả hai endpoint từ chối query/body. Worker mặc định tắt, cấu hình rõ qua env; shutdown ngừng lịch chạy, chờ tác vụ đang chạy trước khi đóng pool. Kiểm tra bằng `pnpm test:runtime-config` và `pnpm test:runtime-operations`.

Backup/restore local xem [Recovery](recovery.md). Readiness không thay bằng chứng restore, security audit hay triển khai HA. Kiểm chứng `pnpm test:organization-operations` và unit operations.

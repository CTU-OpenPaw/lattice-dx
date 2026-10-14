# Core readiness và diagnostics

`GET /health` là liveness, không cần DB. `GET /ready` trả200 khi core store/identity đã cấu hình và DB probe thành công;503 khi chưa sẵn sàng. Public response chỉ status/service, không có connection string hoặc counts.

`GET /v1/operations/diagnostics` cần platform:operate trong signed JWT. Trả riêng reachability của DB và booleans các core store, kết hợp để tính ready; adapter n8n/broker/agent không được chứng nhận ready chỉ vì core ready.

`GET /v1/operations/retention-preview?before=2020-01-01T00:00:00Z` cùng role, chỉ đếm archived entities/settled waits/terminal tasks/audit trong tenant hiện tại trước cutoff. `{dryRun:true,warning:"review_only"}`; không trả row payload và không có delete/apply endpoint. Receipts không bị purge vì xóa có thể làm retry sinh lại side effect. Đây là xem xét dữ liệu, chưa policy retention tự động.

API trả X-Request-Id với id bounded hợp lệ hoặc UUID mới; không dùng nó làm identity. Lỗi contracts cũ giữ nguyên. DB query có timeout, diagnostics không lộ lỗi nội bộ hoặc secrets.

Backup/restore local xem [Recovery](recovery.md). Readiness không thay bằng chứng restore, security audit hay triển khai HA. Kiểm chứng `pnpm test:organization-operations` và unit operations.

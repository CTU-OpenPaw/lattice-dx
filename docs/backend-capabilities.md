# LatticeDX — phạm vi nền tảng backend

Quyết định 14/10/2026: **engine quản lý dữ liệu nghiệp vụ dùng chung; NocoBase làm Studio/UI**. Mỗi loại dữ liệu có một nguồn chính. Collection riêng của NocoBase chưa được tự di chuyển vào engine; adapter của Hưng cần gọi API và tham chiếu entity ID. Broker chứa ngữ cảnh dùng chung, không thay kho giao dịch của engine.

## Tám nhóm năng lực

| Nhóm | Nền hiện có | Phần phải xây thêm |
| --- | --- | --- |
| Dữ liệu nghiệp vụ | Records/task/files; typed schema publication/CRUD/relations/archive/audit; grants; pinned typed query; bounded import/export, explicit migration và contextual attachments | Upsert/bulk relation import, arbitrary mapping DSL ngoài v1 |
| Tổ chức và quyền | Keycloak/JWT, exact-resource guards; current directory/grants; hierarchy metadata/manager và snapshot revision | Federation/account provisioning, delegation và field ACL ngoài v1 |
| Công việc và phê duyệt | Giao việc/claim queue/chuyển/hủy/deadline/history; thu hồi evidence người cũ; workflow waits/completion | Cấu hình lifecycle thành block và escalation nghiệp vụ cần nối orchestration |
| Action/block | Record/task/connector workflow blocks;7 entity builtin API blocks có input/output/version | Typed entity execution trong workflow chưa nghiệm thu |
| Quy trình | Draft/publish/pin, guards AND/OR, audit, waits/callback, cancel/transfer atomically; durable timer chạy bằng service authority hiện tại | Parallel/join ngoài v1 |
| Sự kiện/tích hợp | Durable outbox/retry/lease; signed ingress +pinned subscriptions/provenance/dedupe | Adapter n8n/broker/agent do Nhi nối; event-to-transition correlation ngoài v1 |
| Vòng đời module | Bundle và enterprise manifest schemas/blocks/workflows/dependencies; install/enable/disable newstarts | Dynamic executable plugin, destructive uninstall/migration không thuộc v1 |
| Vận hành/khôi phục | CI,health/readiness/diagnostics/correlation,retention preview; local backup+isolated restore evidence | Offsite/encryption/automatic retention/HA không được coi đã triển khai |

Đây là phạm vi đích; các ô phải xây thêm chưa được coi là đã có. Nhóm dữ liệu đầu tiên có implementation và bằng chứng trong [enterprise data](enterprise-data.md)/[verification](verification.md); các nhóm còn lại chỉ hiện thực những phần ghi ở cột nền hiện có. Không gọi toàn bộ nền tảng hoàn chỉnh chỉ vì có sơ đồ hoặc các route khai báo.

## Trình tự triển khai

1. **Dữ liệu:** engine có schema và typed entity API; entity độc lập với quy trình, không chỉ title hoặc dữ liệu chuỗi trong workflow.
2. **Tổ chức/quyền:** thêm người phụ trách và policy dùng chung; việc chia sẻ dữ liệu phải thu hồi được, giữ identity trong Keycloak.
3. **Lifecycle task:** xử lý claim/chuyển giao/hủy và task gắn workflow trong cùng giao dịch.
4. **Block registry:** đưa các năng lực dữ liệu/task vào action contract dùng chung, Hưng render theo schema và Nhi gọi cùng API.
5. **Workflow orchestration:** timer, cancel, conditions và các bước tự động có service authority hạn chế.
6. **Event contract/configuration:** tiếp nhận nguồn ngoài và quản lý subscription/recovery ở backend; chị Nhi nối adapter thực tế.
7. **Module lifecycle:** đóng gói các năng lực đã thực thi thành module có phiên bản; không tự cấp quyền khi import.
8. **Operation/recovery:** hoàn thiện restore/retention/diagnostics; checks vận hành được bổ sung trong từng increment chứ không chỉ ở cuối.

Mỗi increment phải có API chạy thật, signed quyền/tenant tests, giao dịch/idempotency/concurrency tương ứng, tài liệu input/output và review. Theo dõi implementation bằng plan trong repo; Notion không tự tick.

## Ranh giới thành viên

- **Duy:** engine/schema/API/policy/transactions/actions/orchestration/audit/event contracts và vận hành backend.
- **Hưng:** NocoBase Studio, cấu hình UI/biểu mẫu, plugin/proxy/data-source, giao diện sử dụng APIs.
- **Chị Nhi:** triển khai adapter n8n/NGSI-LD/agent, ánh xạ nguồn và xử lý tác vụ bên ngoài theo contract.

Nếu đổi hợp đồng ảnh hưởng hai người, ghi rõ request/response/quyền/error/version và phần tích hợp cần điều chỉnh. Không đưa password, token hoặc role do browser tự khai vào contract.

## Hạn định

Một engine bao quát không tự chứa mọi logic kế toán, kho, tiền lương hoặc vận tải. Engine phải cung cấp các primitive để cấu hình những hệ thống đó. Nghiệp vụ chuyên môn, adapter nguồn và giao diện vẫn là module/solution riêng. Chỉ primitive đã có tests/evidence mới được đánh dấu hiện thực.

# LatticeDX — phạm vi nền tảng backend

Quyết định 14/10/2026: **engine quản lý dữ liệu nghiệp vụ dùng chung; NocoBase làm Studio/UI**. Mỗi loại dữ liệu có một nguồn chính. Collection riêng của NocoBase chưa được tự di chuyển vào engine; adapter của Hưng cần gọi API và tham chiếu entity ID. Broker chứa ngữ cảnh dùng chung, không thay kho giao dịch của engine.

## Tám nhóm năng lực

| Nhóm | Nền hiện có | Phần phải xây thêm |
| --- | --- | --- |
| Dữ liệu nghiệp vụ | Records nền, task/file links; increment dữ liệu đã thêm schema có phiên bản, typed entity CRUD/quan hệ/archive/audit | Chia sẻ quyền, block dữ liệu trong workflow, query theo thuộc tính, bulkimport/migration cần đợt tiếp |
| Tổ chức và quyền | Keycloak, JWT tenant/role, owner/exact-assignee guards, directory snapshot | Người phụ trách, membership lifecycle, policy theo phạm vi, chia sẻ/thu hồi rõ ràng |
| Công việc và phê duyệt | Giao cá nhân/phòng ban, quyết định, workflow waits/deadline | Claim, chuyển giao, hủy, hạn xử lý, quyền người nhận cũ được thu hồi |
| Action/block | Create record/task, connector dispatch, input binding và execution evidence | Hợp đồng đăng ký/version/output chung; read/query/update/link/archive và lifecycle blocks |
| Quy trình | Draft/publish, pinned version, state/role guards, audit, waits/callback, eq/gt/exists | Timer/compound conditions/cancel, service step chạy dưới authority rõ ràng; parallel/join cần thiết kế riêng |
| Sự kiện/tích hợp | Durable outbox, retry/lease, fixed receiver, callback quyền connector | Catalog/ingress/source provenance/subscriptions/configuration server-side và diagnostics |
| Vòng đời module | Workflow export/import bundle | Manifest nhóm schemas/actions/workflows/permissions; dependencies, enable/disable, phiên bản và gói cấu hình |
| Vận hành/khôi phục | CI/tests, container config, health, restart persistence, scoped audit | Readiness/diagnostics, backup/isolated restore, quản lý retention và bằng chứng phục hồi |

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

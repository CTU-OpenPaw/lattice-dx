# Bàn giao tích hợp chung — 15/10/2026

## Mốc mã nguồn đã đối chiếu

| Thành phần | Commit | Trạng thái được kiểm |
| --- | --- | --- |
| Backend `main` | `ee10614` | PR13 đã merge; giữ nguyên runtime/config/storage/worker mới |
| Hưng, PR15 | `ca5adf0` | Ghép cây Git với main không conflict; build plugin và41 Node tests Foundation/bridge đã chạy độc lập, đạt |
| Nhi, n8n/connector | `86959cf` | Có export order-intake, broker client và fixture; source được đối chiếu, chưa triển khai trong lượt này |
| Nhi, PR14 receiver | `4ff7901` | CI nhánh đạt; ghép với main có4 conflict, chưa xác nhận live broker delivery |

PR14: https://github.com/TrDuy-pan3000/LatticeDX/pull/14

PR15: https://github.com/TrDuy-pan3000/LatticeDX/pull/15

Không dùng số lượng commit làm thước đo công việc. Hai nhánh tách trước đợt backend lớn nên cần cập nhật main và kiểm tra hành vi sau ghép. Kết quả kiểm trong tài liệu này gắn với SHA trên, không tự áp dụng cho commit mới hơn.

## Quyết định mapping từ phía backend

- Organization lấy từ cấu hình tích hợp tin cậy hoặc JWT đã xác minh; `NGSILD-Tenant` chỉ chọn vùng dữ liệu, không cấp quyền.
- Department metadata ID có thể là businessId của Department trong cùng organization. Account subject là định danh người; không thay bằng username, Department ID hay Warehouse ID.
- Entity UUID, schemaId/schemaVersion, workflow run ID và businessId là các loại ID riêng. Một domain có thể chọn entity UUID làm businessId nhưng phải ghi rõ lựa chọn; không suy rộng sang mọi domain.
- Generic entity quan hệ tới generic entity; directory Department là một danh mục khác. Chỉ ánh xạ quan hệ sau khi kiểm nguồn, loại đích và đơn vị. Không biến mọi target UUID thành Department ID.
- `Order.received` nghĩa là kho nhận việc xử lý đơn; không suy ra hàng đã xuất hoặc Shipment đã giao. `warehouseAssigneeId` là subject người nhận, không phải Warehouse ID.
- `observedAt` là thời điểm quan sát thuộc tính; không thay bằng version giao dịch, thời gian nhận HTTP hoặc thời gian workflow. Journal occurredAt chỉ có thể làm observedAt khi domain thống nhất ý nghĩa đó.
- Asset status context của PR14 là bản chiếu riêng, chưa phải business entity và không tự cấp quyền hoặc chuyển trạng thái workflow. Một quan sát muốn kích hoạt nghiệp vụ phải qua mapping và tài khoản dịch vụ có quyền hiện tại.

## Asset dùng để kiểm thử chung

Module fixture trong `solutions/integration/asset-review.json` cung cấp schema/version thật và workflow review riêng cho lượt kiểm. Đây là cấu hình để kiểm engine, không thay thế mô hình Asset chung của mọi doanh nghiệp. Khi dùng làm nguồn broker, ghi mapping tường minh `{organizationId,schemaId,schemaVersion,sourceEntityId,businessId,brokerUrn}`; đọc field theo schema đã pin. Không sửa collection NocoBase để giả đồng bộ.

Các status/field trong fixture cần được đối chiếu với enum ready/in_use/repair/retired của receiver trước khi phát sang broker. Tên hoặc quan hệ thiếu không được tự tạo ID giả. Tài khoản xem workflow không tự có quyền xem asset liên kết; phải có grant riêng.

## Hưng — những contract đang khớp

- Bridge `dxActions:workflow` dùng fixed route cho definitions/references/list/inbox/detail/history/transitions/waits/executions và completion. Key của lệnh được chuyển thành `Idempotency-Key`; body chứa expectedVersion.
- Inbox dùng `inbox=true` và phân trang/filter phía server. Approval lấy action/fields từ `availableTransitions`, không đoán quyền bằng tên nút hay role trên browser.
- Workflow field text/positiveInteger/subject/department/location/file tương thích với controller hiện có. Metadata context/binding mới không đổi contract approve/reject cũ.
- Đã export source `ca5adf0` vào ignored output, build plugin rồi chạy41tests đạt. Lượt đầu thiếu dist do chưa build; sau đúng trình tự build→test đạt. Đây là kiểm plugin/controller, không phải browser end-to-end hay đăng nhập host thật.

Phần cần Hưng nối tiếp: bridge chưa có operation cho `/v1/workflows/:id/entity-context`, `/v1/entities/:id/workflows` hoặc generic entity CRUD/search; chưa có Context Entity block. Inbox/Approval hiện không thay standalone `/v1/tasks` decision hay hoàn thành task wait. UI hiện có thể liệt kê và xử lý workflow mẫu; việc tạo module/entity được công cụ seed thực hiện trước. Không hứa UI đã dựng được mọi schema/ứng dụng.

## Nhi — điều kiện ghép PR14

Git merge-tree đã xác nhận conflict tại `apps/api/src/app.ts`, `apps/api/src/database.ts`, `apps/api/src/index.ts`, `infra/compose/core.yml`. Không chọn toàn bộ ours/theirs:

1. Giữ toàn bộ createApi options/route registrations của main; thêm riêng NgsiLdOptions/registerNgsiLd.
2. Giữ connectRecords(connectionString,{store}), mọi repository và quy trình đóng pool; thêm ngsiLdContext bằng cùng pool.
3. Giữ bootstrapRuntime, pure config validation, telemetry, store reader và năm worker opt-in. Bổ sung cấu hình receiver được validate trước khi mở tài nguyên; không lấy lại index.ts kiểu connect/listen cũ hoặc bật wait worker mặc định.
4. Compose chỉ thêm biến NGSI từ env bị ignore; giữ mount object và cờ worker. Gateway route receiver vẫn phải xác thực secret tại API, không thay route JWT người dùng.

Receiver source đã có ràng buộc token/tenant/subscription, batch64KiB/100Assets, observedAt ordering và status-only projection. Vẫn phải chạy smoke live qua gateway/broker/PostgreSQL sau ghép; injection với repository giả không chứng minh các bước đó.

Broker client hiện là client CRUD mức thấp: chưa đủ kiểm status/quan hệ/observedAt/chống cập nhật cũ theo toàn bộ contract đề xuất. Không gọi nó là adapter nghiệp vụ hoàn chỉnh. Export n8n order-intake ở trạng thái inactive và tham chiếu credential ID local; phải cấu hình credential/identity hiện tại rồi activate/test. Không dùng secret receiver như JWT để gọi nghiệp vụ.

## Mốc nghiệm thu chung

| Lượt | Thao tác | Kết quả bắt buộc |
| --- | --- | --- |
| Backend signed HTTP | Seed module/entity/workflow, owner và warehouse riêng | ID thật; inbox/action đúng; replay không tạo effect mới; version cũ409 |
| Phân quyền liên tài khoản | Warehouse xem run, thử asset trước/sau grant rồi revoke | Run readership không cấp data access; revoke chặn context; foreign tenant bị chặn |
| UI của Hưng | Mở `/lattice/apps/work`, kết nối tài khoản warehouse, tìm runId/title từ seed, nhập lý do và xử lý | Action từ server; reload giữ state/version; account không được phép không có action; không cần chép token vào browser |
| Broker của Nhi | Sau ghép và deploy, gửi status mới/cũ/trùng/xung đột | Mới cập nhật; cũ/trùng không phá dữ liệu; equal-time khác giá trị409; tenant/token sai bị chặn |
| n8n của Nhi | Cấu hình credential và activate workflow, gửi một request có key rồi retry | Backend trả cùng order; không dùng received làm delivered; lỗi quyền/payload hiển thị đúng |

UI/broker/n8n chỉ được đánh dấu chạy xuyên khi thực hiện các lượt tương ứng. Tài liệu hoặc mock không thay thế bằng chứng live. Duy chịu trách nhiệm fixture, backend contract và lỗi backend được tái hiện; Hưng/Nhi giữ source và triển khai UI/adapters.

# Kế hoạch hoàn thiện nền backend LatticeDX

Ngày lập: 14/10/2026. Phạm vi: phần Duy; engine giữ dữ liệu PostgreSQL, NocoBase là Studio/UI. Không tự tick Notion, sửa plugin của Hưng, adapter của Nhi hoặc upstream NocoBase. Không phát hành release khi chưa nghiệm thu.

## Định nghĩa hoàn thiện

Backend nền hoàn thiện khi mỗi năng lực dưới đây có implementation được nối vào production, hợp đồng API, phân quyền tenant/resource, kiểm thử âm và kiểm thử PostgreSQL thật. Route hoặc tài liệu đơn lẻ không được tính là năng lực đã xong. Nghiệp vụ kế toán/lương/vận tải chuyên môn và UI nằm ngoài nền engine. Không cần thêm framework để đạt các mục này.

## Hiện trạng đã kiểm chứng

- Identity JWT, tenant/role, directory snapshot và validation người nhận.
- Records/files với scan, task quyết định và quyền exact assignee.
- Typed entity/schema có phiên bản, publication, CRUD, quan hệ, archive, audit, optimistic locking và command receipts.
- Entity grants người/phòng ban read/edit và thu hồi; metadata history của recipient. PR #13 chưa merge tại lúc lập kế hoạch.
- Workflow draft/publication, pinned definitions, transitions, task/connector waits, timeout, outbox retry/lease và bundle import/export.
- CI, build, signed HTTP và PostgreSQL smoke. Chưa chứng minh đầy đủ mọi năng lực của nền doanh nghiệp.

## Thứ tự thực hiện và điều kiện nghiệm thu

| Đợt | Năng lực cụ thể | Đầu ra phải chạy | Phụ thuộc |
| --- | --- | --- | --- |
| 1 | Task nhận việc phòng ban, chuyển giao, hủy, deadline, history | Nhân viên active nhận đúng hàng đợi; claim race một người thắng; người nhận cũ mất quyền record/file; creator chuyển/hủy với version/key; workflow-linked tasks không bị generic route phá trạng thái | Directory, task/file policy |
| 2 | Typed queries và block dữ liệu | Lọc/sort theo schema với SQL parameterization; catalog có input/output/version; entity create/read/query/update/link/unlink/archive dùng cùng repository/policy qua action API | Typed entities và ACL |
| 3 | Quy trình phối hợp | Điều kiện AND/OR có giới hạn; hủy run kết thúc waits/jobs atomically; lịch/bước tự động có danh tính dịch vụ và scope rõ; workflow-linked task chuyển/hủy phải cập nhật cả wait/run | 1–2, workflow engine |
| 4 | Tổ chức và trách nhiệm | Danh mục phòng ban, quan hệ cha/con không chu trình, người phụ trách active; resolver current membership, không tự tạo role hoặc quyền admin khi đổi tổ chức | Directory snapshot, ACL |
| 5 | Sự kiện vào và cấu hình kết nối | Ingress signed source; dedupe theo tenant/source/event ID; provenance và trạng thái; subscriptions được cấp quyền, retry/failed diagnostics; connector không nhận arbitrary URL/token từ browser | Action registry, workflow orchestration |
| 6 | Gói module | Manifest có version gom schemas/workflows/action references; preview validate dependency; install transaction/idempotency, enable/disable; không tự nâng quyền và không hủy run đang pin version | 2–5, workflow bundles |
| 7 | Dữ liệu nhập/xuất và tài liệu | Entity attachment links có scan + current entity ACL; CSV/JSON import giới hạn với dry-run và row errors; export có quyền; schema migration explicit và optimistic version, không rewrite publication | 1–2, files, entities |
| 8 | Vận hành và khôi phục | Readiness kiểm DB/cấu hình; request correlation và errors nhất quán; liveness tách readiness; backup/restore rehearsal vào DB riêng; retention dry-run; diagnostics không lộ token/dữ liệu tenant khác | Các store đã ổn định |
| 9 | Nghiệm thu toàn nền | OpenAPI/handoff catalog cập nhật; full check, regression chain, concurrency/restart/rollback tests; dependency/license inventory; chốt giới hạn và review độc lập toàn nhánh | 1–8 |

## Cách thực hiện mỗi đợt

1. Đọc code liên quan và ghi spec giới hạn rõ, đặc biệt các side effect và quyền.
2. Lập plan theo files/contracts, viết test thất bại trước behavior mới.
3. Implement module nhỏ; dùng lại policy/repository, không copy quyền vào adapter.
4. Chạy targeted tests, signed HTTP, PostgreSQL concurrent/rollback/persistence tương ứng.
5. Review độc lập, sửa finding và kiểm thử phần sửa; cập nhật bảng tiến độ bên dưới.
6. Commit có phạm vi rõ; giữ một nhánh đang làm. PR chưa merge không được ghi đã có trên main.

## Các yêu cầu xuyên suốt

- Tenant/actor/role chỉ từ JWT đã xác minh; directory từ nguồn quản trị, không trust payload.
- Mutations mới dùng expectedVersion và Idempotency-Key; replay kiểm quyền hiện tại trước snapshot.
- Pagination và filters chạy sau ACL trong SQL. Queries không nhận raw SQL hoặc arbitrary expressions.
- Một giao dịch cho resource, audit và receipt; lock order thống nhất, không acquire pool client lồng nhau.
- Reassign/revoke không được giữ quyền resource cho người nhận cũ, kể cả qua history/file/replay.
- Action/agent dùng cùng API và quyền; connector secrets chỉ ở server.
- Migration chỉ additive mặc định; không xóa volume hoặc dữ liệu người dùng khi test.
- Backup thành công chỉ được coi đủ khi restore vào môi trường riêng và kiểm tra dữ liệu.
- Không đánh dấu toàn nền hoàn thiện khi còn đợt chưa nghiệm thu.

## Tiến độ thực tế

| Đợt | Trạng thái | Bằng chứng |
| --- | --- | --- |
| 1 | Hoàn thành generic task lifecycle; workflow liên kết thuộc đợt3 | Signed HTTP/PG claim/transfer/cancel/deadline, 105 queue +107 history paging, rollback/replay/max1, review fix7daf50a |
| 2 | Typed query +7 entity block APIs hoàn thành; execution trong workflow thuộc đợt3 | Precision/ACL/pinned schema/mixed type/105 paging/max1; REST↔block receipts; reviewfixf7b977f |
| 3 | Compound conditions/cancel/transfer đã nghiệm thu | Live race/rollback/job fence/currentrecipient; fixes9a5ca8f/ad86575. Timers/service authority và typed workflow execution còn riêng |
| 4 | Hoàn thành metadata hierarchy/current directory snapshot | Signed role checks +private snapshotmove/disable/rollback/cycle race/105paging/max1; Unicode canonical và diagnosticsreview đã sửa |
| 5 | Signed ingress/subscriptions đã nghiệm thu | fc84078, atomic multi-sub PG rollback/dedupe/race/current source/max1; review không còn lỗi |
| 6 | Đang triển khai enterprise manifest lifecycle | Preview/install schema+workflow atomic, enable/disable start gates đang làm |
| 7 | Chưa thực hiện | Files/typed entities hiện chưa nối attachment/import |
| 8 | Local recovery/readiness/diagnostics/retention preview đã kiểm | Dump/checksum, restore27 bảng +sentinel; signed diagnostics/currenttenantdryrun. Offsite/automaticretention/HA vẫn ngoài local v1 |
| 9 | Chưa thực hiện | Nghiệm thu sau toàn bộ các đợt |

Docker Desktop bị lỗi khởi động là vấn đề môi trường riêng; phục hồi socket không phải chứng minh root cause đã được sửa.

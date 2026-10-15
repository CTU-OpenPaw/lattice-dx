# Logistics Workspace — kết quả tích hợp giai đoạn 1

Ngày 13/10/2026. Nhánh local `feat/nocobase-workflow-integration`; PR #6 của Duy tại commit `863bf8f3f39b2f999bddb97e9584fb183da11489`. Foundation 0.8.0 chạy trên NocoBase 2.2.22. Không push hoặc merge PR/main trên GitHub.

## Anh dùng thử

Mở http://localhost:13000/lattice/apps/logistics, đăng nhập NocoBase rồi kết nối tài khoản nghiệp vụ. Tài khoản demo và mật khẩu public local `local-<username>-password` chỉ dùng trong môi trường này.

| Tài khoản | Công việc |
| --- | --- |
| alice | Nhập nội dung, khách hàng, địa chỉ, SKU, số lượng nguyên dương và chọn warehouse trong directory. Có thể tải tệp tối đa 1 MiB, đợi scan clean. Lưu đơn draft, sau đó Gửi đơn cho kho. |
| warehouse | Mở đơn từ danh sách hoặc task liên kết, đọc thông tin/tải tệp, nhập ghi chú và Nhận việc kho. |
| warehouse2 | Chỉ đọc đơn được giao cho chính tài khoản này; không thấy đơn giao warehouse dù cùng đơn vị. |

Luồng thành công: đơn `draft/v1 → submitted/v2 → received/v3`; task liên kết `pending/v1 → completed/v2`. “Received” trong demo này là **kho nhận việc xử lý đơn**, chưa phải chứng nhận nhập/xuất hàng vật lý.

## Phần Hùng đã thực hiện

| Phần | Kết quả |
| --- | --- |
| Plugin client/server | Catalog manifest, AMD bundle, Workspace và proxy Logistics cài trên runtime hiện có. Bridge ràng buộc phiên NocoBase + browser; token Keycloak giữ ở server. |
| Collection/migration nền | Department, Employee, Location, Asset và dữ liệu demo trước đó được giữ. Không tự đồng bộ registry NocoBase với directory/database API. |
| Schema cấu hình | Logistics manifest dùng resource orders, action adapter logistics.create, quantity số nguyên và warehousePeople reference. Quyền trong manifest là gợi ý UI; API quyết định quyền thật. |
| Block dùng chung | Logistics dùng Form/List đã có; thêm selector directory, quantity và phân trang/lọc server. Native builder lưu/reload binding Form/List thành công. |
| Action/hook nối API | Tạo đơn, submit và receive có Idempotency-Key; chuyển bước dùng expectedVersion. Panel chi tiết đọc history/availableTransitions từ API. |
| Workspace | Tạo/chọn đơn, chọn task để mở recordId liên kết, thao tác theo quyền, loading/lỗi/hết phiên. Native block có link mở Workspace cho thao tác nghiệp vụ. |

Đường dữ liệu: block → NocoBase APIClient → Action Bridge → Gateway → API của Duy → PostgreSQL. Bridge chỉ cho các operation/path cố định, UUID và query hợp lệ; không nhận URL tùy ý từ trình duyệt.

Tạo/gửi/nhận đơn giữ body/key khi lỗi mạng, 5xx hoặc 429. Người dùng chỉ thử lại lệnh cũ; không tự retry. Sau thành công đọc lại detail/history. Lệnh thất bại xác định 4xx (trừ 429) được bỏ; 409 yêu cầu tải lại dữ liệu. Khi lệnh chi tiết chưa xác định, khóa chuyển sang đơn khác trong trang. Key chỉ giữ trong bộ nhớ: reload/đóng trang/hết phiên phải kiểm danh sách/history trước khi tạo lại. Upload tệp chưa có idempotency; timeout không đồng nghĩa upload thất bại.

Binding `assign-warehouse-task` cũ vẫn tồn tại trong builder cho generic task, được ẩn khỏi Workspace nghiệp vụ. `create-order-record` giữ ID nhưng nay tạo Order thật, yêu cầu các trường đầy đủ; instance cũ cần nhập dữ liệu mới. Task nền không thay thế quy trình Logistics. Inbox tasks hiện có thể chứa cả task nền; chỉ task liên kết Order mới mở được chi tiết Logistics.

## Bằng chứng kiểm tra

- 145 Vitest tests / 18 file PASS; 27 Node tests Foundation/bridge PASS. Typecheck API và solution Logistics, build plugin và git diff --check PASS. Chạy trực tiếp các binary đã cài; không tuyên bố wrapper `pnpm check` đã PASS.
- `scripts/smoke-logistics.mjs` PASS trên API thật: directory cùng đơn vị, assignee active, role kho, tệp clean/rejected, chia sẻ đúng người, replay cùng key, hai lệnh receive đồng thời chỉ một thành công và pagination 106 bản ghi. Fixture pagination riêng đã được dọn bằng ID của chính script. Order bằng chứng backend `2d6e2e15-3110-46cd-a787-a3423e90f539`.
- `scripts/smoke-lattice-logistics.cjs` PASS trên bản plugin cuối: order `8806dbdf-7bbb-4c61-98a6-470472000a2f`, file `a8adf81d-f22e-462a-b097-d7d559adc40b`, received/v3. Script cố ý làm mất phản hồi sau khi create đã lưu; retry giữ nguyên key/body. SQL xác nhận chỉ một đơn có title `Logistics UI 1791891419611`, linked task completed/v2 và audit create/submit/receive v1–3. warehouse2 không thấy đơn; warehouse tải tệp đúng bytes; không pageerror.
- Chạy browser Logistics trước cập nhật nhỏ cuối cũng PASS: order `675cae76-d04a-4748-81f3-3f3299e509d9`. Lần thử đầu của script dừng vì assertion mong HTTP 201 trong khi bridge bọc response HTTP 200; đã sửa assertion. Đơn draft và tệp của lượt đó giữ nguyên, không xóa dữ liệu để tạo kết quả đẹp.
- Hồi quy `scripts/smoke-lattice-procurement.cjs` PASS: run `cd6b4869-531f-4611-ae40-63af2b4f0af1` handed_over/v6, file `df69acc3-c354-4757-9feb-66880b05632c`, manager tải đúng bytes. Run procurement cũ `5627f345-65e8-4b50-a654-6a2a1ead1801` vẫn handed_over/v6. Sau lượt này chỉ đổi adapter create Logistics, giữ legacy binding và text/guard pagination procurement; các Node tests và browser Logistics/builder đã chạy lại.
- `LATTICE_BUILDER_APP=logistics` với `scripts/smoke-lattice-builder-save.cjs` PASS: trang thử ẩn `/admin/ltfabd832ddd`, binding Form/List persisted và reload PASS, schema trang quản lý chi tiêu cũ UID `diox035kb4o` không đổi.

Ảnh local: `output/lattice-logistics-workflow.png`, `output/lattice-builder-logistics-save.png`, `output/lattice-procurement-workflow.png`. SQL proof: `output/logistics-sql-proof.txt`. Package: `output/latticedx-plugin-lattice-foundation-0.8.0.tgz`. Artifact và database backup không commit vì có thể chứa dữ liệu local.

## Triển khai và backup

Trước đổi API/schema/realm/plugin đã sao lưu ba database tại `output/backups/logistics-20261013-182734`: lattice.dump (24768 byte), keycloak.dump (256383 byte), nocobase.dump (274159 byte). Archive được pg_restore --list đọc thành công. Cũng giữ plugin 0.7.0, bridge/server source cũ, compose NocoBase và API image ID trong cùng thư mục.

Core API build từ worktree này; giữ postgres/keycloak/clamav volume. NocoBase tiếp tục dùng runtime/storage cũ `D:/AI/OSS/nocobase_test`, không đổi sang Compose NocoBase khác. Directory sync local đọc Keycloak qua admin và ghi snapshot 13 scoped identities; không reset mật khẩu. WORKFLOW_EVENT_URL/TOKEN đều rỗng, worker không gửi sự kiện ra n8n/broker hoặc hệ thống ngoài.

Trước kiểm thử: records 16, tasks 9, files 11, workflows 2. Sau các lượt kiểm thử: 22 / 13 / 19 / 7. Phần tăng là bằng chứng kiểm thử (bao gồm lượt dừng), giữ dữ liệu cũ. Không reset database hoặc xóa volume. Rollback code dùng API image ID/source và Foundation 0.7.0/bridge backup; giữ schema/data. Không tự restore dump đè dữ liệu mới.

## Những việc còn lại

- Chốt mapping Employee.identitySubject/organizationId với directory và nhu cầu đồng bộ các registry giữa NocoBase/API. Directory là snapshot quản trị, chưa phải cập nhật/revoke realtime.
- Shipment, xuất/nhập tồn kho, giao vận, onboarding UI, App Registry/lifecycle và designer tổng quát chưa được hoàn thành trong lượt này.
- Hoàn thiện giao diện Workspace/Studio theo kiến trúc LatticeDX sau khi nhóm chốt luồng; hiện dùng native builder NocoBase và Workspace chức năng cơ bản.
- Connector n8n/NGSI-LD và event delivery thật chưa bật; chưa kiểm production/SSO/load test. Hai phiên đăng nhập vẫn riêng, bridge tối đa khoảng 5 phút.
- License upstream NocoBase chưa được chốt chỉ bằng license Apache-2.0 của plugin do nhóm viết; giữ kết luận và điều kiện sử dụng đã bàn riêng. Không coi kết quả kỹ thuật này là giải quyết giấy phép.

Mốc này hoàn thành phần tích hợp **Logistics Order tối thiểu** đã bàn với Duy. Không đánh dấu toàn bộ giai đoạn 1 hay toàn bộ kiến trúc LatticeDX hoàn tất.

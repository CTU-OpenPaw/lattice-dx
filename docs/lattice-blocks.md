# Bước 4 — Form và Danh sách dùng chung

Plugin Foundation 0.4.0, runtime NocoBase 2.2.22. Form/list dựng từ manifest và gọi API của Duy qua bridge. Mua sắm/logistics dùng cùng component, không có UI hoặc thuật toán riêng cho logistics.

## Thử trên Workspace

Mở http://localhost:13000/lattice/apps/purchasing, đăng nhập NocoBase, kết nối tài khoản nghiệp vụ. Local fixture Keycloak Alice có quyền tạo record/task. Nhập Nội dung yêu cầu và Lưu; bảng Hồ sơ của tôi đọc lại record thật. Trang logistics có form tạo hồ sơ, form giao việc cho kho và inbox của người nhận. assigneeId phải là Keycloak subject thật; recordId phải là UUID hồ sơ do API đã tạo, không phải tên hiển thị.

Form kiểm required/maxLength/UUID, catalog action quyền hiện tại, khóa nút khi đang lưu, hiện lỗi/thành công và ID. Không tự retry write khi lỗi/timeout. Generic record/task không đồng nghĩa Order/Shipment workflow đã hoàn tất.

Danh sách có lọc không dấu theo các cột cấu hình, page size 5/10/20, trang trước/sau, trạng thái loading/error/empty và nút tải lại. Sau lưu trong Workspace, danh sách tải lại; khi disconnect, bảng bỏ dữ liệu đang hiển thị. API chỉ trả tối đa 100 record/task; phân trang/lọc phía client không tìm được dữ liệu ngoài tập API trả về. Permission enforcement vẫn ở API.

## Đăng ký với builder

Client plugin đăng ký React components và SchemaComponentOptions cho schema builder cũ, đồng thời hai FlowModel LatticeFormBlockModel/LatticeListBlockModel cho menu Add block trên trang NocoBase 2.2 hiện tại. Hai model bọc cùng ConfiguredBlock; không nhân đôi UI hoặc gọi API bằng token khác.

Trong UI Editor → Add block có Lattice Form và Lattice Danh sách. Sau thêm block, mở Cấu hình Lattice → Chọn ứng dụng và block; dropdown đọc manifest từ API, chọn đúng block theo loại. FlowEngine của NocoBase lưu cấu hình binding. Block không có binding sẽ hướng dẫn cấu hình, không tự chọn nguồn dữ liệu; binding sai loại bị từ chối. Schema builder cũ có dialog chọn manifest/block khi thêm.

Native builder smoke chỉ xác nhận hai mục menu xuất hiện; không chèn/sửa schema trang quản lý chi tiêu hiện có. Flow configuration enum và handler được kiểm trong Node tests. Chưa thực hiện một lần lưu binding trên trang native thật; đây không phải bằng chứng cho mọi tính năng thiết kế của NocoBase.

## Đường đọc mới của bridge

GET /api/dxActions:list?resource=records hoặc tasks. Chỉ hai resource này được whitelist; route không nhận URL tùy ý, owner hoặc organization từ browser. Dùng cùng session cookie/user binding và Keycloak token phía server, gọi GET /v1/records hoặc /v1/tasks. Response flat {items:[...]}, tối đa 100. NocoBase bearer, Keycloak/API quyền và scope đều giữ nguyên. Session sai, resource lạ hoặc response sai bị từ chối.

## Bằng chứng kiểm tra 2026-10-13

- 13 Node tests Foundation PASS, gồm validation, pending/error, API helper, filter/paging và AMD/FlowModel registration/binding configuration.
- Bridge list security test PASS: user binding, whitelist, fixed endpoint và response validation.
- Browser smoke: required validation, một record mới, một task liên kết record, đọc lại trong bảng, filter/empty result, page boundary, clear on disconnect; không pageerror.
- Record thử 4c9cd573-b8d9-4d02-8bb7-0a492a1d942a, task a71d0e5e-272b-4ea1-8fce-f3df24bfa914. SQL xác nhận record org-a, task pending và record_id đúng.
- Native Add block menu: PASS cho cả hai loại, không insert schema.
- Ảnh minh họa output/lattice-form-list.png. Các bản ghi thử được giữ lại; không xóa dữ liệu cũ.

Scripts: smoke-lattice-blocks.cjs tạo một record/task mỗi lần chạy; smoke-lattice-builder.cjs chỉ mở menu trên trang mẫu, không insert. Dùng Playwright/Edge và các local fixture accounts; tokens/passwords không được in ra output.

## Thuật ngữ

- Block: thành phần form hoặc bảng có thể cấu hình và dùng lại.
- Validation: kiểm dữ liệu trước khi gửi.
- FlowModel: lớp NocoBase dùng để đưa component vào builder và quản lý cấu hình của nó.
- Binding: liên kết một block với manifest và block ID cụ thể.
- Client pagination: chia trang trong tập dữ liệu đã tải, không tải thêm từ database.

# Kiểm thử điều hành doanh nghiệp và Studio mở rộng

Mở `http://localhost:13000/lattice/console`, hoặc từ Workspace chọn **Điều hành doanh nghiệp**. Giữ đăng nhập NocoBase như trước, rồi kết nối tài khoản nghiệp vụ. Fixture thiết kế là `alice` / `local-alice-password`. Các tài khoản manager, warehouse, warehouse2 dùng `local-<tên>-password`. Khi đổi tài khoản, nếu Keycloak giữ tên cũ thì chọn **Restart login**.

## Các khu vực

| Khu vực | Thao tác thực tế |
|---|---|
| Tổng quan | Mở hệ thống đã xuất bản, tìm kiếm/phân trang, đi tới các năng lực được cấp quyền |
| Việc của tôi | Danh sách bước chờ xử lý trên các quy trình; mở hồ sơ và nhập dữ liệu thực hiện bước |
| Thiết kế hệ thống | Mở Studio; thêm module, trường, block màn hình và quy trình tùy chỉnh |
| Dữ liệu | Thiết kế/publish cấu trúc, nhập/sửa/đọc hồ sơ theo schema, chia sẻ và xem lịch sử |
| Phòng ban & nhân sự | Tạo/sửa cơ cấu, chọn quản lý từ danh bạ, xem thành viên/vai trò và lịch sử |
| Block & tích hợp | Danh mục hành động, block và connector/dịch vụ được backend công bố theo quyền |
| Vận hành | Tình trạng lõi và hàng đợi thuộc đơn vị hiện tại |

Điều hướng dựa trên quyền và dịch vụ thực tế. Không phải mọi tài khoản đều nhìn thấy các khu vực quản trị. Vai trò đăng nhập vẫn quản lý ở Keycloak; danh bạ và phòng ban thuộc engine. Trang này không tự cấp quyền SSO.

## A. Phòng ban

1. Kết nối Alice, chọn **Phòng ban & nhân sự**.
2. Nhập mã mới, ví dụ `office-demo`, tên `Văn phòng thử nghiệm`.
3. Có thể tìm nhân viên trong danh bạ và chọn **Chọn làm quản lý**; để cấp trên/quản lý trống nếu chưa cần.
4. Lưu, tìm lại phòng ban, chỉnh tên và lưu. Phiên bản tăng; **Lịch sử** có phân trang.

## B. Thiết kế dữ liệu và sử dụng

1. Chọn **Dữ liệu → Cấu trúc mới**, đặt mã `equipment-demo`, tên `Thiết bị`.
2. Đặt trường `serial` kiểu text, bắt buộc. Thêm `count` kiểu integer, `active` kiểu boolean hoặc `category` kiểu enum. Có thể khai báo quan hệ tới một cấu trúc đã publish khác.
3. **Lưu cấu trúc** rồi **Publish cấu trúc đã lưu**. Nút publish không dùng các thay đổi chưa lưu.
4. Ở danh sách cấu trúc, chọn **Mở dữ liệu**. Nhập tiêu đề và các giá trị, tạo hồ sơ. Boolean được giữ đúng kiểu, số nguyên chuyển đúng kiểu; decimal giữ chuỗi chính xác.
5. Mở hồ sơ, sửa giá trị và lưu; xem lịch sử. Hồ sơ giữ phiên bản schema đã dùng. Khi tạo từ biểu mẫu v1 sau khi v2 được publish, yêu cầu tạo vẫn chỉ định v1; không âm thầm đổi sang v2.
6. Để chia sẻ, nhập ID nhân viên/phòng ban lấy từ danh bạ và chọn Đọc hoặc Sửa. Backend kiểm tra người nhận cùng đơn vị và quyền chủ sở hữu; xem danh sách quyền có phân trang.
7. **Liên kết nhập liệu** mở đúng mã/phiên bản cấu trúc. Người có data:read có thể đọc schema đã publish qua liên kết, nhưng chỉ thấy các hồ sơ họ sở hữu/được chia sẻ. Liên kết không cấp quyền.

## C. Cấu hình block và quy trình nhiều bước

1. Chọn **Thiết kế hệ thống**. Tạo mã mới hoặc tăng phiên bản hệ thống đã cài.
2. Trong mỗi module, chọn block màn hình và dùng ↑/↓ để đổi thứ tự. Biểu mẫu, danh sách, bộ lọc inbox, chi tiết/hành động, lịch sử và đồng bộ được bật/tắt độc lập.
3. Chọn **Tùy chỉnh các bước quy trình**. Sửa trạng thái đầu, các bước chuyển, vai trò, trường dữ liệu khi chuyển bước và tác động giao/hoàn thành công việc.
4. Ví dụ với các tài khoản đã có: thêm bước `review-extra` từ `submitted` đến `reviewed` cho `procurement:manager`; đổi bước `approve` thành `reviewed → approved`. Như vậy manager thực hiện hai bước trước khi giao việc. Để dùng vai trò tài chính riêng phải cấp tài khoản/vai trò đó trước ở Keycloak và đồng bộ danh bạ; Studio không tự tạo nó.
5. Có thể thêm điều kiện trên dữ liệu đã có: bằng, lớn hơn hoặc có giá trị. Điều kiện không đọc ô nhập của một bước chưa thực hiện.
6. Lưu → kiểm tra → cài → publish → bật. Quy trình không nối được, trường sai hoặc cấu hình nguy hiểm bị validator từ chối. Phiên bản đã cài là bất biến.
7. Alice tạo/gửi; manager xử lý các bước qua **Việc của tôi** hoặc màn hình hệ thống; warehouse hoàn thành việc được giao. Hệ thống sinh từ cấu hình, không thêm nhánh code theo mã use case.

Các vai trò duyệt thêm được đọc hồ sơ để xử lý. Vai trò chỉ có bước ownerOnly/assignee không được tự động cấp quyền đọc mọi hồ sơ. Quyền của backend vẫn áp dụng kể cả khi ẩn/hiện block.

## D. Giới hạn rõ ràng

- Đây là trình cấu hình biểu mẫu, block và chuyển trạng thái; chưa phải canvas kéo thả tự do như một công cụ BPMN chuyên dụng.
- Danh mục connector/agent hiển thị ID đã đăng ký và khả năng có sẵn. Nó không đồng nghĩa mọi worker chạy được mọi quy trình. Luồng n8n/broker/agent chuyên biệt hiện hữu vẫn theo hợp đồng tích hợp riêng.
- Không tạo tenant, tài khoản hoặc tự nâng quyền người dùng. Không reset database/volume và không cần đổi cấu trúc các ứng dụng cũ.
- Tạo schema dùng API hiện hữu không có receipt: nếu mất phản hồi, UI đối chiếu đúng ID/nội dung trước khi thử lại. Các lệnh khác tiếp tục dùng khóa và snapshot bất biến theo khả năng API.

## Kiểm chứng tự động

`pnpm check`, Foundation tests, Bridge tests và `pnpm test:system-studio`. PostgreSQL acceptance chạy trong database dùng riêng rồi dọn đúng database đó; có phòng ban, schema, chia sẻ, schema pinning v1/v2 và một cấp duyệt finance riêng. Không gọi LLM hoặc thay đổi worker tích hợp đang chạy.

## Bằng chứng local ngày 21/10/2026

- `pnpm check`: typecheck/build qua, 121 file / 655 test qua. Foundation 68 test; Bridge 12 test qua. SQL acceptance qua với database dùng riêng.
- Trình duyệt Alice: tạo `console-office-1021`, chọn manager làm quản lý; tạo/publish schema `console-equipment-1021`, tạo hồ sơ `Máy quét mã Console` và chia sẻ read cho warehouse.
- Trình duyệt Studio: tạo/publish/bật `console-flow-1021`, thêm bước `review-extra`, đưa danh sách lên trước biểu mẫu và bỏ block đồng bộ.
- Trình duyệt nghiệp vụ: Alice tạo/gửi; manager thực hiện review-extra rồi approve từ hộp việc chung; warehouse hoàn thành từ hộp việc chung. Hồ sơ cuối `completed`, version 5, đủ năm sự kiện lịch sử. Màn hình manager chỉ có các khu vực được phép.
- Ảnh bằng chứng local: `output/verification/enterprise-console-completed.png`. Dữ liệu minh họa được giữ lại để tự xem. Các biến thể từ chối quyền, cạnh tranh cập nhật và pin schema v1 sau v2 có kiểm thử tự động; không khẳng định đã chạy mọi biến thể qua trình duyệt.
- Foundation 0.16.0, Action Bridge 0.3.0 đã cài qua installer có backup database trước khi cập nhật.

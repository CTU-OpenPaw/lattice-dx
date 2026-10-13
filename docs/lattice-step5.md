# Bước 5 — mẫu ứng dụng và tệp thật

2026-10-13, Foundation 0.5.0, NocoBase 2.2.22 local. Phần có API đã triển khai; nghiệp vụ Order/Shipment và chuyển trạng thái chưa hoàn tất.

## Thao tác trên giao diện

1. Mở http://localhost:13000/lattice, đăng nhập NocoBase rồi kết nối tài khoản nghiệp vụ.
2. Mua sắm: nhập nội dung, Lưu hồ sơ. Sau khi có ID, chọn tệp và bấm Tải tệp lên. Upload là thao tác riêng, không tự gửi lại hồ sơ khi tệp lỗi.
3. Tệp tối đa 1 MiB, không rỗng; chỉ trạng thái scan clean mới có nút tải xuống khả dụng. Ghi lại ID tệp; sau reload có thể nhập ID và Kiểm tra tệp để đọc lại metadata. Chưa có API liệt kê toàn bộ tệp theo hồ sơ.
4. Logistics: kinh doanh tạo hồ sơ đơn hàng và xem bảng hồ sơ. Form giao việc gợi ý các ID hồ sơ API trả về; cũng cho nhập UUID. Chọn đúng hồ sơ và Keycloak subject của người nhận. API kiểm liên kết hồ sơ theo owner/đơn vị.
5. Người kho kết nối tài khoản nghiệp vụ riêng và mở Kho nhận việc. Inbox chỉ trả việc của người nhận trong đơn vị token, không phải toàn bộ công ty.

Hai ứng dụng dùng cùng FormBlock/ListBlock/AttachmentPanel; manifest bật attachments và recordId.reference. Không có implementation UI riêng cho logistics. Các hồ sơ hiện đều thuộc API records chung, chưa có trường phân loại ứng dụng hay kiểu Order riêng; hai bảng không được coi là dữ liệu tách biệt mua sắm/đơn hàng.

## API và bảo mật

- Bridge mới dxActions:files chỉ nhận POST với operation upload/metadata/content, không nhận URL/owner/organization tùy ý.
- Giữ kiểm NocoBase bearer + user-bound cookie, token Keycloak chỉ ở server. Gateway/API quyết định quyền thực tế.
- Upload đi POST /v1/files; metadata/content đi đường dẫn cố định với UUID hợp lệ. Giới hạn base64/bytes, nội dung download streamed bị giới hạn 1 MiB, kiểm khớp size metadata.
- Download kiểm quyền và scan clean trước, endpoint API vẫn kiểm lần nữa. Không tự retry upload. Scan error/rejected/pending không được coi là upload sử dụng thành công.
- Timeout upload bridge 25 giây, client 30 giây để chứa scanner timeout 15 giây. Restart bridge mất phiên kết nối trong bộ nhớ; kết nối lại nếu cần.
- Tệp lưu PostgreSQL bytea, chưa có object storage. Chỉ chủ tệp đọc được, không tự chia sẻ cho người nhận task.

## Runtime và phép kiểm

- Khởi động dịch vụ clamav từ infra/compose/core.yml, image digest cố định; health healthy, không public cổng scanner.
- Thêm riêng warehouse-demo org-a bằng scripts/prepare-local-warehouse.mjs; không đổi Alice/Bob. Realm profile khai báo organization_id chỉ admin sửa để Keycloak giữ scope trên tài khoản mới. Script sẽ dừng nếu cấu hình fixture hiện có không phù hợp.
- scripts/smoke-lattice-files.cjs: browser thật tạo hồ sơ mua sắm + hồ sơ logistics + task liên kết, upload/metadata/download, kiểm byte tải về, từ chối tệp quá 1 MiB trước gửi, kho nhìn thấy task và không được tạo hồ sơ kinh doanh.
- 17 Node tests PASS: Foundation và bridge; gồm whitelist, scope binding, file size, quarantine và manifest cấu hình. Quarantine test là unit test; chưa tuyên bố browser upload virus test hay outage test đã chạy trong bước này.
- Browser PASS đã ghi record 60a3713b-b665-443b-b8b7-cfe95f6d406b, order record 3b4fb87d-a770-4f75-9c61-25aaae099c42, task 85b7dc65-fb37-4e22-84cc-ac75dac67c23, file 2e30fc1c-bfbb-4ab9-8502-ce21e7993103. SQL xác nhận task org-a, assignee đúng warehouse-demo và liên kết đúng hồ sơ; file clean.
- API thực bằng tài khoản kho: đọc metadata/content tệp của Alice đều 404, đúng owner isolation. Không vượt quyền để chia sẻ tệp.
- Kiểm lại sau khi cài package cuối: browser PASS, record 870f1cf0-cf0f-4857-8742-70b5b986fe7c, order record acf85fc6-21b6-41b8-ae55-da91cad318f9, task 32db93f8-7be3-4a4f-8818-45fb154d7234, file 10621620-c611-49c4-8706-e09afbe6f7ef. Plugin đang phục vụ là bản có guard bỏ qua kết quả tệp đến muộn sau disconnect/đổi hồ sơ.
- Các smoke có ghi dữ liệu demo, giữ nguyên dữ liệu cũ và các bản ghi thử. Một lần thử trước dùng Bob org-b đã tạo task 39d2393a-6891-4fdb-974a-c87376cf9f6b trong org-a; task đó không phải chứng cứ luồng kho PASS, không sửa/xóa để che kết quả. Phép kiểm đúng dùng warehouse-demo org-a riêng.

## Chưa hoàn thành

- API chưa có entity Order/Shipment, chi tiết hàng/số lượng/địa điểm, workflow mua sắm và chuyển trạng thái đơn hàng. Không giả lập bằng cách đổi status local hoặc task decision.
- API chưa kiểm directory/đơn vị của assignee. Nhập một subject đơn vị khác có thể tạo task mà người nhận không thấy; cần Duy bổ sung kiểm ở server trước dùng thật.
- Không có directory chọn nhân viên được API cấp quyền; hiện vẫn nhập subject thật, không ánh xạ hai nhân viên seed thành tài khoản nghiệp vụ.
- Chưa có chia sẻ hồ sơ/tệp cho kho, file list theo record, xóa/retry scan, object storage hoặc giao dịch nguyên tử record + file.
- Lọc/gợi ý hồ sơ giới hạn 100 record API trả về; phân trang server còn thiếu.
- Lưu binding trên native builder thật và kiểm tích hợp toàn bộ vẫn theo ghi chú bước 4/6. Giao diện đẹp làm sau sáu bước.

## Thuật ngữ

- Attachment: tệp đính kèm đã lưu trên dịch vụ và gắn với ID hồ sơ.
- Quarantine: giữ tệp nhưng chặn sử dụng khi scanner chưa xác nhận clean.
- Subject: ID tài khoản Keycloak dùng xác định người nhận, không phải tên đăng nhập.
- Owner isolation: người khác không được đọc dữ liệu riêng chỉ vì cùng đơn vị.

# Kho tệp chung cho Yêu cầu native

NocoBase kiểm tra phiên, membership và ACL của hồ sơ trước khi gọi dịch vụ tệp. Dịch vụ API dùng `foundation_files`, ClamAV và cơ chế chuyển dữ liệu sang ObjectStore hiện có. Form tiếp tục gọi các action `latticeRequestAttachments`.

## Cấu hình

Hai dịch vụ dùng cùng `DX_NATIVE_FILES_SECRET`, một giá trị ngẫu nhiên 32 byte biểu diễn bằng 64 ký tự hex, và cùng `DX_NATIVE_FILES_INSTANCE`, tên duy nhất cho bản NocoBase. Giữ khóa trong cấu hình môi trường riêng.

Trên dịch vụ API, cần PostgreSQL và scanner theo cấu hình sẵn có. Đặt thêm hai biến trên để đăng ký `POST /internal/native-request-files`. Khi dùng filesystem, đặt `FILE_STORAGE_PROVIDER=filesystem`, `FILE_STORAGE_ROOT` trỏ vào volume riêng và `FILE_STORAGE_WORKER=true`.

Trên NocoBase, đặt ba biến gồm khóa, tên instance và `DX_NATIVE_FILES_URL` trỏ vào origin nội bộ của dịch vụ API. Đường nội bộ được tính cố định từ origin đó. Sử dụng TLS khi đi qua mạng dùng chung và giới hạn cổng API cho các dịch vụ được phép kết nối.

Mỗi lời gọi được ký HMAC-SHA256 trên toàn bộ nội dung, có thời gian hiệu lực 15 giây và UUID dùng một lần. API lưu UUID trong PostgreSQL để chặn phát lại qua nhiều tiến trình. Chữ ký gắn với thao tác, tổ chức, instance, hồ sơ, người gọi và dữ liệu tệp. Form chỉ nhận metadata và nội dung đã được cho phép tải.

## Dữ liệu và khả năng đọc lại

Khởi động API bổ sung các cột `native_request_id`, `native_instance`, `native_upload_key`, `native_content_digest` trong `foundation_files`, chỉ mục gửi lại và bảng UUID chống phát lại. Tệp native dùng đường tải theo hồ sơ. Các đường chủ tệp, chứng từ cũ, entity và workflow cũ từ chối sử dụng tệp native.

Tệp sạch được lưu trước trong provider PostgreSQL và có thể được worker chuyển sang filesystem bằng cơ chế xác minh kích thước và SHA-256 hiện có. Khóa upload chống tạo hai tệp khi gửi lại hoặc gửi đồng thời. Khóa trùng với nội dung hoặc tên khác trả `409`.

Hồ sơ có tệp trong bảng cục bộ của bản thử cũ tiếp tục dùng bảng cục bộ cho toàn bộ tệp của hồ sơ đó. Hồ sơ chưa có tệp cục bộ dùng dịch vụ chung khi cấu hình được bật. Trước khi đổi hoặc tắt cấu hình, phải đối soát dữ liệu và chuyển tệp của các hồ sơ đã dùng dịch vụ chung. Việc xóa hồ sơ NocoBase chưa có tác vụ dọn tệp tương ứng ở dịch vụ chung. Tệp sẽ không tải được khi hồ sơ không còn, nhưng metadata và bytes vẫn được giữ để xử lý theo chính sách lưu trữ.

## Kiểm chứng

Trên lab `13001`, đã thử tệp cũ và tệp qua dịch vụ chung, đối chiếu đúng nội dung. Bộ kiểm thử `scripts/acceptance-native-request-attachment-api.mjs` đạt khi dịch vụ chung bật, gồm quét tệp, gửi lại đồng thời, một task duyệt, sai hồ sơ, người ngoài phạm vi và membership bị thu hồi.

Nếu lab đã có workflow duyệt khác cho cùng tổ chức, tắt workflow đó trong thời gian chạy ca tự tạo workflow và bật lại sau đó. Giữ một workflow duyệt cho tổ chức để tránh hai luồng nhận cùng sự kiện.

Kiểm thử `apps/api/src/files/native-request-storage.test.ts` kiểm tra chữ ký bị sửa, hết hạn, phát lại, phạm vi tải, lỗi quét và xung đột khóa upload. Đã kiểm tra trực tiếp API nội bộ và xác nhận các trường hợp thiếu chữ ký, sửa nội dung, hết hạn và phát lại trả `401`. Đường đọc tệp cũ cũng đã từ chối tệp native khi dùng đúng owner.

Lab dùng container API `lattice-native-storage-rehearsal-api`, database `native_file_rehearsal` và volume filesystem riêng. Môi trường nhóm cần review, áp dụng cấu hình và chạy lại ca nghiệm thu trước khi tick checklist.

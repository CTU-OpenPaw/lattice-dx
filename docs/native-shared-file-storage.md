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

### Upload chưa xác định kết quả

Migration `20261107000100-shared-upload-receipts` bổ sung bảng private `lattice_native_request_uploads`. NocoBase ghi receipt `pending` trước khi gọi dịch vụ chung, sau đó giữ khóa hồ sơ khi thực thi/đối soát. Submit trả `409` khi còn receipt pending, kể cả khi lời gọi upload trước đã timeout hoặc API vừa ghi tệp muộn. Kết quả thành công được lưu để các lần gửi lại không gọi upload mới.

Người dùng chọn lại đúng tên/nội dung tệp bằng cùng tài khoản để retry; nếu reload khiến UI sinh khóa mới, backend vẫn dùng khóa của receipt đang chờ. Đổi nội dung hoặc người tải không thay thế được lượt chưa hoàn tất. Lần gọi đầu tiên bị từ chối rõ ràng (`400/409/413`, gồm scanner từ chối) được ghi thất bại và không chặn submit; lỗi chưa rõ kết quả hoặc lỗi sau một lần retry giữ pending vì writer cũ có thể còn chạy.

Không có thời hạn tự xóa receipt. Nếu tài khoản đã mất quyền hoặc upload không thể đối soát thành công, vận hành cần kiểm tra đúng instance/tổ chức/hồ sơ/owner/key, trạng thái dịch vụ và các writer còn chạy trước khi quyết định phục hồi. Không xóa receipt hoặc tắt cấu hình chỉ để mở nút gửi. Có thể giữ hồ sơ nháp và tạo yêu cầu thay thế trong khi xử lý; không coi đây là bảo đảm hủy upload phân tán hay tự phục hồi mọi lỗi.

Hồ sơ có tệp trong bảng cục bộ của bản thử cũ tiếp tục dùng bảng cục bộ cho toàn bộ tệp của hồ sơ đó. Hồ sơ chưa có tệp cục bộ dùng dịch vụ chung khi cấu hình được bật. Trước khi đổi hoặc tắt cấu hình, phải đối soát dữ liệu và chuyển tệp của các hồ sơ đã dùng dịch vụ chung. Việc xóa hồ sơ NocoBase chưa có tác vụ dọn tệp tương ứng ở dịch vụ chung. Tệp sẽ không tải được khi hồ sơ không còn, nhưng metadata và bytes vẫn được giữ để xử lý theo chính sách lưu trữ.

## Kiểm chứng

Trên lab `13001`, đã thử tệp cũ và tệp qua dịch vụ chung, đối chiếu đúng nội dung. Bộ kiểm thử `scripts/acceptance-native-request-attachment-api.mjs` đạt khi dịch vụ chung bật, gồm quét tệp, gửi lại đồng thời, một task duyệt, sai hồ sơ, người ngoài phạm vi và membership bị thu hồi.

Nếu lab đã có workflow duyệt khác cho cùng tổ chức, tắt workflow đó trong thời gian chạy ca tự tạo workflow và bật lại sau đó. Giữ một workflow duyệt cho tổ chức để tránh hai luồng nhận cùng sự kiện.

Chạy thêm `--shared-upload-recovery` với `DX_NATIVE_UPLOAD_TEST_DATABASE_CONTAINER` trỏ vào container PostgreSQL của lab riêng có tên `lattice-native-...-postgres-1`. Ca này chủ động khóa bảng tệp khoảng 20 giây, kiểm submit bị chặn trước/sau commit muộn, membership bị thu hồi, retry sau reload giữ nguyên file ID và chỉ tạo một task sau đối soát. Không chạy vào môi trường đang phục vụ người dùng; script từ chối tên container core mặc định và chỉ chấp nhận URL loopback.

Kiểm thử `apps/api/src/files/native-request-storage.test.ts` kiểm tra chữ ký bị sửa, hết hạn, phát lại, phạm vi tải, lỗi quét và xung đột khóa upload. Đã kiểm tra trực tiếp API nội bộ và xác nhận các trường hợp thiếu chữ ký, sửa nội dung, hết hạn và phát lại trả `401`. Đường đọc tệp cũ cũng đã từ chối tệp native khi dùng đúng owner.

Lab dùng container API `lattice-native-storage-rehearsal-api`, database `native_file_rehearsal` và volume filesystem riêng. Môi trường nhóm cần review, áp dụng cấu hình và chạy lại ca nghiệm thu trước khi tick checklist.

## Ghép trên môi trường nhóm

Overlay `infra/compose/native-files.yml` nối API và NocoBase qua mạng Compose hiện có. Chọn thư mục checkout chứa bản ghép đã được review. Trước khi cập nhật runtime hoặc migration, sao lưu database NocoBase, database core và volume object store đang dùng bằng quy trình backup của nhóm.

Tạo tệp môi trường riêng ngoài Git, đặt `DX_NATIVE_FILES_INSTANCE` thành tên bản NocoBase, `DX_NATIVE_FILES_SECRET` bằng khóa 32 byte ngẫu nhiên dạng hex, và `DX_NATIVE_ATTACHMENT_SUBMIT_ORGANIZATION` bằng tổ chức riêng cho ca nghiệm thu. Chỉ có một workflow `startOnSubmit` đang bật trong tổ chức đó.

```powershell
docker compose --env-file PATH_TO_ENV -f infra/compose/core.yml -f infra/compose/nocobase.yml -f infra/compose/native-files.yml config --quiet
docker compose --env-file PATH_TO_ENV -f infra/compose/core.yml -f infra/compose/nocobase.yml -f infra/compose/native-files.yml up -d --build api nocobase
```

Build và cài Foundation theo hướng dẫn runtime trước khi mở form. Kiểm tra phiên bản host, migration và plugin registry. Bản thử đã dùng NocoBase 2.2.38. Cổng local 13000 của máy Hưng tại thời điểm đối chiếu vẫn chạy 2.2.20 và nhánh cũ.

Nghiệm thu trên đúng URL nhóm đang dùng. Nhân viên tạo nháp, đính kèm, gửi. Quản lý nhận một task và tải tệp sạch. Kiểm tra hồ sơ không tệp bằng **Tạo và gửi**, người không liên quan, người thuộc tổ chức khác và tài khoản vừa mất quyền. Đối chiếu tệp cũ và tệp mới, số task, bản ghi `foundation_files` và provider thực tế. Ghi URL, SHA của bản ghép, phiên bản runtime, kết quả và người review trước khi tick.

# Contract đề xuất cho tệp đính kèm của Yêu cầu native

Trạng thái: bản nháp để Duy review. Các endpoint dưới đây là đề xuất, chưa được triển khai.

## Phần dùng lại

- Dùng lại kho riêng, kiểm tra kích thước và tên tệp, pipeline quét và đọc nội dung đã xác minh của dịch vụ tệp. Luồng hiện tại giới hạn 1 MiB và chỉ trả nội dung khi trạng thái là `clean`.
- `POST /v1/files` hiện giải `recordId` qua repository hồ sơ cũ. Đường `/v1/entities/:id/attachments` kiểm quyền trên `enterprise_entities`. Cả hai chưa nhận ID của `latticeRequests`. Cần bổ sung ngữ cảnh riêng cho Yêu cầu native để tái sử dụng phần lưu trữ và quét.
- Ca thử trên lab 13001 xác nhận một tài khoản kho không liên quan vẫn đọc được tệp tải lên qua collection `attachments` mặc định của NocoBase. Luồng mới lưu tệp ở kho riêng và trả nội dung qua endpoint kiểm quyền theo yêu cầu.

## Ranh giới định danh và quyền

- `requestId` là ID của `main/latticeRequests`, truyền dưới dạng chuỗi số nguyên dương. `fileId` là UUID do dịch vụ tệp cấp. Bản ghi liên kết lưu ngữ cảnh native, request ID, file ID và tổ chức đã xác minh. Tạo lại cùng yêu cầu với cùng khóa idempotency trả kết quả cũ. Cùng khóa với payload khác trả `409`.
- NocoBase xác thực phiên, xác định membership đang hoạt động và kiểm tra quyền trên chính yêu cầu. Dịch vụ tệp nhận danh tính đã xác minh và ngữ cảnh hồ sơ qua kết nối máy chủ với máy chủ. Tổ chức, vai trò và chủ sở hữu do máy chủ xác định. Cơ chế xác thực giữa hai máy chủ là điểm Duy cần chốt.
- Thêm tệp cần quyền sửa yêu cầu và trạng thái cho phép chỉnh. Danh sách và tải cần quyền đọc yêu cầu hiện tại. Kiểm cả quan hệ giữa tệp và yêu cầu, tổ chức và trạng thái quét khi tải. Tệp native chỉ được tải qua ngữ cảnh hồ sơ đã liên kết. Đường tải độc lập theo chủ tệp và URL kho trực tiếp đều phải từ chối tệp native.

## API dành cho giao diện

Tên đường dẫn đề xuất. Có thể dùng route NocoBase hoặc route gateway tương đương nếu giữ cùng điều kiện.

| Thao tác | Đề xuất | Kết quả |
| --- | --- | --- |
| Tải lên và gắn tệp | `POST /v1/native/requests/{requestId}/attachments`, `Idempotency-Key`, JSON `{filename, contentBase64}` | `201` với `fileId`, `filename`, `size`, `scanStatus`. Không trả URL kho. |
| Xem danh sách | `GET /v1/native/requests/{requestId}/attachments?limit=20&offset=0` | Metadata phân trang. Không trả bytes hoặc đường dẫn kho. |
| Tải nội dung | `GET /v1/native/requests/{requestId}/attachments/{fileId}/content` | Bytes dạng download khi quyền còn hiệu lực và tệp sạch, với `Cache-Control: private, no-store`. |

- `401` khi thiếu phiên, `403` khi không có quyền thao tác trên hồ sơ nhìn thấy, `404` khi hồ sơ hoặc cặp yêu cầu và tệp không khả dụng trong phạm vi, `409` khi trạng thái hồ sơ không cho phép sửa hoặc tệp chưa sạch, `413` khi quá giới hạn. Lỗi scanner hoặc kho không cấp quyền tải.
- Nếu tải lên thành công nhưng gắn liên kết thất bại, giữ tệp ở ngữ cảnh riêng không tải được và đưa vào luồng dọn tệp mồ côi. Retry không sinh bản ghi hoặc liên kết trùng.

## Luồng đề xuất

Tệp là tùy chọn. Với hồ sơ có tệp, nhân viên **Lưu nháp → Đính kèm → Gửi**. Quản lý nhận việc sau khi hồ sơ được gửi. Hồ sơ không có tệp tiếp tục dùng nút **Tạo và gửi**. Cả hai đường đi qua cùng quy tắc gửi và chống tạo task trùng. Sau khi gửi, hồ sơ chỉ còn thao tác đọc tệp trong phạm vi được cấp quyền.

Workflow hiện kích hoạt khi tạo bản ghi. Bản thử cần tách thời điểm lưu nháp khỏi thời điểm kích hoạt duyệt cho luồng có tệp. Bộ kiểm thử giả định lưu nháp qua `latticeRequests:create` và gửi qua `POST /v1/native/requests/{requestId}/submit` với `Idempotency-Key`. Duy review cách kích hoạt trên chuyển trạng thái và cách giữ luồng **Tạo và gửi** hiện có. Trước khi tích hợp, xác nhận một bản nháp chưa sinh task quản lý và một lần gửi chỉ sinh một task, kể cả khi gửi lại.

## Điều kiện nghiệm thu

1. Người tạo có quyền gắn tệp vào đúng hồ sơ. Người duyệt có quyền đọc tải được tệp sạch và nội dung khớp.
2. Tài khoản kho không liên quan và tài khoản tổ chức khác bị chặn khi gọi trực tiếp. Đổi sang cặp request ID và file ID không liên kết cũng bị chặn.
3. Tệp đang chờ quét, bị từ chối hoặc gặp lỗi scanner không trả bytes. Thu hồi quyền sau khi mở chi tiết phải chặn lần tải tiếp theo.
4. Kiểm tra URL kho, endpoint tải độc lập, retry cùng khóa, hai thao tác đồng thời, lỗi giữa upload và gắn liên kết. Thử trên form native và bằng HTTP trực tiếp.

## Bản thử API trên lab

Bản thử chạy trong plugin NocoBase. Nó dùng ClamAV hiện có và lưu bytes đã quét sạch trong bảng PostgreSQL riêng. Bảng này không đăng ký làm collection công khai. Đường tải đọc quyền của hồ sơ qua ACL NocoBase trong mỗi lần gọi. Việc dùng chung kho tệp với dịch vụ gateway vẫn là phần cần chốt khi tích hợp.

Chạy migration Foundation, đặt `DX_NATIVE_CLAMD_HOST` thành tên máy ClamAV có thể truy cập từ container NocoBase qua cổng `3310`. Đặt `DX_NATIVE_ATTACHMENT_SUBMIT_ORGANIZATION=native-attachment-submit-lab` để mở thao tác gửi cho đúng tổ chức thử. Dùng workflow `startOnSubmit: true` trong tổ chức thử. Workflow theo dõi trạng thái chuyển sang `submitted`. Giữ một workflow duyệt đang bật cho tổ chức thử.

| Thao tác | API NocoBase của bản thử |
| --- | --- |
| Danh sách | `GET /api/latticeRequestAttachments:list?requestId={id}` |
| Đính kèm | `POST /api/latticeRequestAttachments:upload?requestId={id}` với payload và khóa như ở trên |
| Tải nội dung | `GET /api/latticeRequestAttachments:download?requestId={id}&fileId={uuid}` |
| Gửi | `POST /api/latticeRequestAttachments:submit?requestId={id}` |

Chạy `node scripts/acceptance-native-request-attachment-api.mjs` trên lab. Script tạo tài khoản, workflow và hồ sơ thử. Nó xác nhận ClamAV chặn tệp mẫu, tệp sạch tải đúng nội dung, hai lần upload cùng khóa chỉ lưu một bản, hai lần gửi đồng thời chỉ tạo một task và đường tải trực tiếp chặn truy cập sai phạm vi. Script dọn dữ liệu thử khi kết thúc.

### Ca thử đầu tiên trên lab 13001

Đã kiểm tra hồ sơ `STUDIO-FIELD-01` đang chờ duyệt. Người tạo và quản lý đọc được hồ sơ. Tài khoản kho chưa được giao việc không thấy bản ghi qua API. Kết quả này kiểm chứng dữ liệu và quyền hồ sơ để dựng ca thử, phần tệp cần chạy lại khi có endpoint.

Tạo một bản nháp mới với cùng ba tài khoản trong [hướng dẫn lab](native-ui-lab-guide.md), rồi gắn tệp văn bản `request-proof.txt` chứa dòng `native request attachment proof`. Kiểm tra quản lý chưa nhận task khi hồ sơ còn nháp. Gửi hồ sơ, xác nhận quản lý nhận đúng một task và tải được đúng bytes khi quét sạch. Dùng cùng cặp ID gọi trực tiếp bằng tài khoản kho và xác nhận bị từ chối. Giữ dữ liệu thử tách khỏi hồ sơ có sẵn.

Chạy `node scripts/acceptance-native-request-attachments.mjs` để kiểm tra quyền hồ sơ và khả năng gọi API tệp. Chế độ mặc định chỉ đọc. Nó cần manifest lab `output/native-platform/ui-lab.json` và hồ sơ đang chờ duyệt `STUDIO-FIELD-01`. Có thể đặt `DX_ATTACHMENT_FIXTURE_CODE` để dùng mã khác, `NOCOBASE_URL` cho NocoBase và `DX_REQUEST_ATTACHMENTS_URL` cho gateway. Hai địa chỉ phải trỏ về localhost.

Thêm `--run` sau khi API danh sách trả mảng JSON, trực tiếp hoặc trong trường `data`. Bộ kiểm thử tạo hồ sơ riêng với tiền tố `STUDIO-ATTACH-`, thử đính kèm và gửi lại, kiểm số task của đúng hồ sơ, so sánh bytes và kiểm thu hồi quyền bằng tài khoản thử tạm. Hồ sơ và tệp thử được giữ trên lab để đối chiếu. Nếu API danh sách chưa sẵn sàng, `--run` trả mã thoát `2` trước khi ghi dữ liệu.

Nguồn đối chiếu trong repo gồm [upload và quét tệp](../apps/api/src/foundation.ts), [kiểm quyền khi tải](../apps/api/src/files/content.ts) và [contract tệp theo entity](entity-data-tools.md).

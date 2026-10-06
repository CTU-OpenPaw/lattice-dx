# Ranh giới kiến trúc

Thiết kế đích và đối chiếu đề thi nằm trong [DX-OS tối thiểu](dx-os-minimum-design.md). Nội dung dưới đây mô tả bộ khung đang chạy; các dịch vụ trong thiết kế đích chưa được tích hợp.

Luồng hiện có: trình duyệt → Next.js route `/api/agent/demo` → API `/v1/agent/demo` → worker `/run`.

Web gọi backend từ server, tránh phải cấu hình CORS giữa trình duyệt và các dịch vụ. Các địa chỉ API/worker được cấu hình bằng biến môi trường. Request được kiểm tra tại từng ranh giới. Timeout API → worker là 5 giây, web → API là 6 giây.

## Đơn vị mở rộng

- `apps/`: chương trình có entrypoint, lệnh chạy và vòng đời riêng.
- `packages/`: thư viện được import; không chạy thành dịch vụ.
- `plugins/`: phần mở rộng tuân theo SDK/vòng đời của nền tảng chủ.
- `infra/`: cấu hình công nghệ upstream; không chứa bản sao source của upstream.
- `solutions/`: mô hình dữ liệu, workflow và cấu hình một ứng dụng nghiệp vụ.

Mỗi app/package mới phải có manifest và tài liệu chạy. App chỉ dùng public exports của package. Mã phụ thuộc một nền tảng cụ thể được giữ trong module/plugin của nền tảng đó.

Không tạo `core`, `sdk`, `ui` hoặc microservice rỗng. Khi xuất hiện logic quản lý ứng dụng dùng chung, tạo `packages/core`; khi có người dùng SDK thực tế, tách SDK từ phần kết nối đang chạy.

## Agent

`apps/agent-worker/src/app.ts` hiện cung cấp endpoint demo. Khi có bài toán cụ thể, thêm định nghĩa agent, tools và jobs tại worker. Tools phải thực thi quyền tại điểm gọi dịch vụ. Worker không được truy cập trực tiếp bảng nghiệp vụ của nền tảng khác.

## Quyết định còn mở

Nền low-code và giấy phép phiên bản; mô hình định danh/SSO; broker NGSI-LD; lưu trữ tác vụ; provider AI; bài toán nghiệp vụ. Không coi bộ khung hiện tại là sản phẩm đáp ứng toàn bộ đề thi.

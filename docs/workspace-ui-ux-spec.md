# Đặc tả thiết kế UI/UX Workspace LatticeDX (Bản chuẩn V1.1)

Phiên bản 1.1 · 13/10/2026 · Chủ phần việc: Hưng

Tài liệu dành cho designer, người dựng prototype và lập trình viên. Đây là đặc tả đề xuất cho bước hoàn thiện giao diện; không phải xác nhận mọi chức năng bên dưới đã triển khai. Không thay đổi runtime, API, Notion hoặc phạm vi nghiệm thu giai đoạn trước.

## 1. Mục tiêu và phạm vi

Workspace là cổng làm việc của doanh nghiệp: nhân viên mở ứng dụng builder đã cấu hình, tìm công việc của mình, thực hiện thao tác hợp lệ và theo dõi kết quả. Studio là nơi builder thiết kế/cấu hình; dùng cơ chế NocoBase và plugin Lattice đã phát triển.

Mục tiêu trải nghiệm:
1. Nhận ra ngay công ty, tài khoản và ngữ cảnh ứng dụng đang sử dụng.
2. Tìm đúng ứng dụng/công việc với ít bước và không cần nhớ mã kỹ thuật.
3. Hiểu trạng thái, người chịu trách nhiệm và thao tác tiếp theo.
4. Hoàn thành đúng công việc, không tạo trùng hoặc xử lý nhầm bản ghi.
5. Giữ được ngữ cảnh khi chuyển trang, quay lại hoặc gặp lỗi.
6. Giao diện thống nhất khi nhiều builder xây nhiều ứng dụng khác nhau.

## 2. Bố cục chung & Thống nhất ngôn ngữ

Dùng tiếng Việt chuẩn cho toàn bộ màn hình; không đặt nhãn song ngữ dài trên sidebar:
- `My Tasks` → **Công việc của tôi**
- `Applications` → **Ứng dụng**
- `App Shortcuts` → **Lối tắt ứng dụng**
- `Action Required` → **Cần xử lý**
- `In Progress` → **Đang thực hiện**
- `Completed` → **Đã hoàn thành**
- `Created by Me` → **Tôi đã tạo**
- `Filter by title` → **Lọc theo nội dung…**
- `Personal Settings` → **Cài đặt cá nhân**
- Tên tài khoản luôn hiển thị đúng dấu tiếng Việt: **Hưng**.

## 3. Dữ liệu chuẩn trong tab “Cần xử lý”

Tab này **chỉ chứa công việc tài khoản hiện tại cần thực hiện một hành động nghiệp vụ**. Mẫu dữ liệu gồm **đúng 3 dòng**:

| Công việc | Ứng dụng | Người liên quan | Trạng thái | Hành động chính | Thao tác phụ (`···`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Duyệt yêu cầu mua laptop Dell XPS** (`#REQ-204`) | Mua sắm nội bộ | Người tạo: An Nguyễn | Chờ duyệt | **Duyệt** | Từ chối *(cần lý do)* |
| **Gửi đơn phụ kiện Tân Bình** (`#ORD-101`) | Logistics | Người tạo: Hưng | Bản nháp | **Gửi đơn cho kho** | Chỉnh sửa, Hủy đơn |
| **Nhận xử lý đơn Cần Thơ** (`#ORD-098`) | Logistics | Người được giao: Hưng | Chờ kho nhận việc | **Nhận việc** | Chuyển tiếp |

*(Dòng chỉ có "Xem chi tiết" trước đây đã được chuyển sang tab "Đã hoàn thành" hoặc "Tôi đã tạo". Số đếm trên tab là Cần xử lý (3), khớp hoàn toàn với số dòng).*

## 4. Ngữ nghĩa trạng thái & Phân quyền
- Logistics dùng: `Bản nháp` → `Chờ kho nhận việc` → `Kho đã nhận việc`.
- **"Kho đã nhận việc"** nghĩa là tiếp nhận nhiệm vụ xử lý đơn, **không phải đã nhận hàng, xuất kho hoặc giao hàng**.
- Chi tiêu dùng trạng thái riêng của ứng dụng chi tiêu, không dùng trạng thái kho.
- Mua sắm dùng trạng thái và hành động theo quy trình mua sắm.
- Không đặt "Duyệt/Từ chối" trên mọi loại công việc.
- Với đơn được giao, ghi rõ **"Người được giao"**, không ghi "Người giao".
- Người xử lý Logistics hiện là tài khoản cá nhân; không dùng tên kho/phòng ban thay cho người được giao.

## 5. Hoàn thiện bảng và thao tác
- Bấm tiêu đề mở Drawer chi tiết công việc.
- Mỗi dòng có tối đa một nút hành động chính; thao tác phụ đặt trong menu `···`.
- Menu chỉ chứa thao tác hợp lệ theo quyền và trạng thái.
- Tiêu đề dài được xuống dòng, không làm mất nút thao tác.
- Có pagination, nút xóa bộ lọc và trạng thái cập nhật dữ liệu ("Cập nhật lúc 10:30").
- Quay lại từ chi tiết phải giữ tab, bộ lọc, trang và vị trí cuộn chuột (URL Sync).
- Hạn xử lý chỉ hiển thị khi có dữ liệu thật.

## 6. Thiết kế 9 trạng thái bắt buộc
1. **Đang tải dữ liệu**: Skeleton theo đúng lưới bảng.
2. **Không có công việc**: "Bạn chưa có công việc trong mục này", gợi ý mở Apps.
3. **Không có kết quả lọc**: "Không tìm thấy kết quả phù hợp", kèm nút "Xóa bộ lọc".
4. **Lỗi tải dữ liệu**: Giữ ngữ cảnh, thông báo lỗi tiếng Việt kèm nút "Thử lại ⟳".
5. **Hết phiên**: Thông báo kết nối lại, giữ return path.
6. **Không có quyền**: Báo lỗi 403, không lộ dữ liệu trái quyền.
7. **Dữ liệu đã bị cập nhật (409 Conflict)**: Yêu cầu tải phiên bản mới nhất.
8. **Đang gửi lệnh**: Khóa nút (Disabled), hiển thị loading để chống double-click.
9. **Mất phản hồi sau khi gửi**: Thông báo "Kết quả chưa xác định", cho kiểm tra hoặc thử lại đúng lệnh cũ; không khẳng định lệnh đã thất bại.

## 7. Thiết kế chi tiết và Form
- Drawer chi tiết rộng 560–640 px: Tiêu đề, Mã, Trạng thái, Người liên quan, Dữ liệu nghiệp vụ, Tệp đính kèm, Lịch sử Audit, Sticky Action Footer + Nút "Mở trang đầy đủ".
- Form Logistics: Nội dung, Khách hàng, Địa chỉ, SKU, Số lượng, Người kho (chọn từ danh sách hợp lệ, không nhập UUID), Tệp đính kèm. Nút tạo là "Lưu đơn nháp", gửi đơn tách riêng.
- Nhận việc: Cần nhập `receiptNote`.
- Từ chối mua sắm: Cần nhập `Lý do từ chối`.
- Validation: Đặt cạnh trường, giữ nguyên dữ liệu đã nhập.
- Tệp đính kèm: Trạng thái đang kiểm tra / sạch / bị từ chối / lỗi; giới hạn 1 MiB.

## 8. Giữ rõ phạm vi tính năng
- AI Assistant: Đánh dấu "Dự kiến" trong concept; chưa dựng chatbot hoạt động giả.
- Báo cáo, thông báo, deadline/SLA và số đếm tổng hợp phải ghi phụ thuộc dữ liệu/API.
- Không thêm shipment, tồn kho hoặc giao vận như chức năng đã có.
- Cài đặt cá nhân tách khỏi cấu hình nền tảng.
- Builder chỉ có lối vào Studio khi được cấp quyền.

## 9. Responsive và Khả năng sử dụng
- Giao diện Desktop (≥1200 px), Tablet (768–1199 px), Mobile (<768 px).
- Mobile chuyển bảng công việc thành thẻ (Cards) dễ đọc, không chỉ thu nhỏ bảng desktop.
- Nút bấm có vùng chạm tối thiểu 44×44 px trên mobile.
- Keyboard navigation (Tab, Enter, Esc, Ctrl+K), aria-live cho thông báo, tương phản WCAG 2.2 AA.

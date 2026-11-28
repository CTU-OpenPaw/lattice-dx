# Bàn giao kiểm thử thủ công LatticeDX v0.4.2

- Người kiểm thử: Hưng
- Bản kiểm thử: `f24dc0e` (PR #76), 28/11/2026
- Môi trường: lab Docker NocoBase riêng, cổng `13019`, dữ liệu thử

## Kết quả

| Phạm vi | Kết quả |
|---|---|
| Typecheck, Vitest, build | Hoàn tất. Vitest đạt 152 tệp, 1.128 ca. |
| Bộ test Node | 1.393 đạt, 0 lỗi, 1 bỏ qua khi tắt màu. Một ca trong `acceptance-headless-paas.test.mjs` so khớp thông báo lỗi và thất bại khi Node chèn mã màu ANSI. |
| Eval định tuyến tiếng Việt | 163/163 (100%) trên CLI. |
| Giấy phép, SBOM, audit | Pure-OSI 6/6, SBOM 257 thành phần. Audit production không báo lỗ hổng đã biết tại thời điểm chạy. |
| Live API | Headless PaaS đạt 9/9 mục. Logistics và phiếu dịch vụ đi tới `completed`; 7/7 kiểm tra từ chối quyền trả `403` theo kỳ vọng. |
| Workflow Automation | Kiểm tay đạt việc tiếp tục sau hai lượt duyệt HITL và đi qua cổng `done`. Merge `first_completed` hoàn tất sau khoảng 2,25 giây với nhánh chậm đặt 60 giây. |
| Sao lưu và phục hồi | Diễn tập database NocoBase hoàn tất, kiểm kê 165 bảng và xác minh metadata. Chưa xác minh phục hồi toàn stack, tệp đính kèm hoặc sức khỏe ứng dụng sau phục hồi. |
| AI thật | Hưng xác nhận đã thử AI sau bước cấu hình Gemini. Chưa có kết quả riêng cho từng câu hỏi. |

## Phát hiện cần xử lý

| # | Khu vực | Bước tái hiện và kết quả | Kỳ vọng |
|---|---|---|---|
| 1 | Biểu đồ Logistics | Mở **Cấu hình nội dung**. Nhãn **Số nhóm tối đa (1–500)** có hiện, ô nhập bị thiếu. | Có ô số để nhập giới hạn. |
| 2 | Tạo đơn Logistics | Dùng root mở **Tạo đơn vận chuyển**, điền các trường khả dụng rồi bấm Submit. Form báo `Mã tổ chức cannot be null` và thiếu ô chọn tổ chức. | Form xác định được tổ chức hoặc cho người dùng chọn trước khi gửi. |
| 3 | Biểu đồ Đối soát | Đổi **Nguồn dữ liệu** sang **Dòng đơn hàng WMS/OMS** ở phép **Đếm**. Biểu đồ vẫn kiểm tra `settlementAmountVnd` của nguồn cũ. Nguồn WMS/OMS có dữ liệu. [Ảnh](evidence/manual-retest/bi-source.png) | Phép đếm sử dụng cấu hình hợp lệ cho nguồn đã chọn và hiển thị kết quả. |
| 4 | Menu Cấu hình | Mở menu cấu hình trên thanh trên cùng khi UI Editor đang bật. Nhiều nhãn hiện biểu thức dịch `{{t(...)}}`. [Ảnh](evidence/manual-retest/settings-labels.png) | Hiện tên mục dễ đọc. |
| 5 | Built Apps Plan-Diff | Nhập “Thêm trường ghi chú bảo hành có mã warrantyNote, kiểu văn bản.”. Xem trước đề xuất `ghi` và `ki`. JSON Patch tường minh tạo đúng `warrantyNote`. [Ảnh](evidence/manual-retest/plan-diff.png) | Chỉ đề xuất một trường `warrantyNote: text`. |
| 6 | Nhật ký Kiểm toán | Chọn một tác nhân rồi mở lại bộ lọc. Các tác nhân khác biến mất cho đến khi chọn **Tất cả tác nhân**. [Ảnh](evidence/manual-retest/audit-filter.png) | Có thể đổi trực tiếp giữa các tác nhân khả dụng. |
| 7 | DMN trên màn hình hẹp | Giả lập điện thoại 427 × 952, mở DX-OS Studio với menu cài đặt đang hiện. Bảng luật và vùng nhập mô phỏng bị khuất bên phải. [Ảnh](evidence/manual-retest/dmn-mobile.png) | Có thể đọc và thao tác trong vùng nội dung, bảng rộng cuộn riêng. |
| 8 | Dữ liệu Ấm/Lạnh & MKT | Ở 1280 × 800, mở Hàng đợi Cách ly Dữ liệu. Nút **Phê duyệt / Phát hành** bị cắt nhẹ ở mép phải. [Ảnh](evidence/manual-retest/data-gov-action.png) | Đọc được toàn bộ nhãn nút ở kích thước này. |
| 9 | DMN Legacy | Mở **Chỉnh sửa JSON & Mô phỏng nâng cao**. Nút **Chạy Mô phỏng DMN** cao bất thường so với nút lưu bên cạnh. [Ảnh](evidence/manual-retest/dmn-legacy.png) | Chiều cao đồng nhất với nhóm thao tác. |
| 10 | Outbox & DLQ | Bấm **Xem Payload** trên một sự kiện Location đang chờ gửi. UI hiện `null`. Đối chiếu chỉ đọc xác nhận JSON nằm trong cột `payload`, trong khi API lấy `payloadJson`. | Hiện nội dung payload của sự kiện được chọn. |

Ưu tiên xử lý #2, #3 và #10. Sau khi có commit sửa, chạy lại đúng các bước tái hiện trên lab.

## Mục còn mở

- Kiểm lại Mobile PWA trên Android thật sau bản sửa, nhất là đồng bộ lại khi Tailscale vừa kết nối.
- Hai bộ nghiệm thu AI/MCP và Broker/Automation Builder cần n8n, chưa chạy trên lab này.
- Chuông thông báo có 0 mục chưa đọc tại thời điểm kiểm. Chưa có bằng chứng cho đánh dấu đã đọc và liên kết sâu.
- Chưa chốt bằng chứng riêng cho Teardown giữ dữ liệu, kết quả từng câu hỏi AI thật hoặc gửi thử đa kênh theo Delivery UID.

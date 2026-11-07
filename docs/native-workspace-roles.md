# Workspace native theo vai trò

Workspace của người dùng cuối nằm tại `/admin/lattice-workspace`. Builder có quyền `allowConfigUI` tiếp tục dùng shell Config / Build UI hiện có. Người dùng cuối không có quyền thiết kế được dùng shell Workspace trên cùng runtime và phiên đăng nhập NocoBase.

## Phạm vi

- Công việc của tôi: hai tab Cần xử lý / Đã xử lý, dùng component `WorkflowTodo` và popup `PagePopups` do NocoBase cung cấp. Quyền xem và xử lý công việc do backend native kiểm tra.
- Ứng dụng: danh sách các trang native được cấp quyền, lối tắt ba trang đầu và tìm theo tên trang. Đây là danh mục trang; chưa giả định mỗi trang là một sản phẩm độc lập.
- Báo cáo: chỉ xuất hiện nếu cây trang được cấp quyền có metadata `options.workspace.section = "reports"`. Nhãn trang không được dùng để suy đoán loại trang.
- Header giữ `PinnedPluginList` của host, bao gồm menu tài khoản/đăng xuất và các chức năng plugin đã bật. Các module tùy chọn hiển thị theo cấu hình host.
- Sidebar thu gọn trên màn hình nhỏ. Khi mở trang nghiệp vụ, nội dung vẫn do native renderer xử lý, gồm cấu hình field, validation, data scope, action và API của trang đó.

Không thêm logic Logistics hay tên collection nghiệp vụ vào shell. Không dùng manifest hoặc API tác vụ của Workspace `/lattice` cũ. Không cấp quyền mới cho role và không thay workflow.

## Cài đặt và tái tạo

Build Foundation và cập nhật plugin trên NocoBase 2.2.38 theo quy trình deploy plugin của repo. Shell được đăng ký bởi `src/client/native-builder-navigation.js`; không sửa upstream. Runtime thiếu SDK bắt buộc giữ shell native cũ.

Cấp desktop routes và collection/action permissions bằng cơ chế NocoBase hiện có cho từng role. Hai lớp quyền này độc lập: thấy link không thay cho quyền truy cập dữ liệu. Gắn metadata báo cáo bằng `desktopRoutes:update`, giữ nguyên những trường `options` khác khi cập nhật:

```json
{"options":{"workspace":{"section":"reports"}}}
```

Có thể đặt metadata trên group để áp dụng cho các trang con. Trang/group ẩn và link ngoài không được liệt kê trong danh mục Workspace. Thứ tự theo `sort` của host.

Role `ldx_employee`, `ldx_manager`, `ldx_warehouse`, `ldx_dispatcher`, `ldx_driver`, `ldx_director`, `ldx_admin` chỉ được dịch tên để hiển thị. Danh sách trang, task, action và dữ liệu không được quyết định bằng tên role trong frontend.

## Kiểm chứng local

Ngày 07/11/2026, môi trường tách biệt tại `localhost:13001`, NocoBase 2.2.38:

- Quản lý mở task thật từ Workspace, xem form workflow native và duyệt hồ sơ thử “Hồ sơ thử kho tệp chung”. Task chuyển Resolved.
- Kho đăng nhập bằng tài khoản riêng, nhận task tiếp theo của chính workflow, mở form native và Hoàn thành. Task chuyển Resolved. Sidebar không có Báo cáo vì không được cấp trang đó.
- Mục Báo cáo của quản lý chỉ liệt kê trang đã gắn metadata; tìm tên không tồn tại trả trạng thái rỗng.

- Nhân viên mở danh mục và form Yêu cầu có đính kèm trong shell mới. Không thấy task của quản lý; truy cập trực tiếp URL popup task quản lý không trả bản ghi (backend thêm filter userId của nhân viên).
- Tab Cần xử lý của kho rỗng sau khi hoàn thành; tab Đã xử lý hiển thị đúng task Resolved. Mỗi tab có đường dẫn field Formily riêng để không dùng lại bộ lọc của tab trước.
- Màn hình 390 × 844 mở/đóng sidebar và điều hướng được; menu tài khoản vẫn dùng native. Header chỉnh màu icon để hiển thị rõ trên nền sáng.
- Đăng xuất trả về Sign in. Root đăng nhập vẫn thấy Config / Build UI và cây trang native.
- Build client/server thành công; 224 Foundation tests đạt, gồm hồi quy quyền hiển thị trang và tuyến popup task.

 Đây là bằng chứng local, chưa thay thế nghiệm thu đủ bảy vai trò trên môi trường nhóm và review PR. Không tự đánh dấu hoàn tất toàn bộ Giai đoạn 4.

## Giới hạn hiện tại

Danh sách công việc giữ nội dung/tên trạng thái của plugin workflow native theo ngôn ngữ host. Lối tắt chỉ mở trang; nút tạo nhanh theo từng sản phẩm cần cấu hình action rõ ràng, chưa suy đoán từ tên trang. Không có tab “Tôi đã tạo” hoặc “Đang thực hiện” chung vì cần hợp đồng dữ liệu phân loại xuyên workflow. Không hiển thị các màn hình giả lập cho tính năng chưa có.

Trang đăng nhập và theme host vẫn theo cấu hình NocoBase. Workspace không thay quy tắc phân quyền backend, quản lý phiên hay chính sách tệp.

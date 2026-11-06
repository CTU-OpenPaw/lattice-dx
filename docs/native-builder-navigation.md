# Khung Studio native cho builder

## Bố cục và điều hướng

Header dành cho builder gồm logo LatticeDX, hai liên kết **Config / Build UI** ở ngay bên cạnh, và bộ công cụ native bên phải. Không render dãy nhóm trang và `Add menu item` của header cũ. Không dùng CSS che menu hoặc di chuyển DOM.

- **Config** mở khu vực cấu hình native cùng sidebar cấu hình của NocoBase. Chỉ lấy trang settings được host cấp quyền.
- **Build UI** là khu vực trang, không phải drawer. Trang bắt đầu: `http://localhost:13000/admin/lattice-builder`.
- Trong Build UI, cây **nhóm trang → trang** nằm cố định bên trái. Chọn trang mở URL native ở vùng nội dung giữa. Tìm kiếm, cập nhật danh sách và liên kết tới quản lý route nằm trong sidebar.
- Liên kết dùng `Link` và `Outlet` của router host, giữ basename và chuyển trang SPA. Không dùng `window.location`, iframe hoặc tải lại toàn trang để chuyển mode/trang.
- Nút Build UI quay về trang vừa chọn trong phiên shell; khi chưa chọn trang thì mở trang bắt đầu. Chế độ đang chọn có trạng thái active.
- Việc sửa Table/Form vẫn qua `UI Editor`, canvas và `Add block` native. Chuyển vào Build UI không tự bật chế độ sửa.

Nhóm trang chỉ là cấu trúc điều hướng, chưa phải một ứng dụng nghiệp vụ với quyền/dữ liệu độc lập. Không suy ra cấu trúc ứng dụng từ catalog manifest cũ. Link ngoài, tab con và trang bị ẩn không được tự trình bày như một ứng dụng.

## Cách tích hợp

Plugin đăng ký component `AdminLayout` qua registry công khai của host. Model layout kế thừa class `AdminLayoutModel` hiện đã được NocoBase đăng ký; vẫn render qua `FlowModelRenderer`, dùng `AdminProvider` và vòng đời model native. Khu vực nội dung chứa `Outlet`, nên native router tiếp tục chọn renderer trang, settings và kiểm tra truy cập. Element nội dung và trạng thái màn hình nhỏ được chuyển cho model native; trạng thái flow settings được đồng bộ với UI Editor.

Cây lấy từ `useAllAccessDesktopRoutes`, giữ quan hệ/thứ tự, loại trang ẩn và không thay ACL phía server. Lỗi cập nhật sẽ ẩn danh sách cũ, hiển thị lỗi và cho phép thử lại. Chỉ builder có quyền cấu hình UI native được dùng shell này. Nhân viên không có quyền đó tiếp tục dùng shell runtime của host; landing builder hiển thị thông báo không có quyền.

Các SDK external đều do host cung cấp: `@nocobase/client`, `@nocobase/client-v2`, `@nocobase/flow-engine`, `react-router-dom`, React và Ant Design. Không thêm dependency npm hoặc sửa source upstream. Thiếu điểm mở rộng cần thiết thì giữ layout native. Không sửa schema, migration, ACL server hoặc workflow.

Mã nguồn upstream đã đối chiếu ở tag `v2.2.20`: [AdminLayout](https://github.com/nocobase/nocobase/blob/v2.2.20/packages/core/client/src/route-switch/antd/admin-layout/index.tsx), [AdminProvider](https://github.com/nocobase/nocobase/blob/v2.2.20/packages/core/client/src/route-switch/antd/admin-layout/AdminShellProvider.tsx), [layout model](https://github.com/nocobase/nocobase/blob/v2.2.20/packages/core/client-v2/src/flow/admin-shell/admin-layout/AdminLayoutModel.tsx), [global dependencies](https://github.com/nocobase/nocobase/blob/v2.2.20/packages/core/client/src/application/utils/globalDeps.ts).

## Kiểm chứng và giới hạn

Foundation + Action Bridge đạt **191/191** kiểm tra, bao gồm 12 kiểm tra điều hướng: cây/quyền/đường dẫn, header hai mode, route builder, SPA links, native Outlet, giữ shell cho nhân viên, SDK thiếu, lỗi cập nhật và đăng ký từ bundle AMD.

Chưa nghiệm thu hiển thị và thao tác thật trên trình duyệt vì quyền công cụ truy cập localhost bị chặn. Chưa chấp nhận hoàn thành nhiệm vụ giai đoạn 4 từ kết quả unit/contract. Chưa có panel block phải hoặc mapping ứng dụng nghiệp vụ → native page.

Các bước nghiệm thu thực tế còn lại:

1. Builder mở Config: không còn dãy nhóm trang/Add menu item trên header; sidebar và trang cấu hình native hoạt động.
2. Chọn Build UI: chuyển SPA sang trang bắt đầu/trang vừa chọn, có cây bên trái. Chọn Classic/Modern page, kiểm tra back/forward và deep link.
3. Bật/tắt UI Editor, thêm Table qua Add block native, cấu hình và reload để kiểm tra lưu đúng trang. Kiểm tra tab, popup/chi tiết và màn hình hẹp.
4. Đổi role: nhân viên không có công cụ builder, truy cập trực tiếp và thao tác bị cấm vẫn bị host/server chặn.

## Nạp bundle trong môi trường local

Build thay đổi bundle trong mount `node_modules`; bản cũ trong `storage/plugins` không tự chứng minh là file đang được phục vụ. Phải kiểm tra resolver/asset thực tế. Asset NocoBase có cache một năm, còn URL bundle có hash được lưu trong tiến trình server. Sau build có thể cần restart riêng NocoBase để công bố hash mới, rồi tải lại trang. Không cài lại plugin, seed hay migration chỉ để cập nhật client shell. Sao lưu bundle cũ trước khi build/nạp.

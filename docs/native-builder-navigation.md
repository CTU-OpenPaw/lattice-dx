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

Ngày 06/11/2026, bản ghép với PR #38 tại `7ed4028` chạy trên NocoBase 2.2.38 và Foundation 0.24.0. `pnpm check` đạt 806 tests và build. Các bộ test plugin đạt 235/235, sáu ca identity/ACL và 22 ca workflow Request/Order qua API đạt.

Trên trình duyệt, builder chuyển giữa Config và Build UI, mở Native UI Lab từ cây trang và thêm block Markdown bằng UI Editor. Block còn sau khi tải lại và hiển thị khi đăng nhập nhân viên. Nhân viên gửi `STUDIO-1106-01`, quản lý duyệt qua Workflow To-do và người thực hiện hoàn thành. Bảng hiện `completed` sau khi tải lại.

Phạm vi nghiệm thu là một trang Classic và ba vai trò nghiệp vụ trên môi trường thử. Các trang nghiệp vụ còn lại, Modern page, đăng nhập Keycloak trong bản ghép và ma trận vai trò đầy đủ cần kiểm tra riêng.

## Tái tạo trang thử

Trên môi trường local riêng, build và bật Foundation, rồi chạy `yarn nocobase upgrade` trong container NocoBase thử để áp dụng migration. Lần cài mới đã trả `403` khi nhân viên tạo yêu cầu vì chưa có preset `ldx_employee`. Chạy upgrade bổ sung preset và luồng API đạt sau đó.

```powershell
$env:NOCOBASE_URL = 'http://localhost:13001'
$env:NOCOBASE_DB_CONTAINER = 'lattice-native-studio-nocobase-db-1'
node scripts/setup-native-ui-lab.mjs
```

Script dùng fixture `scripts/fixtures/native-ui-page.json` và tạo workflow, tài khoản thử và ID trang mới. Trên bản đã thử, schema UID là `nativeuilab8b72b41e93`, tab UID là `nlab432fb4862904`, route ID là `396209459691520`. Bản ghi IDs nằm trong `output/native-platform/ui-lab.json`. Schema sau khi thêm block đã lưu cục bộ tại `output/native-platform/studio-request-schema.json`. Để lặp lại thao tác chỉnh sửa, mở trang từ Build UI và dùng **UI Editor → Add block → Markdown**. Cách đăng nhập và tạo yêu cầu dùng hướng dẫn Native UI Lab đi kèm.

## Nạp bundle trong môi trường local

Build thay đổi bundle trong mount `node_modules`; bản cũ trong `storage/plugins` không tự chứng minh là file đang được phục vụ. Phải kiểm tra resolver/asset thực tế. Asset NocoBase có cache một năm, còn URL bundle có hash được lưu trong tiến trình server. Sau build có thể cần restart riêng NocoBase để công bố hash mới, rồi tải lại trang. Không cài lại plugin, seed hay migration chỉ để cập nhật client shell. Sao lưu bundle cũ trước khi build/nạp.

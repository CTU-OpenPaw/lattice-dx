# Bước 3 — Workspace

Plugin Foundation 0.3.0, NocoBase 2.2.22. Mở http://localhost:13000/lattice. Workspace dùng client cổ điển của runtime này; client-v2 chỉ export helper API/action, chưa có trang Workspace riêng.

## Chức năng

- Đăng nhập bằng màn hình NocoBase có sẵn; Workspace kiểm tra auth:check rồi tải manifest từ API thật.
- Hai ứng dụng mua sắm/logistics lấy từ manifest. Mở /lattice/apps/purchasing hoặc /lattice/apps/logistics. Bước 4 đã bổ sung form/list dùng chung, xem lattice-blocks.md; workflow chuyển trạng thái vẫn chưa có API.
- Kết nối tài khoản nghiệp vụ bằng DX Action Bridge và Keycloak code flow + PKCE; không tự nhập credentials hoặc lấy token Keycloak vào frontend.
- Sau callback /admin, client đọc marker đường dẫn trong sessionStorage rồi đưa người dùng về đúng Workspace/ứng dụng. Marker chỉ chứa route hợp lệ, không chứa token. Đăng xuất API là disconnect của riêng bridge, không đăng xuất Keycloak trên mọi ứng dụng.
- Đăng xuất Workspace ngắt bridge rồi gọi SDK auth.signOut của NocoBase.
- Hiển thị loading, lỗi/thành công và trạng thái hai phiên riêng. Kiểm tra phiên mỗi 30 giây; đánh dấu bridge hết hạn theo expiresAt. API 401 hướng dẫn đăng nhập/kết nối lại, 403 báo thiếu quyền. Không retry tự động các thao tác ghi.
- Route có namespace /lattice vì /apps/* là multi-app namespace riêng của NocoBase. Workspace mở bằng 127.0.0.1 chuyển sang localhost để cookie bridge khớp callback đã cấu hình. Có thể cần đăng nhập lại khi đổi hostname; NocoBase session/token không được tự sao chép giữa hai origin.

## Code chính

- src/client/workspace.js: giao diện Workspace React, trạng thái/điều hướng.
- src/client/workspace-api.js: lớp request dùng chung, timeout, phân loại lỗi và phiên, connection/signOut.
- src/client/index.js: đăng ký route, hook form dùng cùng lớp API, marker quay lại sau PKCE.
- scripts/build.mjs: đóng gói AMD với React/NocoBase external, không bundle code upstream.

Host APIClient cung cấp token NocoBase như cơ chế có sẵn; Keycloak token nằm phía server bridge. Manifest permissions là gợi ý UI, không thay quyền API. Không thêm quyền nghiệp vụ, không thay API chuyển trạng thái của Duy.

## Kiểm tra

12 Node tests PASS. Browser test scripts/smoke-lattice-workspace.cjs dùng Playwright và Edge trong context riêng: login, đọc manifest, chọn Logistics, actual PKCE qua Keycloak Alice, quay lại đúng app, status, disconnect, signOut. Kiểm tra phản hồi HTTP 403/401 bằng interception được ghi rõ là mô phỏng; không giả nhận đã chờ token hết hạn thật. Ảnh output/lattice-workspace.png minh họa Workspace sau khi kết nối.

Trước khi chạy browser test, đặt PLAYWRIGHT_MODULE tới module Playwright đã cài (hoặc dùng require('playwright') mặc định). Không ghi/in mật khẩu, token hoặc authorization code trong output của test. Browser test chỉ đọc cấu hình và thao tác phiên đăng nhập; không tạo đơn/task mới.

## Thuật ngữ

- Workspace: màn hình chung để chọn và mở ứng dụng.
- API client: code gửi yêu cầu, dùng xác thực của host và chuẩn hóa lỗi.
- Loading: trạng thái đang chờ xử lý; nút liên quan được khóa để tránh bấm trùng.
- Session: phiên đăng nhập hoặc kết nối đang có hiệu lực.
- PKCE: cơ chế bảo vệ việc trao đổi mã đăng nhập; bridge của Duy thực hiện phần này.
- Route: địa chỉ dẫn tới một màn hình.

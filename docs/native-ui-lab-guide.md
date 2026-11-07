# Tự thử luồng native NocoBase

Trang local hiện có: http://localhost:13000/admin/nativeuilabeb8c2601e3

Đây là trang native riêng cho kiểm thử, không phải UI mô phỏng. Page dùng Table, Form, CollectionField và Workflow To-do của NocoBase. Không cần kết nối tài khoản Keycloak qua Workspace cũ.

## Tài khoản local

| Vai trò | Email đăng nhập |
| --- | --- |
| Nhân viên tạo yêu cầu | native.lab.employee@example.invalid |
| Quản lý duyệt | native.lab.manager@example.invalid |
| Người thực hiện | native.lab.worker@example.invalid |

Mật khẩu fixture chung: `NativeLab-2026!`. Chỉ dành cho localhost; script không đổi tài khoản thật. Đăng xuất từ menu người dùng trước khi đổi tài khoản, hoặc dùng cửa sổ trình duyệt riêng để tránh trộn session. Tài khoản root cấu hình vẫn dùng thông tin host hiện có; không dùng root thay tài khoản nghiệp vụ.

## Luồng thử

1. Nhân viên mở trang, chọn **Tạo và gửi**, nhập Mã chưa trùng, Tên, Nội dung và Loại yêu cầu, bấm Submit. Mã là unique; các lần thử dùng mã khác nhau.
2. Collection event native tạo execution và task quản lý. Trạng thái chuyển `draft` sang `submitted` bất đồng bộ; tải lại trang để thấy thay đổi.
3. Đăng xuất, đăng nhập quản lý. Trên cùng trang, phần **Công việc của tôi**, chọn View ở task Pending. Xem thông tin hồ sơ và chọn Duyệt hoặc Từ chối.
4. Nếu duyệt, đăng nhập người thực hiện. Task **Thực hiện công việc** xuất hiện. Chọn View rồi Hoàn thành.
5. Tải lại bảng: yêu cầu có trạng thái `completed`; task hiển thị Resolved. Nếu từ chối thì hồ sơ `rejected`, không phát sinh việc thực hiện.

Mẫu là **Tạo và gửi**, không phải luồng lưu nháp riêng. Người nhận trong mẫu được quản trị cấu hình trước; chỉnh chúng trong native Workflow Settings. Native ACL vẫn chặn dữ liệu ngoài phạm vi của tài khoản.

## Cấu hình và tái lập

- Manifest runtime (IDs, không chứa token): `output/native-platform/ui-lab.json`.
- `node scripts/setup-native-ui-lab.mjs` tạo lab nếu chưa có, hoặc giữ nguyên lab đã tạo. Không chạy để reset dữ liệu; manifest dở dang sẽ yêu cầu kiểm tra IDs thay vì ghi đè.
- `scripts/fixtures/native-ui-page.json` là UI schema xuất từ designer thật, không có renderer Lattice riêng. Script cấp UID mới khi tạo lab khác.
- Workflow mẫu tạo disabled qua `scripts/configure-native-process.mjs`; người cấu hình có thể dùng native designer thay CLI.
- Backup trước tạo lab nằm trong manifest. Không restore/delete vì muốn chạy lại một yêu cầu; dùng Mã mới.

Chưa thay toàn bộ trang `/lattice` cũ. Luồng này chứng minh UI native + ACL + workflow native chạy cùng dữ liệu thật; không có nghĩa mọi module/agent/broker đã tích hợp xong.

## Thống kê yêu cầu

Trang Modern **Thống kê yêu cầu** là trang riêng bên cạnh trang luồng Classic của lab. Trang dùng biểu đồ cột native theo trạng thái, đếm theo trường `code` có quyền đọc. NocoBase tiếp tục kiểm tra ACL bản ghi và trường. Foundation bổ sung bộ lọc tổ chức từ membership đã xác thực vào truy vấn Builder trước khi host đọc dữ liệu hoặc tạo khóa cache. Truy vấn SQL đối với các collection Foundation trả `403` cho tài khoản ngoài root.

Build Foundation từ nhánh này và nạp lại runtime trước khi cấp quyền trang. Đặt `NOCOBASE_TOKEN` bằng token root của lab, rồi chạy blueprint một lần:

```powershell
$labApi = 'http://localhost:13001/api/'
$headers = @{ Authorization = "Bearer $env:NOCOBASE_TOKEN" }
$jsonType = 'application/json; charset=utf-8'
$blueprint = Get-Content -Raw -Encoding utf8 scripts/fixtures/native-request-report-blueprint.json
$response = Invoke-RestMethod "${labApi}flowSurfaces:applyBlueprint" -Method Post -Headers $headers -ContentType $jsonType -Body $blueprint
$page = if ($response.data) { $response.data } else { $response }
$ids = @{ tk = @($page.surface.tree.props.routeId, $page.surface.tree.subModels.tabs[0].props.route.id) } | ConvertTo-Json -Compress
foreach ($role in @('ldx_employee', 'ldx_manager')) {
    Invoke-RestMethod "${labApi}roles/$role/desktopRoutes:add" -Method Post -Headers $headers -ContentType $jsonType -Body $ids
}
$page.target.pageSchemaUid
```

Chạy `scripts/acceptance-native-documents.mjs` với `NOCOBASE_URL=http://localhost:13001`. Ca kiểm thử dựng ba yêu cầu ở hai tổ chức và xác nhận root thấy ba, quản lý cùng tổ chức thấy hai, nhân viên thấy một. Ca này dùng cache, thử bộ lọc cố tình chỉ vào tổ chức khác và thử SQL trực tiếp. Trên trình duyệt, root mở báo cáo từ Build UI, quản lý và nhân viên đều thấy biểu đồ hiển thị.

## Điều kiện bật tệp đính kèm

Trên NocoBase 2.2.38 của lab, một tài khoản kho không liên quan tải được nội dung tệp thử qua đường dẫn của collection `attachments` mặc định. Tải lên thành công chỉ xác nhận bộ lưu trữ đang hoạt động.

Trước khi thêm ô tải tệp vào form Yêu cầu, chốt contract tạo liên kết và tải theo cặp ID yêu cầu và ID tệp. Máy chủ cần kiểm tra liên kết, quyền hiện hành trên yêu cầu và trạng thái quét trước khi trả nội dung. Có thể tái sử dụng đường tải có kiểm quyền theo bản ghi của dịch vụ tệp nếu có cách ánh xạ rõ ràng từ ID Yêu cầu native. Kiểm lại cùng tệp qua URL trực tiếp bằng người tạo, quản lý có quyền, người dùng không liên quan và người thuộc tổ chức khác. Thử lại sau khi thu hồi quyền và khi tệp chưa sạch.

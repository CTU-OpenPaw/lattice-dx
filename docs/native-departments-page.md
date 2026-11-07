# Trang Phòng ban

Trang Modern **Danh mục nội bộ → Phòng ban** dùng bảng, chi tiết và form native trên collection `latticeDepartments`. Bảng có bộ lọc theo tên, mã và tổ chức, với 10 dòng mỗi trang. Form tạo nhập mã, tên và tổ chức. Form sửa tên dùng bản ghi đang chọn.

Nhân viên dùng quyền hiện có của `ldx_employee` để xem phòng ban trong tổ chức của mình. Quản trị viên root dùng quyền hiện có để tạo và sửa. Quyền menu của trang được cấp riêng cho `ldx_employee`.

## Tái tạo trên lab

Chạy các lệnh từ thư mục repo với NocoBase 2.2.38, Foundation 0.24.0 và preset quyền đã được migration. Đặt `NOCOBASE_TOKEN` thành token của quản trị viên trên lab. Chạy blueprint một lần trên mỗi lab. NocoBase cấp ID mới cho trang và tab.

```powershell
$labApi = 'http://localhost:13001/api/'
$labHeaders = @{ Authorization = "Bearer $env:NOCOBASE_TOKEN" }
$blueprint = Get-Content -Raw scripts/fixtures/native-departments-blueprint.json
$response = Invoke-RestMethod "${labApi}flowSurfaces:applyBlueprint" -Method Post -Headers $labHeaders -ContentType 'application/json; charset=utf-8' -Body $blueprint
$page = if ($response.data) { $response.data } else { $response }
$routeId = $page.surface.tree.props.routeId
$tabId = $page.surface.tree.subModels.tabs[0].props.route.id
$route = Invoke-RestMethod "${labApi}desktopRoutes:get?filterByTk=$routeId" -Headers $labHeaders
$grant = @{ tk = @($route.data.parentId, $routeId, $tabId) } | ConvertTo-Json -Compress
Invoke-RestMethod "${labApi}roles/ldx_employee/desktopRoutes:add" -Method Post -Headers $labHeaders -ContentType 'application/json' -Body $grant
$page.target.pageSchemaUid
```

## Kiểm chứng trên bản ghép

- Trang lab có schema UID `6smphubqo4e`, route ID `396212634779649` và tab ID `396212634779650`.
- Trên trình duyệt, root tạo `STUDIO-DEPT-01`, sửa tên thành **Phòng ban kiểm thử đã cập nhật** và dùng bộ lọc tên để tìm đúng một dòng.
- Nhân viên mở được bảng và chi tiết phòng ban. Hai trang API với kích thước một dòng trả hai bản ghi khác nhau, đều thuộc `native-ui-lab`. API từ chối tạo và sửa bằng tài khoản nhân viên với HTTP `403`.
- Kết quả áp dụng blueprint và bằng chứng kiểm tra được lưu cục bộ ở `output/native-platform/studio-departments-blueprint-result.json` và `output/native-platform/studio-departments-check.json`.

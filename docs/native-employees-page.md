# Trang Nhân viên

Trang Modern **Danh mục nội bộ → Nhân viên** dùng bảng, chi tiết và form native trên collection `latticeEmployees`. Bảng lọc theo tên, mã và tổ chức, với 10 dòng mỗi trang. Quản trị viên root nhập mã, tên, tổ chức và phòng ban khi tạo. Form sửa cho phép đổi tên và phòng ban.

Role `ldx_employee` chỉ đọc bản ghi trong tổ chức của mình. Bảng và chi tiết dùng các trường đơn giản để giữ nguyên cơ chế chặn truy vấn mở rộng quan hệ của Foundation. Form chọn phòng ban dành cho root trên lab. Bộ chọn có thể liệt kê phòng ban từ nhiều tổ chức. Sau khi áp dụng migration, máy chủ trả HTTP `409` nếu phòng ban được chọn thuộc tổ chức khác và giữ nguyên bản ghi cũ khi lưu thất bại.

## Tái tạo trên lab

Chạy từ repo với NocoBase 2.2.38, PostgreSQL và bản Foundation đã build từ nhánh này. Chạy `yarn nocobase upgrade` trong container lab để áp dụng preset quyền và các migration ràng buộc tổ chức. Với dữ liệu cũ, kiểm tra các liên kết sai tổ chức hoặc thiếu phòng ban trước khi upgrade vì migration sẽ dừng nếu gặp dữ liệu vi phạm. Đặt `NOCOBASE_TOKEN` bằng token root của lab. Chạy blueprint một lần trên mỗi lab. NocoBase cấp ID mới cho trang và tab.

```powershell
$labApi = 'http://localhost:13001/api/'
$labHeaders = @{ Authorization = "Bearer $env:NOCOBASE_TOKEN" }
$jsonType = 'application/json; charset=utf-8'
$fieldsUrl = "${labApi}collections/latticeEmployees/fields"
$fields = Invoke-RestMethod "${fieldsUrl}:list?paginate=false" -Headers $labHeaders
$department = $fields.data | Where-Object name -eq 'department'
if ($department.type -ne 'belongsTo' -or $department.target -ne 'latticeDepartments' -or $department.foreignKey -ne 'departmentId') {
    throw 'Không tìm thấy quan hệ phòng ban đúng với blueprint.'
}
if (-not $department.interface) {
    $metadata = @{
        interface = 'm2o'
        uiSchema = @{ title = 'Phòng ban'; 'x-component' = 'AssociationField' }
    } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod "${fieldsUrl}:update?filterByTk=department" -Method Post -Headers $labHeaders -ContentType $jsonType -Body $metadata
    if ($result.data.interface -ne 'm2o') { throw 'Chưa lưu được metadata quan hệ.' }
} elseif ($department.interface -ne 'm2o') {
    throw 'Kiểm tra cấu hình giao diện quan hệ hiện có trước khi áp dụng blueprint.'
}

$blueprint = Get-Content -Raw -Encoding utf8 scripts/fixtures/native-employees-blueprint.json
$response = Invoke-RestMethod "${labApi}flowSurfaces:applyBlueprint" -Method Post -Headers $labHeaders -ContentType $jsonType -Body $blueprint
$page = if ($response.data) { $response.data } else { $response }
$routeId = $page.surface.tree.props.routeId
$tabId = $page.surface.tree.subModels.tabs[0].props.route.id
$route = Invoke-RestMethod "${labApi}desktopRoutes:get?filterByTk=$routeId" -Headers $labHeaders
$grant = @{ tk = @($route.data.parentId, $routeId, $tabId) } | ConvertTo-Json -Compress
Invoke-RestMethod "${labApi}roles/ldx_employee/desktopRoutes:add" -Method Post -Headers $labHeaders -ContentType $jsonType -Body $grant
$page.target.pageSchemaUid
```

## Kiểm chứng trên lab 13001

- Quản trị viên tạo `STUDIO-EMP-01`, chọn **Native UI Lab**, rồi đổi sang **Phòng ban kiểm thử đã cập nhật** trên desktop. Form mở lại sau khi tải trang hiển thị phòng ban mới. API xác nhận `departmentId` đổi từ `5` sang `6`.
- Người dùng cuối mở được trang `g3ot2b4wr3c`, thấy bốn bản ghi thuộc `native-ui-lab` và chỉ có thao tác **Chi tiết** trên từng dòng. API trả HTTP `403` khi tài khoản này thử tạo, sửa hoặc truy vấn mở rộng quan hệ.
- Kiểm lại ở khung hẹp 440 px, đổi về **Native UI Lab**, lưu và mở lại. Form hiển thị đúng giá trị mới và API xác nhận `departmentId = 5`.
- Form desktop báo lỗi khi chọn phòng ban khác tổ chức. Bài kiểm tra `scripts/acceptance-native-foundation.mjs` xác nhận tạo và sửa đều bị chặn với cả khóa ngoại trực tiếp lẫn đối tượng quan hệ.
- Kiểm tra hồi quy cả ba trang Phòng ban, Nhân viên và Tài sản bằng tài khoản người dùng cuối. Mở chi tiết được trong tổ chức, truy vấn theo ID ngoài tổ chức không trả dữ liệu và thao tác sửa trả `403`. Bằng chứng ở `output/native-platform/studio-directory-recheck.json`.
- Bằng chứng cục bộ nằm trong `output/native-platform/studio-employees-check.json` và `output/native-platform/studio-employees.jpg`.

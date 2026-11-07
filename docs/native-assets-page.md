# Trang Tài sản

**Danh mục nội bộ → Tài sản** là trang Modern trên collection `latticeAssets`. Quản trị viên root tạo tài sản và chọn phòng ban, người phụ trách. Người dùng cuối có quyền `ldx_employee` xem danh sách và chi tiết tài sản trong tổ chức của mình.

Hai khóa ngoại PostgreSQL kiểm tra tổ chức của phòng ban và người phụ trách mỗi khi lưu. Có thể để trống hai trường này. Bộ chọn của root vẫn liệt kê ứng viên từ nhiều tổ chức và form báo lỗi cụ thể khi chọn sai. Bảng dành cho người dùng cuối dùng các trường đơn giản, phù hợp với chính sách hiện có về truy vấn mở rộng quan hệ.

## Tái tạo trên lab

Build Foundation và chạy `yarn nocobase upgrade` trong container NocoBase 2.2.38 của lab để áp dụng migration. Migration dừng và hoàn tác nếu dữ liệu cũ có liên kết sai tổ chức hoặc thiếu bản ghi tham chiếu. Rà soát các liên kết đó trước khi chạy trên môi trường đã có dữ liệu.

Đặt `NOCOBASE_TOKEN` bằng token root. Chạy blueprint một lần trên mỗi lab. NocoBase cấp ID mới cho trang và tab.

```powershell
$labApi = 'http://localhost:13001/api/'
$labHeaders = @{ Authorization = "Bearer $env:NOCOBASE_TOKEN" }
$jsonType = 'application/json; charset=utf-8'
$fieldsUrl = "${labApi}collections/latticeAssets/fields"
$fields = Invoke-RestMethod "${fieldsUrl}:list?paginate=false" -Headers $labHeaders
$relations = @(
    @{ Name = 'department'; Target = 'latticeDepartments'; Title = 'Phòng ban' }
    @{ Name = 'custodian'; Target = 'latticeEmployees'; Title = 'Người phụ trách' }
)
foreach ($relation in $relations) {
    $field = $fields.data | Where-Object name -eq $relation.Name
    if ($field.type -ne 'belongsTo' -or $field.target -ne $relation.Target -or $field.foreignKey -ne ($relation.Name + 'Id')) {
        throw "Quan hệ không khớp blueprint $($relation.Name)"
    }
    if (-not $field.interface) {
        $metadata = @{
            interface = 'm2o'
            uiSchema = @{ title = $relation.Title; 'x-component' = 'AssociationField' }
        } | ConvertTo-Json -Compress
        $result = Invoke-RestMethod "${fieldsUrl}:update?filterByTk=$($relation.Name)" -Method Post -Headers $labHeaders -ContentType $jsonType -Body $metadata
        if ($result.data.interface -ne 'm2o') { throw "Chưa lưu được metadata $($relation.Name)" }
    } elseif ($field.interface -ne 'm2o') {
        throw "Kiểm tra giao diện quan hệ hiện có $($relation.Name)"
    }
}

$blueprint = Get-Content -Raw -Encoding utf8 scripts/fixtures/native-assets-blueprint.json
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

- Quản trị viên tạo `STUDIO-ASSET-01` trên desktop, chọn **Native UI Lab** và **Nhân viên thử native**, sau đó đổi sang **Quản lý thử native**. Form mở lại và API xác nhận giá trị mới đã lưu.
- Gán phòng ban hoặc người phụ trách ngoài tổ chức bị từ chối với HTTP `409`. Bài kiểm tra `scripts/acceptance-native-foundation.mjs` thử cả tạo và sửa với khóa ngoại trực tiếp và đối tượng quan hệ, rồi xác nhận bản ghi giữ giá trị cũ.
- Người dùng cuối chỉ thấy tài sản của `native-ui-lab` và mở được chi tiết. API không trả bản ghi ngoài tổ chức khi truy vấn theo ID và trả HTTP `403` khi thử sửa.
- Bằng chứng cục bộ được lưu trong `output/native-platform/studio-assets-check.json` và `output/native-platform/studio-assets.jpg`.

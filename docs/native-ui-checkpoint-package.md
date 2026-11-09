# Gói tái tạo bài thử chỉnh cấu hình native

Gói này tái tạo **trạng thái cấu hình đã lưu** của bài thử field/nhãn/bảng/form/filter/quyền trong task 4 của Hưng. NocoBase tiếp tục render và kiểm ACL. Không tạo renderer, API, migration hoặc workflow nghiệp vụ mới.

## Nội dung gói

- `scripts/fixtures/native-ui-checkpoint.json`: metadata field `latticeRequests.studioLabNote`, nhãn **Ghi chú kiểm thử** và ba mảnh schema native đã xuất: hàng form, cột bảng, Filter.Action.
- Dùng lại `native-ui-page.json`; helper ghép đúng các vị trí cố định, rồi cấp UID mới bằng `instantiateNativePage`. Không lấy ID/user/role từ lab của người xuất.
- Role thử riêng sao chép phạm vi tài liệu của preset nhân viên: đọc hồ sơ liên quan, sửa nháp của mình. Chỉ role mới nhận quyền đọc/tạo field thêm; không nhận quyền cập nhật field đó. Bảy preset đang dùng được fingerprint trước/sau để phát hiện thay đổi.
- Tài khoản/Employee/tổ chức/page đều riêng. Không reset password, gán lại role hay sửa membership của tài khoản đã có. Không bật/sửa workflow nào; form của fixture tạo nháp trong tổ chức thử, không chứng minh luồng duyệt.

Script yêu cầu runtime local tách biệt, NocoBase **2.2.38**, Foundation đã cài và migrate. Không dùng cổng 13000 hay DB core. Backup PostgreSQL được tạo trước mutation đầu tiên; output/backup chứa dữ liệu nội bộ, không commit hoặc gửi cả thư mục output.

## Tái tạo trên lab sạch từ source đã commit

Từ checkout có bộ gói này, dùng đường cài sạch đã có của nhóm:

```powershell
pnpm native:clean --port=13004
# Lấy reportPath từ kết quả. Dùng đúng source export/container của lượt đó:
$checkpointClean = Get-Content -Raw PATH_TO_REPORT | ConvertFrom-Json
$env:NOCOBASE_URL = $checkpointClean.origin
$env:NOCOBASE_DB_CONTAINER = $checkpointClean.project + '-nocobase-db-1'
Set-Location $checkpointClean.sourceRoot
node scripts/setup-native-ui-checkpoint.mjs
node scripts/acceptance-native-ui-checkpoint.mjs
```

Không chạy lại `native:clean` để resume một lab. Script clean tạo lab mới mỗi lần và export HEAD; code chưa commit không được đưa vào source export. Không đổi runbook/installer của Duy để cài gói này.

## Manifest và chạy lại

Setup in `pageUrl`, email thử, role và `packageDigest`; lưu manifest tại `output/native-platform/ui-checkpoint.json`. Chọn file riêng bằng `NATIVE_UI_CHECKPOINT_MANIFEST` nếu quản lý nhiều lab từ một checkout. Manifest gồm IDs, schema đã cấp UID, backup và checkpoint từng bước; không chứa token/password.

Chạy lại setup trên cùng manifest phải giữ nguyên page/user/role. Nếu field, nhãn, component, policy, mapping, package digest hoặc quyền hiện có không còn khớp, script dừng để kiểm tra, không reset. Manifest dở dang được giữ lại; trường hợp API đã commit nhưng chưa ghi manifest có thể cần đối soát thủ công, không xóa fixture để bỏ qua lỗi.

Field có sẵn chỉ được dùng khi type/interface/title/component tương thích. Bài thử chấp nhận field hợp lệ đã tồn tại; không đổi nhãn của một field khác để ép khớp. Đây không phải công cụ rollback hoặc reconcile mọi thay đổi schema.

## Kiểm chứng và phân biệt phạm vi

HTTP acceptance kiểm: mapping tổ chức; field/nhãn và hai binding bảng/form; Filter.Action được lưu; tạo/đọc đúng field; sửa tên được nhưng payload cập nhật ghi chú không thay giá trị do whitelist native; ẩn hồ sơ khác trong cùng tổ chức và tổ chức khác; chặn sửa status/org; bảy preset không đổi. HTTP update có thể trả 200 khi field ngoài whitelist bị bỏ qua — cần đọc lại giá trị, không mặc định mọi trường hợp phải trả 403.

Kết quả ở `ui-checkpoint.json.acceptance.json`, luôn ghi `browserVerified:false`. Các record thử được giữ lại, IDs nằm trong manifest. Không có lệnh tự xóa/reset môi trường hoặc thu hồi quyền đã có của người khác.

Lượt browser cần thực hiện riêng:

1. Mở `pageUrl` bằng root để thấy cột/form **Ghi chú kiểm thử** và Filter native.
2. Đăng xuất, dùng email trong manifest / `NativeLab-2026!` (chỉ localhost). Thấy đúng field/nhãn, tạo một hồ sơ với ghi chú, reload đọc lại đúng giá trị.
3. Dùng Filter/Reset và kiểm phạm vi dữ liệu; không có quyền thiết kế. Đổi một nhãn/block bằng root rồi mở lại bằng nhân viên nếu cần nghiệm thu thêm thao tác chỉnh trực tiếp.
4. Người nhận ghi SHA, URL, IDs và kết quả. Import/HTTP đạt không thay browser acceptance, không tự tick toàn bộ task hay Giai đoạn 4.

Không đưa `native-ui-config-*` lên production. Role thử là bản sao có phạm vi cố định cho bài chứng minh cấu hình, không thay ma trận bảy vai trò Workspace hoặc contract người duyệt của Nhi.

# Lưu form tới database thật — PASS

Ngày 2026-10-13, Asia/Bangkok. Đây là kiểm tra controller dùng chung của form; chưa dựng form UI hay Workspace.

## Kết quả

- Core chạy từ infra/compose/core.yml: postgres, keycloak, api, gateway. Không cần khởi động scanner cho phép thử record/task này; upload tệp chưa thuộc phạm vi kiểm tra.
- Core smoke PASS: JWT, quyền read/write, owner và organization scope qua Gateway/API/PostgreSQL.
- Realm fixture được cập nhật bằng script chính thức; không xóa user/password/volume.
- NocoBase hiện có giữ nguyên database, storage và trang quản lý chi tiêu. Database được sao lưu tại output/backups/nocobase-prebridge-20261013.dump, 267364 bytes (snapshot trước khi cài bridge).
- Đã cài/bật Action Bridge trên runtime NocoBase 2.2.22, dùng cấu hình endpoint PKCE của Duy.
- Smoke đọc manifest thật từ latticeApps:list, gọi createFormActions từ chính source plugin, tạo record bằng purchasing/create-request và task bằng logistics/assign-warehouse-task.
- Record: 2edc10a0-027e-4863-bc5d-9239d1ab93b2.
- Task: 880d5fde-025a-4b95-82bf-8a602a09ff9e, recordId tham chiếu record trên, status=pending.
- Cả hai thuộc org-a của token. Readback API PASS; SELECT trực tiếp trong records/foundation_tasks cũng thấy đúng ID, scope và liên kết.
- Session bridge test được disconnect sau thử. Hai bản ghi minh họa được giữ lại.
- Tám test plugin vẫn PASS; bốn collection nền vẫn có hai bản ghi mỗi bảng.
- Headless Edge đăng nhập, mở trang quản lý chi tiêu cũ; client Foundation và Action Bridge đều HTTP 200, không pageerror/App error.

## Cấu hình runtime có sẵn

Máy này dùng D:/AI/OSS/nocobase_test/docker-compose.yml, không dựng database NocoBase mới từ Compose chính thức. App được nối thêm mạng lattice-dx_default, mount package Action Bridge và nhận bốn DX_BRIDGE endpoint. DB_HOST trỏ rõ nocobase_test-postgres-1 vì cả hai mạng đều có service alias postgres; để tên postgres mơ hồ sẽ kết nối nhầm database.

Action Bridge được thêm AMD client entrypoints tối thiểu để tránh thiếu dist/client/index.js khi browser nạp plugin. Không sửa logic PKCE/token/authorization của bridge. Build bằng node plugins/nocobase/action-bridge/build.mjs; installer chính thức đã gọi build trước enable.

## Chạy lại

```powershell
cd D:\AI\OSS\LatticeOSS
node scripts/smoke-lattice-form.mjs
```

Mỗi lần chạy tạo một record và một task thử mới; chỉ chạy lại khi cần xác minh, không có retry tự động. Token/cookie/authorization code chỉ giữ trong bộ nhớ, không in log hoặc ghi file. Kết quả cuối in PASS và hai ID để đối chiếu.

Phần còn thiếu ở bước 2: API chuyển trạng thái nghiệp vụ purchasing/order/shipment. Không sửa trạng thái local để giả lập hoàn tất. Chưa khẳng định file upload hay logistics workflow đã PASS.

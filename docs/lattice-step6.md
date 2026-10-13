# Bước 6 — kiểm tra tích hợp và nghiệm thu phần sẵn sàng

Ngày 2026-10-13, NocoBase 2.2.22 local, Foundation 0.6.0. Phạm vi là những API hiện có; không chứng nhận toàn bộ sản phẩm đã hoàn tất.

## Kết quả

| Hạng mục | Kết quả | Bằng chứng / giới hạn |
| --- | --- | --- |
| Bộ test dự án | PASS | Vitest: 9 file, 96 test. |
| Plugin/bridge | PASS | Node: 20 test, gồm validation, quyền/catalog, duplicate-submit, phản hồi muộn, file whitelist/quarantine, native expiry timer. |
| Đăng nhập/đăng xuất Workspace | PASS | Browser thực: NocoBase login, PKCE, điều hướng, disconnect/logout. |
| Giao diện khi API 401/403 | PASS mô phỏng | Browser route interception, không giả nhận là quyền/expiry server thật. |
| Hết phiên bridge thật | PASS | Browser chờ tự hết phiên ~296 giây: form disabled và list table bị gỡ. Không thay thời gian/token lifetime. |
| Quyền API, liên kết dữ liệu | PASS trong hợp đồng hiện có | API thật qua Gateway/Keycloak/PostgreSQL; scope token, assignee inbox, quyết định task theo version, concurrent decision conflict, liên kết record/task/file. |
| Luồng kinh doanh → kho | PASS | Browser hai tài khoản cùng org-a: record/task thật, kho đọc đúng task; kho không có quyền tạo record. |
| Tệp và scanner | PASS | Clean upload/download đúng byte; antivirus test string rejected/download 409; scanner dừng → scan error/download 409, sau đó khởi động lại. |
| Lưu binding native builder | PASS | Trang thử riêng: thêm Form/List bằng menu UI, chọn manifest/block, Save, reload, đọc model lưu qua API; cả hai binding còn tồn tại. Schema trang chi tiêu cũ so trước/sau không đổi. |
| Typecheck API và mẫu logistics | PASS | tsc -p apps/api/tsconfig.json và solutions/logistics/tsconfig.json --noEmit. Không tuyên bố build toàn monorepo PASS. |
| Nghiệp vụ mua sắm/Order/Shipment đầy đủ | CHƯA KIỂM ĐƯỢC | API và entity/workflow chưa có. Task approval không tương đương duyệt đơn hàng. |
| Directory người nhận cùng đơn vị | CÒN THIẾU API | API chưa xác minh subject assignee thuộc đơn vị; không coi kiểm inbox scope là đã giải quyết lỗ hổng này. |
| Chia sẻ record/file cho kho | CHƯA CÓ | Owner isolation hiện là đúng hợp đồng; chưa có API cấp quyền chia sẻ. |
| Tải lớn, production, mọi browser | CHƯA KIỂM | Các phép thử local tập trung, không load test hay chứng nhận vận hành production. |

## Các sửa trong bước này

1. FormBlock không hiện kết quả/callback của request cũ sau disconnect, đổi block hoặc unmount. Có regression test trì hoãn write, disconnect rồi nhận success.
2. Độ dài string dùng UTF-16 giống hợp đồng API, tránh frontend chấp nhận chuỗi emoji mà API từ chối theo giới hạn 200.
3. Native ConfiguredBlock kiểm status định kỳ và tự ngắt theo expiresAt, thay vì giữ trạng thái connected mãi sau lần load đầu. Timer được kiểm bằng mock clock; phép expiry browser thật ở trên kiểm Workspace, không phải một phiên native builder thật chờ hết hạn.
4. Chỉnh chỉ dẫn cài đặt block theo UI thật: menu block → Chọn ứng dụng và block. Tên flow Cấu hình Lattice không phải một submenu hiển thị trên runtime này.

## Dữ liệu và trang thử

- Không reset DB, không xóa dữ liệu cũ, không chỉnh schema trang chi tiêu đang có.
- Native page đã kiểm lưu/reload: /admin/lta24e667ab0. Các lần tìm selector có tạo thêm một số trang riêng có tiêu đề Lattice Step6 Test, root UID bắt đầu lt, hideInMenu=true. Giữ lại để kiểm tra, không xóa để che lỗi chạy thử.
- Phép kiểm native cuối sau cài package PASS trên /admin/lte4ecde702b; xem output/lattice-builder-save.png. Form/List binding persisted, reload PASS và originalPageUnchanged=true.
- Browser record/task/file sau bản 0.6.0: record 4b5327a4-0ab1-4d65-93cc-f8fab41a1400, order record 4b446b00-9f4b-4f1d-98e2-14e9c7c87485, task 6cd2e000-41b8-4105-8cb7-4ffc586aadf1, file 005e674f-185a-4ea6-953b-6a10d8af2470. Các script smoke có thể tạo thêm fixture khi chạy lại, không tự retry write.
- Scanner-outage cố ý gián đoạn scanner local ngắn, khởi động lại trong finally. Không chạy khi có người khác upload.

## Lệnh kiểm

```powershell
node --test plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs plugins/nocobase/action-bridge/tests/*.test.cjs
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p solutions/logistics/tsconfig.json --noEmit
node scripts/smoke-foundation.mjs
node scripts/smoke-record-links.mjs
node scripts/smoke-scanner-outage.mjs
# Browser scripts cần Playwright (PLAYWRIGHT_MODULE) và Edge trên máy local.
node scripts/smoke-lattice-workspace.cjs
node scripts/smoke-lattice-expiry.cjs
node scripts/smoke-lattice-files.cjs
node scripts/smoke-lattice-builder-save.cjs
```

Wrapper pnpm trên máy hiện dùng phiên bản khác packageManager pin, tự install rồi bị chặn ignored esbuild builds. Bộ test dự án được chạy trực tiếp bằng Vitest đã cài, PASS 96; không tuyên bố lệnh pnpm check đã PASS và không bật build script tùy ý để bỏ chặn.

## Việc cần tiếp tục

- Duy: entity/API mua sắm và Order/Shipment, trạng thái/guard/version, directory và kiểm assignee, chính sách chia sẻ record/file.
- Phân trang/filter server, phân loại record theo ứng dụng; file list, retry scan/object storage nếu yêu cầu sử dụng thật cần.
- Mapping tài khoản thật với Employee seed và chính sách đa đơn vị đầy đủ.
- Sau các API trên: bổ sung test xuyên suốt tương ứng rồi mới nghiệm thu toàn bộ. Giao diện đẹp vẫn chưa triển khai theo thỏa thuận làm sau các bước chức năng.
- Git vẫn thay đổi local; chưa commit/push. Theo phê duyệt trước, nhánh/commit mốc bước 2 chờ đóng phần transition, chưa tự coi bước 2 đã đóng.

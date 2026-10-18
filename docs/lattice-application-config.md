# Bước 2 — cấu hình ứng dụng và action form

Source: `plugins/nocobase/plugin-lattice-foundation/src/shared/manifest.js`. Plugin 0.2.0.

## Cấu hình bàn giao cho Duy

Hai manifest mẫu ở `src/shared/manifests/purchasing.json` và `logistics.json` của plugin. Workspace ở /lattice/apps/purchasing và /lattice/apps/logistics; bước 4 đã dựng form/list thật từ cấu hình này, xem lattice-blocks.md. Tránh /apps/* vì NocoBase dành namespace đó cho multi-app.

Schema version 1: id, name, route=/lattice/apps/<id>, permissions (UI hints), collections (id/source/resource), blocks (id/type/title/collection/permissions), transitions. Form fields hỗ trợ string, required, maxLength và pattern=uuid. Form submit ràng buộc actionId/version từ catalog. List khai báo columns. Chỉ form/list được đăng ký trong hợp đồng; giao diện block chưa triển khai. Validator kiểm cấu trúc, khóa lạ, tham chiếu, trùng ID/route và khả năng API.

`source=lattice-api` nhận records/tasks: API của Duy là nguồn dữ liệu thật. `source=nocobase` chỉ nhận bốn registry nền của bước 1; không tự đồng bộ hoặc biến chúng thành dữ liệu trong API của Duy. organizationId/ownerId không được nhập vào payload action; API lấy scope từ token.

NocoBase endpoints đọc cấu hình (cần đăng nhập NocoBase):

- GET /api/latticeApps:list → data.items.
- GET /api/latticeApps:get?filterByTk=purchasing → data manifest.

Catalog cấu hình là tài liệu UI, không cấp quyền truy cập dữ liệu. API tiếp tục kiểm tra quyền. Không đưa token/secret vào manifest.

## Đường lưu form

Client plugin đăng ký hook `useLatticeFormAction(manifest, blockId)` vào scope của client cổ điển. Hook trả loading/error/result, submit(values), transition(id). Cả client cổ điển và client-v2 export `createFormActions({apiClient,manifest,blockId})`; client-v2 dùng controller này khi viết block riêng, chưa đăng ký React hook.

Block → hook/controller → NocoBase APIClient (bearer của NocoBase + cookie trình duyệt) → dxActions:catalog → dxActions:run → Gateway/API của Duy (Keycloak token phía server) → database API. Tái sử dụng bridge của Duy, không tự tạo proxy hoặc giữ Keycloak token trong browser. Đang có records.create và tasks.create; cùng controller dùng cho mua sắm/logistics.

Controller whitelist trường, kiểm dữ liệu, xác nhận action có trong catalog, chặn gửi đồng thời và không tự retry khi lỗi/timeout. Success phải đúng action/version và có record/task ID thật. HTTP 401 cần kết nối lại, 403 báo thiếu quyền. Record/task là hồ sơ/nhiệm vụ nền, không phải mô hình đơn hàng đầy đủ.

## Những phần API chưa có

Chuyển trạng thái purchasing/order/shipment chưa có API/action. Manifest đánh dấu unavailable; gọi transition sẽ báo lý do và không ghi local state. API task decisions đã có, nhưng bridge action catalog chưa expose nó; không giả nhận task approval là order approval. Duy cần bàn giao ID action/version/schema/role/guard/trạng thái trả về trước khi nối business transitions.

Ngày 2026-10-13 đã chạy core PostgreSQL/Keycloak/API/Gateway và cài Action Bridge vào runtime NocoBase hiện có. Đường lưu form đã PASS end-to-end qua PKCE bridge; record/task được đọc lại qua API và đối chiếu trong PostgreSQL. Xem lattice-form-e2e.md và scripts/smoke-lattice-form.mjs. Form trên giao diện vẫn chưa dựng. Business transitions vẫn chưa có API; không biến task approval thành order approval. Khi cài môi trường khác cần endpoint cấu hình bridge đúng theo docs/nocobase-action-auth.md.

## Kiểm tra

Trong package plugin: `node scripts/build.mjs`, `node --test tests/*.test.cjs`, `npm pack --ignore-scripts`. Kiểm tra validator, payload chính xác, task linkage, catalog permission, 401/403/network failures, không retry, chặn double click, transition unavailable và AMD loading. Bật plugin không tự dựng Workspace hay form.

## Thuật ngữ

- Schema: quy tắc để kiểm bản mô tả ứng dụng có hợp lệ không.
- Manifest: bản mô tả cụ thể để Workspace/block đọc và dựng ứng dụng.
- Action: thao tác gọi API, như tạo hồ sơ hoặc giao việc.
- Hook: hàm giúp block gọi action và theo dõi trạng thái loading/error/result.
- Controller: đối tượng thực hiện/kiểm soát thao tác, dùng được ngoài React.
- Catalog: danh sách action được API cấp cho tài khoản đang kết nối.
- Scope: phạm vi người dùng/đơn vị đã được API xác minh từ token.

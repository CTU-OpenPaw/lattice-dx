# Workspace dùng chung và các ứng dụng mở rộng

14/10/2026 · Foundation 0.9.0 · sửa sau review của Hưng.

## Vấn đề được sửa

Foundation 0.8.0 để Workspace import LogisticsDetail/ProcurementWorkflow, kiểm selected.id và tự chọn cách xử lý row. Form, action controller, validator và API client cũng chứa một số nhánh Logistics. Hai luồng chạy được nhưng khung nền phụ thuộc nghiệp vụ mẫu, chưa đúng mục tiêu nền tảng.

0.9.0 phân tách như sau:

| Phần | Trách nhiệm |
| --- | --- |
| src/client/workspace.js | Phiên, catalog, chọn app, điều hướng; không import hoặc rẽ nhánh theo mua sắm/Logistics. |
| src/client/application-runtime.js | Dựng panels/blocks theo manifest, selection/refresh/lock dùng chung; không biết app ID hoặc definition nghiệp vụ. |
| src/client/blocks.js, actions.js, reference-data.js | Form/List, validation, upload, lựa chọn, submit/retry; đọc contract đã đăng ký. |
| src/shared/contracts.js | Registry resource/action/reference cho extension tin cậy. |
| src/shared/manifest.js | Kiểm cấu trúc và đối chiếu contract, không liệt kê trường của Logistics. |
| src/shared/application-catalog.js | Catalog đăng ký, kiểm cấu hình, duplicate ID/route và sở hữu snapshot đã validate. |
| src/applications/contracts.js, api.js, catalog.js, views.js | Đăng ký các mẫu đang cài và adapter tới backend hiện có. Đây là composition layer của ứng dụng mẫu, không phải shell. |
| src/applications/logistics/detail.js | Panel đặc thù Order, submit/receive, fields của Logistics. |
| src/applications/procurement/workflow.js | Panel đặc thù mua sắm/bàn giao và fields backend yêu cầu. |
| src/client/workflow.js | Command controller dùng chung: version/body/key, pending và retry. |

Không chỉ đổi tên LogisticsDetail thành tên khác. Selection, display blocks, panels, reference loader, action schema và resource mapping đã được lấy ra khỏi các nhánh trong core.

## Hợp đồng layout

Manifest schemaVersion 1 giữ nguyên các block/form/list cũ, bổ sung workspace tùy chọn:

```json
{
  "workspace": {
    "panels": [{"id":"detail", "renderer":"support.ticket-detail"}],
    "blocks": [
      {"blockId":"new-ticket", "selectFrom":"id"},
      {"blockId":"ticket-list", "selectFrom":"id"},
      {"blockId":"assigned-work", "selectFrom":"recordId"}
    ],
    "showTransitions": false,
    "note": "Thông tin hướng dẫn cho ứng dụng, nếu cần."
  }
}
```

- panels tham chiếu renderer đã cài bằng tên. Không có URL/script/module tùy ý, không eval, không tải code do manifest cung cấp.
- blocks xác định thứ tự và block nào xuất hiện trong Workspace. Block không nằm trong danh sách vẫn có thể tồn tại để giữ binding native cũ.
- selectFrom là field trực tiếp của kết quả form/row, ví dụ id/recordId; không phải JavaScript expression. Khi có panel khóa do lệnh pending/chưa xác định, không đổi selection.
- Không khai báo workspace thì dùng các Form/List trong manifest theo layout mặc định, không cần panel riêng.
- Renderer chưa cài: báo thiếu thành phần, không giả một màn hình hoạt động một phần.
- Layout/ID/reference sai được validator/catalog từ chối; danh sách registry renderer dùng Map để tránh tra cứu prototype.

## Thêm một lĩnh vực khác

### Trường hợp dùng API và các component đã có

1. Tạo manifest với ID/tên/route mới, fields, resource, action và permissions đã được hỗ trợ.
2. Chọn các block và selection trong workspace.
3. Đăng ký manifest bằng catalog server. Shell không thay đổi.

Có thể thay ID ứng dụng mà panel vẫn hoạt động, vì chọn bằng renderer trong cấu hình, không chọn theo appId. Một app chỉ Form/List không cần viết view riêng.

### Trường hợp có API hoặc kiểu màn hình mới

1. Thống nhất hợp đồng dữ liệu/policy/backend với người phụ trách API.
2. Extension tin cậy đăng ký resource/action/reference vào latticeContracts cho server và client. Resource/action không đăng ký vẫn bị chặn.
3. Bridge/backend cần có endpoint/operation tương ứng; đăng ký phía UI không mở thêm quyền hoặc endpoint server.
4. Nếu cần panel đặc thù, extension đăng ký bằng app.latticeRuntime.registerView(name, Component), manifest tham chiếu tên đó.
5. Đăng ký manifest qua app.latticeApplications.register(manifest) ở server sau khi Foundation đã load; dependency/load order của plugin mới phải được khai báo phù hợp cơ chế NocoBase.

Không phải viết lại Workspace/Form/List. Logic riêng và kiểu component chưa có vẫn cần phát triển extension. Đây chưa phải lời hứa mọi nghiệp vụ đều dựng được bằng zero-code.

## Contract registry

- Resource: adapter request đã được dev đăng ký, không lấy URL trực tiếp từ manifest. API client phân trang qua adapter; vẫn giữ kiểm tra page/items.
- Action: resource, version, role, fields/required/maxLength/type/pattern/reference, length mode theo API; transport catalog hoặc command.
- Command: operation và endpoint đã đăng ký; body/key giữ nguyên khi retry. Definition ID trả về có thể được kiểm trong contract.
- Reference: nguồn, query, value/label và kiểu select/suggestion đã đăng ký. Form không biết warehousePeople hay logistics:warehouse; đó là nội dung contract mẫu.
- Attachment: phase before/after và field nhận ID trong contract. Form không gán attachmentId chỉ vì tên app là Logistics.

NocoBase auth/PKCE/file operations là dịch vụ nền chung. Các convenience methods logistics/workflow chuyển tới applications/api.js; bridge của Duy giữ whitelist và policy cũ. Không sửa backend của Duy trong lượt này.

## Giới hạn còn giữ nguyên

- Catalog hiện vẫn đăng ký manifest mẫu bằng code; chưa có publish/unpublish UI/App Registry bền vững.
- Chưa có Inbox tổng hợp, SSO, switch company hoặc phân quyền builder đầy đủ.
- Quyền trong manifest là gợi ý; backend vẫn authoritative.
- Panel nghiệp vụ mẫu vẫn là code extension riêng. Chưa xây một workflow form designer tổng quát cho mọi service.
- Test app Hỗ trợ khách hàng dùng fake API contract để kiểm khả năng mở rộng; chưa có backend hỗ trợ khách hàng thật được triển khai.
- Backend directory/scoped assignment, trạng thái và semantics Order giữ nguyên: received là kho nhận việc, không phải Shipment/nhập hàng.

## Kiểm tra và triển khai

- Build kiểm syntax và tự bundle dependency graph nội bộ; không phải bổ sung branch trong build script cho từng lĩnh vực mới.
- Node tests kiểm các luồng cũ và app thứ ba: đăng ký view, render Form/List, selection/lock, schema mới, submit qua contract, catalog snapshot/duplicate và từ chối URL tùy ý.
- Các phép browser regression dùng scripts/smoke-lattice-logistics.cjs, smoke-lattice-procurement.cjs và smoke-lattice-builder-save.cjs trên runtime local.
- Trước cập nhật đã backup NocoBase/core PostgreSQL và plugin 0.8.0 ở output/backups/workspace-generic-20261014. Không xóa/reset volume hoặc thay core API image.
- Package mới output/latticedx-plugin-lattice-foundation-0.9.0.tgz; artifact/backup không commit.

Kết quả: 32 Node tests PASS, build/AMD loading PASS. Browser Logistics PASS với order b1114fd3-10d5-44ad-8acc-5afdeb2ba732 (received/v3), exact warehouse visibility, same-key retry và evidence bytes. Procurement PASS với run 620f0942-dac1-4a45-9c5c-b52d0b27c4f5 (handed_over/v6). Native builder PASS ở trang thử ẩn /admin/lt8796389e38, persisted/reload và originalPageUnchanged=true. Unit test app giả không chứng nhận backend nghiệp vụ thứ ba đã hoạt động.

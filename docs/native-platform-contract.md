# Hợp đồng native — NocoBase là nền tảng thực thi

Cập nhật 04/11/2026. Thay phần contract `latticeDocuments:*` trước đây. Các API legacy vẫn giữ tương thích; không dùng token Keycloak thay cho session native NocoBase.

## Dữ liệu và identity

| Native collection | Mục đích |
| --- | --- |
| latticeDepartments / latticeEmployees | Phòng ban, nhân viên, mapping `Employee.userId → users.id` |
| latticeLocations / latticeAssets | Địa điểm, tài sản và quan hệ phòng ban/người phụ trách |
| latticeRequests / latticeOrders | Hồ sơ nghiệp vụ; Orders có customer/origin/destination/quantity |
| latticeIncidentRules / latticeIncidentCases | Mô hình sự cố hiện hữu; chưa tự cutover flow legacy |

Collection manager, field/relationship metadata, CRUD, phân trang và lọc dùng native NocoBase. `code` còn unique toàn collection theo schema cũ. Một native User chỉ gắn một Employee (`userId` nullable/unique); chưa hỗ trợ một tài khoản thuộc nhiều organization.

`GET /api/latticeNative:context` trả chính mapping đã xác minh của session: `{data:{userId,employeeId,organizationId,departmentId}}`. User thiếu Employee active trả 403; không suy mapping từ email, prompt hay header organization. Root cấu hình không tự có membership doanh nghiệp.

HTTP guard chỉ bổ sung organization, identity và tham chiếu cùng tổ chức cho các collection trên. Hook `beforeValidate` gắn organization/người tạo sau native field whitelist; không mở các field đó cho người dùng nhập. Background workflow dùng principal/configuration riêng, không lấy organization từ prompt.

## Quyền cấu hình bằng native ACL

7 presets: `ldx_employee`, `ldx_manager`, `ldx_warehouse`, `ldx_dispatcher`, `ldx_driver`, `ldx_director`, `ldx_admin`.

- Mọi quyền resource, field và scope tài liệu là cấu hình native, quản trị được trong Role Permissions.
- Employee/Warehouse/Driver đọc tài liệu do mình tạo hoặc được giao, dùng scope `requester.userId / assignee.userId` với biến native currentUser.
- Manager/Dispatcher/Director/Admin đọc cùng organization (guard tổ chức luôn áp dụng).
- Director chỉ đọc. Các vai trò khác tạo hồ sơ và sửa nháp của mình theo native scope `status=draft + requester.userId=currentUser`.
- Các field status/version/requester/assignee/decisionReason/organization không thuộc whitelist người dùng; workflow hoặc server gắn các giá trị cần thiết.
- Business Admin không có quyền thiết kế host hoặc sửa identity mapping. Root quản trị mapping/roles bằng native UI.
- Migration chỉ chuyển preset cũ còn nguyên resource/action/field và chưa gán user. Role đã dùng/chỉnh được giữ, cần admin cutover có chủ đích; không reset quyền của thành viên.
- Các tùy chọn khác trên role cũ (kể cả quyền AI Employee do host đặt trước đó) được giữ nguyên. Preset mới mặc định không cho tạo AI Employee; quản trị kiểm lại tùy chọn này khi chuyển role cũ.

Generic update tài liệu giữ native ACL filter/whitelist và repository hooks; bổ sung row lock cùng transaction vì host 2.2.20 generic update chọn record rồi lưu theo PK. Đây là bảo vệ mutation, không phải workflow executor. Chưa hỗ trợ bulk update trên endpoint này.

## Quy trình dùng Workflow/Manual Tasks của host

Đã gỡ resource `latticeDocuments:submit/approve/reject/assign/complete`, executor và collection command receipt tự viết. Bảng receipt cũ trong database không bị drop/xóa dữ liệu. Không gọi lại API cũ.

Mẫu mới chỉ chứa cấu hình native: Collection Event → Query/Condition → Update → Manual review → Update quyết định → nhánh Reject/Continue → Query người thực hiện → Update giao việc → Manual work → Update hoàn thành.

- Manual Tasks của host sở hữu task, người nhận, xử lý đồng thời, trạng thái xử lý và resume.
- `workflows`, `flow_nodes`, `executions`, `jobs`, `workflowManualTasks` của host là nguồn dữ liệu cấu hình/lịch sử. Không có task store/scheduler/replay store mới trong plugin.
- Form manual là custom form native, chỉ thu quyết định; node Update dùng field được cấu hình rõ. Không dùng manual update form nhận mọi field từ client.
- Query native kiểm Employee active/cùng organization; reviewer phải có role Manager/Admin, không trùng người tạo. Kiểm lại mapping sau khi task được xử lý trước khi cập nhật dữ liệu nghiệp vụ.
- Mẫu dùng **Tạo và gửi**: collection-create trigger bắt đầu quy trình. Khi bật mẫu này, tạo record không phải thao tác chỉ lưu nháp. Nếu cần tách lưu nháp/gửi, cấu hình action trigger và UI native riêng; chưa tuyên bố luồng này đã có.
- Reviewer và assignee trong mẫu do quản trị chọn bằng Employee ID; quản trị có thể đổi sang biến/query trong designer. Chưa phải màn hình phân công động theo ca/kỹ năng.
- `version` là field tương thích dữ liệu cũ, không còn là revision CAS của engine riêng. Không suy guarantees command receipt cũ sang workflow native.

## Cấu hình mẫu thực tế

Root tạo native User, gán role và Employee active có userId/organizationId đúng. Sau đó chạy:

```powershell
node scripts/configure-native-process.mjs --collection=latticeRequests --organization=org-a --reviewer=12 --assignee=13
```

12/13 là Employee ID thực tế, không phải User ID hoặc Keycloak subject. Script tạo workflow mới **disabled**, in workflowId/key/nodeIds, không đè workflow khác. Mở Workflow Settings native để kiểm tra người xử lý, UI manual và các node rồi bật khi sẵn sàng. Chỉ bật một mẫu phù hợp trên một collection/organization để tránh nhiều workflow cùng xử lý một hồ sơ.

Mẫu có schema form dùng đúng components native. UI hoàn chỉnh có thể thêm Details block của trigger và Workflow To-do block ngay trong NocoBase; không viết trang task mới bên ngoài để thay chúng.

## Handoff

**Hưng:** dựng form/table/detail/relationship/menu bằng native UI; task dùng Workflow To-do và form của Manual node. Không gọi `dxActions` cho generic CRUD native hay dùng renderer manifest cũ cho app mới. Business permissions lấy từ native ACL. Các read association/appends chưa kiểm chứng vẫn bị hạn chế bởi guard hiện tại; cần kiểm riêng trước khi bật.

**Chị Nhi:** chỉnh/nhân bản workflow trong designer; dùng query/update/condition/manual/request native trước khi thêm node code. Không dùng song song flow legacy và native để quyết định cùng hồ sơ. Connector broker/n8n hoặc agent chỉ thêm ở bước có nhu cầu; không tự đổi worker/flow hiện hữu trong đợt này.

## Kiểm chứng và giới hạn

- `node scripts/acceptance-native-foundation.mjs`: native auth/mapping/org guard.
- `node scripts/acceptance-native-documents.mjs`: tạo workflow qua native API, thực thi Request/Order bằng collection trigger + manual task; kiểm dữ liệu, ACL, task sai người/lặp, reject/self-review/revocation, execution/jobs. Fixtures được dọn trong finally.
- Evidence mới: `output/native-platform/native-workflow-acceptance.json`. `document-acceptance.json` cũ là evidence của implementation đã bỏ, không dùng để nghiệm thu kiến trúc mới.
- API acceptance không thay browser E2E. Native form/table/menu và UI của Hưng cần nghiệm thu theo từng luồng.
- Đã bổ sung **một luồng browser native riêng trong Native UI Lab** (xem `docs/native-ui-lab-guide.md`): employee tạo → manager duyệt → worker hoàn thành; native Details block và từ chối cũng được thử. Điều này chưa nghiệm thu UI/renderer legacy của Hưng hoặc mọi module.
- Runtime đã nâng và khóa NocoBase 2.2.38; dependency checker không còn mismatch trong phạm vi inventory đã quét, không downgrade axios hoặc tắt checker. Metadata provisioning bảo toàn existing metadata, chưa reconcile mọi collision/field incompatible.
- Không thay upstream/license của NocoBase; file Lattice mới giữ SPDX của nhóm. Không tick toàn giai đoạn trên Notion chỉ dựa vào API tests.

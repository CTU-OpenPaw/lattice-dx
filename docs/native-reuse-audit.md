# Rà soát phần tự viết và phần nên giao cho NocoBase

Ngày 04/11/2026. Mục tiêu: app mới được xây, quản trị và thực thi từ NocoBase. Legacy chưa được coi là đã di chuyển chỉ vì có plugin/native metadata.

| Năng lực | Trạng thái và quyết định |
| --- | --- |
| Collections / fields / relations | Giữ mô hình domain trong foundation; native Collection Manager quản lý metadata. Không tạo schema engine khác cho app mới. |
| CRUD / filter / pagination | Native API/repository; không bọc mỗi CRUD qua Fastify hoặc dxActions. |
| Roles / field permissions / data scopes | Đã chuyển phần native mới sang cấu hình ACL/scopes. Guard chỉ bổ sung identity/org/ref và atomic mutation cần thiết. |
| Submit / approve / assign / complete | Đã bỏ executor/API riêng mới. Workflow mẫu dùng native query/condition/update/manual/end. |
| Task inbox / concurrent submission / execution history | Dùng workflowManualTasks + executions/jobs của host; đã kiểm API thật cho Request/Order. |
| Native builder / pages / runtime blocks | Chưa hoàn tất cutover UI. Client native-designer/native-publish và renderer manifest cũ đang cùng tồn tại; app mới phải ưu tiên native UI/schema. Phần này cần phối hợp Hưng, không tự xóa UI đang dùng. |
| Native workflow connector cũ | Server native-workflow có instruction nối action legacy, chưa đăng ký trong foundation entrypoint. Giữ như tích hợp legacy; không dùng thay các node CRUD/native có sẵn. |
| Fastify application/schema/records/workflow/task services | Giữ tương thích luồng cũ; không mở rộng chúng thành backend song song cho app native mới. Cần di chuyển từng domain/caller rồi mới loại bỏ. |
| Agent / AI Employees | Ưu tiên chat/tools/workflow native. Worker ngoài giữ cho tác vụ dài/chuyên biệt; chưa tự cutover code của Nhi. |
| n8n | Connector ngoài qua HTTP/webhook, không trở thành kho workflow/approval thứ hai cho cùng quy trình. |
| NGSI-LD | Giữ cho context chia sẻ giữa hệ thống/hiện trường; dữ liệu giao dịch native không chuyển hết vào broker. |
| Files / comments / notification / charts | Ưu tiên plugin/blocks native tương ứng khi dựng UI. Không tự viết lại trước khi xác minh thiếu chức năng. |

## Thứ tự tích hợp còn lại

1. Hưng dựng một page native có form/table/detail và Workflow To-do; dùng cùng collections/ACL. Kiểm bằng browser với tài khoản nghiệp vụ.
2. Nhi cấu hình/cải tiến native workflow theo nhu cầu thật. Node mở rộng chỉ dành cho broker/n8n/agent hoặc luật domain không thể cấu hình.
3. Duy giữ mapping/org integrity, native API contract và kiểm chứng; xử lý dependency runtime riêng. Chỉ bổ sung code khi đã chỉ rõ khoảng trống của host.
4. Khi luồng native đã chạy xuyên UI, lập danh sách caller legacy để rút từng adapter/renderer/service. Không big-bang xóa các luồng cũ đang dùng.

Phần native backend đã được chỉnh; chưa tuyên bố toàn bộ repository trở thành NocoBase-only hoặc việc chỉnh block native đã tự cập nhật mọi trang Lattice cũ.

Nguồn: [Manual Tasks](https://nocode.docs.nocobase.com/workflow/nodes/manual), [Collection Event](https://nocode.docs.nocobase.com/workflow/triggers/collection), [ACL](https://nocode.docs.nocobase.com/plugin-development/server/acl), và source đúng bản host 2.2.20 cài local.

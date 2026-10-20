# UC1: bàn giao tài sản qua n8n và NGSI-LD

Đã chạy thực tế ngày 21/10/2026: tạo yêu cầu mua sắm → gửi → duyệt → nhận hàng → nghiệm thu → bàn giao → outbox tự gửi → n8n → adapter → Orion-LD → notification quay về kho ngữ cảnh engine. Không gọi model trong phép thử này.

## Phân chia trách nhiệm

- Backend kiểm quyền nghiệp vụ và ghi `asset.handed_over` trong cùng giao dịch với bàn giao.
- Worker dùng claim/lease/retry hiện có. Bộ lọc chọn loại sự kiện, đơn vị và mốc tạo; không thay đổi hành vi mặc định của các deployment chưa đặt bộ lọc.
- n8n xác thực webhook, chuyển nguyên envelope/idempotency key tới adapter và trả đúng kết quả. Không retry POST ngầm, không trả thành công trước khi adapter hoàn tất.
- Adapter nội bộ `POST /v1/integrations/asset-handovers` dùng credential riêng; không phải API frontend. Chỉ chấp nhận bản sao canonical của sự kiện thực trong outbox. Nó khóa theo Asset và khóa chia sẻ workflow để phối hợp với hủy workflow; kiểm tenant, Department/Location; ghi broker, đọc lại rồi mới lưu receipt PostgreSQL.
- Broker giữ Asset và các quan hệ. `status=in_use`, `sourceEventId=eventId`, phòng ban/vị trí ánh xạ từ event. Những thuộc tính Asset khác được giữ nguyên. Notification cập nhật kho ngữ cảnh hiện có của engine.

Receipt thể hiện một lần đồng bộ đã hoàn tất, không phải trạng thái hiện tại của Asset mãi mãi. Replay receipt không ghi lại broker, kể cả khi sau đó workflow bị hủy. Hủy workflow không phải thao tác thu hồi thay đổi đã gửi ra bên ngoài.

## Thiết lập local

Yêu cầu core, NocoBase, n8n, Orion-LD và subscription/context receiver hiện có đã hoạt động. Các tài khoản/danh mục demo đã seed. Giữ `.env.integration` ở máy local, không commit.

```powershell
node scripts/configure-uc1-handover-local.mjs --install-n8n
node scripts/seed-uc1-broker-local.mjs
```

Script đầu giữ/tạo hai credential khác nhau, chỉ import/publish workflow có ID dành riêng `LatticeUC1AssetHandover`, rồi restart n8n. Nó không sửa workflow intake của Nhi hoặc workflow khác. File JSON trong Git inactive, không có credential ID/token/pinned data. File credential tạm trong container được xóa sau import.

Script seed chỉ thêm hai tham chiếu demo còn thiếu: `Department:org-a:warehouse`, `Location:org-a:office-1`; gặp dữ liệu khác hợp đồng thì dừng. Receiver không tự tạo danh mục trong luồng nghiệp vụ.

Muốn bật tự động cho các bàn giao mới của demo org-a:

```powershell
node scripts/configure-uc1-handover-local.mjs --enable-auto
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/core.yml up -d --build api
pnpm test:uc1-auto
```

Lệnh cấu hình sao lưu env cũ trong thư mục Git-ignore `output/backups/`, đặt đích webhook và ba bộ lọc cùng nhau:

```dotenv
WORKFLOW_OUTBOX_WORKER=true
WORKFLOW_OUTBOX_EVENT_TYPE=asset.handed_over
WORKFLOW_OUTBOX_ORGANIZATION_ID=org-a
WORKFLOW_OUTBOX_CREATED_AFTER=<UTC ISO timestamp generated at setup>
```

Chạy lại giữ nguyên cutoff. Đổi cutoff hoặc bỏ lọc phải rà soát lại backlog trước. Script không tự nhận xử lý backlog cũ. Không dùng lệnh Compose thiếu `--env-file` để recreate API. Tắt tự động bằng `WORKFLOW_OUTBOX_WORKER=false` trong env rồi recreate riêng API; dữ liệu và receipts được giữ lại.

Trong máy hiện tại, bộ lọc đang bắt đầu từ `2026-10-20T17:15:31.264Z` (00:15:31 ngày 21/10 giờ Việt Nam). Các sự kiện trước đó, loại khác và đơn vị khác không bị worker này claim.

## Kiểm tra và bằng chứng

- `pnpm test:uc1-database`: PostgreSQL thật, schema tạm; concurrency, binding payload gốc, rollback/retry, ordering, reconnect, replay sau hủy, và chọn đúng event/type/đơn vị/cutoff. Downstream trong suite này được mô phỏng.
- `pnpm test:uc1-auto`: tạo procurement mới qua API xác thực, tệp quét thật, đủ các bước nghiệp vụ; đợi worker tự xử lý và xác nhận backlog cũ không đổi. Sau đó kiểm replay, sửa payload 409, sai credential 403, thiếu key 400, broker read-back và context projection.
- `node scripts/smoke-uc1-handover.mjs output/uc1-handoff/<eventId>.json`: chỉ dispatch một event pending được chọn, hoặc kiểm lại receipt đã thành công; không bật worker toàn hàng đợi. Sự kiện thuộc scope auto có thể được worker xử lý trước, nên dùng `test:uc1-auto` khi bật tự động.
- `pnpm test:workflows` là suite producer/manual-retry cũ, giả định worker đang tắt và tự thay trạng thái job fixture. Khi auto worker đang bật, dùng suite UC1 mới; không chạy song song hai suite này trên cùng database. Giữ suite cũ cho môi trường worker-off.

Bằng chứng đầy đủ gần nhất: workflow `fbb8ee0d-48bc-42d4-9732-866daaf826a8`, event `cd3c501f-6fea-4f54-8b85-bcc9d90e825b`, Asset `urn:ngsi-ld:Asset:org-a:68f80f6f-735f-40cc-b854-bd55b7d1d56b`. Worker thành công sau một attempt; receipt và context có thật. Đã restart broker với nguyên volume rồi đọc lại Asset và replay thành công.

Artifacts nằm trong `output/uc1-handoff/` và `output/uc1-e2e/`, không chứa token. Đây là dữ liệu demo, được giữ ở local và không commit.

## Ranh giới nghiệm thu

Luồng backend/tích hợp tự động đã đạt. Đã đăng nhập SSO trên UI và mở đúng workflow `fbb8ee0d-48bc-42d4-9732-866daaf826a8`: handed_over, version 6, đủ sáu mục lịch sử. Đây là kiểm tra đọc; chưa gọi là nghiệm thu toàn bộ thao tác nghiệp vụ trên UI.

Màn hình của Hưng vẫn cần hiển thị `GET /v1/workflows/:id/sync` theo quyền người dùng và trạng thái ngữ cảnh tương ứng, đồng thời thay dòng cũ “gửi sự kiện ngoài chưa bật” bằng thông tin phù hợp cấu hình thực tế. Credential adapter/broker không được đưa vào browser. Không thay code UI hoặc nhánh của Hưng/Nhi trong thay đổi này.

Orion 1.10 cần tên trường rút gọn và application `@context` để phát notification đúng. Adapter dùng chung file context hiện có, không cập nhật subscription bằng inline context. Timestamp trên broker dùng giây tròn; timestamp gốc vẫn ở event/receipt. Hai quan sát khác nhau trong cùng giây hoặc quan sát mới hơn bị conflict để tránh ghi đè mù.

Không có transaction phân tán giữa PostgreSQL và broker: nếu broker đã ghi nhưng response/commit bị mất, retry cùng event đọc `sourceEventId` để hoàn tất receipt. Writer bên ngoài không dùng khóa SQL này; cần thống nhất quyền sở hữu các trường trước khi thêm writer khác. Lỗi cập nhật một phần, thiếu tham chiếu hoặc read-back không khớp không được acknowledge. Read-back xác nhận broker tại thời điểm giao nhận; projection và UI là các bước đọc riêng.

# Bàn giao backend UC1 — 19/10/2026

Phạm vi: producer của Duy, chuẩn bị cho connector n8n/NGSI-LD của Nhi. Không phải
nghiệm thu toàn UC1. Backend, broker receiver và UI đã có; đường bàn giao → broker
vẫn cần nối và kiểm cùng nhau. Không tự bật outbox worker trên backlog hiện có.

## Chạy và lấy payload thật

```powershell
pnpm docker:start
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/core.yml up -d
docker --context desktop-linux compose -f infra/compose/nocobase.yml up -d
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml up -d
pnpm test:workflows
```

Yêu cầu cấu hình local và các demo identity/directory đã seed, ClamAV healthy.
Không dùng `--remove-orphans` hoặc `down -v` giữa ba file Compose dùng chung project.
`pnpm test:workflows` tạo dữ liệu demo mới và giữ lại. Chạy tuần tự với các smoke dùng
gateway để không vượt giới hạn tốc độ. Cuối phép thử thành công, đường dẫn
`output/uc1-handoff/<eventId>.json` được in ra. File có:

- `event`: payload thực sự đọc từ outbox, đã đối chiếu toàn bộ với API workflow và
  audit của bước bàn giao; **chỉ object này là HTTP body gửi sang receiver**.
- `workflow` và `audit`: bằng chứng trạng thái `handed_over`, phiên bản 6 và thời điểm.
- `formatVersion: 1`: phiên bản file bằng chứng, không phải revision workflow.

Không có token, URL chứa credential hoặc nội dung tệp trong artifact. Đây vẫn là dữ
liệu nghiệp vụ demo; file được Git ignore. Không dùng script này để xuất dữ liệu thật.
Script không gửi event này tới broker: nó kiểm sender/lease/retry bằng queue sao chép
trong schema riêng và receiver kiểm soát. Public backlog được đối chiếu trước/sau.

## Hợp đồng producer hiện có

`POST <WORKFLOW_EVENT_URL>` gửi JSON với:

```http
Content-Type: application/json
Authorization: Bearer <WORKFLOW_EVENT_TOKEN>
Idempotency-Key: <event.eventId>
```

| Trường | Ý nghĩa/nguồn |
| --- | --- |
| `eventId` | UUID bất biến của sự kiện, cũng là idempotency key khi gửi lại. |
| `eventType` | `asset.handed_over` cho bước bàn giao procurement v1. |
| `organizationId` | Đơn vị từ identity đã xác thực khi chuyển trạng thái. Receiver vẫn phải kiểm nguồn và tenant được cấp. |
| `runId`, `recordId` | UUID workflow/hồ sơ; bằng nhau trong procurement hiện tại. Không phải Asset ID. |
| `definitionId` | `procurement`. Đây là ID định nghĩa, không phải schema Asset. |
| `version` | Revision của run sau chuyển trạng thái, hiện là 6 cho luồng chuẩn. Không phải schema version/event format version. |
| `occurredAt` | Thời điểm backend ghi chuyển trạng thái, trùng audit. Không tự coi là thời điểm cảm biến quan sát. |
| `data` | Snapshot dữ liệu run sau bàn giao; có cả dữ liệu từ các bước trước. |

`data` chứa `assetId`, `recipientId`, `departmentId`, `locationId`, `attachmentId`,
`receiptAttachmentId`, `acceptanceNote`. Không được suy ra tên tài sản hoặc số serial
từ UUID hồ sơ. Producer hiện không cung cấp tên/serial trong event này; receiver cần
mapping/config hoặc nguồn được cấp quyền nếu broker yêu cầu các thuộc tính đó.

## ID và ranh giới mapping

- Fixture mới dùng `urn:ngsi-ld:Asset:org-a:<uuid>` để tương thích connector Asset
  hiện tại. `assetId` của API tổng quát vẫn là text; dữ liệu cũ có thể dùng mã khác.
  Không tự thêm prefix vào một URN đã đầy đủ hoặc đổi ID cũ để làm phép thử đạt.
- Với luồng chuẩn mới, giữ nguyên URN. Với mã cũ, Nhi cần mapping ổn định và kiểm
  đơn vị; không âm thầm sửa ký tự hoặc chuyển sang tenant mặc định.
- `recipientId` là subject tài khoản nghiệp vụ; không phải Employee row ID. Department
  và Location là mã danh mục có phạm vi đơn vị. Ví dụ `warehouse` và `office-1` chỉ
  áp dụng fixture org-a, không hard-code cho mọi doanh nghiệp.
- `Asset.status` của broker dùng `ready/in_use/repair/retired`. Event bàn giao không
  tự định nghĩa giá trị status. Connector cần quy tắc mapping rõ; không biến
  `handed_over` thành enum broker. Dữ liệu cảm biến mới hơn không được ghi đè bởi replay.
- Asset URN khác UUID enterprise entity mà UC2 sử dụng. Tạo/mapping một enterprise
  entity đúng schema `incident-asset`, quyền và serial là bước tích hợp riêng; liên
  kết ngữ cảnh qua `PUT /v1/entities/:id/context-links/ngsi-ld` với
  `{externalId:<URN>,expectedRevision:0}`, idempotency key và quyền của actor.
  Đọc `docs/incident-agent-runtime.md` trước khi nối UC2. UC1 handover không tự tạo
  entity, mapping hay cấp quyền đọc nó.

## Receiver, acknowledge và retry

Receiver phải kiểm token, loại event, tenant được cho phép, các ID/trường và quan hệ
trước khi gọi broker. Không dùng tenant tự khai thay cho xác thực. Đường outbox này
dùng Bearer token, **khác** webhook tạo đơn đang dùng `X-Lattice-Webhook-Token`.

Sender có timeout 10 giây, không theo redirect và coi HTTP 2xx là nhận thành công.
Vì vậy n8n không được trả 200 mặc định trước khi có kết quả:

- Đồng bộ trực tiếp: chỉ trả 2xx sau khi broker thao tác thành công và read-back đạt;
  HTTP 207 hoặc lỗi một phần không coi là hoàn tất.
- Nếu nhận bất đồng bộ: chỉ acknowledge sau khi lưu bền vững, có trạng thái/retry
  riêng. Khi đó outbox `succeeded` chỉ có nghĩa đã nhận, chưa có nghĩa Asset đồng bộ.
- Khử lặp bền vững theo tenant + eventId và phát hiện cùng ID khác nội dung. Broker
  upsert cùng URN ngăn tạo Asset thứ hai nhưng không thay thế ordering/idempotency.
- Sender có thể gửi lại sau khi receiver đã làm xong mà response bị mất. Giữ nguyên
  eventId và body. Đừng dùng một idempotency key mới cho từng attempt.

Backend tối đa 5 attempt với backoff 5–300 giây, lease 60 giây và fencing. Sai token,
payload hoặc lỗi broker không được trả 2xx để che lỗi. Backend lưu lỗi sender chung,
không lưu raw error chứa secret. Receiver lưu trace an toàn để phân biệt nguyên nhân.

Chỉ sau khi receiver sẵn sàng và backlog đã được nhóm rà soát, cấu hình đủ
`WORKFLOW_EVENT_URL`, `WORKFLOW_EVENT_TOKEN`, **`WORKFLOW_OUTBOX_WORKER=true`** rồi
recreate API bằng `.env.integration`. Chỉ đặt URL/token không tự bật worker.
Không thực hiện bước bật này trong đợt kiểm chứng 19/10.

## API cho Hưng/Nhi theo dõi

- `GET /v1/workflows/:id/sync`: danh sách job với status/attempts/lastError, cần
  quyền đọc run trong đơn vị; không yêu cầu riêng `workflow:sync`. Status bao gồm pending/processing/succeeded/
  failed/cancelled; không lấy trạng thái workflow làm trạng thái broker.
- `POST /v1/workflows/:id/sync/retry`, body `{}`, idempotency key, quyền đọc run và
  role `workflow:sync`: reset các job failed
  được phép. Không dùng để reset toàn backlog hoặc ghi lại bước bàn giao.
- API trả 401 nếu token không hợp lệ, 403 nếu thiếu role, 404 nếu run không nhìn
  thấy và 409 nếu key bị dùng với payload khác. UI không gửi service token vào trình duyệt.

## Kết quả 19/10 và phần còn lại

- Procurement REST/PostgreSQL: PASS; workflow → audit → payload đối chiếu đúng.
- Worker trên queue riêng: lỗi HTTP 503 rồi thành công, cùng eventId, hai lần gửi và
  một lần xử lý hữu hiệu; concurrent claim, lease fencing và retry có kiểm tra.
- Shared integration signed HTTP: PASS; quyền workflow và entity tách biệt, grant/
  revoke, tenant, replay và stale version được kiểm tra.
- Orion thật → gateway → receiver → PostgreSQL: PASS tạo/cập nhật Asset, dữ liệu
  mới/cũ/trùng và lỗi nguồn. Đây là fixture subscription riêng, không phải Asset từ
  bàn giao vừa tạo. Quyền/token lỗi được thử trực tiếp tại receiver.
- Backend UC2: `pnpm test:incident-agent` PASS signed HTTP/PostgreSQL trong schema
  riêng; lifecycle, quyền, retry/lease, rollback và lịch sử 102 job. Worker mô phỏng,
  không gọi 9router hoặc model thật. `pnpm check` PASS 609 test/112 file, typecheck
  và production build.
- Chưa kiểm chứng: n8n bàn giao → broker, token tự động, mapping Asset → UC2 entity,
  rule executor và model thật. Các phần đó vẫn thuộc tích hợp của Nhi/nhóm.

Mốc producer: run `cc395ba7-3b5b-4ab5-a166-f7ca351274ad`, event
`0645923b-cc7d-4392-9c55-1a4c68ed00fa`. Mốc subscription riêng:
`urn:ngsi-ld:Asset:org-a:subscription-178ee1da-827b-4530-9a9c-fb7b671aef61`.
Không tick Notion và không đánh dấu UC1 hoàn thành từ các kết quả riêng lẻ này.

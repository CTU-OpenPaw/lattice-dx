# UC1 — tích hợp n8n, bàn giao và Asset

Base: snapshot main `b13109cadb10b013d4c18b8c49a41187b1242909` (18/10/2026).
Đây là implementation để nghiệm thu trên local, chưa phải bằng chứng end-to-end đã chạy trên máy Nhi.
Không sửa workflow `procurement` v1, receiver Asset.status, API phân quyền hoặc outbox của Duy.

## Luồng và contract

- Intake: nguồn mẫu → webhook n8n có Header Auth → kiểm schema → integration service → `POST /v1/workflows`.
- Handover: backend outbox `asset.handed_over` → webhook n8n có Header Auth → durable inbox → worker → broker và hệ thống mẫu.
- `202` chỉ có nghĩa đã lưu event PostgreSQL, không phải Asset đã đồng bộ. Backend outbox có thể `succeeded` trong khi inbox riêng còn `pending`/`failed`; phải kiểm tra cả hai.
- Service mới: `apps/uc1-integration`, port local 4100, PostgreSQL schema `uc1_integration` trong DB local hiện có. Không tạo endpoint công khai trên Gateway hoặc cấp thêm quyền cho nhân viên.
- Hệ thống mẫu là endpoint `/sample/handovers`, dùng token riêng và lưu bảng `sample_handovers`. Nó mô phỏng hệ thống ngoài; không phải tích hợp với nhà cung cấp thật.

### Intake

POST webhook `/webhook/latticedx/uc1/orders`, header `Authorization: Bearer <UC1_WEBHOOK_TOKEN>` và `Idempotency-Key` (1–128 ký tự `[A-Za-z0-9._:-]`).

```json
{
  "title": "Yêu cầu mua laptop phòng IT",
  "sourceSystem": "sample-orders",
  "sourceRecordId": "purchase-2026-001",
  "order": {
    "itemName": "Laptop",
    "quantity": 1,
    "supplierName": "Nhà cung cấp mẫu",
    "requestedDepartmentId": "it",
    "requestedLocationId": "office-1"
  }
}
```

`title`, `sourceSystem`, `sourceRecordId` bắt buộc. `order` tùy chọn, chỉ nhận các trường trên; quantity nếu có là số nguyên 1–1000000. Từ chối trường ngoài schema, owner/tenant override. Không nhận URL hoặc token trong body.

API procurement hiện chỉ nhận `{definitionId:"procurement",title,input:{}}`; metadata đơn nguồn được giữ tại `uc1_integration.intakes`, không giả làm trường nghiệp vụ đã được backend hỗ trợ. Department/Location trong yêu cầu ban đầu là metadata yêu cầu, không tự trở thành tham chiếu bàn giao có thẩm quyền.

Scope lấy từ cấu hình service và JWT upstream đã được API xác thực qua `/v1/me/capabilities`. Actor được pin vào receipt; thay actor khi retry bị từ chối. Mỗi retry vẫn đi qua API để kiểm quyền hiện tại. SourceSystem là nhãn do nguồn khai báo, không phải cơ chế xác thực nguồn.

Key backend được băm từ organization + sourceSystem + sourceRecordId. Cùng source/key/payload trả cùng hồ sơ; sourceRecordId giống nhau nhưng gửi key mới cũng không tạo thêm hồ sơ. Cùng key/source record nhưng payload khác trả 409. Khi nguồn thật sửa đơn đã nhận, cần contract cập nhật riêng, không đổi key để tạo lại.

Token API là credential local ngắn hạn, không được export vào workflow hay log. Chưa có OAuth client/service identity production hoặc tự động refresh. Khi hết hạn: làm mới credential, recreate service, gửi lại cùng key và payload; không xóa receipt.

### Event bàn giao

Nhận đúng envelope đã có trong `WorkflowEvent`: eventId, eventType, organizationId, runId, recordId, definitionId, version, occurredAt, data. eventType phải `asset.handed_over`, definitionId phải `procurement`, recordId=runId. Idempotency-Key phải bằng eventId. Mọi identity/timestamp/tham chiếu bắt buộc được kiểm trước khi ghi inbox. Backend vẫn là nơi kiểm quyền bàn giao và sự tồn tại tham chiếu nghiệp vụ.

| Đầu vào | NGSI-LD |
| --- | --- |
| organizationId + data.assetId | `urn:ngsi-ld:Asset:<org>:<businessId>` |
| data.departmentId | `belongsToDepartment` → `urn:ngsi-ld:Department:<org>:<id>` |
| data.locationId | `locatedAt` → `urn:ngsi-ld:Location:<org>:<id>` |
| event bàn giao hợp lệ | `status=in_use` |
| eventId | `sourceEventId` |
| occurredAt | nguồn tạo observedAt; giữ nguyên timestamp chính xác trong inbox |

ID có thể là business ID `[A-Za-z0-9_-]{1,128}` hoặc đầy đủ URN đúng type/org; không ghép thêm URN nếu đã có. ID engine UUID không tự đồng nhất với business ID; API context-links hiện có là nơi gắn mapping UUID ↔ URN khi có entity tương ứng. Implementation này không tự tạo liên kết tới một engine UUID suy đoán từ assetId.

Vì broker 1.10.0 đã từng bỏ phần mili giây, mapper chủ động xuất observedAt theo giây tròn. Exact occurredAt và run version vẫn lưu nguyên trong inbox/trace. Không tuyên bố bảo toàn mili giây trên broker. Trường hợp quan sát broker cùng giây từ event khác bị giữ lại với conflict để đối chiếu, không ghi đè mù.

Trước khi ghi Asset, connector đọc Department/Location và kiểm type, businessId, organizationId. Thiếu hoặc sai tham chiếu → failed với mã lỗi, không tự tạo kho/phòng/vị trí tùy ý.

Asset chưa có: create đúng URN; create 409 do race → đọc lại. Asset đã có: chỉ patch status, Department, Location và sourceEventId, giữ tên/thuộc tính khác. Event cùng sourceEventId và cùng giá trị là replay. Quan sát mới hơn từ nguồn khác bị từ chối ghi đè.

Các job handover cùng Asset được serialize bằng advisory lock trong PostgreSQL. Watermark dùng occurredAt gốc: event cũ bị `ignored`, cùng timestamp/event khác trả conflict. Không có giao dịch phân tán với broker: nếu HTTP timeout sau khi broker ghi, retry đọc sourceEventId để phục hồi; sample sink khử lặp theo eventId. Các writer broker khác không chia sẻ lock này, vì vậy phải chốt quyền sở hữu trường cập nhật trước khi dùng nhiều nguồn thực.

## Cài local

Chạy trên nhánh `feat/uc1-n8n-handover`, sau khi áp dụng patch và check. Giữ backup PostgreSQL và MongoDB đã có. Không restore patch merge cũ lên nhánh này.

```powershell
node .\scripts\configure-uc1-local.mjs
node .\scripts\configure-uc1-api-local.mjs
```

Script thứ hai chỉ lấy JWT fixture local qua Keycloak localhost bằng alice (hoặc env UC1_LOCAL_USERNAME/UC1_LOCAL_PASSWORD), không thay role/password. Nó chỉ sửa UC1_API_TOKEN trong `.env.integration`, không in JWT. `sync-local-realm.mjs` và `sync-local-directory.mjs` cần đã hoàn thành theo hướng dẫn demo.

```powershell
docker compose --env-file .env.integration -f infra/compose/core.yml -f infra/compose/uc1.yml config --quiet
docker compose --env-file .env.integration -f infra/compose/core.yml -f infra/compose/uc1.yml up -d --build uc1-integration
docker compose --env-file .env.integration -f infra/compose/core.yml -f infra/compose/uc1.yml ps uc1-integration
```

Worker mặc định tắt; intake và ghi inbox vẫn chạy được khi broker lỗi. Không mount `.env.integration` vào image, không share output `compose config` có giá trị secret. Image chỉ copy source integration và connector/context cần thiết.

Sau khi làm mới JWT, nạp lại bằng:

```powershell
docker compose --env-file .env.integration -f infra/compose/core.yml -f infra/compose/uc1.yml up -d --no-deps --force-recreate uc1-integration
```

### Import n8n

Import hai JSON bằng UI n8n:

- `infra/config/n8n/uc1-intake.json`
- `infra/config/n8n/uc1-handover.json`

Cả hai export inactive, không có secret, pinData, project/email hay credential ID cục bộ. Tạo/chọn Header Auth credential tại từng node theo tên tham chiếu:

| Credential | Header name | Header value chỉ nhập trong credential UI |
| --- | --- | --- |
| LatticeDX UC1 Intake Webhook | Authorization | Bearer + một dấu cách + UC1_WEBHOOK_TOKEN |
| LatticeDX UC1 Handover Webhook | Authorization | Bearer + một dấu cách + UC1_HANDOVER_TOKEN |
| LatticeDX UC1 Integration Source | Authorization | Bearer + một dấu cách + UC1_SOURCE_TOKEN |

Lấy giá trị từ `.env.integration` trên máy bạn; không gửi token vào chat, Git hoặc workflow JSON. Credential Integration Source dùng ở HTTP node của cả hai workflow. Publish/activate từng workflow sau khi chọn credential. Production path dùng `/webhook/`, test canvas dùng `/webhook-test/` và chỉ nghe khi execute workflow.

n8n không auto retry POST. Lỗi transport/timeout/JSON trả 502 đã sanitize; HTTP thực từ service được chuyển tiếp. Intake có timeout 30 giây, handover 10 giây. Khi không biết kết quả, đọc trace và retry đúng payload/key, không tạo key mới để né lỗi.

### Test intake thật (chưa cần broker)

```powershell
node --env-file=.env.integration .\scripts\smoke-uc1-intake.mjs
```

Tạo và giữ một procurement draft; kiểm replay, sourceRecordId không tạo trùng khi đổi key, conflict, schema, auth và source trace. Test này gọi n8n/service/API thật; nó không tự approve/receive/hand over.

### PostgreSQL acceptance

```powershell
docker compose --env-file .env.integration -f infra/compose/core.yml -f infra/compose/uc1.yml exec -T uc1-integration node src/acceptance.mjs
```

Tạo database tạm tên `uc1_accept_<UUID>`, chạy production store trên PostgreSQL thật và xóa database đó trong finally. Không chạy worker hoặc thay public workflow_jobs. User local phải có CREATEDB. Kiểm concurrency/replay, source/payload conflict, claim, lease, retry, stale/equal time, sample sink, reopen repository và attempts tối đa 5. Downstream trong suite này là simulated; không phải broker acceptance.

### Demo handover thật qua n8n và broker

Chỉ thực hiện sau khi Orion-LD đã sửa lỗi restart và Department `it`/Location `office-1` đúng tenant đã có. Đặt `UC1_SYNC_WORKER=true` trong `.env.integration`, recreate riêng uc1-integration bằng lệnh trên.

```powershell
node --env-file=.env.integration .\scripts\smoke-uc1-handover.mjs --demo-event
```

Script gửi event có đánh dấu controlled fixture, tạo một Asset demo mới, kiểm duplicate/content conflict, inbox succeeded, đọc lại URN/status/quan hệ/sourceEventId từ Orion thật và source payload ở sample system. Giữ Asset/event làm bằng chứng. Đây không phải chứng minh backend đã handover hoặc worker outbox đã gửi event.

### Nối với outbox của Duy

Outbox đã POST envelope, Bearer token và Idempotency-Key=eventId. Khi nghiệm thu chung, cấu hình đích:

```dotenv
WORKFLOW_EVENT_URL=http://n8n:5678/webhook/latticedx/uc1/handovers
# WORKFLOW_EVENT_TOKEN phải khớp UC1_HANDOVER_TOKEN, đặt giá trị tại máy local.
```

Không tự bật WORKFLOW_OUTBOX_WORKER trên backlog đang dùng chung: worker backend hiện dispatch mọi event đủ điều kiện tới một URL, còn webhook này chỉ nhận procurement handover. Phải thống nhất với Duy cách route event khác hoặc dùng môi trường nghiệm thu riêng có backlog được kiểm tra trước khi bật. Không tạo một dispatcher SQL khác bỏ qua claim/lease/authority của backend.

Nghiệm thu end-to-end cuối cùng phải thực hiện một handover mới qua UI/API, kiểm backend job → n8n → inbox → broker + sample. Ghi eventId/runId/assetURN, rồi gửi lại cùng event để xác nhận không trùng. Backend job succeeded chỉ là durable delivery acknowledgement, inbox succeeded mới xác nhận cả hai đích đã phản hồi thành công.

## Đọc trạng thái và retry

Port 4100 chỉ bind loopback; các API dưới dành cho operator local, không forward token vào browser nhân viên. Authorization dùng UC1_ADMIN_TOKEN cho `/v1/uc1/*` reads/retry và UC1_SAMPLE_TOKEN cho sample reads.

- GET `/v1/uc1/intakes/<source-key>`: actor, source payload, backend key/result, receivedAt, state, lastError.
- GET `/v1/uc1/handover-events/<eventId>`: payload gốc, assetURN, state, attempts, lastError, result/trace và tối đa 100 attempt mới nhất.
- GET `/sample/handovers/<eventId>`: payload và receivedAt đã ghi ở hệ thống mẫu.
- POST `/v1/uc1/handover-events/<eventId>/retry`, body `{}`, Idempotency-Key mới cho quyết định retry: chỉ reset event failed; lặp cùng retry key trả receipt cũ, không reset ngân sách thêm lần nữa. Đổi event với key cũ trả 409.

Trạng thái inbox: pending → processing → succeeded, hoặc transient error → pending/backoff 5/10/20/40s rồi failed sau 5 lần. Lỗi schema/auth/reference/conflict dừng failed để người vận hành xử lý; stale event chuyển ignored. Lease 120 giây, token fencing, dừng graceful trước khi đóng pool. Retry giữ nguyên eventId/payload/URN; muốn sửa nguồn phải có event mới và quy tắc nghiệp vụ tương ứng.

Ví dụ PowerShell, không in token:

```powershell
@'
const id=process.env.UC1_EVENT_ID;
if(!id)throw Error("Set UC1_EVENT_ID to the failed event UUID");
const r=await fetch(`http://localhost:4100/v1/uc1/handover-events/${encodeURIComponent(id)}/retry`,{
 method:"POST",headers:{Authorization:`Bearer ${process.env.UC1_ADMIN_TOKEN}`,
 "Content-Type":"application/json","Idempotency-Key":`retry:${id}:decision-1`},body:"{}"
});
console.log("HTTP",r.status);console.log(await r.text());
'@ | node --env-file=.env.integration --input-type=module
```

Chưa có UI retry hay service identity production; không dùng admin/source token chung với token broker, sales hoặc người dùng. Cần TLS, role DB riêng và quản lý token phù hợp khi ra khỏi local.

## Giới hạn và tiêu chí hoàn thành

Code/unit tests không đóng sáu task end-to-end. Cần lưu output thật của intake, PostgreSQL acceptance và handover/outbox/broker restart trước khi đánh dấu hoàn thành. Unit tests chạy cả validator Code node bằng JavaScript thực, nhưng không chứng minh JSON import/publish thành công trên n8n instance.

Chưa xử lý crash khởi động Orion-LD 1.10.0 với dữ liệu backup cũ. Không xóa volume hoặc thay image để che lỗi. Regression bắt buộc sau khi sửa broker: đồng bộ handover → restart broker với nguyên volume → đọc lại Asset → gửi lại cùng event → vẫn một Asset và source trace đúng.

Không mở rộng Vehicle/Shipment/Warehouse, không đổi trạng thái nghiệp vụ, không tự sửa metadata đơn nguồn vào workflow schema v1, không đánh dấu model inference hay token refresh đã hoàn thành.

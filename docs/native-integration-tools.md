# Bàn giao backend native: ingress và proposal tools

06/11/2026 — Duy, foundation 0.25.1. Các endpoint dưới `/api/latticeIntegrations:*`; body JSON trực tiếp, response được NocoBase bọc `data`.

## Quyền và ranh giới

NocoBase xác thực bằng session hoặc API key native. Test hiện tại dùng session native thật; chưa tuyên bố đã nghiệm thu credential/API key của n8n. Connector dùng tài khoản dịch vụ riêng với role `ldx_connector` và Employee active có userId/organizationId. Không dùng root token làm connector/model credential. Quản trị viên cấu hình credential qua cơ chế API key của host, không tạo secret store/auth engine khác.

Role connector chỉ có view một số field của Asset; không có quyền trực tiếp tạo/sửa hồ sơ hoặc tự approve. Mỗi nguồn broker/n8n nên dùng một service user ổn định; thay key trên cùng user không đổi dedupe namespace. Đổi service user là đổi source identity.

Tools `record/context/proposals` yêu cầu native login + Employee active, rồi kiểm ACL dữ liệu/field của chính người gọi. `propose` còn cần snippet native **lattice.integrations.propose**. Migration thêm capability này vào sáu role nghiệp vụ có khả năng tác nghiệp, giữ nguyên quyền khác; không cấp cho director chỉ đọc hoặc connector. Role tùy chỉnh do admin cấp snippet trong Users & Permissions khi có nhu cầu.

Generic API của `latticeIntegrationInbox` và `latticeAgentProposals` chỉ cho root. Hưng không đưa token root vào block nhân viên. Workflow được admin cấu hình vẫn đọc/ghi các collection này bằng native repository/nodes; API agent không được dùng đường đó để vượt quyền.

## 1. Nhận sự kiện từ broker/n8n

`POST latticeIntegrations:receive` — role connector.

```json
{
  "eventId": "sensor-0001",
  "kind": "observation",
  "observedAt": "2026-11-06T09:00:00.000Z",
  "data": {"assetId": 12, "attribute": "temperature", "value": 39, "unit": "CEL"}
}
```

`assetId` là ID native thật và phải đọc được trong cùng tổ chức. Thời gian ví dụ phải thay bằng thời gian hiện tại khi thử. Observation quá 5 phút gắn `late=true`; quá 24 giờ hoặc tương lai trên 60 giây bị từ chối. Ingress không cập nhật nhiệt độ/status Asset, không đánh giá rule hoặc tự tạo incident; Nhi quyết định nhánh xử lý dữ liệu cũ trong workflow.

Các loại khác: `external-order`, `external-request`; data có code/name bắt buộc, description/customer/origin/destination tùy chọn; quantity nếu có phải dương. Đây là **inbox**, không tự tạo Order/Request thật trước khi workflow đã kiểm tra nghiệp vụ. Payload không nhận org/role/actor/status/action/URL. eventId bắt buộc là chuỗi ASCII tối đa 120 ký tự.

Response: `{id, accepted:true, duplicate:false}`. Cùng source user + organization + eventId và cùng nội dung trả lại cùng ID với duplicate=true. Đổi nội dung cùng eventId trả 409. Role và membership luôn kiểm lại trước nhận, kể cả replay.

Collection workflow trigger: **latticeIntegrationInbox → create**. Fields cho Nhi: id/eventId/organizationId/sourceUserId/sourceEmployeeId/kind/observedAt/late/data. Native transaction + advisory lock + unique receipt bảo đảm chỉ có một create event cho cạnh tranh cùng ID; không có task store hoặc workflow engine mới. Không cam kết exactly-once cho tác vụ bên ngoài mà workflow gọi sau đó.

## 2. Đọc record và context

`POST latticeIntegrations:record`:

```json
{"collection":"latticeOrders","recordId":12}
```

Allowlist: latticeAssets, latticeRequests, latticeOrders, latticeIncidentCases. Response: collection, recordId, **record đã lọc bằng native field/data ACL**, fingerprint SHA-256 của đúng dữ liệu đang được phép thấy. Tool gọi API host loopback cố định bằng phiên/role hiện tại; không dùng root repository để trả dữ liệu và không nhận query/SQL/URL tùy ý. Giới hạn main app local hiện tại; subapp trả 503 đến khi có routing được kiểm chứng.

`POST latticeIntegrations:context` dùng cùng body nhưng collection phải là latticeAssets. Asset cần đọc được trước; broker URL do deployment quyết định và tenant lấy từ membership đã xác minh. URN là namespace native của phần đồng bộ 05/11.

Context chỉ trả name/status khi native field đó được xem, cùng telemetry có allowlist temperature/humidity/batteryLevel/speed dưới dạng số. Telemetry được cấp cùng khả năng view Asset, không có quyền field riêng trong bản này. Có observedAt và cờ stale cho telemetry; phản hồi được giới hạn kích thước. Không trả toàn entity hoặc metadata tùy ý từ broker.

## 3. Lưu đề xuất có bằng chứng

### Nối inbox UC2 với n8n

Import `infra/config/n8n/uc2-observation-review.json` vào n8n 2.42.7 đã thiết lập tài khoản quản trị. Chỉnh URL của NocoBase và 9Router theo mạng triển khai, sau đó gắn ba credential Header Auth theo tên trong workflow:

| Credential | Header | Giá trị |
| --- | --- | --- |
| LatticeDX UC2 Webhook | `X-Lattice-UC2-Key` | Khóa webhook riêng của lab |
| LatticeDX UC2 Native Agent | `Authorization` | Bearer của tài khoản nghiệp vụ cùng tổ chức có quyền đọc Asset và `lattice.integrations.propose` |
| LatticeDX UC2 Model | `Authorization` | Bearer của 9Router, workflow gọi `combo` |

Publish workflow n8n. Đặt `NOCOBASE_URL`, `NOCOBASE_TOKEN`, `UC2_SENSOR_TENANT`, `UC2_N8N_WEBHOOK_URL` và `UC2_N8N_WEBHOOK_KEY`, rồi chạy `node scripts/configure-uc2-inbox-workflow.mjs` trên lab riêng. URL phải truy cập được từ container NocoBase. Chỉ chạy installer một lần cho mỗi lượt setup. Kiểm tra rồi bật workflow inbox và workflow xem xét đề xuất bên dưới. Khóa webhook nằm trong cấu hình node HTTP của NocoBase, vì vậy giới hạn quyền xem/chỉnh workflow và loại khóa khi xuất cấu hình.

Workflow chỉ chuyển observation mới thuộc tổ chức đã cấu hình và có `late=false`. n8n đọc Asset qua API có quyền, gọi model và lưu đề xuất với fingerprint. Mỗi inbox ID tạo một khóa đề xuất ổn định. Khi thử lại node gửi HTTP, model có thể được gọi lại. Nếu nội dung model khác sau khi lượt trước đã ghi thành công, API có thể trả `409` và cần kiểm biên nhận hiện có. Task native ghi nhận việc đã xem đề xuất.

Nghiệm thu local đã chạy từ `receive` tới task qua NocoBase `13003`, n8n `2.42.7` và 9Router với model `combo` thật. Gửi lặp cùng sự kiện chỉ gọi model một lần trong lượt thử, tạo một đề xuất và một task. Người gửi đề xuất bị chặn khi xử lý task của quản lý. Node model yêu cầu JSON với `stream:false`. Timeout của trigger bao gồm thời gian gọi model và hai lượt gọi API native.

Lab có thể dựng task xem xét cho đề xuất về Asset bằng lệnh sau. Chọn ID Employee của quản lý cùng tổ chức. Installer tạo workflow ở trạng thái tắt để quản trị viên kiểm tra cấu hình trước khi bật.

```powershell
$env:NOCOBASE_URL='http://localhost:13003'
node scripts/configure-native-process.mjs --collection=latticeAgentProposals --organization=ORG --reviewer=EMPLOYEE_ID
node scripts/acceptance-native-proposal-review.mjs
```

Task hiển thị mã bản ghi đích và ghi nhận **Xác nhận đã xem** vào lịch sử workflow. Nội dung và bằng chứng của đề xuất đọc qua tool `proposals` theo quyền hiện tại. Phê duyệt nghiệp vụ và thực thi thay đổi cần workflow riêng có bước kiểm lại bằng chứng.

`POST latticeIntegrations:propose`:

```json
{
  "eventId":"proposal-0001",
  "collection":"latticeOrders",
  "recordId":12,
  "fingerprint":"<64 ký tự hex nhận từ record tool>",
  "text":"Đề xuất kiểm tra tồn kho trước khi thực hiện."
}
```

Khi phân tích Asset kèm dữ liệu broker, thêm `contextFingerprint` từ context tool. Backend kiểm lại cả hai fingerprint trước ghi; không nhận evidence URL do model tự khai. Nội dung đề xuất tối đa 12.000 ký tự, là dữ liệu không đáng tin cậy, không được thực thi như mã hoặc chỉ dẫn hệ thống.

Response `{id,duplicate,state:"proposed",requiresHumanApproval:true}`. Collection **latticeAgentProposals → create** là điểm Nhi gắn workflow review/manual task. Fields: targetCollection/targetRecordId/recordFingerprint/recommendation/evidence/sourceUserId/sourceEmployeeId/organizationId/state. Không có endpoint approve/execute hoặc chỉnh status cho agent. Native workflow chịu trách nhiệm kiểm trạng thái/phân công hiện tại, human approval, stale evidence và action được phép khi thực thi; việc tạo proposal không tự cấp quyền thực thi.

`POST latticeIntegrations:proposals`:

```json
{"collection":"latticeOrders","recordId":12,"page":1,"pageSize":20}
```

Response items/page/pageSize/total; pageSize tối đa 100. Kiểm lại quyền record/field trước đọc. Fingerprint khác hoặc context đã đổi/không truy cập được thì item có `stale=true`, không trả recommendation/evidence cũ. Điều này bảo vệ proposal được tạo khi người gọi còn thấy nhiều field hơn hiện tại.

## Mã lỗi chính

| Status | Ý nghĩa |
| --- | --- |
| 400 | schema/field/eventId/recordId/page/time không hợp lệ |
| 401 | chưa đăng nhập hoặc token native không hợp lệ |
| 403 | sai role/capability, membership mất hiệu lực/đổi trong transaction hoặc API native cấm |
| 404 | không thấy record/context đúng phạm vi; không tiết lộ record đơn vị khác |
| 409 | cùng event ID khác nội dung, fingerprint/evidence cũ hoặc context identity mismatch |
| 502/503 | native API/broker lỗi, response quá lớn/sai hoặc subapp chưa hỗ trợ |

## Bàn giao và kiểm chứng

**Nhi:** cấu hình collection events nêu trên, manual task/human approval và hành động native sau phê duyệt; gắn HTTP tools bằng phiên người dùng hoặc service principal giới hạn phù hợp. Không dùng connector service user như đại diện người duyệt. Broker notification NGSI-LD gốc cần adapter của chị chuẩn hóa sang envelope; endpoint này không tự diễn giải mọi subscription payload. AI Employee/model combo/n8n workflow của chị không bị thay đổi.

**Hưng:** dùng endpoint record/context/proposals và shape response trên để gắn UI hiện có. Nhãn state chỉ phản ánh dữ liệu thật; stale/error phải hiển thị rõ. Không dùng generic journal API hoặc root token để lấy proposal.

```powershell
node scripts/acceptance-native-integrations.mjs
node --test plugins/nocobase/plugin-lattice-foundation/tests/native-integration*.test.cjs
```

Suite tạo tài khoản/đơn vị/role/workflow observer tạm rồi dọn fixtures của mình. Kiểm HTTP, native ACL, PostgreSQL receipts, Orion context và collection workflow events thật. Workflow observer chỉ kết thúc để đếm trigger, không thay workflow approval sản xuất của Nhi.

Chưa nghiệm thu trong gói này: logistics đầy đủ, broker subscription/n8n production, model live/timeout và UI agent/human approval xuyên toàn hệ thống. Worker và adapter cũ được giữ nguyên, chưa tuyên bố cutover toàn bộ hệ thống hoặc tick hoàn thành cả giai đoạn 5.

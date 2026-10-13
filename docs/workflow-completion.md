# Workflow completion — task, connector và điều kiện

Engine đã phân biệt việc giao yêu cầu với kết quả xử lý. Một transition có thể tạo task hoặc connector event và chờ kết quả; callback hợp lệ tự chuyển sang trạng thái thành công/thất bại đã cấu hình. Các action ở trạng thái sau vẫn chạy qua transition thông thường bằng quyền JWT hiện tại, không tự dùng lại quyền cũ của chủ hồ sơ.

## Cấu hình chờ

Thêm `wait` vào transition đã có `steps`. `stepId` phải trỏ đến block cuối, là `tasks.create` hoặc `connectors.dispatch`:

```json
{
  "id":"prepare",
  "from":"draft",
  "to":"waiting_it",
  "role":"employee",
  "ownerOnly":true,
  "fields":{},
  "steps":[
    {"id":"assign","action":"tasks.create","input":{"title":{"source":"literal","value":"Chuẩn bị tài khoản"},"assigneeId":{"source":"data","field":"itAssignee"}}}
  ],
  "wait":{
    "stepId":"assign",
    "successState":"account_ready",
    "failureState":"needs_review",
    "resultFields":{"accountRef":"text"},
    "timeoutSeconds":3600
  }
}
```

Workflow đang chờ có `waiting:true`, `availableTransitions:[]`; backend chặn chuyển bước sớm dù UI gọi trực tiếp. Wait tồn tại trong PostgreSQL sau restart. Result fields chỉ nhận text/positiveInteger, không trùng các trường đầu vào, người nhận hoặc trường định danh/quyền. Kết quả được kiểm tra và lưu vào `run.data`, nên bước sau có thể dùng binding `data.accountRef`.

## API cho Hưng và Nhi

| API | Quyền / hành vi |
| --- | --- |
| `GET /v1/workflows/:id/waits?limit=50&offset=0` | Người được đọc workflow; trả `{items,page}` |
| `POST /v1/workflow-waits/:id/complete` | Người nhận task hoặc tài khoản connector được cấp đúng role; cần Idempotency-Key |

Wait ID bằng task ID hoặc eventId của connector. Task DTO có `workflowWaitId`; task thường có null/không có trường này. Hưng dùng endpoint complete cho task đang gắn wait; `/tasks/:id/decisions` bị chặn để không làm lệch task và workflow. Task wait được hoàn thành thành `completed` khi thành công, `rejected` khi thất bại/hết hạn. Task thường và liên kết Logistics vẫn giữ hành vi cũ.

Body thành công:

```json
{"status":"succeeded","result":{"accountRef":"account-123"}}
```

Body thất bại:

```json
{"status":"failed","result":{},"reason":"Không thể cấp tài khoản"}
```

Thất bại cần reason tối đa 500 ký tự và result rỗng. Thành công phải đủ các resultFields đã publish, không nhận reason hoặc trường lạ. Không gửi tenant/state/version để điều khiển luồng. Receipt chỉ gồm `waitId`, `runId`, `status`, `state`, `version`, không trả dữ liệu riêng của workflow.

Task: JWT `tasks:decide`, đúng người nhận ban đầu và đúng đơn vị. Connector: JWT `workflow:callback` và `connector:n8n` / `connector:ngsi-ld` / `connector:agent` đúng loại event đã dispatch. Service adapter dùng tài khoản riêng; không cấp callback cho mọi nhân viên. Wrong actor/connector 403, foreign/hidden resource 404, malformed output 400, trạng thái/deadline/key xung đột 409.

Gửi lại cùng key và cùng nội dung được chấp nhận trả receipt đã lưu; quyền vẫn được kiểm tra trước replay. Key mới cho wait đã đóng hoặc payload khác trả 409. Nhi cần deduplicate eventId, giữ key ổn định khi gửi lại completion. Hai kết quả khác nhau đồng thời chỉ một được chấp nhận. HTTP 200 của endpoint nhận sự kiện outbox chỉ là xác nhận tiếp nhận; adapter phải gửi completion sau khi nghiệp vụ thật kết thúc.

Danh sách wait dành cho người được đọc workflow có `evidence` gồm result/reason để Hưng hiển thị kết quả hoặc lý do thất bại. Callback receipt không có evidence; quyền xử lý resource không tự cấp quyền đọc lịch sử workflow.

## Rẽ nhánh đơn giản

Transition có thể khai báo một predicate:

```json
{"condition":{"field":"accountRef","operator":"exists"}}
{"condition":{"field":"approvalResult","operator":"eq","value":"approved"}}
{"condition":{"field":"cost","operator":"gt","value":"1000"}}
```

Field phải được khai báo trong input hoặc wait output. `eq` so sánh chuỗi chính xác; `exists` đòi trường chuỗi không rỗng; `gt` chỉ nhận số thập phân hữu hạn tối đa 20 ký tự, không nhận scientific notation, hex, newline hoặc giá trị thiếu. Dùng double precision, không phải phép tính tiền tệ chính xác. Không có script/regex/nested expression do người dùng nhập. Guard false bị loại khỏi availableTransitions và inbox trước phân trang; gọi trực tiếp trả 409. Nếu nhiều nhánh đều hợp lệ, người gọi chọn action, engine không tự quyết định ưu tiên.

## Hết hạn và phục hồi

Worker mặc định kiểm tra deadline mỗi giây; deadline dùng clock PostgreSQL. Hết hạn tự chuyển failureState, tăng version, ghi audit `wait.timed_out`; task liên quan bị rejected. Callback muộn bị chặn kể cả worker chưa kịp settle. Việc settle không chạy action với quyền hệ thống.

Timeout không bảo đảm tác vụ ở hệ thống ngoài đã bị hủy. Adapter cần chính sách hủy/bù riêng nếu nghiệp vụ yêu cầu. Outbox retry chỉ retry vận chuyển, không mở lại business wait đã đóng. Quy trình muốn thử lại cần transition phục hồi đã publish từ failureState, tạo task/event và wait mới. Có thể tắt poller khi chạy kiểm thử bằng `WORKFLOW_WAIT_TIMEOUT_WORKER=false`; khi bật lại nó xử lý deadline quá hạn đã lưu.

Read workflow có thể mang snapshot cũ khi completion diễn ra đồng thời; UI gặp 409 nên GET lại. Mọi mutation vẫn kiểm tra version/state dưới lock. Không có canvas UI hoặc adapter thật mới trong increment backend này; Hưng nối hiển thị/configuration, Nhi nối hoàn thành nghiệp vụ.

## Kiểm thử local

```powershell
pnpm local:up
pnpm identity:sync-local
pnpm directory:sync-local
pnpm workflow:seed-local
pnpm test:workflow-completion
```

Fixture service local: connector-demo (org-a/n8n), connector-agent (org-a/agent), connector-b (org-b/n8n); mật khẩu public `local-<username>-password`. Smoke giữ demo và restart API process khi đang chờ để kiểm tra persistence; không reset Docker/volume. Các batch smoke cách nhau 60 giây nếu chạm rate limit Gateway.

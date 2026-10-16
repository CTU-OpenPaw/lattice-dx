# Sự kiện vào và subscriptions

Adapter n8n/broker/agent gọi `POST /v1/workflow-events` bằng JWT nguồn đã cấp workflow:event:receive. Body `{eventId,eventType,occurredAt,data}`; eventType slug lowercase-hyphen, eventId opaque128, thời gian UTC thật, tối đa50 stringfields và128KiB. Actor/tenant từ JWT, nguồn phải active trong directory. Adapter không gửi owner/role/tenant hoặc token vào dữ liệu cấu hình.

Owner designer dùng GET/POST `/v1/workflow-event-subscriptions`, PATCH `/:id` với workflow:design +workflow:integrate. Subscription `{id,eventType,sourceSubject,definitionId,definitionVersion,title,input,enabled}`; PATCH thêm expectedRevision và giữ id. Bindings `{source:"event",field}` hoặc `{source:"literal",value}`. Version publication được pin, mapping chỉ dùng fields đã khai báo. Mutations cần key, revision và nguồn active sameorg; tối đa10 match cho một source/eventType.

Receive mới kiểm current JWT workflow:start +definition.startRole trước khi tạo run. Nó không dùng role của người tạo subscription. Các run, start receipts, event receipt và provenance nằm cùng transaction. Một subscriber lỗi làm cả event không có effect; key/eventID chưa được consume. Zero matches vẫn có receipt accepted, không tự chạy lại khi sau đó thêm subscription.

Kết quả `{eventId,status:"accepted",runs:[{subscriptionId,runId}]}`. Same source+tenant+eventId và nội dung canonical trả cùng result; khác nội dung409. GET `/v1/workflow-events/:eventId` chỉ nguồn đó đọc metadatareceipt. Disable nguồn chặn replay, disable subscription chỉ chặn event mới; old run vẫn giữ pin và quyền lịch sử. Không lưu raw event payload/token vào provenance, mapped fields trở thành workflow business data có quyền hiện tại.

Nhi giữ eventId ổn định khi adapter retry; không dùng randomID cho mỗi lần gửi cùng sự kiện. Callback task/connector completion vẫn dùng wait API, chưa có event-to-transition correlation tự động. Store nguồn/danh tính dịch vụ phải được quản trị cấp quyền và sync; API này không tạo chúng.

Kiểm chứng `pnpm test:inbound-events`: signed source/role, mismatch/races/dedup, multi-subtransaction rollback, disable/replay, pin1 và max1 newexecution/restart. Malformed400,token401,role/source403,missingresource404,key/revisionconflict409,unconfigured503.

Incident adapter extension: `{source:"envelope",field:"eventId"}` binds only the canonical event envelope ID; `{source:"event",field}` continues to read `data`. No other envelope field is accepted. New matching events require both current source directory and JWT workflow:start/startRole grants. Exact existing receipt replay still checks active source and receiver JWT, then returns the original receipt without starting a new run. See [Incident agent runtime](incident-agent-runtime.md) for rule revision provenance and notification correlation.

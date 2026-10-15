# Enterprise module v1

Manifest gói schema, workflow definitions, builtin block references và dependencies theo version chính xác. Format `latticedx.enterprise-module`, formatVersion1; version x.y.z, không ranges/latest. Schema tối đa10, workflow bundle1–10, blocks20, dependencies10. Không chứa executable code, URL, credentials, người dùng, grants hay dữ liệu sống.

Designer có workflow:design +data:design gửi `{manifest}` tới POST `/v1/enterprise-modules/preview` hoặc `/install`; install cần Idempotency-Key. Preview chỉ đọc/conflict check. Install tạo schema/publication v1, workflow drafts và module mapping cùng transaction, mặc định disabled. Không ghi đè schema/draft đích. Cùng moduleversion khác content hash409; samekey replay giữ receipt.

Sau khi publish từng draft, POST `/v1/enterprise-modules/:id/versions/:version/enabled` nhận `{expectedRevision,enabled}` và key. Enable kiểm dependencies enabled và đóng băng published mapping. Disable chặn start mới qua cả module và `/v1/workflows`; không xóa dữ liệu hoặc chặn đọc/tiếp tục run đang chạy. Registry vẫn trả publication cũ để history không mất quyền.

POST `/:id/versions/:version/start` nhận `{definitionId,title,input}`, cần workflow:start và definition.startRole của caller, key. Run thuộc caller, pin mapping đã enable; không chạy dưới quyền installer. GET list/detail/audit cần workflow:design, tenant scoped và phân trang. Module install không cấp bất cứ JWT/identity authority nào.

Version là configuration package version, không phải tự động release GitHub. Workflow/schema definitions bất biến theo publication; thay đổi nghiệp vụ cần publish/version quản lý rõ. v1 không uninstall/delete/auto migration hoặc dynamic plugin execution.

Các mã401/403/400/404/409/503 theo identity/role/input/resource/conflict/unconfigured. Kiểm chứng `pnpm test:enterprise-modules`: previewzeroeffects, allresource receiptrollback, immutableinstall, publish-beforeenable, newstartdisable, historicalread vàpoolmax1.

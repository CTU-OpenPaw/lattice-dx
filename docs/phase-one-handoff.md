# Giai đoạn 1 — hợp đồng nền

## Phân chia

- Duy: identity, Gateway, runtime, API và chính sách truy cập.
- Hưng: plugin/collections và giao diện; không tự quyết định quyền hay trạng thái trên browser.
- Nhi: mapping URN, connector và payload sự kiện. Broker không thay database giao dịch.

## Identity và dữ liệu

JWT phải có issuer cấu hình, audience `dx-api`, subject, expiration, RS256 và claim `organization_id` (1–80 ký tự chữ/số/gạch dưới/gạch ngang). Claim lấy từ Keycloak, không nhận từ body/header tùy ý.

Role hiện thực: `records:read`, `records:write`. Hồ sơ giới hạn đồng thời theo `sub` và `organization_id`; không phải mọi người trong đơn vị đều xem được. Quyền quản lý/phê duyệt sẽ mở riêng theo workflow.

| API đã hiện thực | Request | Response |
| --- | --- | --- |
| GET `/health` | Không token, liveness | `{status:"ok",service:"api"}` |
| POST `/v1/records` | Bearer token + `{title:"Yêu cầu máy tính"}` | 201 `{id,title,ownerId,organizationId,createdAt}` |
| GET `/v1/records` | Bearer token | 200 `{items:[...]}`, tối đa 100 hồ sơ của scope |

`ownerId`/`organizationId` trong body không đổi scope. Mã lỗi: 400 dữ liệu sai, 401 token thiếu/sai/hết hạn, 403 thiếu quyền/đơn vị, 503 thiếu database/identity. Body lỗi `{error:string}`; frontend dùng HTTP status.

Bản ghi cũ chưa có đơn vị giữ nguyên nhưng query mới không trả chúng. Muốn đọc lại cần migration owner→organization được quản trị xác nhận. Keycloak import không cập nhật realm tồn tại: bổ sung mapper và thuộc tính người dùng qua Admin Console/API; không xóa volume để làm mới fixture.

## Task/decision và tệp đã chạy

Role `tasks:read` đọc inbox của mình; `tasks:assign` tạo task trong đơn vị token (assigneeId là subject Keycloak); `tasks:decide` duyệt task được giao cho mình. Task `{id,title,organizationId,assigneeId,createdBy,status,version}`.

- GET `/v1/tasks`: `{items:[...]}`, tối đa 100 task theo assignee/đơn vị.
- POST `/v1/tasks`: `{title,assigneeId}`, trả 201 task pending, version 1. Chỉ principal có quyền assign dùng endpoint này; scope không lấy từ body.
- POST `/v1/tasks/:id/decisions`: `{decision:"approve"|"reject",reason,expectedVersion}`. Từ chối cần lý do. SQL kiểm tra đồng thời assignee, đơn vị, pending và version; thành công tăng version, quyết định lặp/không khả dụng trả 409. Actor, lý do và thời điểm quyết định lưu trong database.

Role `files:write` upload; `files:read` đọc metadata/nội dung tệp của mình trong đơn vị token.

- POST `/v1/files`: `{filename,contentBase64}` tối đa 1 MiB, base64 canonical. Tệp lưu pending trước khi gọi ClamAV; trả 201 metadata `{id,filename,ownerId,organizationId,size,scanStatus}`.
- GET `/v1/files/:id`: metadata, không trả nội dung.
- GET `/v1/files/:id/content`: attachment/octet-stream chỉ khi clean và đúng scope. Khác scope trả 404; pending/rejected/error trả 409.

Scanner TCP nội bộ timeout 15 giây; chưa cấu hình hoặc lỗi trả error, không cấp quyền tải. Upload chờ scan; tiến trình ngắt giữ pending và chặn tải. Chưa có worker quét lại, có thể upload lại. Tệp dùng PostgreSQL bytea ở bootstrap, **chưa phải object storage/lakehouse**, chưa có API gắn tệp vào hồ sơ. Khi đưa S3/MinIO vào, giữ hợp đồng metadata/quyền và thay adapter nội dung. Scan clean không là chứng nhận tệp tuyệt đối an toàn.

`pnpm identity:sync-local` đồng bộ mapper/thuộc tính/role fixture local, không xóa user/mật khẩu/volume. Alice có role trên; bob có read/decide nhưng khác đơn vị. `pnpm test:foundation` kiểm tra task, quyết định đồng thời và ClamAV thật.

## UC1 đầy đủ: hợp đồng ghép tiếp

Trạng thái: `draft → submitted → approved → received → accepted → handed_over`; `submitted → rejected`. Từ chối cần lý do. Nhân viên tạo/gửi hồ sơ của mình; quản lý trong đơn vị duyệt; người được phân công nhận/nghiệm thu/bàn giao. Server kiểm tra quyền/version, ghi audit và chống thao tác lặp.

Task engine nền chưa liên kết recordId hoặc đổi trạng thái hồ sơ UC1. UC1 cần association, audit vòng đời và workflow nghiệp vụ. Chưa kiểm tra assignee thuộc đơn vị trong directory; endpoint assign chỉ cho principal đáng tin, task khác scope không thể xử lý. Trước production cần directory check và chống tạo task lặp.

Sự kiện bàn giao dự kiến: `{eventId,eventType:"asset.handed_over",organizationId,assetId,occurredAt,sourceId,version}`. Nhi ánh xạ assetId→URN; broker không là bước commit giao dịch. Cần job/outbox trước khi xác nhận retry/dedupe hoạt động.

## NocoBase local

Chạy `pnpm nocobase:up`, mở http://localhost:13000. Database/volume riêng. `pnpm nocobase:down` giữ volume; không chạy `down -v` khi có dữ liệu.

Pin `nocobase/nocobase:2.2.20` và digest `sha256:4d57058347c9862dc10b0fd9d0163a8d88918ba14a1c591a61cb76bb60a0cff3`, theo version trong submodule `lerna.json`; không chứng minh binary trùng commit. Tài liệu cấu hình: https://docs.nocobase.com/get-started/installation/docker . Keys/password Compose là fixture công khai, chỉ dùng local loopback.

Login NocoBase và Keycloak vẫn riêng. Không mặc định Community có plugin OIDC thương mại; chưa tuyên bố SSO NocoBase hoạt động. Extension auth phải kiểm chứng API và license.

Giữ license/NOTICE upstream, xem `nocobase-source-review.md`. Không đóng gói plugin thương mại hoặc bỏ branding/license. Dịch vụ độc lập không tự xác nhận tuân thủ mọi điều khoản upstream.

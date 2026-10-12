# Verification — 2026-10-12

## Action runtime

- `pnpm check`: typecheck, 58 tests (20 action tests) và build đạt. Các test action ban đầu thất bại vì route chưa tồn tại, sau triển khai đạt.
- `pnpm test:actions`: gọi qua Keycloak/APISIX, catalog theo quyền, chặn role/scope giả và tạo record/task thật trong PostgreSQL; scope khác không đọc được dữ liệu đã tạo.
- `pnpm test:infra` và `pnpm test:foundation`: các luồng cũ tiếp tục đạt, gồm quyết định đồng thời và ClamAV thật.
- Compose core/NocoBase config, script syntax và git diff whitespace check đạt.
- Reviewer phát hiện schema maxLength và validator UTF-16 không khớp. Action parsers chuyển sang Unicode code points; thêm test biên 200/201 title và 100/101 assignee; reviewer xác nhận không còn finding trong phạm vi review. REST cũ giữ hành vi.
- Docker Desktop gặp lại socket runtime cũ sau khởi động; giữ bản sao hai thư mục runtime và tái tạo đường kết nối, không xóa ổ/volume. Engine 29.2.1 chạy lại, core được rebuild và smoke đạt. Chưa sửa nguyên nhân dài hạn của lỗi Docker.
- Catalog/execute là action runtime đồng bộ đầu tiên; không phải graph engine, workflow hoàn chỉnh, idempotency hoặc SSO NocoBase. Xem `action-runtime.md`.

---

# Verification — 2026-10-11

## Giai đoạn 1 — kiểm chứng thực tế

- `pnpm check`: typecheck, 38 tests và build đạt sau đợt kiểm tra bổ sung.
- Core Docker build/up đạt; Keycloak 26.8.0, APISIX 3.19.0, PostgreSQL 16.13, API chạy thật.
- `pnpm test:infra`: token → Gateway → API → PostgreSQL; quyền ghi, owner và organization scope đạt.
- `pnpm test:foundation`: task tạo/đọc/quyết định lưu PostgreSQL; hai quyết định cùng version chỉ một thành công; đơn vị khác không thấy/duyệt task.
- Upload tệp sạch → ClamAV → clean → download đạt. Mẫu antivirus EICAR vô hại → rejected → download 409. Unit test scanner lỗi → error → download 409.
- Sau restart PostgreSQL/API: counts và hash trạng thái task/nội dung tệp giống trước restart. Kiểm tra này không thay thế thử backup/restore thảm họa.
- NocoBase runtime 2.2.20 xác nhận qua package server trong container. `pnpm test:nocobase`: API metadata và frontend đạt, http://localhost:13000.
- Compose core/NocoBase parse hợp lệ. Hai dịch vụ có database/volume riêng; NocoBase chưa SSO và chưa plugin nhóm.
- Review độc lập không có lỗi critical/important; đã sửa lỗi tên tệp chứa Unicode malformed và thêm regression test.

## Kiểm tra bổ sung qua UI và lỗi biên

- Đăng nhập NocoBase qua trình duyệt bằng fixture local thành công, chuyển đến `/admin`. Trang báo No pages yet vì chưa có app/plugin của nhóm; không coi UI trống là lỗi runtime. Ảnh kiểm chứng local: `output/verification/nocobase-admin.png`.
- Unit tests mới kiểm tra tên tệp chứa đường dẫn/ký tự điều khiển, metadata không lộ content, giới hạn 1 MiB chính xác và đọc task/tệp cần token.
- TCP scanner test kiểm tra framing INSTREAM, kết quả clean/rejected, lỗi daemon và response thiếu terminator; lỗi scanner không được coi là clean.
- `pnpm test:scanner-outage` tắt ClamAV thật, upload tệp thử và xác nhận scanStatus error/download 409; script khởi động lại ClamAV trong finally. Script này gián đoạn scanner local ngắn, không chạy chung với người đang upload.

## Docker Desktop recovery

Daemon lúc đầu không khởi động do socket reparse point bị kẹt ở Docker/run/dockerInference và docker-secrets-engine/engine.sock. Dừng tiến trình Docker, giữ thư mục runtime cũ dưới tên `*-stale-20261011*`, tái tạo đường kết nối và khởi động lại. Giữ nội dung không phải socket của thư mục Secrets Engine. Không reset factory, xóa ổ VHD hay volume. Engine sau sửa trả phiên bản 29.2.1 và chạy các container.

Lỗi tương tự được báo ở https://github.com/docker/desktop-feedback/issues/460 . Nếu tái diễn cần xử lý vòng đời socket/phiên bản Windows–Docker; chưa kết luận do chuyển ổ dữ liệu.

## Giới hạn còn lại

API task nền chưa liên kết UC1/recordId, directory assignee, outbox hoặc workflow đa bước. Tệp tối đa 1 MiB trong PostgreSQL bytea, chưa object storage hay quét lại nền. UI/plugin của Hưng và broker/n8n/agent của Nhi chưa tích hợp. Chưa nghiệm thu toàn bộ giai đoạn 1; chưa kiểm toán đủ license upstream/dependency và chưa đạt chứng nhận an toàn nào.

---

# Kết quả cũ — 2026-10-06

## Đã kiểm chứng ở máy phát triển

- `pnpm install --frozen-lockfile`: thành công.
- `pnpm check`: typecheck, 14 tests và build thành công.
- Kiểm thử token dùng RSA JWT thật: thiếu token, sai issuer/audience, thiếu quyền ghi, owner isolation, tiêu đề trống.
- Luồng API → demo worker được kiểm thử qua HTTP thật.
- `docker compose -f infra/compose/core.yml config --quiet`: hợp lệ.
- `node --check scripts/smoke-core.mjs`: cú pháp hợp lệ.
- Working tree upstream NocoBase sạch; upstream, .env và build output được ignore.

## Chưa kiểm chứng

Docker Engine không phản hồi ở máy trong lượt triển khai này, dù Docker Desktop đã được gọi khởi động. Chưa chạy Docker build/pull/up, truy vấn PostgreSQL thật, Keycloak realm import, xác thực APISIX hoặc restart persistence. Test records dùng repository trong bộ nhớ và JWKS local, không thay thế smoke container.

Chạy `pnpm infra:up` và `pnpm test:infra` khi Docker Engine sẵn sàng. Sau đó thử restart stack và truy vấn lại dữ liệu. Cập nhật tài liệu này bằng kết quả thực tế trước release.

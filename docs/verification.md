# Verification — 2026-10-11

## Giai đoạn 1 — kiểm chứng thực tế

- `pnpm check`: typecheck, 26 tests và build đạt.
- Core Docker build/up đạt; Keycloak 26.8.0, APISIX 3.19.0, PostgreSQL 16.13, API chạy thật.
- `pnpm test:infra`: token → Gateway → API → PostgreSQL; quyền ghi, owner và organization scope đạt.
- `pnpm test:foundation`: task tạo/đọc/quyết định lưu PostgreSQL; hai quyết định cùng version chỉ một thành công; đơn vị khác không thấy/duyệt task.
- Upload tệp sạch → ClamAV → clean → download đạt. Mẫu antivirus EICAR vô hại → rejected → download 409. Unit test scanner lỗi → error → download 409.
- Sau restart PostgreSQL/API: counts và hash trạng thái task/nội dung tệp giống trước restart. Kiểm tra này không thay thế thử backup/restore thảm họa.
- NocoBase runtime 2.2.20 xác nhận qua package server trong container. `pnpm test:nocobase`: API metadata và frontend đạt, http://localhost:13000.
- Compose core/NocoBase parse hợp lệ. Hai dịch vụ có database/volume riêng; NocoBase chưa SSO và chưa plugin nhóm.
- Review độc lập không có lỗi critical/important; đã sửa lỗi tên tệp chứa Unicode malformed và thêm regression test.

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

# Verification — 2026-10-06

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

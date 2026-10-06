# Changelog

## 0.1.0 — 2026-10-06

- Khởi tạo pnpm monorepo với Next.js web, Fastify API và worker độc lập.
- Thêm hợp đồng dữ liệu và luồng demo web → API → worker.
- Thêm kiểm thử tích hợp, tài liệu kiến trúc và cấu hình CI.
- Đặt tên LatticeDX; thêm core Compose với Keycloak, APISIX, PostgreSQL và API hồ sơ xác thực JWT, kiểm tra role và owner.
- Giới hạn Vitest vào mã nhóm để không chạy nhầm kiểm thử upstream.

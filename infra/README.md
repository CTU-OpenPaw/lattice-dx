# Infrastructure

Đặt cấu hình chạy các dịch vụ upstream ở đây sau khi đã chọn phiên bản và kiểm tra giấy phép. Mỗi dịch vụ cần ghi nguồn image/source, phiên bản, biến môi trường, volume, healthcheck và cách gỡ bỏ.

Core Compose ở `compose/core.yml`, gồm PostgreSQL, Keycloak, API, APISIX và ClamAV. Chạy `pnpm infra:up`; đọc [hướng dẫn](../docs/core-local.md). NocoBase runtime riêng ở `compose/nocobase.yml`, chạy `pnpm nocobase:up`; không dùng `--remove-orphans` vì hai file dùng cùng Compose project. Credential fixture công khai, chỉ dùng local. Chưa có Kubernetes/GitOps deployment.

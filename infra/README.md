# Infrastructure

Đặt cấu hình chạy các dịch vụ upstream ở đây sau khi đã chọn phiên bản và kiểm tra giấy phép. Mỗi dịch vụ cần ghi nguồn image/source, phiên bản, biến môi trường, volume, healthcheck và cách gỡ bỏ.

Core Compose ở `compose/core.yml`, gồm PostgreSQL, Keycloak, API và APISIX. Chạy `pnpm infra:up`; đọc [hướng dẫn](../docs/core-local.md). Credential fixture là công khai, chỉ dùng local; không lưu secret thật vào repo. Chưa có Kubernetes/GitOps deployment.

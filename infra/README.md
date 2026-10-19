# Infrastructure

Đặt cấu hình chạy các dịch vụ upstream ở đây sau khi đã chọn phiên bản và kiểm tra giấy phép. Mỗi dịch vụ cần ghi nguồn image/source, phiên bản, biến môi trường, volume, healthcheck và cách gỡ bỏ.

Core Compose ở `compose/core.yml`, gồm PostgreSQL, Keycloak, API, APISIX và ClamAV. Chạy `pnpm infra:up`; đọc [hướng dẫn](../docs/core-local.md). NocoBase runtime riêng ở `compose/nocobase.yml`, chạy `pnpm nocobase:up`; không dùng `--remove-orphans` vì hai file dùng cùng Compose project. Credential fixture công khai, chỉ dùng local. Chưa có Kubernetes/GitOps deployment.


## Tích hợp NGSI-LD và n8n

Đã triển khai môi trường local gồm Orion-LD, MongoDB và n8n.
Đã kiểm chứng tạo và đọc lại dữ liệu mẫu Asset, Department, Location, bao gồm quan hệ giữa các entity và thời gian observedAt.
Đã viết Asset connector tạo/đọc/cập nhật qua Orion-LD.
Smoke test đã kiểm chứng vòng create → read → update → read-back.


Chi tiết cấu hình, kết quả kiểm chứng và công việc tiếp theo:
[Tài liệu tích hợp](docs/integration-ngsi-ld-n8n.md).

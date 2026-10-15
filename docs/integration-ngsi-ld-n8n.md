# Tích hợp NGSI-LD và n8n

## Mục 5 — Asset subscription receiver

Đã bổ sung receiver backend, lưu bản chiếu Asset.status vào PostgreSQL và script đăng ký/kiểm chứng subscription.
Xem [hướng dẫn subscription](ngsi-ld-subscription.md) để cấu hình credential riêng và chạy Docker local.

Trạng thái: **đã triển khai code; chưa ghi nhận kiểm chứng broker → gateway → backend → PostgreSQL trên máy local**.
Không đánh dấu hoàn thành mục 5 trước khi smoke test thực tế pass.

## Phạm vi

Broker lưu trạng thái và ngữ cảnh dùng chung.
Backend nghiệp vụ quản lý dữ liệu giao dịch, kế toán và quyền truy cập.

## Môi trường đã chạy

- Orion-LD: 1.10.0 — http://localhost:1026
- MongoDB: 4.4.29 — chỉ truy cập trong mạng Docker
- n8n: 2.42.7 — http://localhost:5678
- Compose: infra/compose/integration.yml
- Credential nằm trong .env.integration; không đưa secret vào tài liệu hoặc Git.

## Kết quả đã kiểm chứng — 15/10/2026

- GET /version: Orion-LD trả về phiên bản 1.10.0.
- GET n8n /healthz: HTTP 200.
- Tạo Department, Location và Asset: cả ba trả HTTP 201.
- Đọc lại Asset: trả đúng businessId, organizationId, tên, trạng thái,
  observedAt và các quan hệ đến Department, Location.
- Tenant sử dụng trong các request: org-a.
- Header NGSILD-Tenant chọn không gian dữ liệu; không thay thế xác thực.

## Mô hình dữ liệu hiện có

- Context: infra/config/ngsi-ld/context.jsonld
- Dữ liệu mẫu: infra/config/ngsi-ld/seed.json
- Namespace https://latticedx.example/ns/ là đề xuất của nhóm.
- Department là loại entity.
- belongsToDepartment là tên quan hệ trong context, ánh xạ đến
  https://latticedx.example/ns/department.
- Đổi tên quan hệ để tránh xung đột Department/department khi đọc JSON
  bằng Windows PowerShell.
- observedAt dùng thời gian UTC theo ISO 8601.

## Mapping đã thử nghiệm

| Loại      | Organization | Business ID | URN                                 |
| ---------- | ------------ | ----------- | ----------------------------------- |
| Department | org-a        | it          | urn:ngsi-ld:Department:org-a:it     |
| Location   | org-a        | office-1    | urn:ngsi-ld:Location:org-a:office-1 |
| Asset      | org-a        | laptop-001  | urn:ngsi-ld:Asset:org-a:laptop-001  |

Đây là mapping đã chạy thử, chưa phải contract đã thống nhất với cả nhóm.
Không mặc định business ID, ID bản ghi backend và workflow run ID là một.

## Công việc còn lại

- Chốt quy tắc ID, trường bắt buộc và nguồn cập nhật từng thuộc tính.
- Bổ sung mapping Vehicle, Shipment, Warehouse.
- Hoàn thiện ghi nhận giấy phép, credential và khóa image digest.
- Viết connector tạo/đọc/cập nhật Asset.
- Tạo webhook n8n có xác thực và kiểm tra payload.
- Tích hợp subscription với endpoint backend.

## Nhật ký hoàn thiện mục 2 — 15/10/2026

### Bằng chứng đã có

- Ba entity Department, Location, Asset được tạo với HTTP 201.
- Đọc lại Asset thành công, đúng trạng thái, observedAt và quan hệ.

### Thiết kế bổ sung

- Đặc tả: [NGSI-LD Data Contract](ngsi-ld-data-contract.md).
- Bổ sung mô hình đề xuất Vehicle, Shipment, Warehouse.
- Định nghĩa quy tắc ID, quan hệ, dữ liệu thiếu và ranh giới dữ liệu.
- Phân biệt Order.received với Shipment.delivered.
- Phân biệt warehouseAssigneeId với Warehouse ID.

### Chưa kiểm chứng

- Chưa tạo và đọc lại fixture logistics trên broker.
- Chưa kiểm chứng connector thực thi các quy tắc validation,
  observedAt và chống cập nhật cũ.
- Chưa xác nhận contract cuối cùng với Duy.

### Kiểm chứng fixture logistics

- Fixture: infra/config/ngsi-ld/seed-logistics.json.
- Tạo và đọc lại 6 entity logistics thành công.
- Kiểm tra ID, type, businessId, organizationId và name.
- Kiểm tra status và observedAt của Vehicle, Warehouse, Shipment.
- Kiểm tra Warehouse/Vehicle → Location.
- Kiểm tra Shipment → Vehicle, kho nguồn và kho đích.
- Dữ liệu là fixture demo, chưa đồng bộ với backend.
- Contract và nguồn ID thực tế vẫn chờ nhóm review.

### NGSI-LD data model

- Đã định nghĩa Asset, Department, Location, Vehicle, Shipment, Warehouse.
- Đã lập quy tắc mapping ID nghiệp vụ ↔ URN và ranh giới dữ liệu.
- Đã kiểm chứng dữ liệu mẫu và quan hệ logistics trên Orion-LD.
- Contract hiện là đề xuất tích hợp, chờ nhóm review.

Chi tiết: [Data contract](docs/ngsi-ld-data-contract.md) và [nhật ký tích hợp](docs/integration-ngsi-ld-n8n.md).


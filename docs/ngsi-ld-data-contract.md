
# NGSI-LD Data Contract — đề xuất v1.0

## 1. Trạng thái và phạm vi

Owner: Nhi — Integration, Data & AI.

Trạng thái: bản đề xuất phục vụ tích hợp local; chưa xác nhận contract
cuối cùng với backend.

Đã kiểm chứng trên Orion-LD:

- Tạo Department, Location, Asset: HTTP 201.
- Đọc lại Asset thành công, bao gồm Property, Relationship và observedAt.

Vehicle, Shipment, Warehouse đang được thiết kế.
Chưa có bằng chứng tích hợp end-to-end cho ba loại này.

Broker lưu bản chiếu trạng thái/ngữ cảnh.
Backend nghiệp vụ giữ dữ liệu gốc, giao dịch và quyết định phân quyền.

## 2. Tài liệu backend đối chiếu

- docs/logistics-ui-handoff.md
- docs/enterprise-data.md

Theo tài liệu backend tại thời điểm đối chiếu:

- Logistics Order là workflow run.
- Trong API Order hiện tại, recordId bằng order.id.
- Quy tắc này không áp dụng mặc định cho các domain khác.
- Logistics chưa có Shipment, tồn kho, xe hoặc đối soát.
- Order received nghĩa là kho nhận việc xử lý đơn;
  không có nghĩa hàng đã xuất kho hoặc giao thành công.
- warehouseAssigneeId là Keycloak subject của người nhận việc,
  không phải Warehouse ID.
- Department ID là ID danh mục thuộc organization.
- Adapter truy cập backend bằng authority được cấp;
  không mặc định service account đọc được mọi dữ liệu.

Các quyết định về tích hợp phải đối chiếu với checkout/commit của nhóm
khi triển khai, vì main có thể tiếp tục thay đổi.

## 3. Quy tắc ID đề xuất

Dạng URN:

urn:ngsi-ld:<EntityType></entitytype>:<organizationId></organizationid>:<businessId></businessid>

Ví dụ:

urn:ngsi-ld:Asset:org-a:laptop-001

Quy tắc cho v0.1:

- EntityType thuộc sáu loại được định nghĩa trong tài liệu này.
- organizationId và businessId là chuỗi không rỗng.
- Hai thành phần ID sử dụng chữ ASCII, số, dấu gạch ngang
  hoặc gạch dưới; tối đa 128 ký tự mỗi thành phần.
- Phân biệt hoa/thường; không tự lowercase, bỏ dấu hoặc thay ký tự.
- ID ngoài tập ký tự trên cần mapping riêng trước khi tích hợp.
- Không lấy tên hiển thị, biển số xe hoặc địa chỉ làm ID.
- businessId trong contract này là khóa tích hợp ổn định.
- Thay tên, đổi biển số hoặc đổi mã hiển thị không làm đổi URN.
- Nếu nguồn chỉ có mã nghiệp vụ có thể thay đổi, adapter phải lưu
  mapping ổn định thay vì dựng lại URN từ mã mới.
- Không mặc định backend entity UUID, workflow run ID, record ID,
  businessId và eventId là cùng một loại ID.

organizationId phải lấy từ cấu hình tích hợp tin cậy hoặc identity
đã xác thực; không tin trực tiếp organizationId do caller tùy ý gửi.

Header NGSILD-Tenant phải khớp organizationId của entity.
Header này chọn tenant, không thay thế xác thực/phân quyền.

## 4. Thuộc tính chung

| Thuộc tính   | Kiểu NGSI-LD    | Yêu cầu                                |
| -------------- | ---------------- | ---------------------------------------- |
| id             | Entity ID        | Bắt buộc; theo quy tắc URN            |
| type           | Entity Type      | Bắt buộc                               |
| businessId     | Property, string | Bắt buộc; khóa tích hợp ổn định  |
| organizationId | Property, string | Bắt buộc; khớp tenant                 |
| name           | Property, string | Bắt buộc; tên hiển thị              |
| status         | Property, string | Theo từng loại entity                  |
| sourceEventId  | Property, string | Có khi cập nhật xuất phát từ event |

Payload ghi dùng application/ld+json và context của dự án.

Namespace https://latticedx.example/ns/ là namespace đề xuất,
không phải tuyên bố tuân thủ một bộ Smart Data Models có sẵn.

## 5. Sáu loại entity

| Entity     | Property riêng                 | Relationship                                                                                | Ý nghĩa                                 |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Department | Các thuộc tính chung         | Không bắt buộc                                                                           | Phòng ban/đơn vị nội bộ             |
| Location   | Các thuộc tính chung         | Không bắt buộc                                                                           | Địa điểm dùng chung                  |
| Asset      | status                          | belongsToDepartment → Department; locatedAt → Location                                    | Trạng thái và nơi quản lý tài sản |
| Vehicle    | status; licensePlate tùy chọn | locatedAt → Location                                                                       | Ngữ cảnh vận hành phương tiện      |
| Shipment   | status                          | assignedVehicle → Vehicle; originWarehouse → Warehouse; destinationWarehouse → Warehouse | Ngữ cảnh vận chuyển                   |
| Warehouse  | status                          | locatedAt → Location                                                                       | Ngữ cảnh cơ sở kho                    |

Yêu cầu quan hệ cho v0.1:

- Asset: belongsToDepartment và locatedAt bắt buộc.
- Warehouse: locatedAt bắt buộc.
- Vehicle: locatedAt tùy chọn.
- Shipment: các quan hệ tùy chọn khi chưa được phân công.
- Mọi quan hệ, nếu có, phải trỏ đúng loại entity và cùng organization.
- Không tạo URN giả cho quan hệ chưa có dữ liệu.

locatedAt biểu diễn địa điểm được gán/ghi nhận.
Không được diễn giải là vị trí GPS trực tiếp của xe.

Shipment trong bản demo là lô vận chuyển giữa hai kho.
Chưa mô hình hóa giao đến khách hàng hoặc nhiều chặng.

Broker không được mặc định kiểm tra sự tồn tại của đích quan hệ.
Connector phải kiểm tra loại, organization và đích quan hệ
trước khi coi dữ liệu là hợp lệ.

## 6. Giá trị status đề xuất

| Entity    | Giá trị                                             |
| --------- | ----------------------------------------------------- |
| Asset     | ready, in_use, repair, retired                        |
| Vehicle   | available, assigned, maintenance, offline             |
| Shipment  | planned, dispatched, in_transit, delivered, cancelled |
| Warehouse | active, inactive                                      |

Đây là enum đề xuất cho broker, chưa phải enum của backend.
Nếu backend dùng enum khác, adapter phải có mapping tường minh.

Không suy ra Shipment.delivered từ Order.received.
Không suy ra Warehouse.active là kho còn hàng.

## 7. Mapping mẫu

| Entity     | Organization | Business ID       | URN                                          |
| ---------- | ------------ | ----------------- | -------------------------------------------- |
| Department | org-a        | it                | urn:ngsi-ld:Department:org-a:it              |
| Location   | org-a        | office-1          | urn:ngsi-ld:Location:org-a:office-1          |
| Location   | org-a        | depot-1           | urn:ngsi-ld:Location:org-a:depot-1           |
| Location   | org-a        | depot-2           | urn:ngsi-ld:Location:org-a:depot-2           |
| Asset      | org-a        | laptop-001        | urn:ngsi-ld:Asset:org-a:laptop-001           |
| Vehicle    | org-a        | truck-001         | urn:ngsi-ld:Vehicle:org-a:truck-001          |
| Warehouse  | org-a        | warehouse-001     | urn:ngsi-ld:Warehouse:org-a:warehouse-001    |
| Warehouse  | org-a        | warehouse-002     | urn:ngsi-ld:Warehouse:org-a:warehouse-002    |
| Shipment   | org-a        | shipment-demo-001 | urn:ngsi-ld:Shipment:org-a:shipment-demo-001 |

Các ID logistics trong bảng là fixture demo.
Không phải dữ liệu đã lấy từ API backend.

Mapping backend ↔ broker phải được lưu tại adapter/configuration,
gồm tối thiểu:

- organizationId
- sourceSystem
- sourceEntityType
- sourceId
- brokerUrn

Một source entity trong cùng organization/sourceSystem chỉ có
một brokerUrn đang được sử dụng.

Không dùng Order ID làm Shipment ID mặc định.
Quan hệ một Order có bao nhiêu Shipment chưa được thống nhất.

## 8. observedAt và dữ liệu thiếu

- observedAt là thời điểm nguồn quan sát trạng thái, dạng ISO 8601 UTC.
- Không thay observedAt bằng thời điểm retry hoặc nhận webhook.
- Dữ liệu demo được phép dùng thời điểm sinh fixture.
- Cập nhật status phải có observedAt hợp lệ.
- Thiếu ID, organization hoặc trường bắt buộc: từ chối ghi.
- Thiếu trường tùy chọn: bỏ trường đó, không điền giá trị suy đoán.
- Không gửi null để ngầm xóa quan hệ hoặc thuộc tính.
- Event cũ hơn observedAt hiện tại: không ghi đè trạng thái mới.
- Cùng thời điểm nhưng trạng thái mâu thuẫn: ghi nhận xung đột,
  không tự chọn theo thứ tự request đến.
- sourceEventId hỗ trợ truy vết; bản thân thuộc tính này chưa tạo
  cơ chế deduplicate hoặc bảo đảm xử lý đúng một lần.

Quy tắc chống event cũ và deduplicate cần được thực thi ở connector/
adapter; không mặc định Orion-LD tự thực hiện.

## 9. Ranh giới dữ liệu

| Đưa vào broker                          | Giữ ở backend nghiệp vụ                        |
| ------------------------------------------ | -------------------------------------------------- |
| Khóa tích hợp, tên hiển thị          | Toàn bộ hồ sơ Order                            |
| Trạng thái tài sản/xe/lô vận chuyển | SKU, số lượng và giao dịch tồn kho           |
| Quan hệ phòng ban, địa điểm, kho, xe | Hóa đơn, thanh toán, sổ kế toán             |
| observedAt và sourceEventId               | Địa chỉ giao hàng, thông tin liên hệ khách |
| Ngữ cảnh phục vụ cảnh báo            | Tệp đính kèm, JWT, credential, secret          |

Không sao chép toàn bộ payload API Order sang broker.
Không coi broker là nguồn phân quyền thay cho backend.

## 10. Nội dung cần Duy review

- [ ] Nguồn ID thực tế và tính ổn định của từng domain.
- [ ] Mapping Department ID với directory/backend.
- [ ] Có cần Shipment riêng; quan hệ Order ↔ Shipment.
- [ ] Nguồn phát trạng thái cho Asset, Vehicle, Shipment, Warehouse.
- [ ] Service authority được phép đọc/ghi dữ liệu cần tích hợp.
- [ ] Enum trạng thái và mapping với backend.
- [ ] Mapping storage đặt ở đâu trong adapter.

Có thể hoàn thiện và kiểm thử fixture trước khi review.
Chỉ ghi "đã thống nhất" khi có xác nhận thực tế.

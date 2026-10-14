# Enterprise data — hợp đồng engine

LatticeDX quản lý thực thể nghiệp vụ dùng chung trong PostgreSQL. NocoBase Studio/UI cấu hình schema và đọc/ghi qua API; dữ liệu typed này không phải bản sao của các collection NocoBase đã có. Record/task/workflow cũ giữ nguyên API và cách lưu.

## Schema và dữ liệu có kiểu

Schema định nghĩa tên field, kiểu và yêu cầu đầu vào; designer tạo nháp rồi publish. Published versions bất biến. Thực thể mới dùng latest publication; thực thể cũ pin phiên bản lúc tạo, kể cả khi schema mới thêm trường bắt buộc. Chưa có migration tự động cho các thực thể đang lưu.

Ví dụ schema:

```json
{
  "id":"equipment",
  "title":"Thiết bị",
  "fields":{
    "name":{"type":"text","required":true,"maxLength":200},
    "active":{"type":"boolean","required":true},
    "quantity":{"type":"integer","required":true},
    "cost":{"type":"decimal","required":true},
    "purchasedOn":{"type":"date"},
    "status":{"type":"enum","choices":["ready","repair"]}
  },
  "relations":{"related":{"targetSchemaId":"equipment"}}
}
```

| Kiểu | Giá trị và giới hạn |
| --- | --- |
| text | Chuỗi; maxLength1–4000 code points, mặc định4000; required không nhận chuỗi toàn khoảng trắng |
| boolean | JSON true/false, không nhận chuỗi "true" |
| integer | JSON integer an toàn JavaScript, không nhận số chuỗi hoặc số thập phân |
| decimal | Chuỗi plain decimal có dấu tùy chọn, tối đa38 digits tổng và18digits phần lẻ; không exponential/leadingzero tùy ý; lưu nguyên giá trị chính xác |
| date | YYYY-MM-DD thật trong lịch, năm0000 không hợp lệ |
| enum | Một trong1–100 choices chuỗi khác nhau, mỗi choice tối đa200 code points |

Tối đa50fields/20relations. Schema ID slug lowercase tối đa64 ký tự; field/relation name chữ cái đầu, chữ/số/underscore tối đa64; tên authority/prototype bị chặn. Attributes chỉ có field được khai báo; không có null/nested object/list trong increment đầu. Schema chưa publish trả404; unknown keys, kiểu sai, required thiếu và malformed schema/attributes trả400. Schema definition và attributes còn được giới hạn16KiB JSON UTF-8 khi lưu; HTTP giới hạn16KiB cho toàn bộ body, nên cần tính cả envelope.

## API schema — quyền data:design

| API | Body / kết quả |
| --- | --- |
| POST `/v1/entity-schemas` | Schema như trên;201 draft revision1 |
| GET `/v1/entity-schemas?limit=50&offset=0&q=…` | `{items,page}` drafts thuộc đơn vị |
| GET `/v1/entity-schemas/:id` | Draft hiện tại và publishedVersion |
| PUT `/v1/entity-schemas/:id` | `{expectedRevision,title,fields,relations}`; không đổi ID |
| POST `/v1/entity-schemas/:id/publish` | `{expectedRevision}`; publication cóversion |

Save/publish kiểm tra revision dưới lock. Cùng revision publish lại trả publication cũ; stale revision409. Relation target schema phải có publication trong cùng đơn vị khi publish, trừ self-reference. Không tự cấp role hoặc tạo quyền bằng schema.

Người dùng có data:read gọi `GET /v1/entity-schemas/:id/versions/:version` để lấy **published schema đúng phiên bản** của entity. Endpoint này chỉ trả publication trong đơn vị hiện tại, không trả draft; version dương tối đa2,147,483,647. Dùng schemaVersion của entity, không lấy draft/latest để render biểu mẫu của dữ liệu cũ.

## API thực thể

JWT có signed organization và data:read/data:write theo thao tác. Đọc/ghi thực thể chỉ **đúng owner và đơn vị**; chưa có org-wide read, department sharing hay manager bypass. Những năng lực đó thuộc nhóm quyền tiếp theo.

| API | Quyền | Body |
| --- | --- | --- |
| POST `/v1/entities` | data:write | `{schemaId,title,attributes}` |
| GET `/v1/entities?schemaId=…&q=…&limit=50&offset=0` | data:read | Active owner-scoped entities, paging/filter trong SQL |
| GET `/v1/entities/:id` | data:read | Detail, gồm archivedAt nếu đã archive |
| PATCH `/v1/entities/:id` | data:write | `{expectedVersion,title,attributes}` |
| POST `/v1/entities/:id/archive` | data:write | `{expectedVersion}` |
| POST `/v1/entities/:id/relations` | data:write | `{name,targetId,expectedVersion}` |
| DELETE `/v1/entities/:id/relations/:name/:targetId` | data:write | `{expectedVersion}` |
| GET `/v1/entities/:id/relations?limit=50&offset=0` | data:read | `{items,page}` readable relations |
| GET `/v1/entities/:id/history?limit=50&offset=0` | data:read | `{items,page}` audit |

Các mutation thực thể **bắt buộc Idempotency-Key**, do đây là API mới; không thay optional key của record/task nền cũ. Samekey/same normalized command trả snapshot cũ sau khi kiểm tra quyền sở hữu hiện tại, kể cả nếu entity sau đó đã archive; samekey/differentcommand409. Entity update hoàn toàn thay thế title/attributes, không phải merge từng field; attributes theo schemaVersion của entity, không theo latestschema.

Optimistic expectedVersion tránh ghi đè thay đổi người khác. Entity/result/audit/receipt được lưu atomic; SQL locks và command scopes tenant/actor ngăn quyết định đồng thời gây lệch dữ liệu. Decimalstrings giữ precision, thứ tự JSON keys không tạo fingerprint khác.

## Quan hệ và archive

Quan hệ có tên trong schema nguồn và targetSchemaId. Cả hai thực thể phải hiện hữu, đúng owner/đơn vị và target thuộc đúng schema; source phải active. Link mới yêu cầu target active; unlink được phép xóa quan hệ tới target đã archive để không giữ liên kết dở dang. Relation ban đầu many-to-many theo set membership; chưa có cardinality1/uniqueness/reverse auto/graph inference. Engine khóa source/target theo thứ tựUUID thống nhất.

Link đã tồn tại hoặc unlink link không tồn tại với **key mới và expectedVersion hiện tại** là no-op: source version không tăng và không ghi audit mutation mới. Key vẫn lưu snapshot kết quả để retry. Nếu expectedVersion sai vẫn409.

Archive là softarchive có audit và version; chưa có harddelete/restore. Active list loại archived entities; owner có quyền vẫn đọc detail/history. Archived entity không update/link mới. Relation listing không lộ target bị archive hoặc không còn readable. Audit chỉ có readAPI, không có update/delete; đây chưa phải ledger chống sửa bởi DBA hoặc chứng nhận giá trị pháp lý.

## Bàn giao và giới hạn

Hưng dùng schema fields để dựng biểu mẫu và gửi typed JSON, không tự biến tất cả input thành strings; UI phải giữ entityVersion và schemaVersion. Nhi gọi API theo service authority đã cấp, gửi key ổn định, giữ source provenance/mapping ở adapter theo contract sau này. Increment này chưa có entity-block trong workflow, entity bulkimport, fulltext index, field-level ACL, tự migrate schema hoặc integration adapter.

401 token,403 role/tenant,404 hidden resource,400 malformed/type/schema,409 revision/entity/key/state conflict,503 missing identity/repository; HTTP413 body quá lớn. Domain schemas không chứa arbitrary code/SQL hoặc URL. Không có role grants qua payload.

Smoke: `pnpm test:enterprise-data`; kiểm tra tổng: `pnpm check`. Phạm vi tổng thể xem [backend capabilities](backend-capabilities.md).

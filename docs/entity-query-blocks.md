# Truy vấn typed data và block dùng chung

`POST /v1/entities/query` cần data:read, body như sau; đây là read API nên không cần Idempotency-Key:

```json
{
  "schemaId":"equipment",
  "schemaVersion":1,
  "filters":[{"field":"cost","operator":"gte","value":"1000.00"}],
  "sort":{"field":"cost","direction":"asc"},
  "limit":50,
  "offset":0
}
```

SchemaVersion bắt buộc để giữ đúng kiểu dữ liệu, chỉ trả active entities ở phiên bản đó. Filters kết hợp AND, tối đa10. `eq/ne` hỗ trợ scalar đúng kiểu; `gt/gte/lt/lte` cho integer/decimal/date; `contains` cho text, phân biệt hoa thường; `exists` không nhận value. Thiếu attribute không khớp so sánh, kể cả ne. Decimal dùng chuỗi và SQL NUMERIC, không chuyển qua JavaScript float. Lọc quyền trước phân trang, không nhận raw SQL hoặc code.

Sort theo field đã khai báo, asc/desc; giá trị thiếu ở cuối, id phá hòa để thứ tự ổn định. Nếu không sort dùng createdAt/id giảm dần. Boolean không dùng toán tử gt/lt nhưng có thể sort false/true. Limit1–100 mặc định50; offset bắt đầu0. Kết quả `{items,page}` như entity list.

`GET /v1/blocks` trả catalog builtin chỉ chứa block có repository support và role phù hợp. Block gồm id/version/title/requiredRole/inputSchema/outputSchema/mutation. Bảy block: `entities.create`, `entities.read`, `entities.query`, `entities.update`, `entities.archive`, `entities.link`, `entities.unlink`.

```json
{
  "version":1,
  "input":{"id":"<entity UUID>","expectedVersion":3,"title":"Thiết bị A","attributes":{"cost":"1000.00"}}
}
```

Gửi body này tới `POST /v1/blocks/entities.update/run`, kèm Idempotency-Key. Input tương ứng REST, thêm id khi thao tác entity hiện có. Kết quả `{blockId,version:1,status:"succeeded",result}`. Read nhận `{id}`, query nhận body query, create nhận `{schemaId,title,attributes}`; archive nhận `{id,expectedVersion}`; link/unlink thêm name,targetId.

REST và block gọi cùng repository, mutation operation/key/actor/org không đổi. Retry cùng key/body qua hai giao diện trả cùng snapshot; khác nội dung409; quyền hiện tại bị thu hồi vẫn404. Không có handler upload, script hoặc tự cấp quyền qua catalog. Old `/v1/actions` và workflow executors vẫn giữ hợp đồng riêng; typed block thực thi bên trong workflow cần helper transaction riêng ở đợt điều phối, chưa được tính là đã tích hợp.

400 input/type/version/key;401 token;403 role;404 entity/unknownblock/publication;409 optimistic/key/state;503 thiếu repository/capability. HTTP16KiB bounds giữ nguyên.

Hưng dùng JSON schema catalog để dựng input, schema publication để render attributes. Nhi/agent gọi cùng API bằng danh tính và grants được cấp. Kiểm chứng `pnpm test:entity-query-blocks`; không sửa UI/adapter trong increment backend.

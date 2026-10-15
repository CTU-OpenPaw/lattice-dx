# Backend cho Studio và context

Đợt này bổ sung các API để Studio khai thác engine hiện có. Không tạo lại giao diện NocoBase, không thay Workspace và không tự triển khai broker, n8n hay agent. Các endpoint dưới đây dùng JWT nghiệp vụ qua Gateway; cấu hình và dữ liệu vẫn do engine quản lý.

## Năng lực tài khoản và danh mục thiết kế

`GET /v1/me/capabilities` trả `version:1`, `subject`, `organizationId` và các năng lực có ba cờ riêng:

- `authorized`: token hiện tại có role cần thiết.
- `configured`: thành phần backend tương ứng đã được cấu hình.
- `available`: cả hai điều kiện trên đều đúng.

Đây là hướng dẫn hiển thị UI, không phải giấy phép truy cập từng bản ghi. Quyền thực thể, tham chiếu, trạng thái workflow và phiên bản vẫn được kiểm tra khi gọi API thực hiện. Không cache kết quả giữa hai tài khoản hoặc hai đơn vị.

`GET /v1/studio/catalog` yêu cầu `data:design` hoặc `workflow:design`. Danh mục lấy từ registry/validator đang dùng, gồm kiểu trường, toán tử truy vấn, block, action và định danh connector/service được phép xem. Không trả URL kết nối, token hoặc bí mật triển khai. Block thực thi trong workflow phụ thuộc vào workflow runtime, không bắt buộc bật API tác nghiệp độc lập tương ứng. Block/action độc lập vẫn có điều kiện riêng.

## Kiểm tra cấu hình trước khi cài

`POST /v1/studio/preflight` nhận đúng một trường `{manifest}` và yêu cầu cả `workflow:design` lẫn `data:design`. Nó tái sử dụng module preview hiện có, không install, publish, cấp quyền hay gọi connector.

```json
{
  "version": 1,
  "valid": false,
  "issues": [
    {"code": "dependency_error", "path": "manifest.dependencies", "message": "..."}
  ]
}
```

HTTP 200 với `valid:false` nghĩa là đã kiểm tra được nhưng cấu hình chưa hợp lệ. HTTP 400 là envelope/query sai; 401/403 là lỗi danh tính/quyền; 503 là thiếu dịch vụ. Khi sửa xong, caller vẫn phải dùng API install/publish hiện có; preflight thành công không bảo đảm cấu hình không đổi trước khi install.

`GET /v1/studio/modules/:id/versions/:version/dependencies` yêu cầu `workflow:design`, trả các tham chiếu trực tiếp của đúng module trong đơn vị: schema IDs, workflow versions nếu đã pin, block versions, business bindings và module dependencies. Đây không phải trình tự nâng cấp hoặc migration tự động. Schema IDs đơn lẻ không được gán phiên bản giả; binding mới là nơi giữ schema publication đã pin.

## Lịch sử workflow

```text
GET /v1/workflows/:id/history
GET /v1/workflows/:id/history?limit=50&offset=0
```

Không query: giữ `{items}` với tối đa 100 sự kiện đầu như trước. Có `limit` hoặc `offset`: trả `{items,page}`, giới hạn 1–100, mặc định limit50/offset0, thứ tự ổn định theo version và ID. Đọc tiếp bằng `page.nextOffset` khi `page.hasMore=true`; không tự kết luận hết dữ liệu chỉ từ độ dài trang. Không hỗ trợ `q` hay query tùy ý trên lịch sử. Quyền đọc workflow được kiểm tra ở cả hai chế độ.

Transition mới có trường `reason` được khai báo kiểu `text` sẽ lưu giá trị đã validate vào `metadata.reason` của sự kiện audit. Không sao chép toàn bộ input, không suy từ run.data và không điền ngược lịch sử cũ. Trần hiện có là 2000 Unicode code points. Audit, thay đổi trạng thái và receipt cùng transaction; bước thất bại không tạo quyết định dở dang. Caller Timeline cần coi lý do vắng mặt là không có bằng chứng, không lấy lý do hiện tại thay thế.

## Lỗi và tương thích

API Studio mới dùng `{error:{code,message}}`; caller nên dựa vào code, không so khớp câu mô tả. Lỗi cũ của workflow/action được giữ nguyên. Không đổi toàn bộ client sang một envelope mới trong đợt này.

GET của Studio không nhận body; query/body không khai báo bị từ chối. Không gửi tenant, roles hay actor trong payload để thay quyền JWT.

## Mapping giữa entity và Asset bên ngoài

Mọi endpoint context yêu cầu `data:read` và quyền đọc entity hiện tại trong đơn vị JWT. PUT/DELETE yêu cầu thêm `data:design`. Biết UUID, thấy capability hoặc có receipt cũ không thay thế quyền hiện tại; sau khi thu hồi share, replay cũng bị từ chối. Entity không tồn tại/không được đọc trả 404. Bob thiếu `data:read` nhận 403 chỉ chứng minh role denial, không chứng minh tenant isolation.

| Method và đường dẫn | Kết quả HTTP 200 |
| --- | --- |
| `GET /v1/entities/:id/context-links/ngsi-ld` | `{version:1,entityId,mapping}`; mapping null trước lần gắn đầu |
| `PUT /v1/entities/:id/context-links/ngsi-ld` | Mapping mới: provider, entityId, externalId, revision, updatedAt |
| `DELETE /v1/entities/:id/context-links/ngsi-ld` | Mapping tombstone: externalId null, revision tăng |
| `GET /v1/entities/:id/context-links/ngsi-ld/history?limit=50&offset=0` | `{items,page}` theo revision giảm dần; không nhận q |
| `GET /v1/entities/:id/context` | `{version:1,entityId,mapping,status,freshnessThresholdSeconds:300,observation}` |

PUT nhận chính xác `{externalId,expectedRevision}`, DELETE nhận chính xác `{expectedRevision}`. Cả hai bắt buộc header `Idempotency-Key`. `externalId` có dạng `urn:ngsi-ld:Asset:<organizationId>:<businessId>` với organizationId trùng JWT; businessId dài 1–128 ký tự trong `[A-Za-z0-9_-]`. Không nhận tenant override, URL, SQL hoặc adapter tùy ý. Tạo lần đầu dùng expectedRevision0, nhận revision1; cập nhật hoặc gỡ dùng revision đang đọc. Gắn lại sau tombstone dùng revision của tombstone, không quay về 0.

Một externalId đang hoạt động chỉ được gắn vào một entity trong cùng organization/provider. Request cùng operation, key và input trả lại kết quả đã chấp nhận, kể cả sau lần sửa tiếp theo; kết quả replay có thể là revision cũ. Cùng key nhưng khác input trả `idempotency_conflict`; key mới với revision cũ trả `revision_conflict`; trùng liên kết đang hoạt động trả `external_id_conflict` (đều 409). Khi gặp conflict, đọc lại mapping và yêu cầu người dùng xác nhận quyết định mới trước khi gửi key mới. Mapping, audit và receipt commit nguyên tử. Gỡ giữ lịch sử và tombstone; không xóa audit.

Audit mapping chỉ gồm entityId, provider, actorId, operation (`link`/`remove`), fromRevision, toRevision, externalId và occurredAt. Không dùng audit làm bằng chứng broker đã nhận dữ liệu.

Ví dụ dưới đây dành cho shell có cú pháp biến POSIX, với `TOKEN`, `ENTITY_ID` và `ORGANIZATION_ID` lấy từ phiên đã xác thực. Đặt key mới cho quyết định mới; giữ nguyên key/body khi retry cùng quyết định. Không ghi JWT vào log hoặc tài liệu nghiệm thu.

```sh
curl -sS http://localhost:8080/v1/me/capabilities \
  -H "Authorization: Bearer $TOKEN"
curl -sS "http://localhost:8080/v1/entities/$ENTITY_ID/context-links/ngsi-ld" \
  -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-link-decision-1' \
  --data "{\"externalId\":\"urn:ngsi-ld:Asset:$ORGANIZATION_ID:asset-42\",\"expectedRevision\":0}"
curl -sS "http://localhost:8080/v1/entities/$ENTITY_ID/context" \
  -H "Authorization: Bearer $TOKEN"
curl -sS "http://localhost:8080/v1/entities/$ENTITY_ID/context-links/ngsi-ld" \
  -X DELETE -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-remove-decision-2' --data '{"expectedRevision":1}'
```

## Nguồn quan sát và giới hạn

Engine PostgreSQL giữ dữ liệu nghiệp vụ có thẩm quyền. Adapter chỉ đọc projection cố định `public.ngsi_ld_asset_context` bằng truy vấn tham số hóa theo organization và externalId đã gắn. Nó không tạo receiver, ghi projection, đổi business entity/workflow state hoặc nhận URL nguồn từ caller. Bật `NGSI_LD_CONTEXT_READ=true` cho API mới cho phép đọc nguồn; mặc định `false`, compose chuyển tiếp cờ này vào container. Không bật cờ để giả lập receiver đang hoạt động.

| status HTTP 200 | Ý nghĩa |
| --- | --- |
| `not_linked` | Chưa gắn hoặc đã gỡ; observation null |
| `source_unavailable` | Cờ đọc tắt hoặc chưa có relation nguồn; observation null |
| `no_observation` | Nguồn tồn tại nhưng không có bản ghi đúng tenant/externalId |
| `fresh` | Quan sát hợp lệ, observedAt không quá 300 giây |
| `stale` | Quan sát hợp lệ nhưng observedAt cũ hơn 300 giây |

Observation chỉ chứa provider, externalId, status (`ready`, `in_use`, `repair`, `retired`), observedAt và receivedAt. Tuổi tính bằng observedAt; receivedAt không làm mới dữ liệu cũ. Provenance/businessId/status/timestamp sai trả HTTP503 `source_invalid`; truy vấn nguồn lỗi trả HTTP503 `source_unavailable`. Phân biệt mã lỗi này với status HTTP200 cùng tên. Không chuyển những trường hợp thiếu nguồn thành thành công đồng bộ hoặc broker delivery.

Lỗi ổn định khác gồm `invalid_request`400, `invalid_token`401, `authority_denied`403, `not_found`404, `entity_archived`/`resource_conflict`409 và `identity_unavailable`/`runtime_unavailable`503. API trả lỗi đã sanitize; UI nên giữ nội dung thiết kế, cho phép retry khi dịch vụ trở lại và không phơi dữ liệu nguồn thô.

## Khởi động, kiểm tra và bàn giao

Hợp đồng máy đọc nằm trong [studio-context-api.openapi.json](studio-context-api.openapi.json), dùng OpenAPI3.1 và bearer JWT. Gateway thêm allowlist GET capabilities/catalog/dependencies và POST preflight, giữ openid-connect, request-id và rate limit hiện có. Context/entity và workflow history dùng các family đã được bảo vệ. Không expose endpoint receiver mới.

```sh
pnpm exec vitest run tests/studio-context-contract.test.ts
pnpm check
pnpm backup:core
# Sau review và backup thành công, chỉ rebuild API và reload Gateway khi cấu hình đổi.
docker --context desktop-linux compose -f infra/compose/core.yml up -d --build api
docker --context desktop-linux compose -f infra/compose/core.yml restart gateway
pnpm test:studio-context
node scripts/acceptance-studio-context-postgres.mjs
```

Lệnh backup là snapshot, không restore/reset. Không cần restart NocoBase, broker, n8n hoặc agents cho thay đổi này. Chỉ chạy smoke trên stack local đã sẵn sàng và đúng Docker context. Smoke đăng nhập fixture local sẵn có (alice/warehouse/bob), không seed lại tài khoản/role, chỉ chấp nhận URL loopback HTTP. Có thể đặt `STUDIO_CONTEXT_API_URL`, `STUDIO_CONTEXT_IDENTITY_URL`, `STUDIO_CONTEXT_PASSWORD_ALICE`, `STUDIO_CONTEXT_PASSWORD_WAREHOUSE`, `STUDIO_CONTEXT_PASSWORD_BOB` trong process khi local fixture dùng cấu hình khác. `STUDIO_CONTEXT_FOREIGN_TOKEN` tùy chọn phải có data:read và organization khác để kiểm tra HTTP404 xuyên tenant; không in token ra output.

Smoke tạo module/schema/entity/workflow có ID riêng mỗi lần và giữ fixture để điều tra. Nó kiểm tra preflight không install, dependency DTO, mapping revision/replay/conflict/audit, nguồn chưa khả dụng và 105 transition để xác nhận lịch sử 106 sự kiện: legacy100 và paged đầy đủ, reason bất biến, privateNote không lộ vào audit. Smoke mặc định kỳ vọng nguồn unavailable; các trạng thái nguồn có dữ liệu được kiểm tra trong database riêng. Pacing tránh hạn mức Gateway120/phút; một lượt có thể mất vài phút. Output chỉ ghi IDs, stage và kết quả.

Helper PostgreSQL cần API image có source/tsx và quyền tạo database trên PostgreSQL local. Nó tạo database tên ngẫu nhiên `studio_context_acceptance_<random>`, kiểm tra tên database trước khi tạo fixture, rồi drop chỉ database đó khi kết thúc. Mọi directory/share/projection fixture chỉ nằm trong database riêng này, không dùng search_path để đụng projection public của stack chính. Helper kiểm tra pool max1, tenant/current ACL, receipt replay sau thu hồi share, rollback muộn, uniqueness và replay đồng thời, audit sau gỡ, và nguồn tắt/thiếu/rỗng/fresh/stale/sai/lỗi query. Nếu cleanup lỗi, chỉ database có prefix ngẫu nhiên đó có thể còn lại để điều tra có redaction; không xóa database hoặc volume hiện hữu.

Các lệnh và phạm vi trên là hướng dẫn vận hành, không tự chứng nhận đã chạy. Kết quả cụ thể, backup, fixture IDs và giới hạn nghiệm thu phải được ghi trong `docs/verification.md` và ledger bởi người thực hiện; không suy từ việc có script rằng broker thật đã được triển khai hoặc đồng bộ.

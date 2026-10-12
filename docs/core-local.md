# Core local của LatticeDX

## Phạm vi

Keycloak cấp access token; APISIX kiểm tra bearer token và định tuyến; API kiểm tra lại chữ ký RS256, issuer, audience, subject, thời hạn và role. PostgreSQL giới hạn hồ sơ theo chủ sở hữu và đơn vị `organization_id` lấy từ token đã ký. Client không được chọn owner hoặc đơn vị.

Đây là bản phát triển local. Chưa có SSO trong web/NocoBase, refresh/session UI, workflow UC1 đầy đủ hoặc agent thật. API hồ sơ có scope đơn vị, chưa phải multi-tenancy đầy đủ của toàn nền tảng. Role cấp quyền hành động; owner + organization filter giới hạn dữ liệu. Không tuyên bố hoàn tất Zero-Trust/GitOps.

## Chạy

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm test:infra
```

`test:infra` đợi dịch vụ sẵn sàng, lấy token cho hai người dùng, tạo hồ sơ thật, đọc lại, kiểm tra người dùng khác không thấy hồ sơ và không được tạo. Mỗi lần chạy thêm một hồ sơ smoke. Không xóa volume tự động.

```sh
pnpm infra:logs
pnpm infra:down
```

Down giữ volume PostgreSQL. Dừng rồi chạy lại stack và truy vấn hồ sơ để kiểm chứng persistence. Script smoke kiểm tra persistence trong cùng phiên; không tự restart stack.

## Tài khoản công khai chỉ dành cho local

| Tài khoản | Mật khẩu fixture | Quyền |
| --- | --- | --- |
| Keycloak admin | `local-admin-password` | Quản trị Keycloak |
| alice | `local-alice-password` | records:read, records:write |
| bob | `local-bob-password` | records:read |

Database và gateway cũng dùng credential fixture trong Compose/config. Khi tạo môi trường khác phải thay credential, cấu hình TLS, secret management và authorization-code/PKCE. Password grant `dx-local` chỉ phục vụ script smoke, không dùng cho frontend production.

## API

- `GET /health`: tình trạng tiến trình API; không là readiness đầy đủ của tất cả dịch vụ.
- `POST /v1/records`: JSON `{ "title": "Hồ sơ mẫu" }`, cần role records:write.
- `GET /v1/records`: cần records:read; trả tối đa 100 hồ sơ gần nhất của subject và đơn vị hiện tại.

Token thiếu `organization_id` trả 403. Fixture alice thuộc `org-a`, bob thuộc `org-b`. Realm có sẵn cần thêm mapper/thuộc tính theo [hợp đồng nền](phase-one-handoff.md); không xóa dữ liệu cũ. Hồ sơ trước migration thiếu đơn vị được giữ nhưng không hiển thị cho đến khi quản trị gán scope có kiểm chứng.

Gọi API thông qua gateway ở http://localhost:8080. Keycloak issuer phải là `http://localhost:8081/realms/lattice` và audience phải có `dx-api`. Không thay `localhost` thành IP khác trong cấu hình issuer nếu không đồng thời sửa realm/client và runtime.

## Giới hạn bản đầu

- PostgreSQL init script tạo database Keycloak khi volume lần đầu được khởi tạo; không chạy lại trên volume có sẵn.
- API tạo bảng/index nếu chưa tồn tại lúc khởi động; cần migration có version trước khi thay đổi schema hoặc dùng production.
- Keycloak và API dùng chung DB role ở môi trường local; cần role/privilege riêng khi triển khai thật.
- Container API dùng tsx và development toolchain để chạy source; chưa tối ưu image production.
- Keycloak dùng start-dev và HTTP; cấu hình APISIX tắt SSL verify vì backchannel local HTTP.
- Phiên bản image được khóa bằng tag; cần bổ sung digest và kiểm tra dependency/image trước release.

Nếu Docker Engine chưa chạy, vẫn có thể `pnpm check` và `docker compose -f infra/compose/core.yml config --quiet`. Hai lệnh này không chứng minh stack container chạy được.

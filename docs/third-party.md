# Nguồn và giấy phép

Mã gốc LatticeDX dùng Apache-2.0, toàn văn ở root `LICENSE`. Giấy phép đó không thay giấy phép dependency. Source NocoBase được tham chiếu bằng submodule và không sao chép vào Docker build của API hoặc phạm vi Vitest. Runtime riêng dùng image upstream; kiểm tra nguồn/license ở `nocobase-source-review.md`.

| Thành phần trực tiếp | Nguồn / license |
| --- | --- |
| Next.js / React | https://github.com/vercel/next.js / https://github.com/facebook/react — MIT |
| Fastify | https://github.com/fastify/fastify — MIT |
| jose | https://github.com/panva/jose — MIT |
| node-postgres | https://github.com/brianc/node-postgres — MIT |
| Keycloak | https://github.com/keycloak/keycloak — Apache-2.0 |
| APISIX | https://github.com/apache/apisix — Apache-2.0 |
| PostgreSQL | https://www.postgresql.org/about/licence/ — PostgreSQL License |
| NocoBase runtime 2.2.38 | Image `nocobase/nocobase` khóa digest trong `infra/compose/nocobase.yml` và `infra/compose/native-rehearsal.yml`. Giữ các điều khoản và notices đi kèm đúng image. |
| Orion-LD 1.10.0, MongoDB 4.4.29 và n8n 2.42.7 | Dịch vụ ngoài trong `infra/compose/integration.yml`, khóa image theo digest. Đối chiếu điều khoản của từng bản trước khi phân phối image hoặc cung cấp dịch vụ. |
| ClamAV 1.4.3 | https://github.com/Cisco-Talos/clamav — GPL-2.0; chạy dịch vụ độc lập, không sao chép implementation vào API |

Thông tin trên là danh sách nguồn/license cấp project, không phải audit toàn bộ bản phân phối. Node, pnpm, TypeScript, Vitest, tsx, typings và dependency gián tiếp giữ thông báo riêng trong package. Linux image có thêm package hệ thống với license riêng.

Dependencies npm khóa bằng `pnpm-lock.yaml`; container tags ở `infra/compose/core.yml` và `apps/api/Dockerfile`. Trước phát hành: lưu bản license/NOTICE cần thiết, xuất danh sách dependency/SBOM, kiểm tra compatibility từng phiên bản, bổ sung image digest, ghi nguồn dữ liệu/model nếu có. Không đóng gói source upstream đã sửa mà không ghi nhận thay đổi và quyền phân phối.

Build từ nguồn của mã nhóm được mô tả ở README; source/build upstream tham khảo repository của từng thành phần. Container image có sẵn không được coi là thay thế hoàn toàn tài liệu build upstream trong hồ sơ dự thi.

## Phạm vi plugin native

| Package của nhóm | Phiên bản đã kiểm trong lab 09/11/2026 | Vai trò |
| --- | --- | --- |
| `@latticedx/plugin-lattice-foundation` | `0.25.1` | Collections nghiệp vụ, migration, guard và tích hợp native. |
| `@latticedx/plugin-enterprise-auth` | `0.1.0` | Cầu nối đăng nhập doanh nghiệp qua Keycloak. |
| `@latticedx/plugin-action-bridge` | `0.4.1` | Kết nối giao diện cũ với API LatticeDX. |

Ba package khai báo Apache-2.0 cho mã nhóm và có file `LICENSE` riêng. Build và cài plugin trên host NocoBase sử dụng SDK do host cung cấp. Giữ thông báo bản quyền và giấy phép của dependency được đóng gói cùng plugin theo phạm vi áp dụng của chúng.

Enterprise Login đóng gói các dependency dưới đây. Phiên bản và giấy phép được ghi trong [lockfile của plugin](../plugins/nocobase/plugin-enterprise-auth/package-lock.json). Các bản đã cài trong lab mang theo `LICENSE.md` riêng.

| Dependency đóng gói | Phiên bản | Giấy phép |
| --- | --- | --- |
| `openid-client` | `6.8.9` | MIT |
| `jose` | `6.2.15` | MIT |
| `oauth4webapi` | `3.8.8` | MIT |

Submodule `upstream/nocobase` khóa commit `5b47bec116c52239348c09d360e4bd2649c99efc` để khảo sát. Đối chiếu điều khoản và header của checkout này trong [ghi nhận source upstream](nocobase-source-review.md). Hồ sơ phân phối cần kiểm riêng nội dung image 2.2.38, dependency gián tiếp và các notices tương ứng. Inventory hiện tại ghi nhận nguồn và phạm vi đóng góp, chưa đủ để kết luận giấy phép cho toàn bộ bản phân phối.

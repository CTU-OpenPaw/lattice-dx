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
| NocoBase runtime 2.2.20 | https://github.com/nocobase/nocobase — điều khoản upstream riêng, chưa xác nhận Apache-2.0 thuần; giữ nguyên notices |
| ClamAV 1.4.3 | https://github.com/Cisco-Talos/clamav — GPL-2.0; chạy dịch vụ độc lập, không sao chép implementation vào API |

Thông tin trên là danh sách nguồn/license cấp project, không phải audit toàn bộ bản phân phối. Node, pnpm, TypeScript, Vitest, tsx, typings và dependency gián tiếp giữ thông báo riêng trong package. Linux image có thêm package hệ thống với license riêng.

Dependencies npm khóa bằng `pnpm-lock.yaml`; container tags ở `infra/compose/core.yml` và `apps/api/Dockerfile`. Trước phát hành: lưu bản license/NOTICE cần thiết, xuất danh sách dependency/SBOM, kiểm tra compatibility từng phiên bản, bổ sung image digest, ghi nguồn dữ liệu/model nếu có. Không đóng gói source upstream đã sửa mà không ghi nhận thay đổi và quyền phân phối.

Build từ nguồn của mã nhóm được mô tả ở README; source/build upstream tham khảo repository của từng thành phần. Container image có sẵn không được coi là thay thế hoàn toàn tài liệu build upstream trong hồ sơ dự thi.

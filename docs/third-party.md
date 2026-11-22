# Nguồn và giấy phép

Mã gốc LatticeDX dùng Apache-2.0, toàn văn ở root [`LICENSE`](../LICENSE) và thông báo phân tách phạm vi tại [`NOTICE`](../NOTICE). Giấy phép đó không thay thế giấy phép dependency hay dịch vụ container bên ngoài. Source NocoBase được tham chiếu bằng submodule `upstream/nocobase` và không sao chép vào Docker build của API, phạm vi Vitest hay gói phát hành `.tar.gz`. Runtime riêng dùng image upstream; kiểm tra nguồn/license ở [nocobase-source-review.md](nocobase-source-review.md).

| Thành phần trực tiếp | Nguồn / license / Digest Compose |
| --- | --- |
| Next.js / React | https://github.com/vercel/next.js / https://github.com/facebook/react — MIT |
| Fastify | https://github.com/fastify/fastify — MIT |
| jose | https://github.com/panva/jose — MIT |
| node-postgres | https://github.com/brianc/node-postgres — MIT |
| Keycloak 26.8.0 | https://github.com/keycloak/keycloak — Apache-2.0 (`quay.io/keycloak/keycloak:26.8.0@sha256:27b3230fbabb8c9ff3c66c864cf09dcd8a41aca82e5100679d109ef0eeb05741` trong `infra/compose/core.yml`) |
| APISIX 3.19.0 | https://github.com/apache/apisix — Apache-2.0 (`apache/apisix:3.19.0-debian@sha256:9a7e45dc943fbf10ec916d1232bae4cda9302ae28a4696cfb83c2da01d261141` trong `infra/compose/core.yml`) |
| PostgreSQL 16.13 | https://www.postgresql.org/about/licence/ — PostgreSQL License (`postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50` trong `core.yml`, `nocobase.yml`, `native-rehearsal.yml`) |
| NocoBase runtime 2.2.38 | `nocobase/nocobase:2.2.38@sha256:90028473fe54b1fd1929b1ab0669a12e48a9a8f100d41662c98bc3c618225f4e` trong `infra/compose/nocobase.yml` và `infra/compose/native-rehearsal.yml` — NocoBase License Agreement (2026-02-24: Apache-2.0 + Clauses 4.2, 5.1–5.4; một số package/plugin mang AGPL-3.0 / Commercial). |
| FIWARE Orion-LD 1.10.0 | https://github.com/FIWARE/context.Orion-LD — AGPL-3.0 (`fiware/orion-ld:1.10.0@sha256:3c490a746f6596e24875b046719b97fa5ede39cbb364e3c93d144de2f00898dc` trong `infra/compose/integration.yml`); giao tiếp qua HTTP NGSI-LD |
| MongoDB 4.4.29 | https://github.com/mongodb/mongo — SSPL-1.0 (`mongo:4.4.29@sha256:52c42cbab240b3c5b1748582cc13ef46d521ddacae002bbbda645cebed270ec0` trong `infra/compose/integration.yml`); DB container riêng cho Orion-LD |
| n8n 2.42.7 | https://github.com/n8n-io/n8n — Sustainable Use License (non-OSI; `n8nio/n8n:2.42.7@sha256:906dd7fb0a2f23869001d1767168359489c518ff34d4f67427abf2dc59e868fe` trong `infra/compose/integration.yml`); dịch vụ tự động hóa độc lập |
| ClamAV 1.4.3 | https://github.com/Cisco-Talos/clamav — GPL-2.0 (`clamav/clamav:1.4.3@sha256:75fb5fd95fcbe1d7e6d240c369c1572b686ee2c95949d1042b5148de8eddebb4` trong `infra/compose/core.yml`); chạy dịch vụ độc lập qua TCP socket |

Thông tin trên là danh sách nguồn/license cấp project, không phải tư vấn pháp lý toàn diện. Node, pnpm, TypeScript, Vitest, tsx, typings và dependency gián tiếp giữ thông báo riêng trong package (`123` nhóm entry trong [dependency-inventory.md](dependency-inventory.md)). Linux image có thêm package hệ thống với license riêng.

Dependencies npm khóa bằng `pnpm-lock.yaml`; container images trong `infra/compose/*.yml` đều khóa digest `@sha256:`. Quy trình build từ nguồn được ghi tại [build-from-source.md](build-from-source.md), kiểm toán PoF tại [oss-pof-compliance.md](oss-pof-compliance.md).

## Phạm vi plugin native

| Package của nhóm | Phiên bản hiện tại | Vai trò |
| --- | --- | --- |
| `@latticedx/plugin-lattice-foundation` | `0.25.1` | Collections nghiệp vụ, migration, guard, Multi-Portal UI và tích hợp native. |
| `@latticedx/plugin-enterprise-auth` | `0.1.0` | Cầu nối đăng nhập doanh nghiệp qua Keycloak (OIDC + PKCE). |
| `@latticedx/plugin-action-bridge` | `0.4.1` | Kết nối giao diện và action proxy với API LatticeDX. |
| `@latticedx/plugin-dxos-para` | `0.1.0` | Không gian tri thức P.A.R.A. (`latticeParaDocuments`), ACL 7 vai trò, org-scope và `latticePara:summary`. |
| `@latticedx/plugin-dxos-blocks` | `0.1.0` | 6 Native v2 `BlockModel` tùy biến trong UI Editor và 2 API scoped (`dxosBlocks:proposals`, `contextTelemetry`). |
| `@latticedx/plugin-dxos-studio` | `0.1.0` | Màn hình `/admin/settings/dxos-studio`, 4 mẫu quy trình Poka-yoke, `composePortals` và `latticeServiceTickets`. |

Sáu package khai báo `Apache-2.0` cho mã nhóm, có file `LICENSE` + `README.md` riêng và dùng SDK từ host (`sdkProvidedByHost: true`). Giữ thông báo bản quyền và giấy phép của dependency được đóng gói cùng plugin theo phạm vi áp dụng của chúng; xem tổng hợp tại [`COPYRIGHT.txt`](../COPYRIGHT.txt).

Enterprise Login đóng gói các dependency dưới đây. Phiên bản và giấy phép được ghi trong [lockfile của plugin](../plugins/nocobase/plugin-enterprise-auth/package-lock.json). Các bản đã cài mang theo `LICENSE.md` riêng.

| Dependency đóng gói | Phiên bản | Giấy phép |
| --- | --- | --- |
| `openid-client` | `6.8.9` | MIT |
| `jose` | `6.2.15` | MIT |
| `oauth4webapi` | `3.8.8` | MIT |

Submodule `upstream/nocobase` khóa commit `5b47bec116c52239348c09d360e4bd2649c99efc` để khảo sát. Đối chiếu điều khoản và header của checkout này trong [ghi nhận source upstream](nocobase-source-review.md). Gói phát hành nguồn (`pnpm release:tarball`) không bundle mã nguồn upstream hay `node_modules/`.

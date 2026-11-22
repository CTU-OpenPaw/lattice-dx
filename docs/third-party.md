# Nguồn và giấy phép

Mã gốc LatticeDX dùng Apache-2.0, toàn văn ở root [`LICENSE`](../LICENSE) và thông báo phân tách phạm vi tại [`NOTICE`](../NOTICE). Giấy phép đó không thay thế giấy phép dependency hay dịch vụ container bên ngoài. Source NocoBase được tham chiếu bằng submodule `upstream/nocobase` và không sao chép vào Docker build của API, phạm vi Vitest hay gói phát hành `.tar.gz`. Runtime riêng dùng image upstream; kiểm tra nguồn/license ở [nocobase-source-review.md](nocobase-source-review.md).

| Thành phần trực tiếp | Nguồn / license / Digest Compose |
| --- | --- |
| React | https://react.dev — MIT (UI plugin NocoBase) |
| Fastify | https://github.com/fastify/fastify — MIT |
| jose | https://github.com/panva/jose — MIT |
| node-postgres | https://github.com/brianc/node-postgres — MIT |
| Keycloak 26.8.2 | https://github.com/keycloak/keycloak — Apache-2.0 (`quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3` trong `infra/compose/core.yml`, `prod.yml`) |
| APISIX 3.19.0 | https://github.com/apache/apisix — Apache-2.0 (`apache/apisix:3.19.0-debian@sha256:9a7e45dc943fbf10ec916d1232bae4cda9302ae28a4696cfb83c2da01d261141` trong `infra/compose/core.yml`, `prod.yml`) |
| PostgreSQL 16.16 | https://www.postgresql.org/about/licence/ — PostgreSQL License (`postgres:16.16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d` trong `core.yml`, `prod.yml`) |
| pgvector 0.8.1 (PG 16) | https://github.com/pgvector/pgvector — PostgreSQL License (`pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337` trong `nocobase.yml`, `native-rehearsal.yml`, `prod.yml`) |
| RustFS 1.0.6 | https://github.com/rustfs/rustfs — Apache-2.0 (`rustfs/rustfs:1.0.6@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a` trong `prod.yml`) |
| Caddy 2.10 | https://github.com/caddyserver/caddy — Apache-2.0 (`caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d` trong `prod.yml`) |
| NocoBase runtime 2.2.50 | `nocobase/nocobase:2.2.50@sha256:04b75164936e7314ef74d82844bc56c9f34ed7ff1ca976ca53ffac2d3c88d777` trong `infra/compose/nocobase.yml`, `native-rehearsal.yml` và `prod.yml` — NocoBase License Agreement (2026-02-24: Apache-2.0 + Clauses 4.2, 5.1–5.4; một số package/plugin mang AGPL-3.0 / Commercial; giữ Clause 5.2 `Powered by NocoBase`, `https://www.nocobase.com`). |
| FIWARE Orion-LD 1.12.0 | https://github.com/FIWARE/context.Orion-LD — AGPL-3.0 (`fiware/orion-ld:1.12.0@sha256:f562a93ed84cccae05063688e1c3605f75060d0c7b9cd004561eec43bcbd613b` trong `integration.yml`, `prod.yml`); giao tiếp qua HTTP NGSI-LD |
| MongoDB 8.0 | https://github.com/mongodb/mongo — SSPL-1.0 (`mongo:8.0@sha256:479e85ced54ffb8a40dade1dcde2da2a9ae858515b9415e9cc54bfb8f0575d01` trong `integration.yml`, `prod.yml`); DB container riêng cho Orion-LD |
| n8n 2.48.1 | https://github.com/n8n-io/n8n — Sustainable Use License (non-OSI; `n8nio/n8n:2.48.1@sha256:5e022f23ef9eaac3f51467e021610c218ed7eb5b41a05edb388ef1c8e00e009f` trong `integration.yml`, `prod.yml`); dịch vụ tự động hóa độc lập |
| ClamAV 1.5.5 | https://github.com/Cisco-Talos/clamav — GPL-2.0 (`clamav/clamav:1.5.5@sha256:12177441d1b40cef3c47b44c4090d59d4babc4c67bedd5af0fa315e603aa6dd8` trong `core.yml`, `prod.yml`); chạy dịch vụ độc lập qua TCP socket |
| Eclipse Mosquitto 2.0.21 | https://github.com/eclipse-mosquitto/mosquitto — EPL-2.0 (`eclipse-mosquitto:2.0.21@sha256:94f5a3d7deafa59fa3440d227ddad558f59d293c612138de841eec61bfa4d353` trong `iiot.yml`); MQTT broker IIoT chuẩn OSI |
| Node-RED 4.0.9 | https://github.com/node-red/node-red — Apache-2.0 (`nodered/node-red:4.0.9@sha256:0b295b3a14c512548567ca99db631bc37b23bfc79fd009ee8248a610fafdb4b5` trong `iiot.yml`); chuẩn hóa giao thức IIoT |
| TimescaleDB OSS 2.19.3 | https://github.com/timescale/timescaledb — Apache-2.0 (`timescale/timescaledb:2.19.3-pg16-oss@sha256:769f2b43c7dac8e50887de2b49aff971dc5a8cf4aedfe2045d8b77eca2924a72` trong `iiot.yml`); kho chuỗi thời gian OSS thuần |

## Cam kết Thuần khiết Giấy phép OSS (OSS License Purity Guarantee)

Khi thiết kế kiến trúc mở rộng `v0.3.0`, nhóm **CTU-OpenPaw** chủ động loại bỏ hoàn toàn các thành phần mang giấy phép nguồn hạn chế **BSL-1.1** (ví dụ **ThingsBoard**, **EMQX**) khỏi ngăn xếp IIoT và quan sát hệ thống, thay thế 100% bằng các giải pháp được OSI phê chuẩn (permissive / weak-copyleft):
- **Node-RED (`Apache-2.0`)**, **TimescaleDB bản `-oss` (`Apache-2.0`)**, **OpenTelemetry Collector (`Apache-2.0`)** và **Prometheus (`Apache-2.0`)** thay cho các nền tảng phân tích/IIoT có điều khoản BSL-1.1 hoặc TSL.
- **Eclipse Mosquitto (`EPL-2.0`)** thay cho EMQX nhằm bảo đảm broker MQTT thuần OSI weak-copyleft.
- **Gotenberg (`MIT`)** cho kết xuất tài liệu container hóa tùy chọn.

Thông tin trên là danh sách nguồn/license cấp project, không phải tư vấn pháp lý toàn diện. Node, pnpm, TypeScript, Vitest, tsx, typings và dependency gián tiếp giữ thông báo riêng trong package (`123` nhóm entry trong [dependency-inventory.md](dependency-inventory.md)). Linux image có thêm package hệ thống với license riêng.

Dependencies npm khóa bằng `pnpm-lock.yaml`; container images trong `infra/compose/*.yml` đều khóa digest `@sha256:`. Quy trình build từ nguồn được ghi tại [build-from-source.md](build-from-source.md), kiểm toán PoF tại [oss-pof-compliance.md](oss-pof-compliance.md).

## Phạm vi plugin native

| Package của nhóm | Phiên bản hiện tại | Vai trò |
| --- | --- | --- |
| `@latticedx/plugin-lattice-foundation` | `0.27.0` | Collections nghiệp vụ, migration, guard, Multi-Portal UI, Record Chatter, Chứng từ bất biến, Chuông thông báo SSE, SLA Engine và tích hợp native. |
| `@latticedx/plugin-enterprise-auth` | `0.3.0` | Cầu nối đăng nhập doanh nghiệp qua Keycloak (OIDC + PKCE), Redis session cache, Backchannel Logout và đồng bộ vai trò 2 chiều. |
| `@latticedx/plugin-action-bridge` | `0.3.0` | Kết nối giao diện và action proxy với API LatticeDX. |
| `@latticedx/plugin-dxos-para` | `0.3.0` | Không gian tri thức P.A.R.A. (`latticeParaDocuments`), trích xuất PDF/DOCX (`latticeParaChunks`), ACL 7 vai trò và Semantic Neural + Hybrid RAG (`latticePara:hybridSearch`, `reindex`). |
| `@latticedx/plugin-dxos-blocks` | `0.3.0` | 7 Native v2 `BlockModel` tùy biến trong UI Editor, IIoT `telemetryIngest` + biểu đồ `timeseries-line`, xuất báo cáo RBAC CSV/XLSX/PDF Unicode và Command Palette `Ctrl+K`. |
| `@latticedx/plugin-dxos-studio` | `0.3.0` | Màn hình `/admin/settings/dxos-studio`, 4 mẫu quy trình Poka-yoke, `composePortals` + `/mobile`, Outbox/DLQ replay, GitOps Solution Bundle apply/rollback và `latticeServiceTickets`. |
| `@latticedx/plugin-dxos-ai` | `0.3.0` | Màn hình `/admin/settings/dxos-ai`, 15 Unified Tools, Nhân sự AI động, Hàng chờ Phê duyệt AI HITL (`latticeAiApprovalQueue`), Hạn mức AI bền vững PostgreSQL (`latticeAiQuotaUsage`), Time-Machine và 2-Way MCP Gateway. |

Cả bảy package khai báo `Apache-2.0` cho mã nhóm, có file `LICENSE` + `README.md` riêng và dùng SDK từ host (`sdkProvidedByHost: true`, `testedRuntime: "2.2.50"`). Giữ thông báo bản quyền và giấy phép của dependency được đóng gói cùng plugin theo phạm vi áp dụng của chúng; xem tổng hợp tại [`COPYRIGHT.txt`](../COPYRIGHT.txt).

Enterprise Login đóng gói các dependency dưới đây. Phiên bản và giấy phép được ghi trong [lockfile của plugin](../plugins/nocobase/plugin-enterprise-auth/package-lock.json). Các bản đã cài mang theo `LICENSE.md` riêng.

| Dependency đóng gói | Phiên bản | Giấy phép |
| --- | --- | --- |
| `openid-client` | `6.8.9` | MIT |
| `jose` | `6.2.15` | MIT |
| `oauth4webapi` | `3.8.8` | MIT |

Submodule `upstream/nocobase` khóa commit `5b47bec116c52239348c09d360e4bd2649c99efc` để khảo sát. Đối chiếu điều khoản và header của checkout này trong [ghi nhận source upstream](nocobase-source-review.md). Gói phát hành nguồn (`pnpm release:tarball`) không bundle mã nguồn upstream hay `node_modules/`.

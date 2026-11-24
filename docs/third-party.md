# Nguồn và giấy phép

Mã gốc LatticeDX **`v1.0.0`** dùng **Apache-2.0**, toàn văn ở root [`LICENSE`](../LICENSE) và thông báo phân tách phạm vi tại [`NOTICE`](../NOTICE). Giấy phép đó không thay thế giấy phép dependency hay dịch vụ container bên ngoài. **100% kho mã nguồn Git (`https://github.com/CTU-OpenPaw/lattice-dx`) và gói phát hành `latticedx-1.0.0-src.tar.gz` là mã nguồn thuần chuẩn OSI** (mã gốc `Apache-2.0` + các dependency npm chuẩn OSI), **hoàn toàn không chứa Git submodule `upstream/nocobase` hay tệp `.gitmodules`**. Runtime host NocoBase (`nocobase/nocobase:2.2.50`) chạy hoàn toàn độc lập dưới dạng OCI container bên ngoài kho Git lúc thực thi; xem phân tích ranh giới nguồn/license ở [nocobase-source-review.md](nocobase-source-review.md) và SBOM CycloneDX 1.5 tự động tại [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json).

## 1. Thành phần trực tiếp & toàn bộ 19 OCI Images khóa Digest `@sha256:`

Mọi định danh giấy phép dưới đây được đồng bộ 1-1 với `OCI_IMAGE_LICENSES` trong [`scripts/generate-sbom.mjs`](../scripts/generate-sbom.mjs) và [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json):

| Thành phần trực tiếp | Nguồn / Giấy phép (SPDX) / Digest Compose |
| --- | --- |
| React | https://react.dev — `MIT` (UI plugin NocoBase, host-provided) |
| `@xyflow/react` `12.12.1` | https://github.com/xyflow/xyflow — `MIT` (khai báo trong `devDependencies` của `plugin-dxos-studio`, đóng gói tại build time vào `dist/client/index.js` trong khi giữ NocoBase SDK / React / Antd host-external) |
| `@dagrejs/dagre` `3.1.3` | https://github.com/dagrejs/dagre — `MIT` (khai báo trong `devDependencies` của `plugin-dxos-studio`, bố cục đồ thị DAG tự động cho LatticeFlow v2 Studio) |
| `esbuild` `0.28.2` | https://github.com/evanw/esbuild — `MIT` (công cụ đóng gói plugin trong `devDependencies`) |
| Fastify `5.12.8` | https://github.com/fastify/fastify — `MIT` |
| jose `6.2.12` | https://github.com/panva/jose — `MIT` |
| node-postgres (`pg`) `8.23.1` | https://github.com/brianc/node-postgres — `MIT` |
| PostgreSQL `16.16` | https://www.postgresql.org/about/licence/ — `PostgreSQL` (`postgres:16.16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d` trong `infra/compose/core.yml`, `prod.yml`) |
| pgvector `0.8.1` (PG 16) | https://github.com/pgvector/pgvector — `PostgreSQL` (`pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337` trong `nocobase.yml`, `native-rehearsal.yml`, `prod.yml`; lưu luôn chuỗi thời gian IIoT `latticeTelemetryPoints` không cần container `timescaledb` tách rời) |
| Valkey `8.1` | https://github.com/valkey-io/valkey — `BSD-3-Clause` (`valkey/valkey:8.1-alpine@sha256:9971099af41c36e887aabdfe22b80c0fe45df949163dfc9cb434febc57cfc3fc` trong `nocobase.yml`, `prod.yml`; thuần OSI, tương thích giao thức Redis `PUBSUB_ADAPTER=redis`) |
| RustFS `1.0.6` | https://github.com/rustfs/rustfs — `Apache-2.0` (`rustfs/rustfs:1.0.6@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a` trong `prod.yml`) |
| Caddy `2.10` | https://github.com/caddyserver/caddy — `Apache-2.0` (`caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d` trong `prod.yml`) |
| Keycloak `26.8.2` | https://github.com/keycloak/keycloak — `Apache-2.0` (`quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3` trong `core.yml`, `prod.yml`) |
| keycloak-config-cli `6.5.1-26` | https://github.com/adorsys/keycloak-config-cli — `Apache-2.0` (`adorsys/keycloak-config-cli:6.5.1-26@sha256:1b22dfaa9ae0c71f74b0342f9221a6510f272da5def683dbba26a98e6b1b1411` trong `prod.yml`) |
| Apache APISIX `3.19.0` | https://github.com/apache/apisix — `Apache-2.0` (`apache/apisix:3.19.0-debian@sha256:9a7e45dc943fbf10ec916d1232bae4cda9302ae28a4696cfb83c2da01d261141` trong `core.yml`, `prod.yml`) |
| NocoBase runtime `2.2.50` | `nocobase/nocobase:2.2.50@sha256:04b75164936e7314ef74d82844bc56c9f34ed7ff1ca976ca53ffac2d3c88d777` trong `nocobase.yml`, `native-rehearsal.yml`, `prod.yml` — `NocoBase License Agreement (2026-02-24; Apache-2.0 + Clauses 4.2, 5.1-5.4)`; nạp **độc lập lúc chạy dưới dạng external host OCI container ngoài kho Git** (giữ Clause 5.2 `Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`). |
| FIWARE Orion-LD `1.12.0` | https://github.com/FIWARE/context.Orion-LD — `AGPL-3.0-only` (`fiware/orion-ld:1.12.0@sha256:f562a93ed84cccae05063688e1c3605f75060d0c7b9cd004561eec43bcbd613b` trong `integration.yml`, `prod.yml`); giao tiếp qua HTTP NGSI-LD |
| MongoDB `8.0` | https://github.com/mongodb/mongo — `SSPL-1.0` (`mongo:8.0@sha256:479e85ced54ffb8a40dade1dcde2da2a9ae858515b9415e9cc54bfb8f0575d01` trong `integration.yml`, `prod.yml`); DB container riêng cho Orion-LD |
| n8n `2.48.1` | https://github.com/n8n-io/n8n — `Sustainable Use License` (non-OSI; `n8nio/n8n:2.48.1@sha256:5e022f23ef9eaac3f51467e021610c218ed7eb5b41a05edb388ef1c8e00e009f` trong `integration.yml`, `prod.yml`); **container tích hợp tùy chọn độc lập bên ngoài** (không thuộc lõi engine tự động hóa của LatticeDX) |
| ClamAV `1.5.5` | https://github.com/Cisco-Talos/clamav — `GPL-2.0-only` (`clamav/clamav:1.5.5@sha256:12177441d1b40cef3c47b44c4090d59d4babc4c67bedd5af0fa315e603aa6dd8` trong `core.yml`, `prod.yml`); chạy dịch vụ độc lập qua TCP socket |
| Eclipse Mosquitto `2.0.21` | https://github.com/eclipse-mosquitto/mosquitto — `EPL-2.0 OR BSD-3-Clause` (`eclipse-mosquitto:2.0.21@sha256:94f5a3d7deafa59fa3440d227ddad558f59d293c612138de841eec61bfa4d353` trong `iiot.yml`, `prod.yml`); MQTT broker IIoT chuẩn OSI với Dynamic Security (`$CONTROL/dynamic-security/v1`) & `BIRTH`/`DEATH` LWT |
| Node-RED `4.0.9` | https://github.com/node-red/node-red — `Apache-2.0` (`nodered/node-red:4.0.9@sha256:0b295b3a14c512548567ca99db631bc37b23bfc79fd009ee8248a610fafdb4b5` trong `iiot.yml`, `prod.yml`); chuẩn hóa giao thức IIoT, cầu nối LWT & downlink Twin |
| OpenTelemetry Collector Contrib `0.123.0` | https://github.com/open-telemetry/opentelemetry-collector-contrib — `Apache-2.0` (`otel/opentelemetry-collector-contrib:0.123.0@sha256:e39311df1f3d941923c00da79ac7ba6269124a870ee87e3c3ad24d60f8aee4d2` trong `prod.yml`) |
| Prometheus `v3.3.0` | https://github.com/prometheus/prometheus — `Apache-2.0` (`prom/prometheus:v3.3.0@sha256:339ce86a59413be18d0e445472891d022725b4803fab609069110205e79fb2f1` trong `prod.yml`) |
| Grafana OSS `11.5.8` | https://github.com/grafana/grafana — `AGPL-3.0-only` (`grafana/grafana-oss:11.5.8@sha256:b8121de93047fd77c77de806bae9706e7d60de21c3bd5381a5db0167f94c6a48` trong `prod.yml`); dịch vụ dashboard quan sát 360° tách biên mạng container |
| Gotenberg `8.20.1` | https://github.com/gotenberg/gotenberg — `MIT` (`gotenberg/gotenberg:8.20.1@sha256:cda4386c7ed38f18bc6897828be01ba7361c99929a5c84ec5e293d7916e29bac` trong `prod.yml`); kết xuất PDF tùy chọn (profile `pdf`) |

## 2. Cam kết Thuần khiết Giấy phép OSS & SBOM CycloneDX 1.5

Khi phát triển từ nhánh `v0.3.0` lên **`v1.0.0`**, nhóm **CTU-OpenPaw** chủ động loại bỏ hoàn toàn các thành phần mang giấy phép nguồn hạn chế **BSL-1.1 / Business Source License** (như **ThingsBoard**, **EMQX**) khỏi toàn bộ mã nguồn, lockfile và OCI container:
- **Kiểm chứng tự động qua CycloneDX 1.5 SBOM:** Lệnh `pnpm release:sbom` (`node scripts/generate-sbom.mjs --out=docs/sbom-cyclonedx.json`) tạo hồ sơ [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json) gồm **`233` thành phần** (`workspace=12`, `npm=202`, `oci=19`, trong đó `232/233` thành phần có giấy phép đã phân giải — duy nhất `fsevents@2.3.3` là tùy chọn đặc thù macOS không cài trên Windows), đồng thời từ chối mọi gói hoặc image chứa `BSL-1.1`, `thingsboard` hoặc `emqx`.
- **Chuẩn hóa cache & IIoT thuần OSI (`Valkey 8.1` + `PG 16`):** Dùng **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause` thuần OSI)** cho session cache, pub/sub (`PUBSUB_ADAPTER=redis` tương thích giao thức) và rate-limiting, đồng thời lưu trực tiếp chuỗi thời gian IIoT vào **PostgreSQL `16`** (`latticeTelemetryPoints`) nên `infra/compose/iiot.yml` chỉ vận hành **Mosquitto `2.0.21` (`EPL-2.0 OR BSD-3-Clause`)** + **Node-RED `4.0.9` (`Apache-2.0`)** mà không cần container `timescaledb` tách rời.
- **Biên giới container tách biệt:** Host runtime **NocoBase `2.2.50`** và các dịch vụ ngoài như **Grafana OSS `11.5.8` (`AGPL-3.0-only`)**, **FIWARE Orion-LD `1.12.0` (`AGPL-3.0-only`)**, **ClamAV `1.5.5` (`GPL-2.0-only`)**, **MongoDB `8.0` (`SSPL-1.0`)** và **n8n `2.48.1` (`Sustainable Use License` — container tích hợp tùy chọn bên ngoài, không thuộc lõi automation engine của LatticeDX)** chỉ chạy qua tiến trình OCI tách biệt ngoài kho Git, giao tiếp qua giao thức mạng chuẩn (HTTP/TCP/SQL/MQTT) hoặc giao diện host SDK và không bị đóng gói tĩnh hay liên kết vào mã nguồn Apache-2.0 của LatticeDX.

Thông tin trên là danh sách nguồn/license cấp project, không phải tư vấn pháp lý toàn diện. Xem kiểm kê chi tiết các nhóm package npm trong [dependency-inventory.md](dependency-inventory.md), quy trình build từ nguồn trong [build-from-source.md](build-from-source.md) và checklist PoF trong [oss-pof-compliance.md](oss-pof-compliance.md).

## 3. Phạm vi 7 Plugin Native NocoBase (`v1.0.0`)

| Package của nhóm | Phiên bản | Vai trò |
| --- | :---: | --- |
| `@latticedx/plugin-lattice-foundation` | `1.0.0` | Collections nghiệp vụ, 7 vai trò `ldx_*`, Multi-Portal + Mobile Field PWA `/v/mobile`, PaaS API Keys (`ldx_pat_*`), Sổ cái Ed25519/Merkle PKI, Phân tầng Hot–Warm–Cold/Lineage/Quarantine/MKT, **42 bảng PostgreSQL RLS** (+ dynamic `latticeCustom*` RLS), **Connector & Secrets Vault (`dxosVault`, AES-256-GCM + SSRF allowlist)**, **Unified CloudEvents 1.0 + Standard Webhooks Event Bus (`dxosEvents`: PG Outbox `SKIP LOCKED`, HMAC-SHA256, Circuit Breaker 5 lỗi/120s, DLQ Replay)**, OpenAPI 3.1/AsyncAPI 3.0 & Prometheus `/api/dxos:metrics`. |
| `@latticedx/plugin-enterprise-auth` | `1.0.0` | Cầu nối đăng nhập doanh nghiệp qua Keycloak (OIDC + PKCE), Valkey `8.1` (tương thích giao thức Redis) session cache, Backchannel Logout và đồng bộ vai trò 2 chiều. |
| `@latticedx/plugin-action-bridge` | `1.0.0` | Kết nối giao diện và action proxy với API LatticeDX. |
| `@latticedx/plugin-dxos-para` | `1.0.0` | Không gian tri thức P.A.R.A. (`latticeParaDocuments`), trích xuất PDF/DOCX/XLSX/PPTX (`latticeParaChunks`), OCR Form Autofill (`latticePara:extractFormFields`), ACL 7 vai trò và Hybrid RAG `pgvector` HNSW + RRF. |
| `@latticedx/plugin-dxos-blocks` | `1.0.0` | **10 Native v2 `BlockModel`s** (bao gồm `DxosWebGisBlockModel` & `DxosKanbanScheduleBlockModel`), Digital Twin 2 chiều + Node-RED downlink, **Mosquitto Dynamic Security + LWT Device Registry & FIWARE Orion-LD 2-Way Subscriptions (`dxosBroker`)**, Bulk Import 2 pha, IIoT `telemetryIngest` + cảnh báo, xuất báo cáo RBAC CSV/XLSX/PDF Unicode và Command Palette `Ctrl+K`. |
| `@latticedx/plugin-dxos-studio` | `1.0.0` | Màn hình `/admin/settings/dxos-studio` (**9 tab Studio** + 6 Governance Consoles) & **Full-Screen LatticeFlow v2 DAG Studio (`/admin/settings/dxos-flow-studio`, 24 node types / 6 nhóm, Pause/Resume HITL, trigger cron/webhook, đóng gói build-time `@xyflow/react@12.12.1` + `@dagrejs/dagre@3.1.3` MIT qua `esbuild@0.28.2` từ `devDependencies`, giữ React/Antd/NocoBase host-external)**, OMS/WMS/FEFO/ePOD + `publicTrack`, DMN Engine, Ủy quyền vai trò, **Visual Domain Builder + 1-Click `cmms-maintenance` Pack + 1-Click Tenant Provisioning (`dxosBuilder`)**, 4 quy trình Poka-yoke, Outbox/DLQ và **GitOps Solution Bundle v3** (`latticedx.solution-bundle/v3`, gồm DMN, SLA, Incident Rules, `automationRules` & `webhookSubscriptions` đã che secret). |
| `@latticedx/plugin-dxos-ai` | `1.0.0` | Màn hình `/admin/settings/dxos-ai` (6 tab), **17 Unified AI Tools** (`11` Admin Builder gồm `dxos_configure_workflow` kết nối real-LLM **DX-OS Flow Architect** + `6` Operational), Proactive Incident Triage (`dxosAi:triageScan`), Hàng chờ AI HITL (`latticeAiApprovalQueue`), Hạn mức PostgreSQL (`latticeAiQuotaUsage`), Time-Machine và 2-Way MCP Gateway (`/api/dxos-mcp`, `/api/dxos-mcp/it-ot`). |

Cả bảy package khai báo `Apache-2.0` cho mã nhóm, có file `LICENSE` + `README.md` riêng và dùng SDK từ host (`sdkProvidedByHost: true`, `testedRuntime: "2.2.50"`). Ngoài `plugin-enterprise-auth` đóng gói runtime dependencies dưới đây, `plugin-dxos-studio` khai báo `@xyflow/react@12.12.1` (`MIT`), `@dagrejs/dagre@3.1.3` (`MIT`) và `esbuild@0.28.2` (`MIT`) trong `devDependencies` để đóng gói vào `dist/client/index.js` lúc build mà vẫn giữ nguyên `react`, `react-dom`, `antd` và `@nocobase/client` do host cung cấp (`sdkProvidedByHost: true`). Giữ thông báo bản quyền và giấy phép của dependency được đóng gói cùng plugin theo phạm vi áp dụng của chúng; xem tổng hợp tại [`COPYRIGHT.txt`](../COPYRIGHT.txt).

Enterprise Login đóng gói các dependency dưới đây. Phiên bản và giấy phép được ghi trong [lockfile của plugin](../plugins/nocobase/plugin-enterprise-auth/package-lock.json). Các bản đã cài mang theo `LICENSE.md` riêng.

| Dependency đóng gói | Phiên bản | Giấy phép |
| --- | --- | --- |
| `openid-client` | `6.8.9` | MIT |
| `jose` | `6.2.15` | MIT |
| `oauth4webapi` | `3.8.8` | MIT |

Kho mã nguồn Git của LatticeDX `v1.0.0` và gói phát hành nguồn `latticedx-1.0.0-src.tar.gz` (`pnpm release:tarball`) **không chứa `.gitmodules`, không có submodule `upstream/nocobase` và không bundle `node_modules/` hay bất kỳ mã nguồn upstream NocoBase nào**. Host runtime `nocobase/nocobase:2.2.50` chỉ được nạp dưới dạng OCI container độc lập lúc chạy; xem chi tiết ranh giới giấy phép trong [ghi nhận source upstream](nocobase-source-review.md).

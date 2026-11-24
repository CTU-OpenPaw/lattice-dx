<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX · Open-Core Digital Enterprise Platform (`v1.0.0`)

**LatticeDX `v1.0.0` (DX-OS Open-Core Championship Edition)** là **Hệ điều hành Doanh nghiệp Số nguồn mở 6 Phân hệ** (phát hành theo giấy phép **Apache-2.0**) do **CTU-OpenPaw** phát triển cho kỳ thi **OLP PMNM 2026 (VFOSSA)**. Nền tảng hợp nhất **Con người (`[H]`) – Quy trình (`[P]`) – Dữ liệu (`[D]`) – Trí tuệ (`[I]`)** qua **6 phân hệ điều phối**:
1. **Identity, Zero-Trust Edge & Security Guardrails:** Keycloak `26.8.2` OIDC + PKCE, **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause` thuần OSI, tương thích giao thức `PUBSUB_ADAPTER=redis`)** session cache & Backchannel Logout, Caddy `2.10` -> Apache APISIX `3.19.0` (`/api/*`), PaaS Scoped API Keys (`ldx_pat_*`), Sổ cái Ed25519/Merkle PKI, `apps/file-scanner` + ClamAV `1.5.5` + RustFS `1.0.6`, **Connector & Secrets Vault (`dxosVault`, AES-256-GCM, SSRF allowlist, live `testConnection`, rotation & masking)**, và **42 bảng PostgreSQL RLS** (+ dynamic `latticeCustom*` RLS).
2. **IT/OT Digital Twin, Mosquitto DynSec/LWT & Orion-LD 2-Way:** **FIWARE Orion-LD `1.12.0`** (entity diff + `/ngsi-ld/v1/subscriptions` đẩy ngược `/api/dxosBroker:orionNotify` -> `latticeTelemetryPoints` + `orion.notification` CloudEvent) + MongoDB `8.0`, **Eclipse Mosquitto `2.0.21` Dynamic Security** (`EPL-2.0 OR BSD-3-Clause`, `allow_anonymous false`, `$CONTROL/dynamic-security/v1` qua thuần `node:net` MQTT 3.1.1, ACL `latticedx/<orgId>/<deviceKey>/*`, `BIRTH`/`DEATH` LWT `device.offline`), **Node-RED `4.0.9`** (`Apache-2.0`) chuẩn hóa telemetry & downlink **2-Way Digital Twin Shadow** (IIoT time-series lưu trực tiếp trong **PostgreSQL `16`** `latticeTelemetryPoints`, không dùng container `timescaledb` tách rời), tính **Arrhenius MKT**, cách ly dữ liệu bất thường (Quarantine) và chuỗi khử trùng lặp cảnh báo.
3. **Unified CloudEvents 1.0 Event Bus, LatticeFlow v2 DAG Studio & Cold-Chain OMS/WMS/TMS:** **Event Bus CloudEvents 1.0 + Standard Webhooks (`dxosEvents`: PG Outbox `FOR UPDATE SKIP LOCKED`, `webhook-id`/`webhook-timestamp`/`webhook-signature` HMAC-SHA256, backoff + jitter, Circuit Breaker 5 lỗi/120s, DLQ Replay)**, **LatticeFlow v2 DAG Engine & Full-Screen Studio (`/admin/settings/dxos-flow-studio`, `@xyflow/react@12.12.1` + `@dagrejs/dagre@3.1.3` MIT: 24 loại node thuộc 6 nhóm, Pause/Resume HITL bền vững trên PostgreSQL, trigger cron/webhook, `dxosAutomations`: `Event -> DMN Table -> Actions`, `maxDepth 8`, `stepTracesJson` + Replay)**, **Live 2-Way `n8n` `2.48.1`** (`dxos-coldchain-alert-orchestrator.json`, `dxos-epod-partner-sync.json` xác thực Standard Webhooks HMAC & gọi ngược NocoBase bằng `ldx_pat_*`), OMS/WMS/FEFO/ePOD + `publicTrack` không PII, **DMN Decision Engine** và **Ủy quyền vai trò có thời hạn**.
4. **Multi-Portal, Mobile Field PWA (`/v/mobile`), Visual Domain Builder & GitOps v3:** Cổng đa vai trò `/p/*`, **`/p/cmms`** (từ gói **1-Click `cmms-maintenance`**), tuyến di động ngoại tuyến `/v/mobile` (`dxos:manifest`, `dxos:sw.js`), **10 Native v2 `BlockModel`s** (gồm `DxosWebGisBlockModel` & `DxosKanbanScheduleBlockModel`), **Visual Domain Builder (`dxosBuilder`: tạo runtime `latticeCustom*` + PG RLS + dynamic OpenAPI + RBAC + `/p/*`)**, **1-Click Tenant Provisioning**, trích xuất PDF/DOCX/XLSX/PPTX + OCR Form Autofill, **pgvector `0.8.1` HNSW + RRF Hybrid RAG** và **GitOps Solution Bundle v3** (`latticedx.solution-bundle/v3` gồm Schema, RBAC, Portals, Workflows, AI, Governance gồm DMN, SLA, Incident Rules, `automationRules` & `webhookSubscriptions` đã che secret).
5. **AI Workforce, DX-OS Flow Architect, Proactive Triage, HITL & 2-Way MCP Gateway:** **17 Unified AI Tools** (`11` Admin Builder gồm `dxos_configure_workflow` kết nối real-LLM **DX-OS Flow Architect** dựng/vá/tối ưu/test/resume đồ thị LatticeFlow v2 + `6` Operational gồm GraphRAG `#16 dxos_graph_impact_analysis` và Alarm `#17 dxos_alarm_action`), **Proactive Incident Triage Agent** (`dxosAi:triageScan`), Hàng chờ Phê duyệt Con người **HITL** (`latticeAiApprovalQueue` & cổng Digital Twin `|delta| > 2.0°C`), Hạn mức bền vững PostgreSQL + che PII Việt Nam, **2-Way Streamable MCP** (`/api/dxos-mcp`, `/api/dxos-mcp/it-ot` với Prompts & Resource Templates), **1 nút Agent nổi duy nhất (`PortalAgentLauncher`)**, và đánh giá `80` ca tiếng Việt tự nhiên.
6. **Plane #6 — Application Data & Observability Substrate:** **NocoBase `2.2.50`** vận hành cùng bộ **7 plugin Apache-2.0 (`1.0.0`)** (`sdkProvidedByHost: true`), đặc tả **OpenAPI 3.1.0 / AsyncAPI 3.0.0** (`/api/dxos:openapi`, `/api/dxos:asyncapi`), **Prometheus `v3.3.0`** (`/api/dxos:metrics` + `alerts.yml`), **OTel Collector `0.123.0`** và **Grafana OSS `11.5.8` Dashboard 360°**.

> - **Ma trận Ánh xạ Kiến trúc 1-1 Đề thi OLP PMNM 2026 (50 PoF + 50 Chung kết):** [docs/olp-2026-architecture-matrix.md](docs/olp-2026-architecture-matrix.md)
> - **Kịch bản Trình diễn Chung kết 15 phút (Live Demo + Q&A Defense + Fallback):** [docs/FINALS_15MIN_SCRIPT.md](docs/FINALS_15MIN_SCRIPT.md)
> - **Hướng dẫn Tự kiểm chứng 15 phút từ Bản cài Sạch (`v1.0.0`):** [docs/DEMO_PACK.md](docs/DEMO_PACK.md)
> - **Báo cáo kỹ thuật & Nghiệm thu chi tiết:** [docs/system-report-and-guide.md](docs/system-report-and-guide.md) · [docs/dxos-ai-and-mcp-acceptance.md](docs/dxos-ai-and-mcp-acceptance.md) · [docs/logistics-and-rbac-acceptance.md](docs/logistics-and-rbac-acceptance.md) · [docs/stack-backup-and-recovery.md](docs/stack-backup-and-recovery.md)
> - **Hồ sơ bản quyền, SBOM CycloneDX 1.5 & Build từ Mã nguồn:** [`COPYRIGHT.txt`](COPYRIGHT.txt) · [`NOTICE`](NOTICE) · [`LICENSE`](LICENSE) · [`docs/sbom-cyclonedx.json`](docs/sbom-cyclonedx.json) · [docs/build-from-source.md](docs/build-from-source.md) · [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md)

---

## 1. Kiến trúc Mô-đun 7 Plugin Open-Core (`1.0.0`) & 6 Phân hệ DX-OS (H–P–D–I)

Toàn bộ phần mở rộng NocoBase đặt trong `plugins/nocobase/*`, khai báo `"version": "1.0.0"`, `"license": "Apache-2.0"` và `"sdkProvidedByHost": true` (build và kiểm thử trực tiếp trên NocoBase `2.2.50`). **100% kho Git và gói phát hành `latticedx-1.0.0-src.tar.gz` là mã nguồn thuần chuẩn OSI**: hoàn toàn không chứa Git submodule `upstream/nocobase` hay tệp `.gitmodules` (runtime host NocoBase `2.2.50` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài kho Git), và giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`):

| Package | Phiên bản | Trụ cột | Vai trò chính |
| --- | :---: | :---: | --- |
| [`@latticedx/plugin-lattice-foundation`](plugins/nocobase/plugin-lattice-foundation/README.md) | `1.0.0` | `[D][H][I]` | Collections lõi, 7 vai trò `ldx_*`, Multi-Portal + **Mobile Field PWA (`/v/mobile`, `dxos:manifest`, `dxos:sw.js`)**, **PaaS API Keys (`ldx_pat_*`)**, **Sổ cái Ed25519/Merkle PKI**, **Phân tầng Hot–Warm–Cold / Data Lineage / Quarantine / Arrhenius MKT (`dxosDataGov:*`)**, **42 bảng PostgreSQL RLS** (+ dynamic `latticeCustom*` RLS), **Connector & Secrets Vault (`dxosVault`)**, **Unified CloudEvents 1.0 + Standard Webhooks Event Bus (`dxosEvents`)**, **OpenAPI 3.1.0 / AsyncAPI 3.0.0 / Prometheus `/api/dxos:metrics`**, Record Chatter, Chứng từ bất biến, Chuông SSE & SLA Engine. |
| [`@latticedx/plugin-dxos-para`](plugins/nocobase/plugin-dxos-para/README.md) | `1.0.0` | `[H]` | Không gian tri thức P.A.R.A. (`latticeParaDocuments`) với `uiManageable: true`, ACL 7 vai trò, tách `organizationId`, trích xuất **PDF/DOCX/XLSX/PPTX** (`latticeParaChunks`), **OCR Form Autofill (`latticePara:extractFormFields`)** và **Hybrid RAG `tsvector` + RRF + `pgvector` HNSW (`latticePara:hybridSearch`, `reindex`)**. |
| [`@latticedx/plugin-dxos-blocks`](plugins/nocobase/plugin-dxos-blocks/README.md) | `1.0.0` | `[H][P][D][I]` | **10 Native v2 `BlockModel`s** cấu hình trong `Add block` (gồm `DxosWebGisBlockModel`, `DxosKanbanScheduleBlockModel`, `DxosCreativeStudioBlockModel`, `DxosRecordWorkbenchBlockModel` kèm PKI/Lineage/In chứng từ sandbox...), **2-Way Digital Twin Shadow (`dxosBlocks:twin*`)**, **Mosquitto Dynamic Security + LWT Device Registry & FIWARE Orion-LD 2-Way Subscriptions (`dxosBroker:*`)**, **2-Phase Bulk Import (`bulkImportDryRun`/`Commit`)**, IIoT `telemetryIngest` + khử trùng lặp cảnh báo `Ack`/`Clear`, xuất báo cáo RBAC CSV/XLSX/PDF Unicode và Command Palette `Ctrl+K`. |
| [`@latticedx/plugin-dxos-studio`](plugins/nocobase/plugin-dxos-studio/README.md) | `1.0.0` | `[P][H][D]` | Bảng điều khiển `/admin/settings/dxos-studio` (**9 tab Studio** + **6 Governance Consoles**) & **Full-Screen LatticeFlow v2 DAG Studio (`/admin/settings/dxos-flow-studio`, `@xyflow/react@12.12.1` + `@dagrejs/dagre@3.1.3` MIT: 24 loại node thuộc 6 nhóm, Pause/Resume HITL bền vững, trigger cron/webhook & DX-OS Flow Architect drawer)**: cài 1-nhấp 4 quy trình Poka-yoke, dựng cổng đa-block + `/mobile`, **OMS/WMS/FEFO/ePOD + `publicTrack` (`dxosWms:*`)**, **DMN Engine (`dxosDmn:*`)**, **Ủy quyền vai trò (`dxosDelegations:*`)**, **Visual Domain Builder + 1-Click `cmms-maintenance` Pack + 1-Click Tenant Provisioning (`dxosBuilder:*`)**, Outbox/DLQ replay và **GitOps Solution Bundle v3 (`latticedx.solution-bundle/v3`)**. |
| [`@latticedx/plugin-dxos-ai`](plugins/nocobase/plugin-dxos-ai/README.md) | `1.0.0` | `[I][P][D][H]` | Trung tâm `/admin/settings/dxos-ai` (6 tab): Nhân sự AI động, **17 Unified Tools** (`11` Admin Builder gồm `dxos_configure_workflow` kết nối real-LLM **DX-OS Flow Architect** + `6` Operational gồm `#16 dxos_graph_impact_analysis` & `#17 dxos_alarm_action`), **Proactive Incident Triage (`dxosAi:triageScan`)**, **Hàng chờ Phê duyệt HITL (`latticeAiApprovalQueue`)**, 1 nút `PortalAgentLauncher` SSE, hạn mức PostgreSQL + che PII Việt Nam, Time-Machine và **2-Way MCP Gateway** (Prompts & Resource Templates). |
| [`@latticedx/plugin-enterprise-auth`](plugins/nocobase/plugin-enterprise-auth/README.md) | `1.0.0` | `[H]` | Đăng nhập Keycloak OIDC + PKCE ánh xạ về phiên NocoBase native, **Valkey `8.1`** (tương thích giao thức Redis) session cache, Backchannel Logout, đồng bộ nhóm→vai trò 2 chiều chống leo thang quyền và giao diện hủy liên kết. |
| [`@latticedx/plugin-action-bridge`](plugins/nocobase/action-bridge/README.md) | `1.0.0` | `[P][I]` | Cầu nối hành động và tương thích quy trình giữa API/Studio cốt lõi và giao diện `/lattice/*`. |

---

## 2. Khởi tạo Nhanh & Thử nghiệm Trình duyệt Sạch (`pnpm native:clean`)

Yêu cầu: **Node.js `24.x`** (`>=24 <25`), **pnpm `10.23.0`**, **Git**, **tar**, và **Docker Desktop / Docker Compose v2+** (khi chạy stack container).

```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
pnpm install --frozen-lockfile
```

### A. Build & Kiểm thử Monorepo + 7 Plugin (Offline / CI)

```sh
# 1. Build cả 7 plugin NocoBase
node plugins/nocobase/action-bridge/build.mjs
node plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs
node plugins/nocobase/plugin-enterprise-auth/build.mjs
node plugins/nocobase/plugin-dxos-para/build.mjs
node plugins/nocobase/plugin-dxos-blocks/build.mjs
node plugins/nocobase/plugin-dxos-studio/build.mjs
node plugins/nocobase/plugin-dxos-ai/build.mjs

# 2. Kiểm thử đơn vị 7 plugin + scripts PoF/demo + externals
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs tests/nocobase-externals.test.mjs

# 3. Đánh giá AI tiếng Việt tự nhiên (80 ca kiểm thử bao gồm GraphRAG, Alarm, DX-OS Flow Architect & Security Refusal)
node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95

# 4. Typecheck, Vitest workspace (apps + packages + tests) & build Node.js/TypeScript services
pnpm check
```

### B. Dựng môi trường NocoBase sạch từ DB 0 bảng (`NOCOBASE_VERSION=2.2.50`)

Lệnh dưới đây xuất mã nguồn từ `HEAD`, dựng PostgreSQL trống và runtime NocoBase ở cổng cô lập (ví dụ `13014`), cài và kích hoạt đủ 7 plugin Apache-2.0 (`1.0.0`), kiểm tra migrations và xuất file `report.json` nghiệm thu (chi tiết tại [docs/native-clean-install.md](docs/native-clean-install.md)):

```sh
pnpm native:clean --port=13014
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"

# Nạp 5 Starter AI Employees, Admin Builder, 2-Way IT/OT MCP Gateway & (khi có AGENT_API_KEY) local-9router
pnpm setup:dxos-ai -- --origin=http://localhost:13014

# Nạp dữ liệu trình diễn nền v0.3.0 & chuỗi lạnh/PaaS v1.0.0 idempotent (cung cấp NOCOBASE_TOKEN hoặc NOCOBASE_ADMIN_PASSWORD / --admin-password)
NOCOBASE_ADMIN_PASSWORD="<admin-password>" node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
NOCOBASE_ADMIN_PASSWORD="<admin-password>" pnpm seed:v100-showcase -- --origin=http://localhost:13014

# Nghiệm thu Headless PaaS v1.0.0 (8 bộ kiểm thử), AI Workforce + 17 Tools + MCP Prompts, Logistics 5 bước + RBAC âm tính, và DR toàn stack
pnpm acceptance:headless-paas -- --origin=http://localhost:13014
pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
pnpm acceptance:logistics-rbac -- "<path-to-report.json>"
pnpm backup:stack
pnpm backup:rehearse-stack -- "output/backups/stack/<bundle-id>"
```

Sau khi nạp demo, đăng nhập quản trị tại `http://localhost:13014` (`admin@nocobase.com` / `admin123`), mở **`/admin/settings/dxos-studio`** (9 tab Studio + 6 Governance Consoles), **`/admin/settings/dxos-flow-studio`** (LatticeFlow v2 DAG Studio toàn màn hình + **DX-OS Flow Architect**), **`/admin/settings/dxos-ai`** (6 tab AI Workforce, MCP & HITL), hoặc các cổng nghiệp vụ **`/p/logistics`**, **`/p/incidents`**, **`/p/procurement`**, **`/p/services`**, **`/p/cmms`** (sau cài pack `cmms-maintenance`) và tuyến di động **`/v/mobile`**.

---

## 3. Cấu trúc Kho mã nguồn

| Thư mục / Tệp | Trách nhiệm |
| --- | --- |
| `plugins/nocobase/*` | 7 plugin NocoBase độc lập (`1.0.0`, `Apache-2.0`, `sdkProvidedByHost: true`) và bộ kiểm thử `node --test`. |
| `apps/api`, `apps/agent-worker`, `apps/file-scanner` | Fastify API tích hợp (`apps/api`), worker thuần `node:http` (`apps/agent-worker`) và sidecar quét tệp ClamAV/RustFS thuần `node:http` (`apps/file-scanner`) (`@dx/*`). |
| `packages/contracts` | Hợp đồng schema và kiểm tra kiểu dùng chung (`@dx/contracts`). |
| `infra/compose/*.yml` & `infra/config/*` | Cấu hình Docker Compose khóa digest `@sha256:` cho **`19` OCI images** (`core.yml`, `nocobase.yml`, `iiot.yml`, `integration.yml`, `native-rehearsal.yml`, `prod.yml`: Caddy, APISIX, Keycloak, `pgvector/pgvector:0.8.1-pg16`, **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause`)**, RustFS, ClamAV, Orion-LD, MongoDB, n8n kèm `dxos-coldchain-alert-orchestrator.json` & `dxos-epod-partner-sync.json`, Mosquitto `2.0.21` DynSec + Node-RED `4.0.9` trên `iiot.yml`, OTel Collector, Prometheus, Grafana OSS `11.5.8`, Gotenberg). |
| `scripts/` | Công cụ clean-install, seed Multi-Portal/v1.0.0 Showcase, nghiệm thu Headless PaaS / AI MCP / Logistics RBAC, kiểm toán PoF (`verify-pof-readiness.mjs`), sinh SBOM CycloneDX 1.5 (`generate-sbom.mjs`) và đóng gói nguồn (`build-oss-release-tarball.mjs`). |
| `solutions/` | Hợp đồng mẫu Logistics (`solutions/logistics`) và định nghĩa quy trình/sự cố (`solutions/workflows`, `solutions/integration`). |

> **Kho mã nguồn 100% thuần chuẩn OSI:** Submodule cũ `upstream/nocobase` và tệp `.gitmodules` đã được gỡ bỏ hoàn toàn khỏi cây Git và gói phát hành nguồn `latticedx-1.0.0-src.tar.gz`; runtime host `nocobase/nocobase:2.2.50` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài kho Git (xem [docs/nocobase-source-review.md](docs/nocobase-source-review.md)).

Các biến môi trường mặc định được mô tả trong [`.env.example`](.env.example) và [`infra/compose/prod.env.example`](infra/compose/prod.env.example). **Không** triển khai mật khẩu demo local lên Internet; chỉ dùng cho môi trường đánh giá và phát triển cục bộ.

---

## 4. Tuân thủ Nguồn mở (OLP PMNM 2026 PoF)

```sh
node scripts/source-headers.mjs --check        # Xác minh 100% file nguồn gốc mang @copyright + SPDX Apache-2.0
pnpm pof:check                                 # Audit PoF (tài liệu quản trị, COPYRIGHT.txt, cô lập 7 plugin, digest Compose, sạch upstream-clean, không secret)
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:sbom                              # Sinh & kiểm tra docs/sbom-cyclonedx.json (CycloneDX 1.5: 233 components — workspace=12, npm=202, oci=19; 232/233 resolved)
pnpm release:sbom -- --check                   # Xác minh không trôi lệch SBOM & không BSL-1.1 / ThingsBoard / EMQX
pnpm release:tarball                           # Xuất output/release/latticedx-1.0.0-src.tar.gz + .sha256
```

- Toàn bộ quy trình đóng góp, phát hành, SBOM và kiểm kê dependency xem tại [`COPYRIGHT.txt`](COPYRIGHT.txt), [`NOTICE`](NOTICE), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md), [`docs/sbom-cyclonedx.json`](docs/sbom-cyclonedx.json), [docs/third-party.md](docs/third-party.md), [docs/dependency-inventory.md](docs/dependency-inventory.md) và [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md).
- Báo lỗi hoặc đề xuất cải tiến tại **GitHub Issues**: <https://github.com/CTU-OpenPaw/lattice-dx/issues>.

<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX · Open-Core Digital Enterprise Platform (`v0.4.2`)

**LatticeDX `v0.4.2` (DX-OS Open-Core Championship Edition)** là **Hệ điều hành Doanh nghiệp Số nguồn mở 6 Phân hệ** (phát hành theo giấy phép **Apache-2.0**) do **CTU-OpenPaw** phát triển cho kỳ thi **OLP PMNM 2026 (VFOSSA)**. Nền tảng hợp nhất **Con người (`[H]`) – Quy trình (`[P]`) – Dữ liệu (`[D]`) – Trí tuệ (`[I]`)** qua **6 phân hệ điều phối**:
1. **Identity, Zero-Trust Edge & Security Guardrails:** Keycloak `26.8.2` OIDC + PKCE, **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause` thuần OSI, tương thích giao thức `PUBSUB_ADAPTER=redis`)** session cache & Backchannel Logout, Caddy `2.10` -> Apache APISIX `3.19.0` (`/api/*`), PaaS Scoped API Keys (`ldx_pat_*`), Sổ cái Ed25519/Merkle PKI, `apps/file-scanner` + ClamAV `1.5.5` + RustFS `1.0.6`, **Connector & Secrets Vault (`dxosVault`, AES-256-GCM, OAuth2 PKCE S256 + single-flight refresh cho 11 app connector, SSRF allowlist, live `testConnection`, rotation & masking)**, và **56 bảng tĩnh PostgreSQL `FORCE ROW LEVEL SECURITY`** (`54` camelCase + `2` snake_case `lattice_native_request_attachments` & `lattice_native_request_uploads`, + dynamic `latticeCustom*` RLS gồm bảng nối `belongsToMany` + role không đặc quyền superuser `nocobase_app` fail-closed, migrations `20261127000100`..`20261205000100`).
2. **IT/OT Digital Twin, Mosquitto DynSec/LWT & Orion-LD 2-Way:** **FIWARE Orion-LD `1.12.0`** (entity diff + `/ngsi-ld/v1/subscriptions` đẩy ngược `/api/dxosBroker:orionNotify` -> `latticeTelemetryPoints` + `orion.notification` CloudEvent) + MongoDB `8.0`, **Eclipse Mosquitto `2.0.21` Dynamic Security** (`EPL-2.0 OR BSD-3-Clause`, `allow_anonymous false`, `$CONTROL/dynamic-security/v1` qua thuần `node:net` MQTT 3.1.1, ACL `latticedx/<orgId>/<deviceKey>/*`, `BIRTH`/`DEATH` LWT `device.offline`), **Node-RED `4.0.9`** (`Apache-2.0`) chuẩn hóa telemetry & downlink **2-Way Digital Twin Shadow** (IIoT time-series lưu trực tiếp trong **PostgreSQL `16`** `latticeTelemetryPoints`, không dùng container `timescaledb` tách rời), tính **Arrhenius MKT**, cách ly dữ liệu bất thường (Quarantine) và chuỗi khử trùng lặp cảnh báo.
3. **Unified CloudEvents 1.0 Event Bus, LatticeFlow v2 Draft/Publish, Approvals, Omnichannel & Stock `n8n`:** **Event Bus CloudEvents 1.0 + Standard Webhooks (`dxosEvents`: PG Outbox `FOR UPDATE SKIP LOCKED`, HMAC-SHA256, backoff + jitter, Circuit Breaker, DLQ Replay)**, **LatticeFlow v2 DAG Engine & Workflow Automation Studio (`Workflow -> Workflow Automation`, `/admin/settings/workflow/automation`, `@xyflow/react@12.12.1` + `@dagrejs/dagre@3.1.3` MIT: 24 loại node / 6 nhóm, tách `draftGraphJson` vs `publishedGraphJson` + rollback `latticeAutomationRuleVersions`, Live Canvas Step Trace + Webhook Copy-cURL, `ai.agent` ReAct nhiều lượt & `latticeflow.approval` HITL, trigger cron/webhook, `dxosAutomations`)**, **Multi-Level Approval Engine (tuần tự & song song `M-of-N` + `latticeDelegations`) & Unified Approval Inbox (`dxosApprovals:*`)**, **Omnichannel Notifications (`email_smtp`, `telegram`, `slack`, `webhook`)**, **Stock `n8n` `2.48.1` Public REST API v1 (`dxosN8n`, 10 endpoint + orchestrator 26 node + callback 2 chiều)**, OMS/WMS/FEFO/ePOD + **QR ISO/IEC 18004 SVG + `/v/track/:code` Ed25519** & **Visual Interactive DMN**.
4. **Multi-Portal, Mobile Field PWA (`/v/mobile`), Public Forms (`/v/form/:slug`), 12 BlockModels, WebGIS & GitOps v3:** Cổng đa vai trò `/p/*`, `/p/cmms`, `/p/partner-claims`, tuyến di động ngoại tuyến `/v/mobile`, **Public Form Builder (`/v/form/:slug` fail-closed zero-PII)**, **12 Native v2 `BlockModel`s** (gồm **`DxosBiChartBlockModel`** Bar/Line/Pie/KPI/Pivot + `dxosBlocks:aggregateQuery` + `dxosBlocks:collectionsMeta`, `DxosWebGisBlockModel` với **`maplibre-gl@6.19.0` (`BSD-3-Clause`)**, `DxosKanbanScheduleBlockModel` & `DxosWmsOpsBlockModel`), **Chuông Thông báo SSE Topbar**, **Rich Schema Engine (`dxosBuilder`: `hasOne`, `belongsToMany` + join table `FORCE RLS`, safe AST `formula`, `validation`)**, **1-Click Tenant Provisioning**, trích xuất PDF/DOCX/XLSX/PPTX + OCR Form Autofill, **pgvector `0.8.1` HNSW + RRF Hybrid RAG** và **GitOps Solution Bundle v3** (`latticedx.solution-bundle/v3`).
5. **AI Workforce, App Builder 2.0 (Plan/Patch/ER), A2A Protocol, OTel GenAI & 2-Way MCP:** **20 Unified AI Tools** (`11` Admin Builder gồm **`dxos_provision_role_workspace` (`build_enterprise_app` / `plan_enterprise_app` / `patch_enterprise_app` / `rollback_enterprise_app` / `verify_app` + `latticeBuiltApps`)** & `dxos_configure_workflow` + `6` Operational + `3` Persistent Memory `dxos_memory_*` trên `latticeAiMemory`), **7 Starter AI Profiles** (`dxos-coordinator`, `dxos-architect`, `dxos-ops`, `dxos-logistics`, `dxos-workspace`, `dxos-operator`, `dxos-analyst`), **Google/LF A2A Protocol (`/.well-known/agent-card.json`, `/api/dxos-a2a`)**, **OTel GenAI Trace Waterfall (`latticeAiTraces`) & Eval Lab UI**, **Proactive Incident Triage LLM thật**, **HITL Approval Queue**, Hạn mức PG + che PII VN, **2-Way Streamable MCP**, **1 nút Agent nổi duy nhất (`PortalAgentLauncher`)**, và đánh giá **`163/163` (100%)** ca tiếng Việt tự nhiên.
6. **Plane #6 — Application Data, OTel Tracing & PITR WAL Observability Substrate:** **NocoBase `2.2.50`** vận hành cùng bộ **7 plugin Apache-2.0 (`0.4.2`)** (`sdkProvidedByHost: true`), đặc tả **OpenAPI 3.1.0 / AsyncAPI 3.0.0**, **OTel Collector `0.123.0`** (nhận OTLP/HTTP JSON + W3C `traceparent` + GenAI semantic spans từ `otel-exporter.js`, `apps/api` & `apps/file-scanner`), **Prometheus `v3.3.0`** (`/api/dxos:metrics` + `alerts.yml`), **Grafana OSS `11.5.8` Dashboard 360°**, và sao lưu **PostgreSQL PITR WAL** tách volume (`postgres-wal-archive`, `nocobase-wal-archive`).

> - **Ma trận Ánh xạ Kiến trúc 1-1 Đề thi OLP PMNM 2026 (50 PoF + 50 Chung kết):** [docs/olp-2026-architecture-matrix.md](docs/olp-2026-architecture-matrix.md)
> - **Kịch bản Trình diễn Chung kết 15 phút (Live Demo + Q&A Defense + Fallback):** [docs/FINALS_15MIN_SCRIPT.md](docs/FINALS_15MIN_SCRIPT.md)
> - **Hướng dẫn Tự kiểm chứng 15 phút từ Bản cài Sạch (`v0.4.2`):** [docs/DEMO_PACK.md](docs/DEMO_PACK.md)
> - **Hướng dẫn Tự test End-to-End Toàn Hệ thống (8 Miền, 5 Vai trò — Dành cho Hưng):** [docs/E2E_TESTING_GUIDE_HUNG.md](docs/E2E_TESTING_GUIDE_HUNG.md)
> - **Báo cáo kỹ thuật & Nghiệm thu chi tiết:** [docs/system-report-and-guide.md](docs/system-report-and-guide.md) · [docs/dxos-ai-and-mcp-acceptance.md](docs/dxos-ai-and-mcp-acceptance.md) · [docs/logistics-and-rbac-acceptance.md](docs/logistics-and-rbac-acceptance.md) · [docs/stack-backup-and-recovery.md](docs/stack-backup-and-recovery.md)
> - **Hồ sơ bản quyền, SBOM CycloneDX 1.5 & Build từ Mã nguồn:** [`COPYRIGHT.txt`](COPYRIGHT.txt) · [`NOTICE`](NOTICE) · [`LICENSE`](LICENSE) · [`docs/sbom-cyclonedx.json`](docs/sbom-cyclonedx.json) · [docs/build-from-source.md](docs/build-from-source.md) · [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md)

---

## 1. Kiến trúc Mô-đun 7 Plugin Open-Core (`0.4.2`) & 6 Phân hệ DX-OS (H–P–D–I)

Toàn bộ phần mở rộng NocoBase đặt trong `plugins/nocobase/*`, khai báo `"version": "0.4.2"`, `"license": "Apache-2.0"` và `"sdkProvidedByHost": true` (build và kiểm thử trực tiếp trên NocoBase `2.2.50`). **100% kho Git và gói phát hành `latticedx-0.4.2-src.tar.gz` là mã nguồn thuần chuẩn OSI**: hoàn toàn không chứa Git submodule `upstream/nocobase` hay tệp `.gitmodules` (runtime host NocoBase `2.2.50` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài kho Git), và giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`):

| Package | Phiên bản | Trụ cột | Vai trò chính |
| --- | :---: | :---: | --- |
| [`@latticedx/plugin-lattice-foundation`](plugins/nocobase/plugin-lattice-foundation/README.md) | `0.4.2` | `[D][H][I]` | Collections lõi, 7 vai trò `ldx_*`, Multi-Portal + **Mobile Field PWA (`/v/mobile`)** + **Public Forms (`/v/form/:slug`)**, **Multi-Level Approval Engine & Unified Approval Inbox**, **Omnichannel Notifications (`email_smtp`/`telegram`/`slack`/`webhook`)**, **PaaS API Keys (`ldx_pat_*`)**, **Sổ cái Ed25519/Merkle PKI**, **Data Governance/Lineage/Quarantine/MKT**, **56 bảng tĩnh PostgreSQL `FORCE ROW LEVEL SECURITY` (`54` camelCase + `2` snake_case + dynamic `latticeCustom*` RLS + role `nocobase_app`)**, **OTel GenAI (`otel-exporter.js`, `latticeAiTraces`)**, **Connector Vault (`dxosVault`)**, **Unified Event Bus (`dxosEvents`)**, **OpenAPI 3.1.0 / AsyncAPI 3.0.0 / Prometheus `/api/dxos:metrics`**, Chatter, Chứng từ bất biến, Chuông SSE Topbar & SLA Engine. |
| [`@latticedx/plugin-dxos-para`](plugins/nocobase/plugin-dxos-para/README.md) | `0.4.2` | `[H]` | Không gian tri thức P.A.R.A. (`latticeParaDocuments`) & cài đặt `/admin/settings/dxos-para`, ACL 7 vai trò, tách `organizationId`, trích xuất **PDF (kèm ToUnicode CMap tiếng Việt)/DOCX/XLSX/PPTX** (`latticeParaChunks`), **OCR Form Autofill (`latticePara:extractFormFields`)** và **Hybrid RAG `tsvector` + RRF + `pgvector` HNSW chiều vector linh hoạt (`20261127000200`)**. |
| [`@latticedx/plugin-dxos-blocks`](plugins/nocobase/plugin-dxos-blocks/README.md) | `0.4.2` | `[H][P][D][I]` | **12 Native v2 `BlockModel`s** cấu hình trong `Add block` (gồm **`DxosBiChartBlockModel`**, **`DxosWebGisBlockModel` với `maplibre-gl@6.19.0` (`BSD-3-Clause`)**, `DxosKanbanScheduleBlockModel`, **`DxosWmsOpsBlockModel`**, `DxosCreativeStudioBlockModel`, `DxosRecordWorkbenchBlockModel`...), `dxosBlocks:aggregateQuery` & `collectionsMeta`, **2-Way Digital Twin Shadow**, **Mosquitto DynSec + LWT & Orion-LD 2-Way (`dxosBroker:*`)**, **2-Phase Bulk Import**, IIoT `telemetryIngest` + cảnh báo, xuất báo cáo RBAC CSV/XLSX/PDF Unicode và Command Palette `Ctrl+K`. |
| [`@latticedx/plugin-dxos-studio`](plugins/nocobase/plugin-dxos-studio/README.md) | `0.4.2` | `[P][H][D]` | Bảng điều khiển `/admin/settings/dxos-studio` (**11 tab Studio** + **6 Governance Consoles** + Unified Approval Inbox + Public Form Builder + **Visual Interactive DMN**) & **Workflow Automation Studio (`/admin/settings/workflow/automation` + alias `/admin/settings/dxos-flow-studio`, `@xyflow/react@12.12.1` + `@dagrejs/dagre@3.1.3` MIT: 24 node types, Draft/Publish `latticeAutomationRuleVersions`, Live Canvas Trace, `ai.agent` ReAct nhiều lượt & HITL bền vững)**: cài 1-nhấp 4 quy trình Poka-yoke, dựng cổng đa-block + `/mobile`, **OMS/WMS/FEFO/ePOD + QR ISO + `/v/track/:code` Ed25519**, **Stock `n8n` Public REST API v1 (`dxosN8n`)**, **Rich Schema Domain Builder (`hasOne`, `belongsToMany` + `FORCE RLS`, AST `formula`, `validation`) + 1-Click Business Packs + 1-Click Tenant Provisioning**, Outbox/DLQ và **GitOps Bundle v3**. |
| [`@latticedx/plugin-dxos-ai`](plugins/nocobase/plugin-dxos-ai/README.md) | `0.4.2` | `[I][P][D][H]` | Trung tâm `/admin/settings/dxos-ai` (gồm Tab 7 Built Apps + Visual ER/Plan-Diff/Rollback, Trace Waterfall & Eval Lab UI): **7 Starter AI Profiles**, **20 Unified Tools** (`11` Admin Builder gồm **`dxos_provision_role_workspace` (`build`/`plan`/`patch`/`rollback`/`verify`)** & `dxos_configure_workflow` + `6` Operational + `3` Persistent Memory `dxos_memory_*`), **Google/LF A2A Protocol (`/.well-known/agent-card.json`, `/api/dxos-a2a`)**, **Proactive Triage LLM thật**, **Hàng chờ Phê duyệt HITL**, `PortalAgentLauncher` SSE, hạn mức PG + che PII VN và **2-Way MCP Gateway**. |
| [`@latticedx/plugin-enterprise-auth`](plugins/nocobase/plugin-enterprise-auth/README.md) | `0.4.2` | `[H]` | Đăng nhập Keycloak OIDC + PKCE ánh xạ về phiên NocoBase native, **Valkey `8.1`** (tương thích giao thức Redis) session cache, Backchannel Logout, đồng bộ nhóm→vai trò 2 chiều chống leo thang quyền và giao diện hủy liên kết. |
| [`@latticedx/plugin-action-bridge`](plugins/nocobase/action-bridge/README.md) | `0.4.2` | `[P][I]` | Cầu nối hành động và tương thích quy trình giữa API/Studio cốt lõi và giao diện `/lattice/*`. |

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

# 3. Đánh giá AI tiếng Việt tự nhiên (163 ca kiểm thử bao gồm App Builder 2.0, A2A, GraphRAG, Alarm, DX-OS Flow Architect & Security Refusal)
node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95

# 4. Typecheck, Vitest workspace (apps + packages + tests) & build Node.js/TypeScript services
pnpm check
```

### B. Dựng môi trường NocoBase sạch từ DB 0 bảng (`NOCOBASE_VERSION=2.2.50`)

Lệnh dưới đây xuất mã nguồn từ `HEAD`, dựng PostgreSQL trống và runtime NocoBase ở cổng cô lập (ví dụ `13014`), cài và kích hoạt đủ 7 plugin Apache-2.0 (`0.4.2`), kiểm tra migrations và xuất file `report.json` nghiệm thu (chi tiết tại [docs/native-clean-install.md](docs/native-clean-install.md)):

```sh
pnpm native:clean --port=13014
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"

# Nạp 7 Starter AI Employees, Admin Builder, 2-Way IT/OT MCP Gateway & (khi có AGENT_API_KEY) local-9router
pnpm setup:dxos-ai -- --origin=http://localhost:13014

# Nạp dữ liệu trình diễn nền v0.3.0 & chuỗi lạnh/PaaS v0.4.2 idempotent (cung cấp NOCOBASE_TOKEN hoặc NOCOBASE_ADMIN_PASSWORD / --admin-password)
NOCOBASE_ADMIN_PASSWORD="<admin-password>" node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
NOCOBASE_ADMIN_PASSWORD="<admin-password>" pnpm seed:v100-showcase -- --origin=http://localhost:13014

# Nghiệm thu Headless PaaS v0.4.2 (QR SVG + Ed25519 + Delegation), AI Workforce (20 Tools + App Builder 2.0 + HITL), Broker + n8n REST v1 + OAuth2 PKCE + Partner Settlement, Logistics RBAC, và DR toàn stack
pnpm acceptance:headless-paas -- --origin=http://localhost:13014
pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
pnpm acceptance:broker-automation-builder -- --origin=http://localhost:13014
pnpm acceptance:logistics-rbac -- "<path-to-report.json>"
pnpm backup:stack
pnpm backup:rehearse-stack -- "output/backups/stack/<bundle-id>"
```

Sau khi nạp demo, đăng nhập quản trị tại `http://localhost:13014` (`admin@nocobase.com` / `admin123`), mở **`/admin/settings/dxos-studio`** (11 tab Studio + 6 Governance Consoles kèm Visual DMN), **`/admin/settings/workflow/automation`** (**Workflow -> Workflow Automation**: LatticeFlow v2 Canvas-First Studio + nút mở nhanh **Connectors / n8n** & **Broker** + đồng bộ trực tiếp **Agent Chat gốc `dxos-architect`**; giữ route alias `/admin/settings/dxos-flow-studio`), **`/admin/settings/dxos-ai`** (AI Workforce, MCP, Tab 7 Built Apps + Visual ER/Plan-Diff/Rollback, Trace Waterfall & Eval Lab), **`/admin/settings/dxos-para`** (Vector RAG), hoặc các cổng nghiệp vụ **`/p/logistics`** (gồm `DxosWmsOpsBlockModel`), **`/p/incidents`**, **`/p/procurement`**, **`/p/services`**, **`/p/cmms`**, **`/p/partner-claims`** (`CLM-V100-001`), tra cứu không PII **`/v/track/:code`**, biểu mẫu công khai **`/v/form/:slug`** và tuyến di động **`/v/mobile`**.

---

## 3. Cấu trúc Kho mã nguồn

| Thư mục / Tệp | Trách nhiệm |
| --- | --- |
| `plugins/nocobase/*` | 7 plugin NocoBase độc lập (`0.4.2`, `Apache-2.0`, `sdkProvidedByHost: true`) và bộ kiểm thử `node --test`. |
| `apps/api`, `apps/agent-worker`, `apps/file-scanner` | Fastify API tích hợp (`apps/api`), worker thuần `node:http` (`apps/agent-worker`) và sidecar quét tệp ClamAV/RustFS thuần `node:http` (`apps/file-scanner`) (`@dx/*`). |
| `packages/contracts` | Hợp đồng schema và kiểm tra kiểu dùng chung (`@dx/contracts`). |
| `infra/compose/*.yml` & `infra/config/*` | Cấu hình Docker Compose khóa digest `@sha256:` cho **`19` OCI images** (`core.yml`, `nocobase.yml`, `iiot.yml`, `integration.yml`, `native-rehearsal.yml`, `prod.yml`: Caddy, APISIX, Keycloak, `pgvector/pgvector:0.8.1-pg16`, **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause`)**, RustFS, ClamAV, Orion-LD, MongoDB, n8n kèm `dxos-coldchain-alert-orchestrator.json` & `dxos-epod-partner-sync.json`, Mosquitto `2.0.21` DynSec + Node-RED `4.0.9` trên `iiot.yml`, OTel Collector, Prometheus, Grafana OSS `11.5.8`, Gotenberg). |
| `scripts/` | Công cụ clean-install (kèm `--blank-slate`), seed Multi-Portal/Showcase, nghiệm thu Headless PaaS / AI MCP / Blank-Slate & Live LLM App Builder / Logistics RBAC, kiểm toán PoF (`verify-pof-readiness.mjs`), sinh SBOM CycloneDX 1.5 (`generate-sbom.mjs`) và đóng gói nguồn (`build-oss-release-tarball.mjs`). |
| `solutions/` | Hợp đồng mẫu Logistics (`solutions/logistics`) và định nghĩa quy trình/sự cố (`solutions/workflows`, `solutions/integration`). |

> **Kho mã nguồn 100% thuần chuẩn OSI:** Submodule cũ `upstream/nocobase` và tệp `.gitmodules` đã được gỡ bỏ hoàn toàn khỏi cây Git và gói phát hành nguồn `latticedx-0.4.2-src.tar.gz`; runtime host `nocobase/nocobase:2.2.50` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài kho Git (xem [docs/nocobase-source-review.md](docs/nocobase-source-review.md)).

Các biến môi trường mặc định được mô tả trong [`.env.example`](.env.example) và [`infra/compose/prod.env.example`](infra/compose/prod.env.example). **Không** triển khai mật khẩu demo local lên Internet; chỉ dùng cho môi trường đánh giá và phát triển cục bộ.

---

## 4. Tuân thủ Nguồn mở (OLP PMNM 2026 PoF)

```sh
node scripts/source-headers.mjs --check        # Xác minh 100% file nguồn gốc mang @copyright + SPDX Apache-2.0
pnpm pof:check                                 # Audit PoF (tài liệu quản trị, COPYRIGHT.txt, cô lập 7 plugin, digest Compose, sạch upstream-clean, không secret)
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:sbom                              # Sinh & kiểm tra docs/sbom-cyclonedx.json (CycloneDX 1.5: 257 components — workspace=12, npm=226, oci=19; 257/257 resolved, 0 NONE)
pnpm release:sbom -- --check                   # Xác minh không trôi lệch SBOM & không BSL-1.1 / ThingsBoard / EMQX
pnpm release:tarball                           # Xuất output/release/latticedx-0.4.2-src.tar.gz + .sha256
```

- Toàn bộ quy trình đóng góp, phát hành, SBOM và kiểm kê dependency xem tại [`COPYRIGHT.txt`](COPYRIGHT.txt), [`NOTICE`](NOTICE), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md), [`docs/sbom-cyclonedx.json`](docs/sbom-cyclonedx.json), [docs/third-party.md](docs/third-party.md), [docs/dependency-inventory.md](docs/dependency-inventory.md) và [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md).
- Báo lỗi hoặc đề xuất cải tiến tại **GitHub Issues**: <https://github.com/CTU-OpenPaw/lattice-dx/issues>.

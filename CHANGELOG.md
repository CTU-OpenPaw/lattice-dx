# Changelog

Tài liệu ghi nhận lịch sử phát triển của **LatticeDX** (Apache-2.0), phục vụ kỳ thi OLP PMNM 2026 (VFOSSA).

## [Unreleased] — chuẩn bị v0.1.0

### 2026-11-22 — Nâng cấp v2 → v3 → v3.1: Deep Admin Architect (15 Tools), Creative Studio Block, 1 Nút Agent Nổi Duy Nhất & Ngôn ngữ Tự nhiên 100%
- **v2 (Admin System Builder & Cross-Dept Copilot — 11 Unified Tools):** Nâng cấp schema tương thích Zod v4/Gemini/OpenAI, bổ sung vòng đời block đầy đủ (`dxos_compose_page_blocks`), phân quyền RBAC chi tiết tới từng trường/tạo vai trò mới `ldx_*` (`dxos_manage_rbac_permissions`), tự cấu hình workflow (`dxos_configure_workflow` / `dxos_deploy_workflow`), tra cứu động mọi collection `latticeCustom*` có kiểm soát `lockedFields` và điều phối liên phòng ban (`dxos_orchestrate_enterprise_case`).
- **v3 (Creative Studio Block, Deep `flowSurfaces` & Time-Machine — 15 Unified Tools):** Thêm `DxosCreativeStudioBlockModel` (Zero-eval Creative DSL 5 theme, 7 widget composable: `gauge`, `thermometer`, `stage-pipeline`, `distribution-bars`, `rule-callout`, `status-matrix`, `quick-actions`), bổ sung `dxos_recommend_page_blueprint`, `dxos_design_creative_block` (hỗ trợ bố cục 2 cột `12:12`), `dxos_snapshot_or_rollback_page` trên bảng `latticeUiSnapshots`, và `dxos_provision_role_workspace` (1 lệnh tạo role + RBAC + trang mới + Creative Block + AI riêng không quyền Admin).
- **v3.1 (Một Nút Agent Nổi Duy Nhất & Tiếng Việt Tự Nhiên 100%):** Gỡ bỏ toàn bộ thanh/strip AI phụ khỏi nội dung portal (`DxosPortalHeroView`), bổ sung `PortalAgentLauncher` (`app.use(...)`) hiển thị đúng 1 nút Agent nổi góc dưới phải trên `/p/*` (nhường `/admin/*` cho nút gốc NocoBase) mở thẳng khung chat gốc NocoBase với ô nhập rỗng + ngữ cảnh trang ngầm + defer Live Canvas Sync; bổ sung tầng suy luận tiếng Việt tự nhiên (`inferPortalPrimaryCollection`, `resolveBlockUidByHint`, `resolveFieldNamesByNaturalLabels`, `synthesizeNaturalCreativeBlueprint`, `slugifyVietnameseToLdxRole`, `normalizeAiUsername`, tái sử dụng/phân tách trùng `roles_title_key`). Nghiệm thu live `23/23` checks, Logistics & Negative RBAC `7/7` HTTP `403`, Node `366/366`, Vitest `148` files / `1095/1095`.

### 2026-11-21 — Hệ sinh thái Nhân sự AI Quản trị Động & Cổng Enterprise MCP 2 Chiều (`@latticedx/plugin-dxos-ai`)
- Tách và hoàn thiện plugin Apache-2.0 thứ 7 **`@latticedx/plugin-dxos-ai`** (`0.1.0`, `"sdkProvidedByHost": true`), định vị rõ **LatticeDX Enterprise Digital OS (6 phân hệ)** với NocoBase `2.2.38` là Plane #6 (`appDataSubstrate`), đồng bộ 2 chiều cấu hình từ `latticeAiProfiles` xuống `aiEmployees` & `aiMcpClients`, và lưu vết thực thi tại `latticeAiAuditLogs`.
- Triển khai **8 Unified Tools (`scope: 'CUSTOM'`)**: 5 Admin Builder tools (`dxos_inspect_architecture`, `dxos_compose_page_blocks`, `dxos_manage_portal_and_acl`, `dxos_extend_collection_schema`, `dxos_deploy_workflow`, hỗ trợ `dryRun` và khóa cứng phía server chỉ cho `root`/`admin`) + 3 Operational/Copilot tools (`dxos_search_enterprise_context`, `dxos_execute_record_action`, `dxos_my_tasks_copilot` chống tự duyệt và khóa `organizationId`).
- Triển khai **Cổng Streamable HTTP MCP 2 Chiều (`/api/dxos-mcp` & `/api/dxos-mcp/it-ot`)**: xác thực Bearer JWT, lọc danh sách tool động theo vai trò, 4 IT/OT tools (`get_live_ngsi_telemetry`, `get_sensor_and_incident_timeline`, `get_stack_connector_health`, `dispatch_itot_webhook_or_sync`) dùng `useUserContext: true`, SSRF guard và timeout 5s fallback `{ degraded: true }`.
- Nâng cấp **`/admin/settings/dxos-ai`** (4 tab điều hành 6 phân hệ + quản trị nhân sự AI động + MCP + Audit), nâng `plugin-dxos-studio` thành **7 plugins**, bổ sung **Dynamic Block Copilot Strip** vào `plugin-dxos-blocks`, và hoàn thiện script `pnpm setup:dxos-ai` / `pnpm acceptance:dxos-ai-mcp`.

### 2026-11-21 — Nghiệm thu Logistics 5 Bước, Multi-Domain, RBAC & Sao lưu Phục hồi Toàn Stack
- Hoàn thiện công cụ sao lưu & diễn tập phục hồi toàn stack an toàn ngoài PostgreSQL (`scripts/stack-recovery.mjs`, `scripts/tests/stack-recovery.test.mjs` — `6/6` đạt) bao phủ 5 thành phần (`nocobase-db`, `uploads`, `keycloak`, `orion-mongo`, `n8n`), lệnh `pnpm backup:stack` / `pnpm backup:rehearse-stack` và hướng dẫn vận hành tại [docs/stack-backup-and-recovery.md](docs/stack-backup-and-recovery.md). Đã chạy sao lưu & diễn tập cô lập live đạt `fullStackVerified: true`, `skippedComponents: []` (`119` bảng NocoBase, `3` uploads entries, `101` bảng Keycloak realm `lattice`, `13.944` bytes Orion MongoDB, `4` workflows n8n) mà không chạm dữ liệu chạy thật.
- Hoàn thiện kịch bản nghiệm thu E2E quy trình Logistics 5 bước (`logistics-5step`), domain thứ 2 (`internal-service` — `latticeServiceTickets`) và `7` kiểm tra RBAC/đa-tổ-chức âm tính (`HTTP 403`) tại `scripts/acceptance-logistics-and-rbac.mjs`, `scripts/tests/acceptance-logistics-rbac.test.mjs` (`5/5` đạt), lệnh `pnpm acceptance:logistics-rbac` và báo cáo nghiệm thu tại [docs/logistics-and-rbac-acceptance.md](docs/logistics-and-rbac-acceptance.md).
- Bổ sung [docs/system-report-and-guide.md](docs/system-report-and-guide.md): báo cáo kỹ thuật tổng thể kiến trúc 6 plugin Apache-2.0, tùy biến nghiệp vụ doanh nghiệp Việt (Data Sources, RBAC theo cột, Keycloak SSO, Multi-Portal, DX-OS Studio, AI Agent thực thi CSDL, IT/OT Orion-LD + n8n) và hướng dẫn cài đặt/khắc phục sự cố chi tiết từng bước.
- Bổ sung `scripts/setup-department-ai-agent.mjs` (và kiểm thử `scripts/tests/department-ai-agent.test.mjs`) tự động hóa idempotent việc tạo AI Workflow `Tạo Phiếu Bảo trì Kho lạnh` (`type: "ai-employee"`, `sync: true`), kết nối gateway OpenAI-compatible cục bộ qua biến môi trường (`AGENT_API_KEY`) và gắn workflow tool ở chế độ `Allow` cho trợ lý `kho-lanh-ops`.

### 2026-11-20 — LatticeDX Open-Core 6-Plugin Suite & NukeViet-Grade PoF
- Mở rộng nền tảng thành hệ sinh thái **6 plugin NocoBase Apache-2.0** (`"sdkProvidedByHost": true`), bổ sung 3 plugin mới:
  - `@latticedx/plugin-dxos-para` (`0.1.0`): không gian tri thức P.A.R.A. (`latticeParaDocuments`, `uiManageable: true`, 7 vai trò `ldx_*`, tách phạm vi `organizationId`, `latticePara:summary`).
  - `@latticedx/plugin-dxos-blocks` (`0.1.0`): 6 Native v2 `BlockModel` tùy biến trực tiếp qua NocoBase UI Editor (`dxosBlockSettings`) và 2 API scoped (`dxosBlocks:proposals`, `dxosBlocks:contextTelemetry`).
  - `@latticedx/plugin-dxos-studio` (`0.1.0`): màn hình `/admin/settings/dxos-studio` cài 1-nhấp 4 quy trình Poka-yoke (gồm `logistics-5step` và `internal-service`), dựng trang tổng quan đa-block (`composePortals`), theo dõi 6 plugin và collection `latticeServiceTickets`.
- Tích hợp cả 6 plugin vào `infra/compose/{nocobase,native-rehearsal}.yml`, `scripts/install-workspace.mjs`, `scripts/native-clean-install.mjs`, `scripts/setup-native-multi-portal-demo.mjs` và `.github/workflows/ci.yml`.
- Bổ sung [`COPYRIGHT.txt`](COPYRIGHT.txt) theo chuẩn NukeViet-style PoF, kịch bản trình diễn [docs/DEMO_PACK.md](docs/DEMO_PACK.md), chuẩn hóa header `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` qua `scripts/source-headers.mjs`, làm sạch `README.md`, và nâng cấp `pnpm pof:check` kiểm tra bắt buộc `COPYRIGHT.txt` và `README.md` cho mọi plugin.

### 2026-11-18 — Native Multi-Portal UI & OLP PMNM 2026 (VFOSSA) PoF Compliance
- Bổ sung giao diện Multi-Portal Apache-2.0 trên `AdminLayoutModel` / `uiLayouts` trong `@latticedx/plugin-lattice-foundation`, giữ nguyên thông tin bản quyền NocoBase Clause 5.2 (`Powered by NocoBase`, `v2.2.38`, `License settings`).
- Tạo `NOTICE` theo Apache-2.0 §4(d) phân tách rạch ròi mã gốc Apache-2.0, submodule/container NocoBase, dịch vụ container độc lập (`PostgreSQL`, `Keycloak`, `APISIX`, `FIWARE Orion-LD`, `MongoDB`, `n8n`, `ClamAV`) và dependency MIT đóng gói.
- Chuẩn hóa header `SPDX-License-Identifier: Apache-2.0` cho 31 tệp nguồn còn thiếu (`30` `apps/api/src/**/*.test.ts` và `tests/workspace-install.test.ts`), loại trừ sạch `apps/web/next-env.d.ts` tự sinh và `upstream/`.
- Khóa toàn bộ container image còn thiếu digest `@sha256:` trong `infra/compose/core.yml`, `infra/compose/nocobase.yml` và `infra/compose/native-rehearsal.yml`.
- Thêm biểu mẫu GitHub Issue (`.github/ISSUE_TEMPLATE/config.yml`, `bug_report.yml`, `feature_request.yml`), cập nhật `CONTRIBUTING.md`, `SECURITY.md`, `README.md`, `docs/nocobase-source-review.md`, `docs/third-party.md` và làm mới kiểm kê `docs/dependency-inventory.md` (`123` nhóm package).
- Tạo `docs/build-from-source.md`, `docs/oss-pof-compliance.md`, `scripts/verify-pof-readiness.mjs` (`pnpm pof:check`) và `scripts/build-oss-release-tarball.mjs` (`pnpm release:tarball`) kèm kiểm thử đơn vị `scripts/tests/oss-pof-audit.test.mjs`.
- Thêm migration cấp quyền xem các trường cần thiết cho cổng Sự cố và giữ cấu hình quyền đã tồn tại. Nghiệm thu lab từ Orion-LD qua n8n và `combo` đến duyệt, ghi kết quả và đóng case trên giao diện.

### 2026-11-17 — Luồng UC2 End-to-End (Orion-LD → n8n → AI Advisory → Human Review)
- Hoàn thiện luồng xử lý cảnh báo sự cố từ NGSI-LD Orion-LD qua n8n tới dịch vụ `combo` AI advisory và hàng đợi duyệt thủ công có kiểm tra thẩm quyền (`8c8cc27`, `PR #56`).

### 2026-11-04 – 2026-11-14 — Nền tảng Native NocoBase 2.2.38
- Nâng cấp runtime host lên `nocobase/nocobase:2.2.38` khóa digest `@sha256:90028473...`, vận hành 3 plugin Apache-2.0 (`@latticedx/plugin-lattice-foundation` `0.25.1`, `@latticedx/plugin-enterprise-auth` `0.1.0`, `@latticedx/plugin-action-bridge` `0.4.1`).
- Hoàn thiện đăng nhập doanh nghiệp Keycloak OIDC + PKCE (`plugin-enterprise-auth`), kho tệp chung qua ClamAV TCP (`PR #46`), sao lưu/phục hồi PostgreSQL native (`PR #45`), Workspace theo 7 vai trò (`PR #47`), cài sạch cô lập từ commit nguồn `pnpm native:clean` (`PR #48`), nhận diện thương hiệu (`PR #51`), chuẩn hóa header CTU-OpenPaw (`aeb9a76`) và tài liệu bàn giao (`PR #49`).
- Hoàn thiện định tuyến quan sát UC2 qua n8n, hàng đợi cảnh báo bền vững và client xác thực cho sensor worker.

### 2026-10-19 – 2026-10-25 — Hoàn thiện Enterprise Backend & Studio Runtime
- Bổ sung bàn giao backend UC1 (`PR #23`), bridge sẵn sàng cho agent (`PR #24`), worker đề xuất sự cố với model `combo` (`PR #25`), phục hồi volume MongoDB cho Orion-LD (`PR #26`), gia cố runtime cục bộ (`PR #27`) và đồng bộ handover UC1 qua broker (`PR #28`).
- Bổ sung Studio System Builder, Enterprise Console, Admin System Foundation và gateway routes (`PR #29`–`#31`, `PR #34`–`#37`).

### 2026-10-12 – 2026-10-18 — Core Workflow Runtime, Tích hợp UC1 & UC2
- Xây dựng `@latticedx/plugin-action-bridge` (PKCE linking + action proxy, `PR #1`–`#4`), Workflow Runtime & Outbox bền vững, Studio/Blocks/Waits/Bundles (`PR #5`–`#10`), idempotency & entity sharing (`PR #11`, `PR #13`).
- Tích hợp NGSI-LD Asset subscription (`PR #14`), Context Foundation & Attachment/Timeline blocks (`PR #20`–`#22`) và dịch vụ nghiệp vụ UC1 mua sắm – bàn giao tài sản (`solutions/logistics`, `solutions/workflows`, `packages/contracts`).

### 2026-10-06 — Khởi tạo Monorepo & Hạ tầng Core
- Khởi tạo pnpm monorepo với Next.js (`apps/web`), Fastify API (`apps/api`), worker độc lập (`apps/agent-worker`) và `@dx/contracts` (`packages/contracts`).
- Thêm Docker Compose core (`PostgreSQL 16.13`, `Keycloak 26.8.0`, `APISIX 3.19.0`, `ClamAV 1.4.3`), xác thực JWT theo role/owner/`organization_id`, GitHub Actions CI và giới hạn Vitest khỏi `upstream/nocobase` submodule (`5b47bec116c52239348c09d360e4bd2649c99efc`).

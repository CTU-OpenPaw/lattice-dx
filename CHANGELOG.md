# Changelog

Tài liệu ghi nhận lịch sử phát triển theo mốc thời gian thực tế của **LatticeDX** (`0.1.0`, Apache-2.0) phục vụ kỳ thi OLP PMNM 2026 (VFOSSA).

## [0.1.0] — 2026-10-06 đến 2026-11-18

### 2026-11-18 — Native Multi-Portal UI & OLP PMNM 2026 (VFOSSA) PoF Compliance
- Bổ sung giao diện Multi-Portal Apache-2.0 trên `AdminLayoutModel` / `uiLayouts` trong `@latticedx/plugin-lattice-foundation`, giữ nguyên thông tin bản quyền NocoBase Clause 5.2 (`Powered by NocoBase`, `v2.2.38`, `License settings`).
- Tạo `NOTICE` theo Apache-2.0 §4(d) phân tách rạch ròi mã gốc Apache-2.0, submodule/container NocoBase, dịch vụ container độc lập (`PostgreSQL`, `Keycloak`, `APISIX`, `FIWARE Orion-LD`, `MongoDB`, `n8n`, `ClamAV`) và dependency MIT đóng gói.
- Chuẩn hóa header `SPDX-License-Identifier: Apache-2.0` cho 31 tệp nguồn còn thiếu (`30` `apps/api/src/**/*.test.ts` và `tests/workspace-install.test.ts`), loại trừ sạch `apps/web/next-env.d.ts` tự sinh và `upstream/`.
- Khóa toàn bộ container image còn thiếu digest `@sha256:` trong `infra/compose/core.yml`, `infra/compose/nocobase.yml` và `infra/compose/native-rehearsal.yml`.
- Thêm biểu mẫu GitHub Issue (`.github/ISSUE_TEMPLATE/config.yml`, `bug_report.yml`, `feature_request.yml`), cập nhật `CONTRIBUTING.md`, `SECURITY.md`, `README.md`, `docs/nocobase-source-review.md`, `docs/third-party.md` và làm mới kiểm kê `docs/dependency-inventory.md` (`123` nhóm package).
- Tạo `docs/build-from-source.md`, `docs/oss-pof-compliance.md`, `scripts/verify-pof-readiness.mjs` (`pnpm pof:check`) và `scripts/build-oss-release-tarball.mjs` (`pnpm release:tarball`) kèm kiểm thử đơn vị `scripts/tests/oss-pof-audit.test.mjs`.

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

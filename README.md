<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX · Open-Core Digital Enterprise Platform (`v0.3.0`)

**LatticeDX `v0.3.0`** là **Hệ điều hành Doanh nghiệp Số nguồn mở 6 Phân hệ** (**DX-OS Open-Core**, phát hành theo giấy phép **Apache-2.0**) do **CTU-OpenPaw** phát triển cho kỳ thi **OLP PMNM 2026 (VFOSSA)**. Nền tảng hợp nhất **Con người (`[H]`) – Quy trình (`[P]`) – Dữ liệu (`[D]`) – Trí tuệ (`[I]`)** qua **6 phân hệ điều phối** (Identity/Security SSO Redis + Keycloak Backchannel Logout & đồng bộ vai trò 2 chiều, IT/OT Orion-LD Digital Twin & IIoT chuẩn OSI Mosquitto/Node-RED/TimescaleDB OSS, n8n Event Bus & `SKIP LOCKED` Outbox/DLQ + SLA Engine, Multi-Portal + `/mobile` + Chuông Thông báo SSE + Semantic Neural RAG P.A.R.A., AI Workforce Quản trị hạn mức PostgreSQL/PII Việt Nam/HITL Approval Queue & Enterprise MCP 2 chiều, và **NocoBase `2.2.50`** làm **Plane #6 — Application Data Substrate** cùng bộ **7 plugin Apache-2.0** bật/tắt linh hoạt ngay trong giao diện quản trị).

> - **Báo cáo kỹ thuật & Hướng dẫn vận hành chi tiết (kiến trúc, RBAC, Multi-Portal, AI Agent phòng ban thực thi CSDL, IT/OT & PoF):** [docs/system-report-and-guide.md](docs/system-report-and-guide.md)
> - **Nghiệm thu AI Workforce + Enterprise MCP 2 chiều, Logistics 5 bước, RBAC âm tính & Sao lưu/Phục hồi Toàn Stack:** [docs/dxos-ai-and-mcp-acceptance.md](docs/dxos-ai-and-mcp-acceptance.md) · [docs/logistics-and-rbac-acceptance.md](docs/logistics-and-rbac-acceptance.md) · [docs/stack-backup-and-recovery.md](docs/stack-backup-and-recovery.md)
> - Hướng dẫn trình diễn trực tiếp 15 phút (Admin Studio, Add block, P.A.R.A., PoF): [docs/DEMO_PACK.md](docs/DEMO_PACK.md)
> - Hồ sơ bản quyền & dependency chuẩn hóa: [`COPYRIGHT.txt`](COPYRIGHT.txt) · [`NOTICE`](NOTICE) · [`LICENSE`](LICENSE)
> - Build từ mã nguồn & PoF OLP PMNM 2026: [docs/build-from-source.md](docs/build-from-source.md) · [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md)

---

## 1. Kiến trúc Mô-đun 7 Plugin Open-Core & 6 Phân hệ DX-OS (H–P–D–I)

Toàn bộ phần mở rộng NocoBase đặt trong `plugins/nocobase/*`, khai báo `"license": "Apache-2.0"` và `"sdkProvidedByHost": true` (build và kiểm thử trực tiếp trên NocoBase `2.2.50`), không sao chép hay sửa mã nguồn `upstream/nocobase`, và giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`):

| Package | Phiên bản | Trụ cột | Vai trò chính |
| --- | :---: | :---: | --- |
| [`@latticedx/plugin-lattice-foundation`](plugins/nocobase/plugin-lattice-foundation/README.md) | `0.27.0` | `[D][H][I]` | Collections lõi, 7 vai trò `ldx_*`, Multi-Portal UI, composite indexes, khóa lạc quan `version`, **Record Chatter (`@mention` + field-diff)**, **chứng từ bất biến `Submit`/`Cancel`/`Amend`**, **Chuông Thông báo SSE (`latticeNotifications`) & SLA Escalation Engine (`latticeSlaPolicies`)**, Outbox `SKIP LOCKED` & đồng bộ NGSI-LD. |
| [`@latticedx/plugin-dxos-para`](plugins/nocobase/plugin-dxos-para/README.md) | `0.3.0` | `[H]` | Không gian tri thức P.A.R.A. (`latticeParaDocuments`) với `uiManageable: true`, ACL 7 vai trò, tách `organizationId`, **trích xuất PDF/DOCX & phân mảnh `latticeParaChunks`**, và **Semantic Neural + Hybrid RAG `tsvector` + RRF + `pgvector` HNSW (`latticePara:hybridSearch`, `reindex`)**. |
| [`@latticedx/plugin-dxos-blocks`](plugins/nocobase/plugin-dxos-blocks/README.md) | `0.3.0` | `[H][P][D][I]` | **7 Native v2 `BlockModel`** cấu hình trong `Add block`, **biểu đồ SVG `timeseries-line`** + IIoT `telemetryIngest` + khử trùng lặp cảnh báo `Ack`/`Clear`, **xuất báo cáo RBAC theo cột CSV/XLSX/PDF Unicode (`dxosBlocks:exportReport`)**, **Chatter & Voucher UI**, và **Command Palette `Ctrl+K` / `Cmd+K`**. |
| [`@latticedx/plugin-dxos-studio`](plugins/nocobase/plugin-dxos-studio/README.md) | `0.3.0` | `[P][H][D]` | Bảng điều khiển `/admin/settings/dxos-studio`: cài 1-nhấp 4 quy trình Poka-yoke, dựng cổng đa-block + **cổng di động `/mobile`**, Outbox/DLQ replay (**Tab 5**) và **GitOps Solution Bundle JSON export/diff/import/apply/rollback (`Tab 6`)** kèm `latticeServiceTickets`. |
| [`@latticedx/plugin-dxos-ai`](plugins/nocobase/plugin-dxos-ai/README.md) | `0.3.0` | `[I][P][D][H]` | Trung tâm `/admin/settings/dxos-ai`: Nhân sự AI động, 15 Unified Tools, **Hàng chờ Phê duyệt Con người HITL (`latticeAiApprovalQueue`)**, **1 nút Agent nổi duy nhất (`PortalAgentLauncher`)** đẩy SSE realtime, **quản trị hạn mức AI bền vững PostgreSQL (`latticeAiQuotaUsage`, `429`) + che PII Việt Nam**, Time-Machine và MCP 2 chiều. |
| [`@latticedx/plugin-enterprise-auth`](plugins/nocobase/plugin-enterprise-auth/README.md) | `0.3.0` | `[H]` | Đăng nhập Keycloak OIDC + PKCE ánh xạ về phiên NocoBase native, **Redis session cache, Backchannel Logout, đồng bộ nhóm→vai trò 2 chiều chống leo thang quyền và giao diện hủy liên kết**. |
| [`@latticedx/plugin-action-bridge`](plugins/nocobase/plugin-action-bridge/README.md) | `0.3.0` | `[P][I]` | Cầu nối hành động và tương thích quy trình giữa API/Studio cốt lõi và giao diện `/lattice/*`. |

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

# 2. Kiểm thử đơn vị 7 plugin + scripts PoF/demo
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs

# 3. Typecheck, Vitest workspace (apps + packages + tests) & build Node.js/TypeScript services
pnpm check
```

### B. Dựng môi trường NocoBase sạch từ DB 0 bảng (`NOCOBASE_VERSION=2.2.50`)

Lệnh dưới đây xuất mã nguồn từ `HEAD`, dựng PostgreSQL trống và runtime NocoBase ở cổng cô lập (ví dụ `13014`), cài và kích hoạt đủ 7 plugin Apache-2.0, kiểm tra migrations và xuất file `report.json` nghiệm thu (chi tiết tại [docs/native-clean-install.md](docs/native-clean-install.md)):

```sh
pnpm native:clean --port=13014
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"
# Nạp 5 Starter AI Employees, Admin Builder, 2-Way IT/OT MCP Gateway & (khi có AGENT_API_KEY) local-9router
pnpm setup:dxos-ai -- --origin=http://localhost:13014
# Nạp dữ liệu trình diễn v0.3.0 idempotent (Chứng từ Submit/Cancel/Amend, Chatter, SLA, Telemetry 24h, RAG Reindex & HITL; cung cấp NOCOBASE_TOKEN hoặc NOCOBASE_ADMIN_PASSWORD / --admin-password)
NOCOBASE_ADMIN_PASSWORD="<admin-password>" node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
# Nghiệm thu AI Workforce + Enterprise MCP 2 chiều, Logistics 5 bước + RBAC âm tính, và sao lưu/phục hồi toàn stack
pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
pnpm acceptance:logistics-rbac -- "<path-to-report.json>"
pnpm backup:stack
pnpm backup:rehearse-stack -- "output/backups/stack/<bundle-id>"
```

Sau khi nạp demo, đăng nhập quản trị tại `http://localhost:13014` (`admin@nocobase.com` / `admin123`), mở **`/admin/settings/dxos-studio`** để cài quy trình Poka-yoke, dựng cổng đa-block, hoặc bật UI Editor trên `/p/services` để thêm & tùy biến block DX-OS trực tiếp.

---

## 3. Cấu trúc Kho mã nguồn

| Thư mục / Tệp | Trách nhiệm |
| --- | --- |
| `plugins/nocobase/*` | 7 plugin NocoBase độc lập (`Apache-2.0`, `sdkProvidedByHost: true`) và bộ kiểm thử `node --test`. |
| `apps/api`, `apps/agent-worker`, `apps/file-scanner` | Fastify API tích hợp (`apps/api`), worker thuần `node:http` (`apps/agent-worker`) và sidecar quét tệp ClamAV/RustFS thuần `node:http` (`apps/file-scanner`) (`@dx/*`). |
| `packages/contracts` | Hợp đồng schema và kiểm tra kiểu dùng chung (`@dx/contracts`). |
| `infra/compose/*.yml` | Cấu hình Docker Compose khóa digest `@sha256:` cho core stack, NocoBase `2.2.50`, stack IIoT chuẩn OSI (`iiot.yml`: Mosquitto/Node-RED/TimescaleDB OSS), clean rehearsal và cấu hình Zero-Trust Production (`prod.yml`, `pgvector/pgvector:0.8.1-pg16`, Redis, RustFS). |
| `scripts/` | Công cụ cài đặt workspace, clean-install, seed Multi-Portal/Workspace, kiểm toán PoF (`verify-pof-readiness.mjs`) và đóng gói nguồn (`build-oss-release-tarball.mjs`). |
| `solutions/` & `logistics-order-webhook.json` | Mẫu quy trình tham chiếu, fixture n8n NGSI-LD webhook và cấu hình nghiệp vụ Logistics/Incident. |
| `upstream/nocobase` | Git submodule chỉ-đọc tại commit `5b47bec116c52239348c09d360e4bd2649c99efc` phục vụ khảo sát kiến trúc; bị loại trừ khỏi tarball phát hành và workspace build. |

Các biến môi trường mặc định được mô tả trong [`.env.example`](.env.example). **Không** triển khai mật khẩu demo local lên Internet; chỉ dùng cho môi trường đánh giá và phát triển cục bộ.

---

## 4. Tuân thủ Nguồn mở (OLP PMNM 2026 PoF)

```sh
node scripts/source-headers.mjs --check   # Xác minh 100% file nguồn gốc mang @copyright + SPDX Apache-2.0
pnpm pof:check                            # Audit PoF (tài liệu quản trị, COPYRIGHT.txt, cô lập 7 plugin, digest Compose, không secret)
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:tarball                      # Xuất output/release/latticedx-0.3.0-src.tar.gz + .sha256
```

- Toàn bộ quy trình đóng góp, phát hành và kiểm kê dependency xem tại [`COPYRIGHT.txt`](COPYRIGHT.txt), [`NOTICE`](NOTICE), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md), [docs/third-party.md](docs/third-party.md), [docs/dependency-inventory.md](docs/dependency-inventory.md) và [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md).
- Báo lỗi hoặc đề xuất cải tiến tại **GitHub Issues**: <https://github.com/CTU-OpenPaw/lattice-dx/issues>.

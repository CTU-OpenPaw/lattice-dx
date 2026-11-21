<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX · Open-Core Digital Enterprise Platform (DX-OS)

**LatticeDX** là nền tảng hệ điều hành doanh nghiệp số nguồn mở (**DX-OS Open-Core**, phát hành theo giấy phép **Apache-2.0**) do **CTU-OpenPaw** phát triển cho kỳ thi **OLP PMNM 2026 (VFOSSA)**. Nền tảng hợp nhất **Con người (`[H]`) – Quy trình (`[P]`) – Dữ liệu (`[D]`) – Trí tuệ (`[I]`)** trên nền tảng cấu hình trực tiếp trong **NocoBase `2.2.38`**, kết hợp bộ **6 plugin Apache-2.0** cài đặt và bật/tắt linh hoạt ngay trong giao diện quản trị NocoBase.

> - **Báo cáo kỹ thuật & Hướng dẫn vận hành chi tiết (kiến trúc, RBAC, Multi-Portal, AI Agent phòng ban thực thi CSDL, IT/OT & PoF):** [docs/system-report-and-guide.md](docs/system-report-and-guide.md)
> - Hướng dẫn trình diễn trực tiếp 15 phút (Admin Studio, Add block, P.A.R.A., PoF): [docs/DEMO_PACK.md](docs/DEMO_PACK.md)
> - Hồ sơ bản quyền & dependency chuẩn hóa: [`COPYRIGHT.txt`](COPYRIGHT.txt) · [`NOTICE`](NOTICE) · [`LICENSE`](LICENSE)
> - Build từ mã nguồn & PoF OLP PMNM 2026: [docs/build-from-source.md](docs/build-from-source.md) · [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md)

---

## 1. Kiến trúc Mô-đun 6 Plugin Open-Core (H–P–D–I)

Toàn bộ phần mở rộng NocoBase đặt trong `plugins/nocobase/*`, khai báo `"license": "Apache-2.0"` và `"sdkProvidedByHost": true`, không sao chép hay sửa mã nguồn `upstream/nocobase`, và giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.38`, `License settings`):

| Package | Phiên bản | Trụ cột | Vai trò chính |
| --- | :---: | :---: | --- |
| [`@latticedx/plugin-lattice-foundation`](plugins/nocobase/plugin-lattice-foundation/README.md) | `0.25.1` | `[D][H][I]` | Collections lõi (`latticeRequests`, `latticeAssets`, `latticeOrders`, `latticeIncidentCases`, `latticeIncidentRules`, ...), 7 vai trò `ldx_*`, Multi-Portal UI (`/p/*`, `/admin/settings/multi-portal`), đề xuất AI có bằng chứng & đồng bộ NGSI-LD. |
| [`@latticedx/plugin-dxos-para`](plugins/nocobase/plugin-dxos-para/README.md) | `0.1.0` | `[H]` | Không gian tri thức P.A.R.A. (`projects`, `areas`, `resources`, `archives`) trên collection `latticeParaDocuments` với `uiManageable: true`, ACL 7 vai trò, tách phạm vi `organizationId`, và API `latticePara:summary`. |
| [`@latticedx/plugin-dxos-blocks`](plugins/nocobase/plugin-dxos-blocks/README.md) | `0.1.0` | `[H][P][D][I]` | 6 Native v2 `BlockModel` cấu hình trực tiếp trong `Add block` (`dxosBlockSettings`): Portal Hero, KPI Metric Grid, NGSI-LD Context Telemetry, AI Proposal & Evidence, Workflow My Tasks (`workflowManualTasks:listMine`), P.A.R.A. Knowledge Vault; cộng 2 API scoped `dxosBlocks:proposals` & `dxosBlocks:contextTelemetry`. |
| [`@latticedx/plugin-dxos-studio`](plugins/nocobase/plugin-dxos-studio/README.md) | `0.1.0` | `[P][H][D]` | Bảng điều khiển `/admin/settings/dxos-studio`: cài 1-nhấp 4 mẫu quy trình Poka-yoke (`procurement`, `logistics-5step`, `incident-uc2`, `internal-service`), dựng trang tổng quan đa-block (`composePortals`), theo dõi 6 plugin và collection `latticeServiceTickets`. |
| [`@latticedx/plugin-enterprise-auth`](plugins/nocobase/plugin-enterprise-auth/README.md) | `0.1.0` | `[H]` | Đăng nhập doanh nghiệp Keycloak OIDC + PKCE ánh xạ an toàn về phiên NocoBase native. |
| [`@latticedx/plugin-action-bridge`](plugins/nocobase/plugin-action-bridge/README.md) | `0.4.1` | `[P][I]` | Cầu nối hành động và tương thích quy trình giữa API/Studio cốt lõi và giao diện `/lattice/*`. |

---

## 2. Khởi tạo Nhanh & Thử nghiệm Trình duyệt Sạch (`pnpm native:clean`)

Yêu cầu: **Node.js `24.x`** (`>=24 <25`), **pnpm `10.23.0`**, **Git**, **tar**, và **Docker Desktop / Docker Compose v2+** (khi chạy stack container).

```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
pnpm install --frozen-lockfile
```

### A. Build & Kiểm thử Monorepo + 6 Plugin (Offline / CI)

```sh
# 1. Build cả 6 plugin NocoBase
node plugins/nocobase/action-bridge/build.mjs
node plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs
node plugins/nocobase/plugin-enterprise-auth/build.mjs
node plugins/nocobase/plugin-dxos-para/build.mjs
node plugins/nocobase/plugin-dxos-blocks/build.mjs
node plugins/nocobase/plugin-dxos-studio/build.mjs

# 2. Kiểm thử đơn vị 6 plugin + scripts PoF/demo
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs

# 3. Typecheck, Vitest workspace (apps + packages + tests) & build Next.js / Fastify
pnpm check
```

### B. Dựng môi trường NocoBase `2.2.38` sạch từ DB 0 bảng

Lệnh dưới đây xuất mã nguồn từ `HEAD`, dựng PostgreSQL `16.13` trống và NocoBase `2.2.38` ở cổng cô lập (ví dụ `13014`), cài và kích hoạt đủ 6 plugin Apache-2.0, kiểm tra migrations và xuất file `report.json` nghiệm thu (chi tiết tại [docs/native-clean-install.md](docs/native-clean-install.md)):

```sh
pnpm native:clean --port=13014
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"
# (Tùy chọn) Nạp AI workflow "Tạo Phiếu Bảo trì Kho lạnh" & trợ lý phòng ban kho-lanh-ops
node scripts/setup-department-ai-agent.mjs "<path-to-report.json>"
```

Sau khi nạp demo, đăng nhập quản trị tại `http://localhost:13014` (`admin@nocobase.com` / `admin123`), mở **`/admin/settings/dxos-studio`** để cài quy trình Poka-yoke, dựng cổng đa-block, hoặc bật UI Editor trên `/p/services` để thêm & tùy biến block DX-OS trực tiếp.

---

## 3. Cấu trúc Kho mã nguồn

| Thư mục / Tệp | Trách nhiệm |
| --- | --- |
| `plugins/nocobase/*` | 6 plugin NocoBase độc lập (`Apache-2.0`, `sdkProvidedByHost: true`) và bộ kiểm thử `node --test`. |
| `apps/api`, `apps/agent-worker`, `apps/web` | Fastify API tích hợp, worker xử lý đề xuất AI/IoT và giao diện Next.js companion (`@dx/*`). |
| `packages/contracts` | Hợp đồng schema và kiểm tra kiểu dùng chung (`@dx/contracts`). |
| `infra/compose/*.yml` | Cấu hình Docker Compose khóa digest `@sha256:` cho core stack, NocoBase runtime và clean rehearsal. |
| `scripts/` | Công cụ cài đặt workspace, clean-install, seed Multi-Portal/Workspace, kiểm toán PoF (`verify-pof-readiness.mjs`) và đóng gói nguồn (`build-oss-release-tarball.mjs`). |
| `solutions/` & `logistics-order-webhook.json` | Mẫu quy trình tham chiếu, fixture n8n NGSI-LD webhook và cấu hình nghiệp vụ Logistics/Incident. |
| `upstream/nocobase` | Git submodule chỉ-đọc tại commit `5b47bec116c52239348c09d360e4bd2649c99efc` phục vụ khảo sát kiến trúc; bị loại trừ khỏi tarball phát hành và workspace build. |

Các biến môi trường mặc định được mô tả trong [`.env.example`](.env.example). **Không** triển khai mật khẩu demo local lên Internet; chỉ dùng cho môi trường đánh giá và phát triển cục bộ.

---

## 4. Tuân thủ Nguồn mở (OLP PMNM 2026 PoF)

```sh
node scripts/source-headers.mjs --check   # Xác minh 100% file nguồn gốc mang @copyright + SPDX Apache-2.0
pnpm pof:check                            # Audit PoF (tài liệu quản trị, COPYRIGHT.txt, cô lập 6 plugin, digest Compose, không secret)
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:tarball                      # Xuất output/release/latticedx-0.1.0-src.tar.gz + .sha256
```

- Toàn bộ quy trình đóng góp, phát hành và kiểm kê dependency xem tại [`COPYRIGHT.txt`](COPYRIGHT.txt), [`NOTICE`](NOTICE), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md), [docs/third-party.md](docs/third-party.md), [docs/dependency-inventory.md](docs/dependency-inventory.md) và [docs/oss-pof-compliance.md](docs/oss-pof-compliance.md).
- Báo lỗi hoặc đề xuất cải tiến tại **GitHub Issues**: <https://github.com/CTU-OpenPaw/lattice-dx/issues>.

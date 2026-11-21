<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Báo cáo Kỹ thuật & Hướng dẫn Vận hành Chi tiết — LatticeDX DX-OS

Tài liệu này tổng hợp kiến trúc kỹ thuật, phạm vi tùy biến chuyên sâu cho doanh nghiệp Việt Nam, hiện trạng kiểm thử/tuân thủ nguồn mở (**OLP PMNM 2026 — VFOSSA**) và hướng dẫn từng bước từ cài đặt trắng đến vận hành đa cổng, Workflow Poka-yoke, AI Agent phòng ban thực thi trực tiếp vào CSDL và tích hợp IT/OT (FIWARE Orion-LD + n8n).

---

## Phần I. Báo cáo Kỹ thuật Tổng thể Hệ thống

### 1. Định vị Kiến trúc Open-Core & Phạm vi Tùy biến Doanh nghiệp Việt

**LatticeDX DX-OS** sử dụng **NocoBase `2.2.38`** làm **công cụ lõi nguồn mở** cung cấp runtime host, giao diện dựng trang, trình quản lý dữ liệu và bộ công cụ workflow; toàn bộ cấu trúc nghiệp vụ doanh nghiệp Việt, 6 plugin mở rộng, giao thức đa cổng, hệ thống phân quyền RBAC chi tiết, chuẩn hóa tri thức P.A.R.A., các block tùy biến và tác vụ AI do nhóm **CTU-OpenPaw** thiết kế và phát triển dưới giấy phép **Apache-2.0**.

- **Cô lập mã nguồn sạch (Plugin-first, Zero Upstream Patch):** Không chỉnh sửa hay phân phối lại mã nguồn NocoBase trong `upstream/nocobase/`. Cả 6 plugin trong `plugins/nocobase/*` đều khai báo `"license": "Apache-2.0"`, `"nocobase": { "sdkProvidedByHost": true }`, kèm `LICENSE` và `README.md` riêng.
- **Minh bạch Điều 5.2 NocoBase:** Bảo toàn toàn bộ nhận diện `Powered by NocoBase`, phiên bản `v2.2.38` tại chân trang vận hành/portal và `License settings`.
- **Hợp nhất 4 trụ cột DX-OS (`[H] – [P] – [D] – [I]`):**
  - **`[H]` Con người & Không gian làm việc:** 7 vai trò nghiệp vụ `ldx_*`, danh bạ nhân sự/đơn vị, kho tri thức P.A.R.A., đăng nhập tập trung Keycloak OIDC + PKCE.
  - **`[P]` Quy trình chống sai sót (Poka-yoke):** Tách người gửi – người duyệt, hộp việc `workflowManualTasks:listMine`, đồ thị Logistics 5 bước liên phòng ban, quy trình Phiếu Dịch vụ Nội bộ.
  - **`[D]` Dữ liệu & Tích hợp IT/OT:** Bảng nghiệp vụ động `uiManageable: true`, tách phạm vi theo `organizationId`, Outbox đồng bộ tài sản thời gian thực sang FIWARE Orion-LD NGSI-LD.
  - **`[I]` Trí tuệ & Agent Thực thi:** Gateway model cục bộ OpenAI-compatible (`9router` cổng `20128`), AI Agent phòng ban gọi workflow tool ghi bản ghi trực tiếp vào PostgreSQL, và luồng tự trị n8n lưu đề xuất có mã băm SHA256.

---

### 2. Kiến trúc 6 Plugin Apache-2.0 (`@latticedx/*`) & Thành phần Hạ tầng

| Thành phần / Package | Phiên bản | Giấy phép | Phạm vi trách nhiệm đã hoàn thiện |
| --- | :---: | :---: | --- |
| `@latticedx/plugin-action-bridge` | `0.4.1` | `Apache-2.0` | Cầu nối hành động server-side, proxy thực thi có khóa idempotency, kiểm tra quyền theo session, bridge `entityContext` & `detail`. |
| `@latticedx/plugin-lattice-foundation` | `0.25.1` | `Apache-2.0` | Collections lõi (`latticeDepartments`, `latticeEmployees`, `latticeLocations`, `latticeAssets`, `latticeRequests`, `latticeOrders`, `latticeIncidentCases`, `latticeIncidentRules`, `latticeAgentProposals`, `latticePortals`), 7 vai trò `ldx_*`, Multi-Portal Manager (`/admin/settings/multi-portal`), portal động `/p/<slug>`, NGSI-LD Outbox & UC2 `agent-run`. |
| `@latticedx/plugin-enterprise-auth` | `0.1.0` | `Apache-2.0` | Đăng nhập doanh nghiệp Keycloak OIDC + PKCE S256 (`/admin/settings/auth/authenticators`), ánh xạ tài khoản rõ ràng tại `/admin/settings/auth/enterprise-mappings`, không tự tạo tài khoản/cấp quyền khi login. |
| `@latticedx/plugin-dxos-para` | `0.1.0` | `Apache-2.0` | Không gian tri thức **P.A.R.A.** trên `latticeParaDocuments` (`uiManageable: true`), cô lập `organizationId`/`ownerId`, ACL 7 vai trò và API `GET /api/latticePara:summary`. |
| `@latticedx/plugin-dxos-blocks` | `0.1.0` | `Apache-2.0` | 6 Native v2 `BlockModel` đăng ký thẳng vào nút **`Add block`** của UI Editor (`dxosBlockSettings`) + 2 API scoped (`dxosBlocks:proposals`, `dxosBlocks:contextTelemetry`). |
| `@latticedx/plugin-dxos-studio` | `0.1.0` | `Apache-2.0` | Màn hình **`/admin/settings/dxos-studio`**: cài 1-nhấp 4 workflow Poka-yoke (`procurement`, `logistics-5step`, `incident-uc2`, `internal-service`), dựng trang tổng quan đa-block idempotent (`dxosStudio:composePortals`), giám sát 6 plugin, collection `latticeServiceTickets` (`uiManageable: true`). |
| Dịch vụ đồng hành & OCI Compose | — | Đa dạng (`NOTICE`) | `apps/api` (Fastify), `apps/agent-worker`, `apps/web` (Next.js), `@dx/contracts`, `PostgreSQL 16.13`, `Keycloak 26.8.0`, `APISIX 3.19.0`, `FIWARE Orion-LD 1.10.0` + `MongoDB 4.4.29`, `n8n 2.42.7`, `ClamAV 1.4.3` (mọi image trong `infra/compose/*.yml` đều khóa digest `@sha256:`). |

---

### 3. Mô hình Dữ liệu, Multi-Portal, RBAC & Bảo mật Vận hành

1. **Quản trị Cổng Nghiệp vụ Độc lập (Multi-Portal Manager):**
   - Tách riêng 4 cổng nghiệp vụ trên một hạ tầng lõi: **Mua sắm & Tài sản** (`/p/procurement`), **Vận hành & Sự cố IoT** (`/p/incidents`), **Điều hành Logistics** (`/p/logistics`) và **Dịch vụ Nội bộ & Danh bạ** (`/p/services`).
   - Hỗ trợ **Chỉnh sửa Portal** trực tiếp, **Tạo Portal mới** (ví dụ cổng phòng ban riêng `/p/maintenance`), gán whitelist vai trò `ldx_*`, xuất **Blueprint JSON** phục vụ GitOps, và dựng trang tổng quan an toàn không ghi đè chỉnh sửa tay (`dxosStudio:composePortals`).
2. **Phân quyền 3 Lớp (`ldx_*` RBAC):**
   - **Lớp Route & Portal:** Nhân viên chỉ thấy đúng các cổng và lối tắt được cấp phép; truy cập trái phép `/admin/settings/dxos-studio` bị chặn ngay màn hình `403`.
   - **Lớp Phạm vi Bản ghi (Data Scope):** Ví dụ trên `latticeRequests`, vai trò `Lattice — Nhân viên` xem giới hạn trong phạm vi `Lattice — Tài liệu liên quan` và chỉ sửa với `Lattice — Nháp của tôi`.
   - **Lớp Trường Dữ liệu (Field Permission):** Khóa ghi cột nhạy cảm (ví dụ cột `Trạng thái` bị tắt quyền `Edit` với nhân viên) và quản lý độc lập quyền `Add new / View / Edit / Export / Import`.
3. **AI Agent Phòng ban Thực thi Trực tiếp vs Hỏi Đáp Tự Trị:**
   - **AI Employee (`AIEmployeeTrigger`, `sync: true`):** Kết nối tới gateway tương thích OpenAI cục bộ (`local-9router` cổng `20128`) hoặc endpoint OpenAI-compatible bất kỳ. Khi gắn workflow có `type: "ai-employee"` và `sync: true`, NocoBase đăng ký tự động công cụ `workflowCaller-<key>`; các tham số tool được đặt trực tiếp tại gốc `execution.context` (`{{$context.code}}`, `{{$context.name}}`, `{{$context.priority}}`, `{{$context.description}}`), và node `Output` trả kết quả JSON để Agent xác nhận ID bản ghi vừa tạo vào bảng đích (`latticeServiceTickets`).
   - **Agent Tự trị IT/OT (`UC2`):** Cảm biến/Orion-LD quá nhiệt `> 80°C` gửi webhook sang **n8n** (`uc2-observation-review.json` 6 nút: `Receive Observation -> Find Proposal Receipt -> Already Saved? -> Read Asset -> Recommend -> Save Proposal`), lưu đề xuất bảo trì kèm bằng chứng và mã băm chống trùng/chống sửa đổi lên khối **`DX-OS AI Proposal & Evidence`**.

---

### 4. Kiểm toán Tuân thủ Nguồn mở (PoF — OLP PMNM 2026)

Toàn bộ các kiểm tra tự động sau được thực thi trực tiếp trên nhánh tích hợp hiện tại:

- `node scripts/source-headers.mjs --check`: `721` tệp mã nguồn hạng nhất đạt `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` (`needsReview: []`, bổ sung script mới cũng bắt buộc giữ nguyên quy chuẩn này).
- `pnpm pof:check` (`scripts/verify-pof-readiness.mjs`): `PASS` toàn bộ 6 tiêu chí (`spdx-headers`, `governance-files`, `plugin-isolation`, `compose-digests`, `upstream-clean`, `no-secrets`).
- Bảo toàn tuyệt đối thông tin giấy phép nguồn gốc tại [`COPYRIGHT.txt`](../COPYRIGHT.txt), [`NOTICE`](../NOTICE), [`LICENSE`](../LICENSE), [`docs/third-party.md`](third-party.md), [`docs/dependency-inventory.md`](dependency-inventory.md) và [`docs/oss-pof-compliance.md`](oss-pof-compliance.md).

---

## Phần II. Hướng dẫn Cài đặt, Cấu hình & Vận hành Từng Bước

### 1. Yêu cầu Môi trường

- **Node.js `24.x`** (`>=24 <25`) và **`pnpm 10.23.0`**
- **Git** & **`tar`**
- **Docker Desktop / Docker Compose v2+** (Linux containers / context `desktop-linux` trên Windows)
- *(Tùy chọn cho AI Agent & IT/OT)*: Local LLM gateway tương thích OpenAI (ví dụ `9router` chạy tại cổng `20128`), FIWARE Orion-LD (`1026`), n8n (`5678`) theo cấu hình Compose của repo.

### 2. Cài đặt Mã nguồn, Build 6 Plugin & Chạy Kiểm thử Offline

```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
pnpm install --frozen-lockfile

# Build toàn bộ 6 plugin NocoBase Apache-2.0
node plugins/nocobase/action-bridge/build.mjs
node plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs
node plugins/nocobase/plugin-enterprise-auth/build.mjs
node plugins/nocobase/plugin-dxos-para/build.mjs
node plugins/nocobase/plugin-dxos-blocks/build.mjs
node plugins/nocobase/plugin-dxos-studio/build.mjs

# Chạy bộ kiểm thử đơn vị plugin + script + monorepo + kiểm toán PoF
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs
pnpm check
pnpm pof:check
node scripts/source-headers.mjs --check
```

### 3. Dựng Runtime NocoBase `2.2.38` Sạch Từ 0 Bảng & Nạp Dữ liệu Demo

```sh
# 1. Tạo dự án container sạch từ git HEAD (cổng 13004..13999, ví dụ 13014)
pnpm native:clean --port=13014

# 2. Nạp 4 Cổng nghiệp vụ + dữ liệu mẫu + DX-OS đa-block
node scripts/setup-native-multi-portal-demo.mjs "output/native-clean/<id>/report.json"

# 3. Nạp Workspace Yêu cầu nội bộ & nút Tạo nhanh
node scripts/setup-native-workspace-demo.mjs "output/native-clean/<id>/report.json"
```

> **Tài khoản thử nghiệm cục bộ (`localhost`):**
> - Quản trị viên: `admin@nocobase.com` / `admin123`
> - Nhân viên: `native.lab.employee@example.invalid` / `NativeLab-2026!`
> - Quản lý: `native.lab.manager@example.invalid` / `NativeLab-2026!`
> - Thủ kho: `native.lab.worker@example.invalid` / `NativeLab-2026!`
> - Điều phối / Tài xế: `native.lab.dispatcher@example.invalid` / `native.lab.driver@example.invalid` (`NativeLab-2026!`)

### 4. Hướng dẫn Cấu hình & Tùy biến Nghiệp vụ trên Giao diện

1. **Kiểm tra 6 Plugin & Cấu hình Hệ thống:**
   - Truy cập `/admin/settings/plugin-manager`, gõ `latticedx` để kiểm tra đủ 6 module Apache-2.0.
   - Mở `/admin/settings/system-settings` để xem/chỉnh tiêu đề hệ thống và ngôn ngữ (`Tiếng Việt (vi-VN)` / `English (en-US)`). Chân trang vận hành tại `/admin/lattice-workspace` và `/p/*` luôn giữ attribution `Powered by NocoBase`.
2. **Tạo Cột Động & Thiết lập RBAC theo Cột / Keycloak SSO:**
   - **Thêm trường dữ liệu động:** Vào `Data sources -> Main -> latticeRequests -> Configure fields -> + Add field -> Single line text` (ví dụ nhãn `Ghi chú phê duyệt`, mã `approvalNote`, `Submit`).
   - **Kiểm tra RBAC chặt theo trường & scope:** Vào `Users & Permissions -> Roles & Permissions -> Lattice — Nhân viên -> Data sources -> Main -> Action permissions -> Yêu cầu nghiệp vụ -> Configure -> Individual`. Quan sát `Action permission` (`View: Lattice — Tài liệu liên quan`, `Edit: Lattice — Nháp của tôi`) và `Field permission` (cột `Trạng thái` khóa `Edit`, bật/tắt `Export` độc lập).
   - **Keycloak SSO:** Vào `Authentication -> + Add new -> Enterprise login (Keycloak)` và `Enterprise identity mappings` (`/admin/settings/auth/enterprise-mappings`) để ánh xạ Keycloak `subject` sang `NocoBase user ID` sẵn có.
3. **Multi-Portal Manager & DX-OS Control Studio:**
   - Vào `/admin/settings/multi-portal` để **`Chỉnh sửa Portal`**, **`+ Tạo Portal mới`** (ví dụ `Kỹ thuật & Bảo trì`, slug `maintenance`, chọn màu & role `ldx_*`), hoặc **`Xuất Blueprint JSON`**.
   - Vào `/admin/settings/dxos-studio`:
     - Tab `1. Quy trình Poka-yoke`: chọn tổ chức `native-ui-lab`, nhấn **`Cài đặt quy trình vào NocoBase`** cho `Mua sắm`, `Điều phối Logistics 5 bước`, `Sự cố IoT`, hoặc `Dịch vụ Nội bộ`, sau đó bấm **`Mở Workflow Designer`** để tùy biến nút đồ thị.
     - Tab `2. Dựng cổng đa-block`: bấm **`Dựng Cổng Đa-Block ngay`** để bổ sung an toàn các trang/block còn thiếu.
4. **UI Editor Trực quan (`Add block`) & Theme Editor:**
   - Mở `/p/services` (hoặc cổng bất kỳ), bật nút **`UI Editor`**, bấm **`Add block`** để chọn 1 trong **6 block DX-OS** (`DX-OS Portal Hero & Quick Actions`, `DX-OS KPI Metric Grid`, `DX-OS NGSI-LD Context & Telemetry`, `DX-OS AI Proposal & Evidence`, `DX-OS Workflow & My Tasks`, `DX-OS P.A.R.A. Knowledge Vault`).
   - Nhấn menu bánh răng trên block chọn **`Cấu hình nội dung`** để đổi tiêu đề, mã màu Hex hoặc JSON KPI; tắt UI Editor và tải lại trang (`F5`) để xác nhận lưu bền trong PostgreSQL. Vào `/admin/settings/theme-editor` để đổi giao diện Sáng/Tối/Compact.

### 5. Thiết lập AI Agent Phòng ban Thực thi Trực tiếp (`Tạo Phiếu Bảo trì Kho lạnh`)

Bạn có thể cấu hình tự động bằng script mới tích hợp sẵn trong repo hoặc tự dựng qua giao diện:

#### Cách A — Tự động hóa bằng Script (khuyến nghị sau `pnpm native:clean`)

```powershell
# Đặt biến môi trường chứa API key cho gateway local (không lưu key vào Git)
$env:AGENT_API_KEY = "<your-local-gateway-key>"

# Dựng đầy đủ AI workflow "Tạo Phiếu Bảo trì Kho lạnh", kết nối local-9router và AI Employee kho-lanh-ops
node scripts/setup-department-ai-agent.mjs --origin=http://localhost:13014 --model=ag/gemini-3.8-flash

# Hoặc chỉ tạo Workflow Trigger (để demo thao tác dựng AI Employee "Chuyên viên Kho lạnh AI" trên UI)
node scripts/setup-department-ai-agent.mjs --origin=http://localhost:13014 --workflow-only --skip-llm
```

> Các tham số hỗ trợ: `<clean-install report.json>` hoặc `--origin=http://localhost:13004..13999`, `--model=<id>` (mặc định `combo`; khuyến nghị chỉ định `ag/gemini-3.8-flash` nếu alias `combo` trên gateway đang quá tải upstream), `--llm-url=<url>` (mặc định `http://host.docker.internal:20128/v1`), `--org=<organizationId>` (mặc định `native-ui-lab`), `--workflow-only`, `--skip-llm`.

#### Cách B — Tạo & Kiểm chứng Thủ công trên Giao diện

1. Kiểm tra quy trình **`Tạo Phiếu Bảo trì Kho lạnh`** (`type: ai-employee`, `sync: true`, `On`) trong `/admin/settings/workflow` gồm 3 bước: `AI employee event` (`code`, `name`, `priority`, `description`) -> `Create record` vào `latticeServiceTickets` dùng `{{$context.code}}`, `{{$context.name}}`, `{{$context.priority}}`, `{{$context.description}}` -> `Output` (`{{$jobsMapByNodeKey.createTicket}}`).
2. Vào `/admin/settings/ai/employees`:
   - Tab **LLM services**: kiểm tra dịch vụ `local-9router` (`http://host.docker.internal:20128/v1`, các model đã bật).
   - Tab **AI employees -> `+ New AI employee`**: nhập `username = kho-lanh-ops`, `nickname = Chuyên viên Kho lạnh AI`, dán chỉ thị SOP ở **Role setting**, bật chọn model ở **Model settings**, mở **Tools -> Add tool -> `Tạo Phiếu Bảo trì Kho lạnh`**, chuyển quyền thành **`Allow`** (`autoCall: true`) rồi nhấn **`Submit`**.
3. Mở `/admin/lattice-workspace`, nhấn biểu tượng **`Open AI chat`** góc dưới phải, đổi trợ lý sang **`Chuyên viên Kho lạnh AI`**, gửi lệnh:
   > `Hãy kiểm tra nhanh các phiếu hiện có trong bảng latticeServiceTickets (dataSource main), sau đó gọi ngay tool Tạo Phiếu Bảo trì Kho lạnh để tạo phiếu mã SRV-AI-2026-01, tên "Kiểm tra dàn ngưng và cảm biến PT100 máy COLD-CHILLER-01", độ ưu tiên high, mô tả "Kiểm tra quá nhiệt 86.5°C theo quy trình PARA-SOP-01".`
4. Xác nhận khung chat gọi tool tích xanh và trang **`Phiếu Dịch vụ Nội bộ`** (`/p/services/...`) xuất hiện bản ghi **`SRV-AI-2026-01`**.

### 6. Kiểm toán PoF & Đóng gói Phát hành

```sh
pnpm pof:check
pnpm release:tarball --ref=v0.1.0
```

Giải nén `output/release/latticedx-0.1.0-src.tar.gz` vào thư mục tạm ngoài Git để kiểm chứng lại `pnpm install --frozen-lockfile && pnpm pof:check && pnpm check && node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs`.

---

## Phần III. Khắc phục Sự cố Thường gặp

| Hiện tượng | Nguyên nhân điển hình | Cách xử lý |
| --- | --- | --- |
| AI Agent trả lỗi `503` khi gọi `combo` | Một model upstream trong alias `combo` trên `9router` hết quota hoặc lỗi session. | Chuyển model trực tiếp sang `ag/gemini-3.8-flash` (hoặc chạy `setup-department-ai-agent.mjs --model=ag/gemini-3.8-flash`) trên cùng cổng `local-9router`. |
| Workflow `ai-employee` không xuất hiện trong `Add tool` | Workflow chưa bật `On`, chưa có `sync: true` hoặc thiếu node `Output`. | Đảm bảo workflow bật `Synchronously` (`sync: true`), trạng thái `On`, gọi `workflows:sync`, hoặc chạy lại `setup-department-ai-agent.mjs`. |
| Không xóa được trường đã thêm bằng API (`Cannot remove a UI manageable field`) | Collection mang cờ `uiManageable: true`. | Tạm đặt `uiManageable: false`, gọi `collections/<name>/fields:destroy`, rồi khôi phục `uiManageable: true`. |
| `node scripts/source-headers.mjs --check` báo thiếu header | Tệp mã nguồn mới chưa có header `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0`. | Dán chuẩn header đầu tệp như các tệp khác trong `scripts/` hoặc dùng `node scripts/source-headers.mjs --write` (với tệp đã đánh dấu SPDX). |

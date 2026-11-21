<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Báo cáo Nghiệm thu Live: Nhân sự AI Quản trị Động & Enterprise MCP 2 Chiều (`@latticedx/plugin-dxos-ai`)

**Thời gian kiểm chứng live:** `2026-11-21T11:16:52Z` (`18:16:52 +07:00`)  
**Môi trường thực thi:** Docker Desktop `29.8.2` (7 containers live: `lattice-native-clean-b0a7c8dfc5c2-nocobase-1` tại `http://localhost:13014`, `nocobase-db`, `lattice-dx-postgres-1`, `lattice-dx-keycloak-1`, `lattice-dx-orion-mongo-1`, `lattice-dx-orion-ld-1`, `lattice-dx-n8n-1`)  
**Phiên bản Host:** `nocobase/nocobase:2.2.38` (`Powered by NocoBase (v2.2.38 preserved)`)  
**Nhánh / Plugin thứ 7:** `feat/dxos-ai-workforce-mcp` — `@latticedx/plugin-dxos-ai@0.1.0` (`Apache-2.0`, `sdkProvidedByHost: true`)

---

## 1. Cài đặt Live 7 Plugin & Khởi tạo AI Workforce (`pnpm setup:dxos-ai`)

- Trạng thái `yarn nocobase pm list` trong `lattice-native-clean-b0a7c8dfc5c2-nocobase-1`: đủ **7/7 plugin `@latticedx/*`** ở trạng thái `enabled: true`:
  `@latticedx/plugin-action-bridge`, `@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-enterprise-auth`, `@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-blocks`, `@latticedx/plugin-dxos-studio`, `@latticedx/plugin-dxos-ai`.
- Kết quả chạy lệnh `pnpm setup:dxos-ai -- --origin=http://localhost:13014`:
  - `result: "PASS"`
  - `bootstrappedCount: 5`, `activeProfileCount: 5`: `dxos-architect`, `dxos-coordinator`, `dxos-logistics`, `dxos-ops`, `dxos-workspace`.
  - `llm`: `{ configured: true, skipped: false, serviceName: "local-9router", baseURL: "http://host.docker.internal:20128/v1" }`.
  - `itOtMcpSynced: true` (`aiMcpClients` đã đồng bộ `dxos-it-ot-mcp` dùng `transport: "http"`, `useUserContext: true`, header `Authorization: Bearer {{request.token}}`).

---

## 2. Nghiệm thu E2E Nhân sự AI, RBAC & Cổng Streamable HTTP MCP 2 Chiều (`pnpm acceptance:dxos-ai-mcp`)

Kết quả trực tiếp từ `pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014` (`result: "PASS"`, `16/16` kiểm tra đạt):

| Hạng mục kiểm chứng | Kết quả live | Ghi chú thực tế |
| --- | :---: | --- |
| Truy cập MCP không Bearer token (`POST /api/dxos-mcp`) | PASS | Trả HTTP `401` kèm `WWW-Authenticate` & JSON-RPC `-32001` |
| Nhân viên (`ldx_employee`) gọi `tools/list` trên `/api/dxos-mcp` | PASS | Chỉ trả về các tool tác nghiệp/cá nhân, ẩn hoàn toàn 5 Admin Builder tools |
| Nhân viên gọi trực tiếp `dxos_compose_page_blocks` qua MCP | PASS | Bị từ chối JSON-RPC `-32003` và ghi log `denied` |
| Nhân viên gọi `dxosAi:enterpriseTopology` | PASS | Bị chặn HTTP `403` (`DXOS_ADMIN_REQUIRED`) |
| Nhân viên gọi `dxosAi:portalCopilot?portalSlug=services` | PASS | Chỉ trả trợ lý thuộc role & portal; không rò rỉ `dxos-architect` |
| Admin (`root`) gọi MCP `initialize` & `tools/list` trên `/api/dxos-mcp` | PASS | Phản hồi `protocolVersion: "2025-03-26"`, liệt kê đủ 8 Unified Tools (`scope: 'CUSTOM'`) |
| Admin gọi MCP `dxos_inspect_architecture` & `dxos_compose_page_blocks` (`dryRun: true`) | PASS | Thành công (`isError: false`, trả preview blueprint `dryRun: true`) |
| Admin đọc MCP Resource `dxos://topology/planes` | PASS | Trả về đủ **6 phân hệ** và `clause52Preserved: true` |
| Endpoint MCP IT/OT `/api/dxos-mcp/it-ot` (`tools/list`, health, telemetry) | PASS | Liệt kê 4 IT/OT tools; `get_stack_connector_health` & `get_live_ngsi_telemetry` trả live OK |
| Vòng đời AI Employee Admin tự tạo (`saveProfile` → `portalCopilot` → `deleteProfile`) | PASS | Tạo động `dxos-e2e-custom-bc5p0`, nhân viên thấy ngay trên `/p/services`, sau đó dọn sạch |
| Nhật ký kiểm toán `latticeAiAuditLogs` (`dxosAi:auditLogs`) | PASS | Ghi đầy đủ lịch sử `aiProfileCount: 5`, `aiAuditCount: 17` |

---

## 3. Hiện trạng 6 Phân hệ Live (`dxosAi:enterpriseTopology` & `dxosStudio:readiness`)

| Thứ tự | Phân hệ LatticeDX | Trạng thái (`healthy`) | Thông số live quan sát được |
| :---: | --- | :---: | --- |
| 1 | Identity, Gateway & Security Guardrails | `true` | Keycloak probe `200`, `rolesCount: 11` |
| 2 | IT/OT Digital Twin & Context Broker | `true` | FIWARE Orion-LD probe `200`, `assetsCount: 3`, `outboxPending: 0` |
| 3 | Integration & Automation Event Bus | `true` | n8n probe `200`, `activeWorkflowsCount: 4` |
| 4 | Multi-Portal Workspaces & P.A.R.A. Knowledge Vault | `true` | `layoutCount: 6`, `paraDocumentsCount: 4` (`portalCount: 4`, `serviceTicketCount: 2`) |
| 5 | Admin-Configurable AI Workforce & 2-Way Streamable MCP | `true` | Endpoints `/api/dxos-mcp`, `/api/dxos-mcp/it-ot`, `activeAiProfilesCount: 5`, `auditLogsCount: 17` |
| 6 | NocoBase 2.2.38 Application Data & UI Substrate | `true` | `collectionsCount: 16`, `Powered by NocoBase (v2.2.38 preserved)` |

---

## 4. Kiểm chứng Không Hồi quy Nghiệp vụ Lõi (`pnpm acceptance:logistics-rbac`)

Thực thi `pnpm acceptance:logistics-rbac -- --origin=http://localhost:13014` ngay sau khi kích hoạt `@latticedx/plugin-dxos-ai`:

- `result: "PASS"` (`organizationId: "native-ui-lab"`):
  - **Logistics 5 bước (`workflowId: 398786389671936`):** Đơn `ORD-E2E-QBC6G7` hoàn thành tới `status: "completed"` (`assigneeId: 35`, `decisionReason: "Đã giao nguyên seal E2E OK"`).
  - **Dịch vụ Nội bộ (`workflowId: 398784396328960`):** Phiếu `SRV-E2E-QBC6G7` hoàn thành tới `status: "completed"` (`resolutionNote: "Hoàn tất cấp quyền VPN E2E OK"`).
  - **RBAC âm tính:** Toàn bộ **7/7 kiểm tra HTTP `403`** đạt (`employee_denied_dxosStudio_readiness`, `employee_denied_dxosStudio_composePortals`, `employee_denied_dxosStudio_installWorkflow`, `employee_denied_foreign_org_serviceTicket`, `employee_denied_foreign_org_paraDoc`, `employee_denied_spoof_approved_request`, `employee_cannot_submit_manager_manual_task`).

---

## 5. Nâng cấp v2 — Admin System Builder & 2 Đại Use Cases Live (`@latticedx/plugin-dxos-ai` v2)

Mở rộng `@latticedx/plugin-dxos-ai` từ 8 tool lên **11 Unified Tools** (7 Admin Builder + 4 Operational/Copilot) tương thích Zod v4 / Gemini / OpenAI (`propertyNames`-free, typed arrays, JSON coercion), kết nối `local-9router` (`http://host.docker.internal:20128/v1`, model `ag/gemini-3.8-flash`):

- **7 Admin Builder Tools (`root`/`admin` only):**
  - `dxos_inspect_architecture`, `dxos_compose_page_blocks` (`listBlocks`, `composePageBlueprint`, `updateBlock`, `reorderBlocks`, `removeBlock`), `dxos_manage_portal_and_acl` (`grant`, `revoke`), `dxos_extend_collection_schema` (`createCollection`, `addFields`, `inspectCollection`), `dxos_manage_rbac_permissions` (`inspectRole`, `ensureCustomRole`, `grantResource`, `lockFields`, `revokeResource`), `dxos_deploy_workflow`, `dxos_configure_workflow` (`inspectWorkflow`, `updateNodeConfig`, `addNode`, `buildCustomWorkflow`, `toggleWorkflow`).
- **4 Operational & Cross-Dept Copilot Tools:**
  - `dxos_search_enterprise_context` (tự động dò cả `latticeCustom*`), `dxos_execute_record_action` (kiểm soát RBAC từng trường), `dxos_my_tasks_copilot`, `dxos_orchestrate_enterprise_case` (`radar`, `correlateCase`, `executeCoordinatedResponse`).
- **Nghiệm thu Live E2E v2 (`pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014`):**
  - Đạt **19/19 kiểm tra (`result: "PASS"`)**, bổ sung `adminMcpToolsListed11`, `adminMcpRbacInspectAndRootBlocked`, `adminMcpWorkflowInspectOk`, `employeeCrossDeptRadarOk`.
- **Kiểm chứng Trực quan 2 Đại Use Cases trên `http://localhost:13014` (Full HD 1920x1080 · 30 fps · `190.0s`):**
  1. **Use Case 1 — Admin System Builder + Live `dxos-architect`:** Tạo bảng tùy biến `latticeCustomColdAudits`, dựng portal `/p/cold-qa` (`Hero` + `KPI` + `NativeTable` + `CreateForm`), trò chuyện live với `@dxos-architect` (`ag/gemini-3.8-flash`) gọi `dxos_inspect_architecture`, cập nhật trực tiếp Hero Block (`#1677ff` → `#0d9488`, `(v2 · Live Edited)`), khóa trường `auditVerdict` cho `ldx_employee`, mở quyền cho `ldx_manager`, dựng & bật workflow `Quy trình Kiểm định Kho lạnh Tự động` (`workflowId: 398974587568128`, tinh chỉnh node điều kiện `> -16°C`).
  2. **Use Case 2 — Nhân viên Cross-Dept Copilot & Thực thi RBAC Cấp trường:** Nhân viên (`ldx_employee`) vào `/p/cold-qa`, bấm `Allow use` chạy `dxos_orchestrate_enterprise_case`, điều phối tạo đồng bộ **3 phân hệ** `QA-COLD-001` (`latticeCustomColdAudits`) + `SRV-COLD-001` (`latticeServiceTickets`, `serviceType: "facilities"`) + `PARA-HO-001` (`latticeParaDocuments`, `status: "active"`), KPI tăng thực tế `0→1` / `0→1` / `4→5`; nhân viên cố ghi trường khóa `auditVerdict` bị chặn `RBAC_FIELD_LOCKED` (`status: "denied"`), Quản lý (`ldx_manager`) phê duyệt `CANH_BAO_BAO_TRI` hiển thị live trên bảng và toàn bộ vết được ghi rõ trong Tab 4 `Nhật ký Kiểm toán`.

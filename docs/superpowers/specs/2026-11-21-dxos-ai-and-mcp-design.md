# Thiết kế Kỹ thuật: `@latticedx/plugin-dxos-ai` — Hệ sinh thái Nhân sự AI Doanh nghiệp, Admin Builder & Cổng Enterprise MCP 2 Chiều

**Ngày chốt thiết kế:** 2026-11-21  
**Trạng thái:** Đã duyệt (Approved v2)  
**Vị thế hệ thống:** LatticeDX Enterprise Digital OS (6 phân hệ; NocoBase `2.2.38` là phân hệ nền tảng dữ liệu/metadata `appDataSubstrate` bên dưới lớp điều phối chung, giữ nguyên attribution Điều 5.2 NocoBase).

---

## 1. Mục đích & Định vị Kiến trúc

Biến lớp Trí tuệ `[I]` của **LatticeDX** thành lực lượng nhân sự số **do Quản trị viên tự định nghĩa hoàn toàn** (`100% Admin-configurable`) và **len lỏi xuyên suốt mọi phân hệ**, đồng thời định vị rõ **NocoBase chỉ là 1 trong 6 phân hệ** của hệ điều hành doanh nghiệp LatticeDX:

1. **Identity & Security (`[H]/[S]`):** Keycloak OIDC + PKCE, APISIX, 7 vai trò `ldx_*`, ClamAV quét tệp.
2. **IT/OT Digital Twin (`[D]/[I]`):** FIWARE Orion-LD Broker (`urn:ngsi-ld:*`), MongoDB, Sensor Rules & Outbox.
3. **Integration & Event Bus (`[P]`):** n8n Event Workflows, Webhook Inbound/Outbound có khóa idempotency.
4. **Knowledge & Portals (`[H]`):** Multi-Portal (`/p/*`), Kho tri thức P.A.R.A. (`latticeParaDocuments`), Quy trình Poka-yoke.
5. **AI Workforce & Enterprise MCP Fabric (`[I]`):** Plugin **`@latticedx/plugin-dxos-ai`** — Quản trị nhân sự AI động, Admin Builder, Long-Running Workflow Copilot, Cổng Streamable HTTP MCP 2 chiều (`/api/dxos-mcp` & `/api/dxos-mcp/it-ot`) & Nhật ký Kiểm toán AI (`latticeAiAuditLogs`).
6. **Application Data Substrate (`[D]`):** NocoBase `2.2.38` runtime lưu trữ bảng, trường, form và metadata giao diện (`sdkProvidedByHost: true`).

---

## 2. Mục tiêu, Phi mục tiêu & Chống mục tiêu

- **Mục tiêu:**
  1. Tách thành plugin Apache-2.0 thứ 7 độc lập **`@latticedx/plugin-dxos-ai`** (`sdkProvidedByHost: true`).
  2. Quản trị viên tự tạo mới / nhân bản / chỉnh sửa / bật-tắt AI Employee bất kỳ trong UI, cấu hình prompt/SOP, mô hình, ma trận quyền từng công cụ (`ALLOW` / `ASK` / `OFF`), kết nối MCP mở và gắn AI + Quick Action Chips lên bất kỳ Portal/Block nào (`latticeAiProfiles`).
  3. Cung cấp bộ **5 Starter Blueprints** (`dxos-coordinator`, `dxos-architect`, `dxos-ops`, `dxos-logistics`, `dxos-workspace`) kèm **8 Unified Execution Tools** (5 tool Admin Builder bị khóa cứng với non-admin + 3 tool Tác nghiệp & Workflow Copilot khóa theo `organizationId`).
  4. Mở **Cổng MCP 2 chiều chuẩn JSON-RPC 2.0 Streamable HTTP** dùng `@modelcontextprotocol/sdk` + User-Context (`useUserContext: true`, `Bearer {{request.token}}`) và circuit-breaker `5s` cho Orion-LD/n8n/ClamAV/DB.
  5. Hiển thị **Bản đồ Điều hành 6 Phân hệ LatticeDX** (`enterpriseTopology`) và **Nhật ký Kiểm toán AI & MCP (`latticeAiAuditLogs`)** theo thời gian thực.

- **Phi mục tiêu:** Không tự viết khung chat mới thay thế AI Chatbox gốc của NocoBase; không cho AI tự ghi file mã nguồn tùy ý lên đĩa máy chủ production.

- **Chống mục tiêu (Thất bại về thiết kế nếu vi phạm):**
  - AI hoặc MCP client vượt quyền RBAC hoặc đọc/ghi chéo `organizationId`.
  - AI tự phê duyệt bước duyệt của quản lý hoặc tự duyệt hồ sơ do chính người gọi tạo.
  - Non-admin nhìn thấy hoặc gọi được `dxos-architect` hay các Admin Builder tools (khắc phục lỗ hổng `isBuilderAI` của host vốn chỉ chặn `nathan`, `orin`, `dara`).
  - Lỗi từ Orion-LD/n8n làm treo hoặc sập phiên chat / cổng MCP.

---

## 3. Cấu trúc Dữ liệu & Bảo mật

### 3.1. `latticeAiProfiles` (`uiManageable: true`, ACL Admin ghi / `loggedIn` qua `portalCopilot` đã lọc)
Lưu toàn bộ cấu hình linh hoạt do Quản trị viên tạo:
- Định danh: `username` (unique slug `^[a-z0-9][a-z0-9_-]{1,62}$`), `nickname`, `position`, `departmentScope`, `organizationId`, `avatar`, `bio`, `greeting`, `systemPrompt`, `enabled`.
- Suy luận & Điều phối: `llmService`, `modelName`, `allowSubAgentDispatch` (boolean).
- Thẩm quyền & Công cụ: `isAdminBuilder` (boolean), `allowedRoles` (JSON array), `toolPermissions` (map `{ [toolName]: 'ALLOW' | 'ASK' | 'OFF' }`).
- Kết nối MCP & Điểm chạm UI: `mcpServers` (mảng `{ name, url, useUserContext, enabled }`, chỉ cho phép `http://` với localhost / `host.docker.internal` / tên service nội bộ hoặc `https://` bên ngoài; chặn link-local `169.254.169.254`, `0.0.0.0`, credential nhúng trong URL), `portalBindings` (mảng slug Portal), `quickPrompts` (mảng `{ label, prompt }`).
- **Quy tắc đồng bộ 2 chiều (`syncProfileToNocobaseAi`):** Mỗi lần lưu profile hoặc `bootstrapDefaults`, server đồng bộ bản ghi xuống bảng `aiEmployees` & `aiMcpClients` của NocoBase, **buộc `allowedRoles = ['root', 'admin']`** nếu `isAdminBuilder === true` HOẶC có bất kỳ Admin Builder tool nào ở trạng thái `ALLOW`/`ASK`, và cập nhật bảng liên kết vai trò `aiEmployees.roles` triệt để (gỡ sạch vai trò nhân viên).

### 3.2. `latticeAiAuditLogs` (`uiManageable: false`, chỉ Admin xem)
Ghi mọi thao tác thực thi công cụ từ 4 kênh (`ai-tool`, `mcp-enterprise`, `mcp-itot`, `studio-sync`):
- `actorUserId`, `actorUsername`, `organizationId`, `channel`, `aiEmployee`, `toolName`, `argsSummary` (tự che khóa chứa `token|secret|password|apikey|authorization|cookie`), `status` (`allowed` | `denied` | `degraded` | `error`), `durationMs`, `errorCode`, `resultSummary`.

---

## 4. Danh mục Công cụ Thực thi & MCP Gateway

### 4.1. Bộ 8 Unified Tools (chạy chung cho AI Chatbox & `/api/dxos-mcp`)
1. `dxos_inspect_architecture` (`ALLOW`, Admin): Inspect portals, pages, blocks, collections, workflows, 7-role ACL.
2. `dxos_compose_page_blocks` (`ASK`, Admin, hỗ trợ `dryRun`): Gắn/cập nhật 6 DX-OS Blocks hoặc Native Table/Form/Details lên portal/page qua `flowSurfaces:applyBlueprint` & `flowModels`.
3. `dxos_manage_portal_and_acl` (`ASK`, Admin, hỗ trợ `dryRun`): Tạo/cập nhật `/p/<slug>`, nhóm menu và gán quyền `rolesDesktopRoutes` cho `ldx_*`.
4. `dxos_extend_collection_schema` (`ASK`, Admin, hỗ trợ `dryRun`): Tạo bảng `uiManageable` mới (tự gắn `organizationId`) hoặc thêm trường vào bảng nghiệp vụ (chặn bảng hệ thống `users`, `roles`, `apiKeys`, `migrations`, `latticeAiAuditLogs`).
5. `dxos_deploy_workflow` (`ASK`, Admin): Cài 1 trong 4 mẫu Poka-yoke (`procurement`, `logistics-5step`, `incident-uc2`, `internal-service`) hoặc mẫu `ai-incident-triage` chạy nền.
6. `dxos_search_enterprise_context` (`ALLOW`, Org-scoped): Tìm kiếm liên thông Đơn hàng, Yêu cầu, Phiếu dịch vụ, Sự cố, Tài sản, Kho SOP P.A.R.A. kèm mã trích dẫn `[collection:code#id]`.
7. `dxos_execute_record_action` (`ASK`, Org-scoped): Tạo/cập nhật bản ghi nghiệp vụ hợp lệ (`latticeServiceTickets`, `latticeOrders`, `latticeRequests`, `latticeParaDocuments`), gán `organizationId` + `requesterId` phía server, chặn sửa trường bảo vệ (`status`, `version`, `requesterId`, `assigneeId`, `decisionReason`, `resolutionNote`).
8. `dxos_my_tasks_copilot` (`ALLOW` đọc / `ASK` nộp, Org + User-scoped): Đọc & tóm tắt lịch sử công việc đang giao cho chính người gọi (`workflowManualTasks`), chỉ cho phép `submit` khi `task.userId === currentUser.id` và chặn tự duyệt đơn do chính mình tạo.

### 4.2. MCP Gateway `/api/dxos-mcp` & `/api/dxos-mcp/it-ot`
- Giao thức Streamable HTTP JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`).
- Xác thực Bearer JWT / API key bắt buộc (`401` + `WWW-Authenticate` khi thiếu/sai); `tools/list` tự lọc bỏ toàn bộ Admin Builder tools nếu caller không có quyền Admin Studio.
- `/api/dxos-mcp/it-ot` (được `bootstrapDefaults` tự đăng ký vào `aiMcpClients` với `useUserContext: true`, header `Authorization: Bearer {{request.token}}`) phơi 4 IT/OT tools: `get_live_ngsi_telemetry`, `get_sensor_and_incident_timeline`, `get_stack_connector_health`, `dispatch_itot_webhook_or_sync` (`ASK`, chỉ `manager`/`dispatcher`/`admin`, timeout `5000ms`, degrade an toàn khi Orion-LD/n8n ngoại tuyến).

---

## 5. Điểm chạm Giao diện & Đóng gói PoF

- **`/admin/settings/dxos-ai` (`plugin-dxos-ai`):** 4 tab (*Hệ điều hành 6 Phân hệ*, *Quản trị Nhân sự AI Động*, *Cổng Enterprise MCP 2 Chiều*, *Nhật ký Kiểm toán*).
- **`plugin-dxos-blocks`:** Mỗi block DX-OS hiển thị **Dynamic Copilot Strip** đọc `GET /api/dxosAi:portalCopilot?portalSlug=...` theo role người dùng và kích hoạt `flowEngine.context.ai.triggerTask(...)` truyền kèm ngữ cảnh đang xem. Tự ẩn im lặng nếu plugin AI tắt.
- **`plugin-dxos-studio`:** Nâng danh mục catalog thành **7 plugins**, thêm số liệu AI/MCP vào `readiness` và nút chuyển nhanh sang AI Workforce & 6-Plane Command Center.
- **PoF & CI:** Đầy đủ `LICENSE`, `README.md`, `sdkProvidedByHost: true`, header 8 dòng SPDX CTU-OpenPaw, cập nhật Compose, `install-workspace`, `native-clean-install`, CI, `pof:check`, `release:tarball` và kiểm chứng E2E live trên Docker `localhost:13014`.

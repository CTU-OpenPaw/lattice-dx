# Thiết kế Kỹ thuật v2: `@latticedx/plugin-dxos-ai` — Deep Admin System Architect & Cross-Department End-User Copilot

**Ngày chốt thiết kế:** 2026-11-21  
**Trạng thái:** Đã duyệt (Approved)  
**Nhánh phát triển:** `feat/dxos-ai-workforce-mcp` (công tác trên nền commit `b01998b`)  
**Vị thế hệ thống:** LatticeDX Enterprise Digital OS 6 Phân hệ — NocoBase `2.2.38` đóng vai trò Plane #6 (`appDataSubstrate`), giữ nguyên attribution Điều 5.2 (*Powered by NocoBase*).

---

## 1. Mục đích & Vấn đề cần giải quyết từ bản v1

Qua kiểm chứng thực tế v1 (`b01998b`), AI Workforce & Enterprise MCP mới dừng ở mức *đọc/gắn bề mặt*:
1. **Build Block quá nông:** `dxos_compose_page_blocks` chỉ *append* một block đơn lẻ, chưa inspect danh sách block `flowModels` trên trang, chưa cập nhật cấu hình block hiện có (Hero, KPI JSON, accent color), chưa đổi thứ tự/gỡ block, và chưa dựng trọn gói trang đa block.
2. **Phân quyền RBAC mới ở mức menu:** `dxos_manage_portal_and_acl` chỉ gắn `rolesDesktopRoutes`, chưa cấp/sửa/thu hồi quyền cấp **bảng – hành động – phạm vi – khóa từng trường** (`dataSourcesRolesResources` + `dataSource.acl`) cũng như chưa tạo/nhân bản role `ldx_*` tùy chỉnh.
3. **Workflow mới cài mẫu tĩnh:** `dxos_deploy_workflow` chưa tự ánh xạ nhân sự theo role, chưa inspect đồ thị `flow_nodes`, chưa sửa cấu hình node (người duyệt, điều kiện rẽ nhánh), chưa lắp workflow mới cho phân hệ tự dựng (`latticeCustom*`) hay bật/tắt `enabled`.
4. **End-User bị đứt gãy với module Admin mới dựng & thiếu điều phối liên phòng ban:** Danh sách tìm kiếm/ghi khóa cứng vào 4–6 bảng có sẵn nên phân hệ `latticeCustom*` Admin vừa tạo không thể dùng ngay bởi AI nhân viên; đồng thời chưa bật `9router` để AI Chatbox thực thi LLM + tool calling trực tiếp.

---

## 2. Mục tiêu, Phi mục tiêu & Bất biến Bảo mật

### Mục tiêu
1. Nâng cấp lên **11 Unified Tools** (`7` Admin System Builder + `4` Operational/Copilot) dùng chung cho cả NocoBase AI Chatbox (`ai.toolsManager`) và cổng JSON-RPC 2.0 Streamable HTTP MCP (`/api/dxos-mcp`).
2. Hỗ trợ toàn bộ vòng đời dựng hệ thống của Quản trị viên qua hội thoại & MCP: **Schema + Select Enum → Multi-Block Page Blueprint + Live Edit/Reorder/Remove Block → Granular Field-Level RBAC → Custom Workflow Graph + Toggle**, đi qua host repository/action chính thống có hiệu lực tức thì.
3. Liên thông tức thì phân hệ `latticeCustom*` vào AI Copilot người dùng cuối, kiểm tra **Granular Field-Level RBAC** ngay trong tool thực thi của AI nhân viên, và bổ sung **`dxos_orchestrate_enterprise_case`** cho radar điểm nghẽn SLA + đối chiếu 360° (IoT Orion-LD + SOP P.A.R.A. + tác vụ) + xử lý liên thông đa phòng ban.
4. Kết nối **`9router` (`http://localhost:20128/v1` / `http://host.docker.internal:20128/v1`)** chạy live trên Docker `localhost:13014`, thực thi và quay video kiểm chứng Full HD (`1920x1080`) cho **2 Đại Use Case**.

### Phi mục tiêu
- Không cho phép AI sửa tệp mã nguồn trên đĩa server; không thay thế khung chat gốc của `@nocobase/plugin-ai`.

### Bất biến Bảo mật (Fail-Closed)
- Non-admin **tuyệt đối không** thấy hoặc gọi được 7 Admin Builder tools nor `dxos-architect`.
- `dxos_manage_rbac_permissions` **chỉ** cho phép tác động role `^ldx_[a-z][a-z0-9_]{1,40}$` (cấm tuyệt đối `root`, `admin`) và **cấm** chạm các bảng hệ thống (`users`, `roles`, `apiKeys`, `authenticators`, `migrations`, `latticeAiAuditLogs`, `latticeAiProfiles`, `dataSourcesRolesResources`, v.v.); luôn tước `id`, `createdAt`, `updatedAt`, `organizationId`, `identitySubject`, `userId` khỏi trường được phép ghi.
- Mọi thao tác ghi của AI nhân viên qua `dxos_execute_record_action` hoặc `dxos_orchestrate_enterprise_case` đều đóng dấu `organizationId` phía server, chặn sửa `PROTECTED_SERVER_FIELDS`, **ép kiểm tra `dataSourcesRolesResources` theo từng trường** (`403 RBAC_FIELD_LOCKED` / `RBAC_ACTION_DENIED` nếu Admin đã cấu hình khóa), và không bao giờ cho phép tự phê duyệt bước của người khác hoặc hồ sơ do chính mình tạo.
- Schema Zod v4 tương thích 100% với Gemini/OpenAI qua `9router`: không sinh `propertyNames` (`z.object({}).passthrough()` thay cho `z.record(z.any())`), khai báo `items` rõ ràng cho mọi `array`, và hỗ trợ auto-parse JSON string cho `object`/`array`.

---

## 3. Phương án Kiến trúc được chọn (Approach A)

Chọn **Approach A — Native Host Metadata & ACL Integration + Live 9router Orchestration**:
- **Không** dùng script ngoài giả lập hoặc chọc SQL thô bỏ qua NocoBase ACL/cache/workflow hooks.
- Chia module gọn sạch trong `plugins/nocobase/plugin-dxos-ai/src/server/`:
  1. `schema-helper.js`: Bộ chuyển đổi JSON Schema ↔ Zod v4 an toàn không sinh `propertyNames`, kèm JSON-string coercion.
  2. `ai-builder-tools.js`: 7 Admin Builder tools đi qua `FlowModelRepository` (`findModelByParentId`, `findModelById`, `upsertModel`, `updateSingleNode`, `remove`), `latticePortals:save` + `desktopRoutesUiLayouts`, `collections.create`/`CollectionModel.load()`/`sync()`, `dataSourcesRoles` + `dataSourcesRolesResources` (`updateAssociationValues: ['actions']` kích hoạt `afterSaveWithAssociations -> writeToACL`), và `workflows`/`flow_nodes`/`workflows:update`.
  3. `ai-copilot-tools.js`: 4 Operational/Copilot tools (`dxos_search_enterprise_context`, `dxos_execute_record_action`, `dxos_my_tasks_copilot`, `dxos_orchestrate_enterprise_case`) có `resolveDynamicCollections` cho `latticeCustom*` và `enforceCallerRbacOnWrite`.
  4. `ai-tools-core.js`: Lớp điều phối chung (`resolveActorScope`, `createAuditedTool`, `invokeResourceAction`, `ADMIN_BUILDER_TOOL_NAMES`, `OPERATIONAL_TOOL_NAMES`, `registerDxosToolsWithHost`) dùng chung cho NocoBase `ai.toolsManager` và MCP Gateway.

---

## 4. 2 Đại Use Case Kiểm chứng Thực chiến (Live trên `localhost:13014`)

1. **Đại Use Case #1 — Admin xây dựng hoàn chỉnh phân hệ *"Kiểm định Chất lượng Kho lạnh (`latticeCustomColdAudits`)"* bằng hội thoại & Admin Builder:**
   - Chat trực tiếp với `dxos-architect` (qua `9router`) & kích hoạt tool chuỗi hệ thống:
     1) Tạo collection `latticeCustomColdAudits` với `batchCode`, `warehouseZone`, `temperatureC`, `humidityPct`, `auditVerdict`, `inspectorNotes` (+ chuẩn hóa `code`, `name`, `status`, `organizationId`).
     2) Dựng Portal `/p/cold-qa` (`Cổng Kiểm định Chất lượng Kho lạnh`) kèm trang đa block (`DxosPortalHeroBlockModel`, `DxosKpiMetricBlockModel`, `DxosAiProposalBlockModel`, `NativeTableBlock`), sau đó dùng `updateBlock` đổi trực tiếp màu nhấn Hero & thẻ KPI trên `/p/cold-qa`.
     3) Cấu hình **RBAC chi tiết cấp trường**: cấp `ldx_employee` quyền `view` + `create` trên `latticeCustomColdAudits` nhưng **khóa trường `auditVerdict`** (`lockFields: ['auditVerdict']`); cấp `ldx_manager` toàn quyền `view`/`create`/`update` gồm cả `auditVerdict`.
     4) Lắp mới & bật (`enabled: true`) workflow tự động `"Quy trình Kiểm định Kho lạnh Tự động"` trên `latticeCustomColdAudits` (`Trigger -> Condition temperatureC > -15 -> Manual Review -> Update Status`).
2. **Đại Use Case #2 — Nhân viên & Quản lý vận hành liên phòng ban trên phân hệ vừa dựng + Khóa RBAC:**
   - Nhân viên (`native.lab.employee`) đăng nhập thẳng vào cổng mới `/p/cold-qa`: thấy trang & Quick Copilot Strip (không thấy `dxos-architect`), chạy `dxos_orchestrate_enterprise_case` (`executeCoordinatedResponse`) đối chiếu cảnh báo Orion-LD + SOP P.A.R.A. để vừa lập phiếu `latticeCustomColdAudits` (`QA-COLD-001`, `-11.4°C`), vừa mở phiếu bảo trì `latticeServiceTickets`, vừa ghi biên bản bàn giao `latticeParaDocuments`; thử ghi đè `auditVerdict: 'PASS_OVERRIDE'` qua AI bị chặn cứng `403 RBAC_FIELD_LOCKED`; Quản lý (`native.lab.manager`) chạy `radar`, duyệt cập nhật `auditVerdict` thành công; Admin mở Audit Log chứng kiến trọn vẹn dấu vết `allowed` & `denied`.

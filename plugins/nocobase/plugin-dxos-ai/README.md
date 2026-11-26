# `@latticedx/plugin-dxos-ai`

Plugin Apache-2.0 thuộc trụ cột **Trí tuệ Thực thi `[I]`** của nền tảng **LatticeDX Enterprise Digital OS** trên NocoBase `2.2.50` (`sdkProvidedByHost: true`).

## Năng lực chính
- **Quản trị Nhân sự AI Động (`/admin/settings/dxos-ai` · `latticeAiProfiles`):** Quản trị viên tạo mới, nhân bản, chỉnh sửa prompt/SOP, chọn mô hình, gán quyền công cụ (`ALLOW` tự chạy / `ASK` xác nhận / `OFF`), gắn MCP ngoài và gán nút tác vụ nhanh lên từng Portal/Block.
- **Bộ 5 Trợ lý Khởi tạo (Starter Blueprints):** `dxos-coordinator` (điều phối đa-agent), `dxos-architect` (Admin Builder khóa cứng quyền `root`/`admin`), `dxos-ops` (Kho lạnh & Sự cố IoT), `dxos-logistics` (Chuỗi lạnh 5 bước), `dxos-workspace` (Nội bộ, Mua sắm & P.A.R.A.).
- **8 Unified Server Tools:** 5 công cụ Admin Builder (`dxos_inspect_architecture`, `dxos_compose_page_blocks`, `dxos_manage_portal_and_acl`, `dxos_extend_collection_schema`, `dxos_deploy_workflow` hỗ trợ `dryRun`) + 3 công cụ tác nghiệp & workflow agent (`dxos_search_enterprise_context`, `dxos_execute_record_action`, `dxos_my_workflow_tasks`).
- **Cổng Streamable HTTP MCP 2 chiều:**
  - `POST /api/dxos-mcp`: Enterprise MCP Gateway chuẩn JSON-RPC 2.0 có xác thực Bearer & lọc tool động theo quyền người gọi.
  - `POST /api/dxos-mcp/it-ot`: IT/OT MCP Server (`dxos-it-ot-mcp`, `useUserContext: true`, timeout 5s + fallback `degraded`) đọc FIWARE Orion-LD, lịch sử sự cố, health 6 phân hệ và đẩy outbox/n8n có kiểm soát.
- **Kiểm toán Thực thi AI (`latticeAiAuditLogs`):** Ghi vết mọi thao tác theo kênh/người dùng/tổ chức và che toàn bộ trường nhạy cảm.

## Giấy phép & Kiểm thử
- Giấy phép: Apache-2.0 ([`LICENSE`](LICENSE)). Host NocoBase cung cấp SDK tại runtime (`sdkProvidedByHost: true`).
- Kiểm thử: `node --test plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs`
- Build: `node plugins/nocobase/plugin-dxos-ai/build.mjs`

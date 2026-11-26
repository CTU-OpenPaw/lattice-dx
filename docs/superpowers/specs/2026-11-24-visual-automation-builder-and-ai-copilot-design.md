<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết Kế Nâng Cấp Lớn: Visual Automation Studio & AI Automation Copilot (`v1.0.0`)

## 1. Mục tiêu & Ràng buộc Tuân thủ Đề bài / PoF
Nâng cấp **Tab 8 (Vault & Automation Studio)** của `@latticedx/plugin-dxos-studio` thành một trình dựng tự động hóa trực quan có sơ đồ rẽ nhánh, đồng bộ dữ liệu thật từ hệ thống, chạy mô phỏng tô sáng live trace và tích hợp AI Copilot tại chỗ lẫn qua MCP Agent (`@latticedx/plugin-dxos-ai`).

Mọi thay đổi giữ nguyên các bất biến của **LatticeDX `v1.0.0`** (nhánh `feat/v1.0.0-olp-championship`):
- **Giữ nguyên version `1.0.0`**, không thêm dependency npm runtime mới vào 7 plugin NocoBase (`sdkProvidedByHost: true`). Toàn bộ Flow Canvas dựng thuần React + inline SVG, không gọi `require('react')`/`require('antd')` từ module client con để tương thích tuyệt đối với bundler trong `plugins/nocobase/plugin-dxos-studio/build.mjs`.
- **Giữ bất biến `adminMcpToolsListed17 === 17`**: mở rộng trực tiếp `dxos_configure_workflow` thay vì tạo tool thứ 18.
- **An toàn & Bảo mật:** Điều kiện rẽ nhánh `when` và nội suy `{{steps.<idx>.*}}` đi qua `matchesFilter`, `hasUnsafeTemplateSyntax`, `sanitizePlainObject`, chặn prototype pollution (`__proto__`, `constructor`, `prototype`), giữ nguyên allowlist collection, khóa trường voucher lõi, giới hạn `maxDepth <= 8`, `cooldownSec`, SSRF guard, mã hóa Connector Vault AES-256-GCM, HITL gate cho Digital Twin, PG RLS, RBAC/PAT fail-closed, SPDX Apache-2.0 và nhận diện Điều 5.2 NocoBase.

## 2. Kiến trúc Backend (`@latticedx/plugin-dxos-studio`)
### 2.1 Rẽ nhánh điều kiện từng bước (`automation-engine.js`)
- `actionsJson[i]` hỗ trợ thêm các thuộc tính tùy chọn an toàn:
  - `when`: biểu thức điều kiện chuẩn `matchesFilter` (hỗ trợ `data.*`, `dmn.*`, `event.*`, `steps.<idx>.*`). Nếu không khớp ở runtime hoặc `dryRun`, step ghi trace `status: 'skipped'`, `skipReason: 'BRANCH_CONDITION_NOT_MATCHED'` và quy trình tiếp tục sang bước kế.
  - `label` (max 120 ký tự), `branchLabel` (max 80 ký tự), `stopOnError` (boolean).
- Hỗ trợ tham chiếu kết quả bước trước qua `eventContext.steps[i]` (VD: `{{steps.0.id}}` lấy ID phiếu CMMS vừa tạo; trong `testRule` dry-run tạo `id: 'sim_1'` để kiểm thử thông suốt chuỗi liên kết).

### 2.2 Metadata Catalog & AI Copilot (`automation-copilot.js`)
- `STANDARD_EVENT_CATALOG` (11 CloudEvents chuẩn kèm payload mẫu).
- `AUTOMATION_BLUEPRINTS` (3 kịch bản doanh nghiệp lớn có rẽ nhánh, cài đặt & chỉnh sửa 100% trên Builder):
  1. `auto_cmms_on_coldchain_fault` (5 bước rẽ nhánh — Ứng cứu khẩn Chuỗi lạnh IT/OT): `alarm.triggered,device.offline` → DMN `cmms_priority_routing_v1` → tạo phiếu `latticeCustomWorkOrders` + báo vai trò được giao → nhánh `dmn.workOrderPriority === 'critical'` thực hiện hạ nhiệt `twin_set_desired` (HITL), `trigger_ai_triage` gắn `#{{steps.0.id}}` và `call_connector` sang `n8n-coldchain-orchestrator` (HMAC).
  2. `auto_mkt_quarantine_response` (4 bước rẽ nhánh — Cách ly Lô Vắc-xin vượt MKT & đồng bộ đối tác): `lot.held_mkt` → DMN `cold_chain_approval_v1` → mở sự cố `latticeIncidentCases`, `trigger_ai_triage`, nhánh `dmn.approvalTier === 'quality_hold_director'` đẩy `n8n-coldchain-orchestrator`, thông báo `ldx_manager`.
  3. `auto_sla_breach_escalation` (3 bước rẽ nhánh — Leo thang SLA Đơn hàng / Phiếu dịch vụ): `sla.warning,sla.breached` → nhánh `sla.warning` nhắc `ldx_dispatcher`; nhánh `sla.breached` tạo phiếu khẩn `latticeServiceTickets` và leo thang `ldx_manager`.
- 2 endpoint quản trị mới trên `dxosAutomations`:
  - `dxosAutomations:builderCatalog`: tổng hợp Event catalog, Action schemas, bảng DMN thật (`latticeDecisionTables`), Collection cho phép kèm danh sách fields thực tế, Vault Connectors (tuyệt đối không trả secret/encryptedSecretsJson), danh sách role `ldx_*`, và 3 blueprints.
  - `dxosAutomations:aiAssist`: chạy AI Copilot 3 chế độ `full` (dựng toàn bộ rule từ tiếng Việt/Anh), `node` (vá đúng node mục tiêu `trigger`/`filter`/`dmn`/`step:<idx>` giữ nguyên phần còn lại), và `suggest` (gợi ý tối ưu rule kèm `previewRule` áp dụng 1-click); từ chối fail-closed prompt injection, system tables và prototype keys; cho phép `apply: true` lưu thẳng sau khi qua `validateRulePayload`.

## 3. Giao diện Visual Automation Studio (`automation-studio-panel.js`)
- Tách panel Automation khỏi `builder-broker-panels.js` (vẫn nhúng trọn vào `VaultAndAutomationPanel` và bảo toàn toàn bộ `data-testid` hiện hữu cho Vault & Automation).
- Bố cục 3 cột trực quan:
  1. **Trái — Rules & Thư viện 3 Blueprint:** tìm kiếm rule, xem KPI nhanh, mở nhanh Thư viện Blueprint để nạp sửa chỉ bằng 1 click.
  2. **Giữa — Visual Flow Canvas (React + inline SVG):** hiển thị đồ thị `Trigger -> Filter & Guard -> DMN Matrix -> Nhánh Mọi mức & Nhánh Điều kiện (when)`, hỗ trợ sắp xếp thứ tự bước, thêm nhánh, mô phỏng `Dry-Run` (`dxosAutomations:testRule`) hoặc `Run Now` và tô màu trực tiếp từng node (`completed`, `simulated`, `skipped`, `failed`, độ trễ `ms`).
  3. **Phải — Structured Inspector & Inline AI Copilot:** biểu mẫu cấu hình riêng cho từng trong 6 loại action (dropdown Event/DMN/Collection/Field/Role/Vault Connector, hàng điều kiện `field/op/value`, chip chèn biến `{{data.*}}`/`{{dmn.*}}`/`{{steps.0.id}}`), đi kèm AI Copilot hỗ trợ ngay tại node (`Gợi ý tối ưu`, `Sửa node này`, `Dựng cả flow`, áp dụng 1-click). Khung Advanced JSON giữ ở dạng thu gọn đồng bộ 2 chiều.

## 4. Tích hợp AI Agent (`@latticedx/plugin-dxos-ai`)
- Mở rộng `dxos_configure_workflow` với 5 operation: `suggestAutomation`, `draftAutomation`, `patchAutomation`, `saveAutomation`, `testAutomation` (giữ nguyên 17 MCP tools và `adminOnly: true`).
- Mở rộng `ai-nl-router.js`, `ai-schemas.js` (`dxos-architect`), `vietnamese-nl-eval.test.cjs` và `scripts/eval-vietnamese-nl-agent.mjs` (+8 case `automation-copilot` nâng tổng lên 72 cases).

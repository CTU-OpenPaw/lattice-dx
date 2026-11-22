# `@latticedx/plugin-dxos-blocks`

Thư viện **6 Block Native v2 tùy biến sâu** xuất hiện trực tiếp trong nút **Add block** của NocoBase 2.2.38 UI Editor, bao phủ cả 4 không gian kiến trúc DX-OS (**H – P – D – I**):

1. **DX-OS Portal Hero & Quick Actions (`DxosPortalHeroBlockModel`, `[H]`):** Banner cổng thông tin, mô tả và các nút thao tác nhanh tự động ẩn/hiện theo quyền ACL của vai trò.
2. **DX-OS KPI Metric Grid (`DxosKpiMetricBlockModel`, `[D]`):** Lưới chỉ số thời gian thực cấu hình số cột, collection bất kỳ, bộ lọc JSON và liên kết mở trang.
3. **DX-OS NGSI-LD Context & Telemetry (`DxosContextTelemetryBlockModel`, `[D]` IT/OT):** Hiển thị thuộc tính cảm biến trực tiếp từ FIWARE Orion-LD, ngưỡng cảnh báo và trạng thái outbox theo tổ chức qua `dxosBlocks:contextTelemetry`.
4. **DX-OS AI Proposal & Evidence (`DxosAiProposalBlockModel`, `[I]`):** Hiển thị đề xuất AI và trích dẫn bằng chứng nguồn theo collection/bản ghi qua `dxosBlocks:proposals`.
5. **DX-OS Workflow & My Tasks (`DxosWorkflowTasksBlockModel`, `[P]`):** Tóm tắt tác vụ phê duyệt/xử lý của người đang đăng nhập qua `workflowManualTasks:listMine`.
6. **DX-OS P.A.R.A. Knowledge Vault (`DxosParaVaultBlockModel`, `[H]`):** Tra cứu, lọc phân vùng P.A.R.A. và tạo nhanh tài liệu trên `latticeParaDocuments` (tự hạ cấp mềm khi `plugin-dxos-para` tắt).

## Giấy phép & Kiểm thử
- Giấy phép: Apache-2.0 ([`LICENSE`](LICENSE)). Host NocoBase cung cấp SDK tại runtime (`sdkProvidedByHost: true`).
- Kiểm thử: `node --test plugins/nocobase/plugin-dxos-blocks/tests/*.test.cjs`
- Build: `node plugins/nocobase/plugin-dxos-blocks/build.mjs`

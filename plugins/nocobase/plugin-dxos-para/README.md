# `@latticedx/plugin-dxos-para`

Plugin NocoBase 2.2.50 cung cấp không gian lưu trữ tri thức & tài liệu chuẩn **P.A.R.A.** (*Projects, Areas, Resources, Archives*) thuộc tầng **[H] Nhân sự & Không gian làm việc** trong kiến trúc DX-OS.

## Thành phần cung cấp
- **Collection native `latticeParaDocuments` (`uiManageable: true`):** Quản lý trực tiếp từ NocoBase Collection Manager với các trường `code`, `title`, `organizationId`, `paraSpace`, `summary`, `contentMarkdown`, `tags`, `status`, `attachmentUrl`, `relatedCollection`, `relatedRecordId`, `active`, và quan hệ `department` (`latticeDepartments`), `owner` (`latticeEmployees`).
- **Cô lập đa đơn vị & ACL:** Hook kiểm tra giá trị hợp lệ + middleware tự động gắn `organizationId`/`ownerId` theo nhân sự đăng nhập và cấp quyền sẵn cho 7 vai trò `ldx_*` qua migration `20261120000100-dxos-para-init.js`.
- **API `GET /api/latticePara:summary`:** Trả thống kê số lượng tài liệu theo 4 nhóm P.A.R.A. trong phạm vi tổ chức.

## Giấy phép & Kiểm thử
- Giấy phép: Apache-2.0 ([`LICENSE`](LICENSE)). Host NocoBase cung cấp SDK tại runtime (`sdkProvidedByHost: true`).
- Chạy kiểm thử: `node --test plugins/nocobase/plugin-dxos-para/tests/*.test.cjs`
- Build: `node plugins/nocobase/plugin-dxos-para/build.mjs`

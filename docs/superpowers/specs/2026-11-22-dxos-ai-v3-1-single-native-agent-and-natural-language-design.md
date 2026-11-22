<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết kế Kỹ thuật v3.1: Một Nút Agent Nổi Duy Nhất & Giao tiếp Ngôn ngữ Tự nhiên 100%

**Ngày chốt thiết kế:** 2026-11-22  
**Trạng thái:** Đã duyệt bởi Quản trị viên  
**Nhánh phát triển:** `feat/dxos-ai-workforce-mcp`

## 1. Bối cảnh & Yêu cầu Người dùng
- Mặt trang nghiệp vụ (`/p/*`) không được bày thêm các nút hoặc dải chip gợi ý phụ (`Chọn Block sửa với AI`, `Hoàn tác trang`, `Trợ lý AI ngữ cảnh...`) lên trên nội dung.
- Toàn bộ giao diện giữ đúng **duy nhất 1 nút Agent nổi góc dưới phải** sử dụng chính khung chat gốc của NocoBase (`Open AI chat`, `[role="dialog"] .ant-sender-input`).
- Người dùng và quản trị viên ra lệnh bằng **100% tiếng Việt tự nhiên bình thường** — tuyệt đối không cần nhắc tên tool (`dxos_*`), mã `blockUid`, `portalSlug`, chuỗi JSON hay tên trường kỹ thuật.

## 2. Kiến trúc Thực thi
1. **`@latticedx/plugin-dxos-blocks` (`DxosPortalHeroView`):** Gỡ bỏ `createCopilotStripElement` và `createAdminArchitectBarElement` khỏi mặt trang; giữ lại phần đồng bộ props ngầm tại chỗ qua `fetchPageSurfaceState`.
2. **`@latticedx/plugin-dxos-ai` (`portal-agent-launcher.js` + `this.app.use`):**
   - Hiển thị nút nổi chuẩn khớp thiết kế `Open AI chat` của `@nocobase/plugin-ai` **chỉ trên `/p/*`** (tự ẩn ở `/admin/*` để không trùng với nút gốc của NocoBase, tự ẩn khi khung chat đang mở hoặc khi user không có AI Employee được phép).
   - Khi click nút nổi: gọi `aiCtx.triggerTask({ aiEmployee, auto: true, open: true, tasks: [{ message: { system: hiddenPageContext }, autoSend: false }] })`, mở khung chat gốc với ô nhập rỗng và ngữ cảnh ngầm về trang/portal hiện tại.
   - Chạy vòng đồng bộ ngầm `dxosAi:pageSurfaceState` (tự hoãn `location.reload()` cho tới khi khung chat đóng).
3. **Suy luận Ngôn ngữ Tự nhiên phía Server (`ai-surface-creative-tools.js` & `ai-schemas.js`):**
   - Tự suy luận `collectionName` chính của trang từ `TableBlockModel`/`CreateFormModel` khi thiếu.
   - Cho phép xác định block kế bên theo từ khóa tiêu đề tiếng Việt (`placeBesideTitle: "Chỉ số"` → `resolveBlockUidByHint`).
   - Cho phép ánh xạ nhãn cột tiếng Việt sang tên trường thật (`"kết luận kiểm định"` → `auditVerdict`), tự sinh slug role `ldx_*` từ `roleTitle` (`slugifyVietnameseToLdxRole`), và tự tổng hợp blueprint creative từ mô tả `goal` bằng tiếng Việt tự nhiên (không chèn nút `askAi` gây thừa).

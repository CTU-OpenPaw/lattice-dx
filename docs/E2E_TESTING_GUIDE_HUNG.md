<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Hướng dẫn Kiểm thử End-to-End (E2E) Toàn Hệ thống LatticeDX `v0.4.2` (Dành cho Hưng)

Tài liệu này được thiết kế để **Hưng tự dựng môi trường từ đầu và kiểm thử trọn bộ toàn hệ thống LatticeDX `v0.4.2`** theo đúng góc nhìn người dùng thực tế — bao phủ cả **8 miền nghiệp vụ**, **6 vai trò người dùng** (cùng khách ẩn danh), **12 Native v2 BlockModels**, **Mobile Field PWA (`/v/mobile`)**, **Public Portals (`/v/form/*`, `/v/track/*`)**, **P.A.R.A. OCR/RAG**, **DX-OS AI Studio (9 tab)**, **Control Studio (11 tab + 6 console)**, **LatticeFlow v2 (24 node)**, và **kiểm thử tự động / bảo mật**.

---

## 0. Chuẩn bị Môi trường & Dựng Stack Từ Đầu (5–10 phút)

### 0.1. Yêu cầu trên máy
- **Node.js `24.x`**, **pnpm `10.23.0`**, **Git**, và **Docker Desktop** đang mở *(lưu ý trên Windows: nếu Docker Desktop cài theo user không nằm trong `C:\Program Files\Docker\...`, hãy mở trực tiếp Docker Desktop từ Start Menu thay vì chạy `pnpm docker:start`)*.
- Trình duyệt **Chrome / Edge** (khuyên mở thêm 1 cửa sổ **Ẩn danh / Incognito** để test luồng khách công khai và chuyển đổi nhiều tài khoản không dính session).

### 0.2. Lấy mã mới nhất từ `main` & cài đặt
```powershell
git pull origin main
pnpm install --frozen-lockfile
```

### 0.3. Dựng NocoBase sạch + 7 plugin `0.4.2` + nạp dữ liệu demo đầy đủ
```powershell
# 1. Dựng NocoBase 2.2.50 trắng (0 bảng) + cài & bật đủ 7 plugin Apache-2.0 (0.4.2) ở cổng 13014
pnpm native:clean --port=13014
```
*(Ghi lại đường dẫn file `report.json` in ra ở cuối lệnh trên, thay vào `<path-to-report.json>` bên dưới.)*

```powershell
# 2. Dựng toàn bộ Multi-Portal + Workspace + đội ngũ nhân sự demo
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"

# 3. Nạp 7 Starter AI Workforce, 20 Unified Tools, MCP Gateway & A2A
pnpm setup:dxos-ai -- --origin=http://localhost:13014

# 4. Nạp dữ liệu trình diễn chuỗi lạnh, OMS/WMS/FEFO, PKI, DMN, P.A.R.A., Public Forms
$env:NOCOBASE_ADMIN_PASSWORD = "admin123"
node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
pnpm seed:v100-showcase -- --origin=http://localhost:13014
```

*(Nếu muốn test chế độ **cài trắng Blank-Slate** không nạp dữ liệu mẫu để kiểm tra Onboarding Checklist và giữ container chạy để mở trình duyệt: dùng cờ **`--keep`** trên PowerShell: `pnpm native:clean --port=13014 --blank-slate --keep` — cờ `--blank-slate` tự gắn `LATTICE_SKIP_DEMO_SEED: "1"` vào container; nếu không truyền `--keep`, script sẽ tự `compose down -v` ngay khi hoàn tất kiểm tra tự động. Khi đặt biến môi trường thủ công trên PowerShell, luôn dùng cú pháp `$env:TEN_BIEN = "gia_tri"` thay cho cú pháp Bash.)*

> **Phạm vi Lab `native:clean` (2 container):** Lệnh `pnpm native:clean` sử dụng `infra/compose/native-rehearsal.yml` gồm 2 container (`nocobase-db` + `nocobase`), **không** bật Keycloak, Valkey/Redis, `n8n`, `9router`, Mosquitto/Node-RED/Orion-LD, cấu hình nginx `10-lattice-public-routes.sh` hay biến `TZ=Asia/Ho_Chi_Minh`. Do đó:
> - Tất cả luồng lõi NocoBase + 7 plugin + PG16 `FORCE RLS` + Public Forms/Track + P.A.R.A. + AI Studio + Control Studio + LatticeFlow v2 chạy đầy đủ trên lab này.
> - Các bài kiểm tra phụ thuộc dịch vụ ngoài (`acceptance:dxos-ai-mcp`, `acceptance:broker-automation-builder` cần `n8n`; SSO Keycloak thật; route `/.well-known/agent-card.json` không qua `/api`; legacy bridge `/lattice/*`) chỉ chạy trên full stack (`infra/compose/prod.yml` / `core.yml`).

### 0.4. Danh sách tài khoản kiểm thử (`http://localhost:13014`)

| Vai trò | Email / Tài khoản | Mật khẩu mặc định | Mục đích test |
|---|---|---|---|
| **Quản trị tối cao (`root`)** | `admin@nocobase.com` | `admin123` | Toàn bộ Admin Studio, AI Studio, Flow Studio, P.A.R.A., UI Editor, đa tổ chức |
| **Quản lý (`ldx_manager`)** | `native.lab.manager@example.invalid` | `NativeLab-2026!` | Phê duyệt, WMS FEFO, Sự cố, Portal quản lý, kiểm tra phân quyền với Admin |
| **Nhân viên (`ldx_employee`)** | `native.lab.employee@example.invalid` | `NativeLab-2026!` | Cổng nhân viên, `/p/logistics` tự chuyển hướng, chặn 403 vào Flow/AI/Control Studio |
| **Kho / Thực hiện (`ldx_warehouse`)** | `native.lab.worker@example.invalid` | `NativeLab-2026!` | Bước 3 luồng Logistics (Kho nhận & chuẩn bị hàng), cập nhật tồn kho WMS |
| **Điều phối (`ldx_dispatcher`)** | `native.lab.dispatcher@example.invalid` | `NativeLab-2026!` | Điều phối vận tải, phân bổ lô hàng & ePOD |
| **Tài xế (`ldx_driver`)** | `native.lab.driver@example.invalid` | `NativeLab-2026!` | Mobile Field PWA `/v/mobile`, chụp/ký ePOD offline & kiểm tra ẩn Digital Twin theo ACL |
| **Khách ngoài (Ẩn danh)** | *(Không đăng nhập — cửa sổ Incognito)* | — | `/v/form/:slug`, `/v/track/:code?verify=...`, `/signin` |

---

## 1. Phần 1 — Onboarding, Đăng nhập, Bảo mật Auth & Cổng Công khai (Miền 1)

### Test 1.1: Màn hình đăng nhập `/signin` sạch lỗi & Việt hóa
1. Mở cửa sổ **Ẩn danh**, bật **DevTools → tab Network & Console**, truy cập `http://localhost:13014/signin`.
2. **Kỳ vọng:** Không có bão lỗi `401` (`aiEmployees`/`aiConversations` không tự bắn khi chưa đăng nhập), không hiện link đăng ký tự do công khai.
3. Nhập sai mật khẩu (`admin@nocobase.com` / `sai123`) rồi bấm Đăng nhập.
4. **Kỳ vọng:** Thông báo lỗi hiển thị rõ ràng bằng **tiếng Việt** (không văng tiếng Anh thô).

### Test 1.2: Đăng nhập `root` vào thẳng Workspace (không rơi vào `/admin` trống)
1. Đăng nhập bằng `admin@nocobase.com` / `admin123`.
2. **Kỳ vọng:** Tự động điều hướng thẳng về **`/admin/lattice-workspace`** (thấy lối tắt các cổng `/p/*` và Hộp thư Phê duyệt DX-OS — **không** còn trang trống `"No pages yet, please configure first"`).
3. Kiểm tra chân trang giữ nguyên nhận diện NocoBase **Điều 5.2** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`).

### Test 1.3: Cài đặt SSO Enterprise Auth không lỗi 500
1. Truy cập `/admin/settings/auth/enterprise-mappings`.
2. **Kỳ vọng:** Trang tải bình thường (**không** còn HTTP `500`), hiển thị rõ trạng thái cấu hình/cảnh báo nếu Keycloak chưa bật, các ô chọn dùng bộ chọn thân thiện (không bắt nhớ UUID/ID thô), có xác nhận `Popconfirm` khi xóa.

### Test 1.4: Biểu mẫu công khai `/v/form/:slug` (Đính kèm tệp, Tra cứu & Chống XSS)
1. Ở cửa sổ **Ẩn danh**, mở `/v/form/yeu-cau-dich-vu-nhanh` (hoặc slug vừa tạo ở Phần 6).
2. Bấm Gửi khi để trống trường bắt buộc → **Kỳ vọng:** Báo lỗi inline bằng **tiếng Việt**, `0` request lỗi `401`/`403`/`404` cho logo/favicon.
3. Điền đầy đủ thông tin, thử chèn chuỗi XSS `<img src=x onerror=alert(1)>` vào ô mô tả, đính kèm 1 tệp ảnh/PDF nhỏ (nếu form có trường file), rồi bấm **Gửi**.
4. **Kỳ vọng:** Tạo hồ sơ thành công, hiển thị **Mã tra cứu** + nút **Sao chép Mã** + nút **"Gửi hồ sơ khác"**; tuyệt đối không có popup XSS; nhập mã hồ sơ vào ô **Tra cứu thủ công** xem lại được trạng thái Zero-PII.

### Test 1.5: Tra cứu vận đơn & quét QR Ed25519 `/v/track/:code?verify=...`
1. Ở tài khoản Admin/Manager, mở `/p/logistics` → chọn đơn `ORD-V100-001` (hoặc đơn đã trình duyệt/xác nhận, không phải đơn nháp), trong block **RecordWorkbench** bấm **In chứng từ**.
2. Copy URL QR dạng `/v/track/ORD-V100-001?verify=...` (hoặc `/v/track/LDX-TRK-...?verify=...` nếu đơn đã có ePOD) mở ở cửa sổ **Ẩn danh**.
3. **Kỳ vọng:**
   - Ô `Mã vận đơn` được điền sẵn và hiển thị **kết quả xác thực chữ ký sổ cái Ed25519 công khai** hợp lệ.
   - Thông tin riêng tư ePOD/PII vẫn được bảo vệ fail-closed cho đến khi nhập đúng `trackingToken` (có nút biểu tượng mắt `eye toggle` để ẩn/hiện mã).
   - Mở ở chế độ Mobile (`390x844`): toàn bộ nút bấm rộng/cao tối thiểu **`44x44px`**, không bị cắt.

### Test 1.6: Trang tương thích cũ `/lattice/*`
1. Mở `/lattice/workspace` (nếu bật bridge) → **Kỳ vọng:** Có thanh breadcrumb **"Quay lại Workspace v2"** để quay về trải nghiệm mới thuận tiện.

---

## 2. Phần 2 — Toàn bộ 7 Business Portals & 12 Native v2 BlockModels (Miền 2)

### Test 2.1: Kiểm tra lần lượt 7 Portal ở `1440x900` và `1280x800`
Mở từng cổng từ thanh chuyển cổng Topbar:
1. **`/p/logistics`**: Kiểm tra vào thẳng cockpit điều hành (không phải bảng CRUD thô).
   - **WmsOpsBlock:** Với tài khoản `root`, chọn `organizationId` (`native-ui-lab`), thử **Phân bổ FEFO** → không lỗi `400`; thử **Tạm giữ MKT (`holdLotByMkt`)** trên 1 lô rồi bấm **Mở khóa QA (`releaseLotByQa`)** → trạng thái cập nhật lại sạch sẽ. Thử bấm In phiếu trên 1 đơn **nháp** → báo lỗi tiếng Việt rõ ràng thay vì lỗi 400 khó hiểu.
   - **Kanban & Lịch biểu 7 ngày:** Đổi qua lại giữa Kanban & Lịch, kiểm tra giờ `+07:00`, mở drawer chi tiết, bấm CTA Phê duyệt.
   - **BiChartBlock (`DxosBiChartBlockModel`):** Đổi lần lượt 5 chế độ **Bar / Line / Pie / KPI / Pivot** (kiểm tra tổng hợp SQL không lỗi), bấm **Cấu hình nội dung** → modal mở gọn ở mép trên (`top: 24px`), **không bị cắt đỉnh**, dropdown hiển thị tên dễ hiểu (không lọt tên cột thô hay tag `[BI]`).
   - **RecordWorkbenchBlock:** Kiểm tra Chatter, huy hiệu **Ed25519 PKI**, ngăn **Lineage**, nút **In chứng từ**, và **Xuất CSV / XLSX / PDF Unicode tiếng Việt**.
2. **`/p/incidents`**:
   - **WebGIS MapLibre (`DxosWebGisBlockModel`):** Bản đồ chuỗi lạnh hiển thị các điểm `COLD-CHILLER-CT-01`, `REEFER-TRUCK-HCM-02`, `COLD-HUB-DN-03`; mở ngăn **Điều khiển Digital Twin**, thử đặt nhiệt độ chênh `> 2°C` → tự đẩy sang hàng chờ HITL.
   - **AiProposalBlock & WorkflowTasksBlock:** Kiểm tra nút **Phê duyệt / Từ chối trực tiếp** hoạt động thật (không chỉ hiển thị thụ động).
3. **`/p/services`**:
   - **ParaVaultBlock (`DxosParaVaultBlockModel`):** Bấm mở một tài liệu SOP → **phần nội dung Markdown hiển thị đầy đủ** (đã sửa lỗi trắng nội dung `contentMarkdown`), kiểm tra phân trang & không lộ tài liệu `draft`/`archived`.
4. **`/p/procurement`**, **`/p/cmms`**, **`/p/partner-claims`** (`CLM-V100-001`):
   - Mở mượt không bị trắng trang, Việt hóa 100%, **không** spam toast `503 local-9router` khi không mở chat AI.
5. **Tiện ích toàn cục trên Topbar:**
   - Nhấn **`Ctrl+K`** (Command Palette): tìm kiếm theo mã đơn/tài liệu (truy vấn SQL nhanh, bấm nhảy thẳng tới kết quả).
   - Bấm **Chuông thông báo (Notification Bell)**: kiểm tra badge số chưa đọc, đánh dấu đã đọc (`markRead` / `markAllRead`), liên kết sâu.
   - Bật **UI Editor → `Add block`**: xác nhận thấy đủ **12 Native v2 BlockModels**.

### Test 2.2: Phân quyền & tự chuyển hướng cho Nhân viên (`ldx_employee`)
1. Đăng xuất `root`, đăng nhập **`native.lab.employee@example.invalid` / `NativeLab-2026!`**.
2. Thử truy cập thẳng `/p/logistics` → **Kỳ vọng:** Tự động chuyển hướng mượt về `/p/logistics-employee/...` (chỉ thấy đơn của mình).
3. Kiểm tra Topbar chỉ hiển thị các cổng được cấp quyền; thử gõ tay `/admin/settings/dxos-studio`, `/admin/settings/dxos-ai`, và **`/admin/settings/workflow/automation`** → **Tất cả đều bị chặn `403` / từ chối truy cập** (đã khóa chặt `ldx_employee` khỏi LatticeFlow Studio).

---

## 3. Phần 3 — Mobile Field PWA Ngoại tuyến `/v/mobile` (Miền 3)

*(Mở DevTools → bật **Device Toolbar** kích thước **`390 x 844`** — iPhone 14/15.)*

1. Đăng nhập tài khoản Tài xế **`native.lab.driver@example.invalid` / `NativeLab-2026!`** rồi truy cập `/v/mobile`.
2. **Kiểm tra bố cục & phân quyền:**
   - Mở DevTools → **Application → Manifest & Service Workers**: xác nhận `<link rel="manifest">` (`/api/dxos:manifest`) có icon PNG `192x192` & `512x512`, Service Worker `/api/dxos:sw.js` đã đăng ký.
   - Toàn bộ nút/tab chạm chính có kích thước **`>= 44x44px`**, không tràn ngang.
   - Tab **Digital Twin** được ẩn/khóa sạch theo ACL (không văng lỗi thô `403 DXOS_ACL_DENIED`).
3. **Test ghi nhận ePOD trong kho lạnh mất GPS & Ngoại tuyến (Offline Outbox):**
   - Trong DevTools → tab **Network**, đổi chế độ sang **`Offline`**.
   - Vào tab ePOD: nhập mã đơn `ORD-V100-001`, tích chọn **Kho lạnh mất GPS (`gpsUnavailable`)** (hoặc giả lập không có GPS), chụp/chọn ảnh minh chứng + ký tay trên canvas, bấm **Lưu ePOD**.
   - Thử tạo thêm 1 **Báo sự cố / Phiếu dịch vụ** khi đang Offline.
   - **Kỳ vọng:** Lưu an toàn vào hàng đợi IndexedDB **Outbox**, hiện số mục chờ đồng bộ.
4. **Test bảo toàn dữ liệu khi lỗi `400/404/422` (Quarantine — KHÔNG xóa mất ePOD!):**
   - Tạo thêm 1 mục ePOD offline với mã đơn **cố tình gõ sai** (ví dụ `ORD-KHONG-TON-TAI-999`).
   - Bật lại **`Online`** trong Network → bấm **Đồng bộ ngay**.
   - **Kỳ vọng:** Mục hợp lệ đồng bộ thành công; mục gõ sai mã đơn **KHÔNG bị xóa mất** mà chuyển sang trạng thái **`Cách ly / Cần sửa (quarantined)`**, hiện rõ mã lỗi + nút **Sửa mã đơn để gửi lại**, **Xuất JSON dự phòng**, hoặc **Xóa thủ công**.
5. **Test hết hạn phiên (`401`) & AI Chat khi LLM tắt:**
   - Xóa hoặc làm sai token trong `localStorage` để giả lập hết hạn JWT rồi bấm Đồng bộ / Gửi ePOD → **Kỳ vọng:** Dừng ngay ở lỗi `401` đầu tiên (không bão `401`), giữ nguyên payload ePOD trong Outbox và hiện banner mời **"Đăng nhập ngay"**.
   - Mở ngăn Chat AI khi `9router` đang tắt → gửi 1 câu → **Kỳ vọng:** Hiện thẻ báo lỗi thân thiện + nút **"Thử lại"** thay vì treo `"..."` vô hạn.

---

## 4. Phần 4 — Kho tri thức P.A.R.A., OCR-to-Record & Hybrid RAG (Miền 4)

Đăng nhập lại bằng `root` (`admin@nocobase.com` / `admin123`), mở **`/admin/settings/dxos-para`**:
1. **CRUD & Lọc trạng thái `active` vs `draft`/`archived`:**
   - Tạo 2 tài liệu: 1 tài liệu `status = active` (ví dụ tiêu đề `SOP Kiểm định Kho Lạnh E2E`), và 1 tài liệu `status = draft` (tiêu đề `Bản nháp bí mật không được lộ`).
   - Bấm **Lập chỉ mục lại (`Reindex`)** → xác nhận hoàn tất sạch.
   - Gõ từ khóa `Bản nháp bí mật` vào ô **Tìm kiếm Hybrid RAG** → **Kỳ vọng:** **Không** trả về tài liệu `draft`.
   - Gõ chuỗi vô nghĩa `xyz_khong_ton_tai_99999` → **Kỳ vọng:** Trả về **danh sách rỗng** (không còn chấm điểm RRF ảo).
   - Kiểm tra tóm tắt (`summary`) đã che các thông tin PII nhạy cảm (số CCCD/điện thoại).
2. **Test OCR-to-Record chuẩn trường theo bảng đích (`latticeStockLots` & `latticeOrders`):**
   - Tải lên 1 tệp `.txt` / `.docx` / `.xlsx` (hoặc dán nội dung mẫu phiếu nhập kho có tên hàng, số lượng, mã lô).
   - Bấm **Trích xuất OCR** → chọn bảng đích **`latticeStockLots`** → sửa trực tiếp ô **Tên sản phẩm (`productName`)** và **Số lượng (`qtyOnHand`)**, xóa trắng hoặc nhập rõ `lotCode` → bấm **"Tạo bản ghi từ OCR"**.
   - **Kỳ vọng:** Bản ghi mới lưu vào DB giữ **đúng tuyệt đối giá trị Hưng vừa sửa** (không bị ghi đè ngầm, không tự lấy nhầm `code` đơn hàng làm `lotCode`).

---

## 5. Phần 5 — DX-OS AI Studio (9 Tab), App Builder 2.0, MCP, Eval Lab & Chat (Miền 5)

Mở **`/admin/settings/dxos-ai`**, duyệt lần lượt 9 tab trên thanh bên trái:
1. **Tab 1 — `1. Hệ điều hành 6 Phân hệ` & Quick-Connect LLM:**
   - Kiểm tra danh sách LLM Providers (`dxosAi:listLlmServices`), thử cấu hình/kiểm tra kết nối; nếu nhập URL nội bộ/SSRF (ví dụ `http://127.0.0.1` hoặc `http://169.254.169.254`) → bị chặn an toàn (`redirect: 'error'` + DNS SSRF guard).
2. **Tab 2 — `2. Quản trị Nhân sự AI Động` (7 Starter Profiles):** Kiểm tra đủ 7 profile & 6 trường cấu hình, tạo/sửa 1 profile thử nghiệm.
3. **Tab 3 — `3. Cổng Enterprise MCP 2 Chiều` & A2A:** Kiểm tra danh mục tool động hiển thị thật, bấm **Ping MCP**, kiểm tra A2A Agent Card (`/api/.well-known/agent-card.json` hiển thị version **`0.4.2`**; lưu ý `/.well-known/agent-card.json` không qua `/api` chỉ bật trên full stack có nginx `10-lattice-public-routes.sh`).
4. **Tab 4 — `4. Ứng dụng Đã dựng (Built Apps)` (App Builder 2.0):**
   - Thử **Lập kế hoạch (`Plan`)** một ứng dụng mới (ví dụ `"Quản lý bảo hành thiết bị lạnh"`) → xem **Visual ER Graph** & **Plan-Diff**.
   - Bấm **Dựng ứng dụng (`Build`)**, sau đó thử **Vá bằng tiếng Việt (`Patch`)** → **Khôi phục phiên bản (`Rollback`)** (xác nhận chỉ rollback đúng các `blockUids` của app này, không phá block của cổng khác).
   - Thử **Gỡ ứng dụng (`Teardown`)** có hộp thoại xác nhận `keepData` → đảm bảo an toàn đa tenant (không `DROP TABLE` bảng đang được tổ chức khác dùng).
5. **Tab 5 — `5. Nhật ký Kiểm toán` (`Audit Log`):**
   - Đổi dropdown lọc **Trạng thái / Agent / Tổ chức** trên Nhật ký Audit → xác nhận gọi lại API tải đúng dữ liệu theo bộ lọc (không chỉ lọc trên trang 1), mốc giờ `+07:00`.
6. **Tab 6 — `6. Agent Trace Waterfall` & Tab 7 — `7. Eval Lab`:**
   - Ở Tab 6 kiểm tra trace waterfall; ở Tab 7 chọn suite **`vietnamese-nl-agent`** → bấm chạy Eval (chế độ `router`) → **Kỳ vọng:** Chạy đủ **163/163 ca (`100%`)** ngay trong container (không còn tụt về `17/17`).
7. **Tab 8 — `8. Duyệt AI (HITL)` & Tab 9 — `9. Hạn mức & Chi phí AI`:**
   - Ở **Tab 8 (`Duyệt AI (HITL)`)**: Kiểm tra bộ lọc bao gồm `pending`, `approved`, `rejected`, **`executing`, `failed`**, cột **`executionResult`** và thời hạn **`expiresAt`**.
   - Ở **Tab 9 (`Hạn mức & Chi phí AI`)**: Chỉnh hạn mức token/chi phí → bấm **Lưu** → tải lại trang để kiểm chứng đã lưu bền vững vào Postgres (`latticeAiQuotaPolicies` có `FORCE RLS`).
8. **Nút Chat Agent nổi trên `/p/logistics`:** Mở khung chat, gửi 1 câu hỏi tiếng Việt (nếu không bật `9router`, xác nhận hiện thẻ lỗi rõ ràng + nút **"Thử lại"** thay vì treo `"is thinking..."`).

---

## 6. Phần 6 — Control Studio (11 Tab + 6 Governance Consoles) (Miền 6)

Mở **`/admin/settings/dxos-studio`** (kiểm tra ở cả **`1440x900`** và **`1280x800`**):
1. **Deep-link & Không vỡ/cắt nút ngang:**
   - Gõ thẳng `/admin/settings/dxos-studio?tab=dmn` → **Kỳ vọng:** Mở đúng vào tab **Bảng Quyết định DMN** (không bị đá về `workflows`).
   - Kiểm tra các tab **`dmn`**, **`broker`**, **`automation`**, **`data-gov`** ở màn hình `1280x800` → bảng cuộn ngang gọn gàng, **không có nút nào bị cắt mất khỏi khung**.
2. **Tab Thông báo Đa kênh (`dxosNotify` — Mới hoàn thiện 100% UI):**
   - Mở tab **Kênh thông báo & Nhật ký gửi** → kiểm tra danh sách kênh (SMTP / Telegram / Slack / Webhook), cấu hình thử 1 kênh, bấm **Gửi thử (`testSend`)** và xem bảng **Nhật ký gửi (`logs`)**.
3. **Tab Biểu mẫu Công khai (`Public Form Builder`):**
   - Tạo 1 form mới có trường kiểu **`select`** → nhập danh sách lựa chọn vào ô **`options`** + đặt `maxLength`/`pattern` → bấm **Lưu** → **Kỳ vọng:** Lưu thành công (**không** lỗi `400`).
   - Bấm **Xem trước (Live Preview)** và mở Drawer **Hồ sơ đã nộp (`listSubmissions`)** để kiểm tra hồ sơ vừa nộp ở Test 1.4.
4. **Tab Bảng Quyết định DMN (`Visual DMN Editor`):**
   - Mở bảng `cold_chain_approval_v1`, thử sửa 1 rule ngay trên giao diện (**chưa bấm Lưu**) rồi bấm **Mô phỏng (Simulate)** → **Kỳ vọng:** Đánh giá theo **bản nháp đang sửa** (không chạy lại bản DB cũ).
   - Thử chuyển Hit Policy (`FIRST`, `COLLECT`, `UNIQUE`, `PRIORITY`) và lưu → không lỗi `400`.
5. **Tab Hộp thư Phê duyệt Thống nhất (`Unified Approval Inbox`):**
   - Quan sát số badge ở cả 4 tab (**Nghiệp vụ / AI HITL / Flow / Đề xuất AI**).
   - Bấm chuyển qua lại giữa các tab → **Kỳ vọng:** Số badge ở các tab còn lại **giữ nguyên chính xác** (không bị reset về `0`).
   - Kiểm tra nút **Đã xem (`Review`)**, **Phê duyệt / Từ chối** (có `diffPreview`), và mở **Drawer cấu hình Approval Policy**.
6. **Tab Sổ cái PKI & Merkle Ledger (`dxosLedger`):**
   - Bấm **Kiểm chứng chuỗi Merkle (`Verify`)** → xanh hợp lệ.
   - Bấm **Xoay vòng khóa (`rotateKey`)** → khóa cũ chuyển sang `retired` nhưng chữ ký cũ (`expectedKeyId`) vẫn xác thực hợp lệ; bấm **Xuất bằng chứng Merkle JSON**.
7. **Tab API Keys (`PaaS PAT`) & Outbox/DLQ:**
   - Cấp phát 1 PAT mới bằng dropdown chọn Role → xác nhận có nút **Sao chép (Copy)** ngay trên banner hiện khóa 1 lần → bấm thu hồi (`Revoke`).
   - Mở tab **Outbox / DLQ**: kiểm tra nút xem `payloadJson`, lọc trạng thái `pending`/`sent`/`failed` và replay/dọn.
8. **Tab GitOps Solution Bundle v3 (Self-Roundtrip):**
   - Bấm **Xuất Bundle JSON** (kiểm tra đã có manifest `latticeConnectors` đã che secret).
   - Bấm **Tải tệp JSON lên (`<input type="file">`)** hoặc dùng ngay JSON vừa xuất → bấm **Kiểm tra Diff (Dry-Run)** → **Kỳ vọng:** **HTTP `200 PASS`** (đã sửa lỗi `ldx_admin` trong `slaPolicies`), hiển thị cây Diff chi tiết từng mục.

---

## 7. Phần 7 — LatticeFlow v2 Workflow Automation Studio (Miền 7)

Mở **`/admin/settings/workflow/automation`** bằng tài khoản `root` (hoặc `ldx_manager`):
1. **Kiểm tra phân quyền:** Nhớ lại Test 2.2 — tài khoản `ldx_employee` đã bị chặn hoàn toàn cả UI lẫn API `listRules`/`listRuns` (`403`).
2. **Canvas-First Editor & 24 Node Types:**
   - Tạo luồng mới hoặc mở 1 blueprint chuẩn → xác nhận đủ **6 nhóm / 24 loại node**.
   - Kéo thử **2 node Trigger** vào canvas → **Kỳ vọng:** Validator phía client cảnh báo ngay bằng **tiếng Việt** trước khi gửi server (server cũng trả thông báo tiếng Việt nếu gọi trực tiếp).
   - Chọn node **`ai.agent`** → kiểm tra Inspector có đủ trường `aiEmployee`, `model`, `temperature`, `maxTokens`, `memoryScope`.
   - Chọn node **`control.if` / `control.switch` / `logic.transform`** → kiểm tra bộ dựng điều kiện/ánh xạ theo dòng trực quan (không bắt gõ JSON tay).
   - Chọn node **`trigger.schedule`** → đặt múi giờ `Asia/Ho_Chi_Minh`, bật/tắt luồng (`toggleRule`) → kiểm tra `nextRunAt` tính đúng theo múi giờ đã chọn.
3. **Chạy thử (`Dry Run`), Draft/Publish & Resume `control.loop` / `control.merge`:**
   - Bấm **Chạy thử (Dry Run)** → kiểm tra badge trạng thái + Live Trace I/O JSON trên từng node, nút **Copy-cURL** cho Webhook.
   - Bấm **Xuất bản (Publish)** → sửa nhẹ thành **Bản nháp (Draft)** → kiểm tra lịch sử phiên bản & **Rollback**.
   - Kiểm thử luồng có **`control.loop` chứa `control.approval` (HITL)** → duyệt bước tạm dừng ở Hộp thư Phê duyệt → xác nhận luồng tự chạy tiếp các phần tử còn lại của vòng lặp và bắn cổng `done`.
   - Kiểm thử luồng phân nhánh vào **`control.merge` chế độ `first_completed`** → xác nhận nhánh nhanh đi qua ngay không bị kẹt chờ nhánh chậm.

---

## 8. Phần 8 — Bộ Lệnh Kiểm thử Tự động, Nghiệm thu Live & Pure-OSI (Chạy trên Terminal)

Hưng có thể chạy toàn bộ bộ kiểm thử tự động & tuân thủ nguồn mở chỉ bằng cụm lệnh sau tại thư mục gốc dự án:

```powershell
# 1. Typecheck + Vitest (152 file / 1,128 test) + Build đủ 12 package/plugin (gồm minify UMD)
pnpm check

# 2. Toàn bộ kiểm thử 7 plugin NocoBase + scripts + externals (174 file / 1,381+ test)
$files = @(
  Get-ChildItem -Path "plugins\nocobase\*\tests\*.test.cjs" -File | Select-Object -ExpandProperty FullName
  Get-ChildItem -Path "scripts\tests\*.test.mjs" -File | Select-Object -ExpandProperty FullName
  Get-ChildItem -Path "tests\*.test.mjs" -File | Select-Object -ExpandProperty FullName
)
node --test --test-concurrency=4 @files

# 3. Bộ đánh giá AI tiếng Việt tự nhiên (163/163 = 100%)
node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95

# 4. Kiểm toán Nguồn mở Pure-OSI, SPDX, SBOM CycloneDX 1.5 (257/257, 0 NONE) & Bảo mật phụ thuộc (0 CVE)
node scripts/source-headers.mjs --check
pnpm pof:check
pnpm release:sbom -- --check
pnpm audit --prod --audit-level=low

# 5. Bộ nghiệm thu Live API/E2E (chạy khi NocoBase đang bật ở http://localhost:13014)
# Lưu ý: acceptance:dxos-ai-mcp và acceptance:broker-automation-builder yêu cầu dịch vụ n8n (chỉ có trên full stack)
pnpm acceptance:headless-paas -- --origin=http://localhost:13014
pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
pnpm acceptance:broker-automation-builder -- --origin=http://localhost:13014
pnpm acceptance:logistics-rbac -- "<path-to-report.json>"

# 6a. Kiểm tra sao lưu & phục hồi DB cho lab native:clean 2 container (không chạm dữ liệu thật)
$env:NATIVE_DATABASE_CONTAINER = "lattice-native-clean-<id>-nocobase-db-1"
pnpm backup:native
pnpm backup:rehearse-native -- "output/backups/native/<core-dump>.dump"

# 6b. Kiểm tra sao lưu & phục hồi toàn stack 7 container (chỉ dùng khi dựng full stack core.yml/prod.yml)
pnpm backup:stack
pnpm backup:rehearse-stack -- "output/backups/stack/<bundle-id>"
```

---

## 9. Bảng Điểm Danh Nghiệm thu E2E (Hưng tích đánh dấu khi tự test)

| # | Miền kiểm thử | Điểm cốt lõi cần xác nhận | Kết quả (`PASS` / `FAIL`) | Ghi chú lỗi (nếu có) |
|---|---|---|---|---|
| 1 | Auth, Onboarding & Public (`/signin`, `/v/form/*`, `/v/track/*`) | `/signin` không 401 thừa; `root` vào `/admin/lattice-workspace`; QR `?verify=` hiện Ed25519 proof mà giữ kín PII; `/v/form` hỗ trợ file & chặn XSS | `[ ]` | |
| 2 | 7 Portals & 12 BlockModels | `ParaVault` hiện Markdown; `WmsOps` có `releaseLotByQa` + org picker cho `root`; `BiChart` modal không cắt đỉnh; `AiProposal`/`WorkflowTasks` duyệt trực tiếp; `Ctrl+K` + Bell | `[ ]` | |
| 3 | Mobile PWA `/v/mobile` (`390x844`) | Offline ePOD + `gpsUnavailable` → lỗi `400/404` vào Quarantine không mất dữ liệu; `401` giữ outbox; ẩn Twin theo ACL; nút `>=44px` | `[ ]` | |
| 4 | P.A.R.A. & OCR-to-Record | Lọc `status='active'`; query rác trả rỗng; OCR `latticeStockLots` giữ đúng `qtyOnHand`/`productName`/`lotCode` đã sửa | `[ ]` | |
| 5 | DX-OS AI Studio (9 tab) & Chat | Eval Lab chạy đủ `163/163`; Audit dropdown lọc đúng; HITL có `executionResult`/`expiresAt`; Rollback đúng block app; Teardown an toàn đa tenant; Chat offline có nút Thử lại | `[ ]` | |
| 6 | Control Studio (11 tab + 6 consoles) | UI `dxosNotify` đầy đủ; Form `select` + Submissions Viewer; DMN mô phỏng bản nháp; Approval giữ nguyên badge 4 tab; PKI `rotateKey`; GitOps Dry-Run `200 PASS`; `?tab=dmn` & không cắt nút ở `1280x800` | `[ ]` | |
| 7 | LatticeFlow v2 Studio | Chặn `ldx_employee` `403`; validator tiếng Việt; `ai.agent` đủ trường; visual builder `if`/`switch`/`transform`; `control.loop` resume HITL; `first_completed` không chặn | `[ ]` | |
| 8 | Bộ lệnh tự động & Pure-OSI | `pnpm check`, `node --test`, `163/163` Eval, `pof:check` `6/6`, `sbom` `257/257`, `audit` `0` CVE, `acceptance:*`, `backup:native` | `[ ]` | |

---

### Dọn dẹp môi trường sau khi test xong
```powershell
# Tắt lab native:clean theo đúng project (<id> lấy từ output/native-clean/<id>/report.json)
docker compose -p lattice-native-clean-<id> -f infra/compose/native-rehearsal.yml -f output/native-clean/<id>/overlay.yml down -v --remove-orphans

# Hoặc nếu dựng bằng compose nocobase.yml mặc định:
docker compose -f infra/compose/nocobase.yml down
```

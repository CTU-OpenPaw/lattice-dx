# Nghiệm thu Quy trình Logistics 5 Bước, Domain thứ 2, RBAC Âm tính & Sao lưu Toàn Stack

Tài liệu ghi nhận kết quả chạy nghiệm thu trực tiếp (E2E live acceptance) đối với các thành phần cốt lõi thuộc Issue [#59](https://github.com/CTU-OpenPaw/lattice-dx/issues/59) và Issue [#60](https://github.com/CTU-OpenPaw/lattice-dx/issues/60) trên môi trường clean-install **NocoBase `2.2.38`** + **6 plugin Apache-2.0** (`organizationId: "native-ui-lab"`, cổng `http://localhost:13014`) và toàn bộ container hỗ trợ (**PostgreSQL**, **Keycloak**, **MongoDB / Orion-LD**, **n8n**).

> Tài liệu chỉ lưu số liệu xác minh, mã phản hồi HTTP, ID/mã quy trình không nhạy cảm và tên thành phần; tuyệt đối không lưu mật khẩu, token, tệp `.env` hoặc dump cơ sở dữ liệu.

---

## 1. Nghiệm thu Issue #59 — Logistics 5 bước, Domain thứ 2 & Kiểm tra RBAC Âm tính

- **Script nghiệm thu:** [`scripts/acceptance-logistics-and-rbac.mjs`](../scripts/acceptance-logistics-and-rbac.mjs) (`pnpm acceptance:logistics-rbac -- --origin=http://localhost:13014`)
- **Kiểm thử đơn vị:** [`scripts/tests/acceptance-logistics-rbac.test.mjs`](../scripts/tests/acceptance-logistics-rbac.test.mjs) (`node --test`: `5/5` đạt)
- **Kết quả chạy live:** `result: "PASS"` (`organizationId: "native-ui-lab"`)

### 1.1. Luồng Logistics 5 bước xuyên phòng ban (`logistics-5step`)

| Bước | Vai trò thực thi (`NATIVE-UI-*`) | Hành động API xác minh | Trạng thái / Kết quả |
| --- | --- | --- | --- |
| 1 | `NATIVE-UI-EMPLOYEE` | `latticeOrders:create` (không truyền trường hệ thống được bảo vệ) | Tạo đơn `ORD-E2E-PTH35Y` (`workflowId: 398786389671936`) |
| 2 | `NATIVE-UI-MANAGER` | `workflowManualTasks:listMine` (`appends[]=node&appends[]=execution`) → `submit` (`review: approve`) | Chuyển sang Kho chuẩn bị |
| 3 | `NATIVE-UI-WORKER` | `workflowManualTasks:listMine` → `submit` (`prepareWarehouse: prepared`) | Chuyển sang Điều phối |
| 4 | `NATIVE-UI-DISPATCHER` | `workflowManualTasks:listMine` → `submit` (`dispatchOrder: dispatched`) | Gán tuyến `65C-999.99 / Tuyến CT-HCM` |
| 5 | `NATIVE-UI-DRIVER` | `workflowManualTasks:listMine` → `submit` (`driverDeliver: delivered`) | Đơn đạt `finalStatus: "completed"`, `assigneeId: 35`, `decisionReason: "Đã giao nguyên seal E2E OK"` |

- Toàn bộ bản ghi tạo mới cho lần test (`ORD-E2E-PTH35Y`) được dọn sạch tự động trong khối `finally` qua `latticeOrders:destroy`.

### 1.2. Domain nghiệp vụ thứ 2 (`internal-service` — `latticeServiceTickets`)

| Thông số | Kết quả xác minh live |
| --- | --- |
| Workflow ID | `398784396328960` (`internal-service`) |
| Bản ghi kiểm thử | `SRV-E2E-PTH35Y` (khởi tạo bởi `NATIVE-UI-EMPLOYEE`) |
| Chuỗi duyệt & xử lý | Manager duyệt (`review: approve`) → Employee hoàn tất (`work: complete`) |
| Kết quả cuối | `finalStatus: "completed"`, `resolutionNote: "Hoàn tất cấp quyền VPN E2E OK"` (dọn sạch sau kiểm thử) |

### 1.3. Kiểm tra RBAC Âm tính & Ranh giới Đa tổ chức / Luồng việc (7/7 HTTP `403`)

| # | Kịch bản tấn công / vượt quyền mô phỏng | Mã HTTP | Kết quả |
| --- | --- | :---: | :---: |
| 1 | `employee` gọi `GET dxosStudio:readiness` (API quản trị Studio) | `403` | Đạt |
| 2 | `employee` gọi `POST dxosStudio:composePortals` | `403` | Đạt |
| 3 | `employee` gọi `POST dxosStudio:installWorkflow` | `403` | Đạt |
| 4 | `employee` tạo `latticeServiceTickets` với `organizationId: "foreign-org"` | `403` | Đạt |
| 5 | `employee` tạo `latticeParaDocuments` với `organizationId: "foreign-org"` | `403` | Đạt |
| 6 | `employee` tạo `latticeRequests` giả mạo `organizationId: "foreign-org"` và `status: "approved"` | `403` | Đạt |
| 7 | `employee` đánh chặn gọi `workflowManualTasks:submit` lên manual task đang giao cho Manager | `403` | Đạt |

---

## 2. Nghiệm thu Issue #60 — Sao lưu & Diễn tập Phục hồi Toàn Stack (Chỉ đọc / Cô lập)

- **Công cụ & Tài liệu:** [`scripts/stack-recovery.mjs`](../scripts/stack-recovery.mjs), [`scripts/tests/stack-recovery.test.mjs`](../scripts/tests/stack-recovery.test.mjs) (`6/6` đạt), [docs/stack-backup-and-recovery.md](stack-backup-and-recovery.md)
- **Nguyên tắc an toàn:** Sao lưu đọc nguyên trạng; diễn tập PostgreSQL tạo database tạm `dx_restore_<32hex>` riêng và xóa ngay khi xong; MongoDB kiểm tra bằng `mongorestore --dryRun`; `uploads` kiểm tra lưu trữ bằng `tar` (chống path traversal); `n8n` kiểm tra cấu trúc JSON mảng workflow. Tuyệt đối **không** ghi đè container hoặc dữ liệu vận hành.

### 2.1. Kết quả `pnpm backup:stack` & `pnpm backup:rehearse-stack` trực tiếp

- `format`: `latticedx.stack-backup` → `latticedx.stack-restore-rehearsal` (`fullStackVerified: true`, `skippedComponents: []`)

| Thành phần | Kết quả sao lưu | Kết quả diễn tập phục hồi cô lập |
| --- | --- | --- |
| `nocobase-db` (PostgreSQL `2.2.38`) | Dump custom format + SHA-256 (`c51b7687eaa14b4e...`) | `metadataVerified: true` trên DB tạm `dx_restore_868941db7a4b41bdbd77a48248587ea3` (`119` bảng, `64` bảng có dữ liệu, `10.832` bản ghi) |
| `uploads` (NocoBase `storage/uploads`) | Archive `.tar.gz` | `verified: true`, `entryCount: 3`, đường dẫn an toàn |
| `keycloak` (PostgreSQL realm `lattice`) | Dump SQL gzip | `verified: true` trên DB tạm `dx_restore_9eaf4c5747b347f3921efbfd6e652c3a` (`101` bảng, realm `lattice`) |
| `orion-mongo` (MongoDB NGSI-LD) | Archive `mongodump --archive --gzip` (`13.944` bytes) | `verified: true` qua `gzip -t` và `mongorestore --archive --gzip --dryRun` |
| `n8n` (Workflow JSON export) | Export CLI không kèm credential | `verified: true`, `workflowCount: 4` |

### 2.2. Cách chạy lại kiểm chứng

```sh
# 1. Kiểm thử logic đơn vị (không cần Docker)
node --test scripts/tests/stack-recovery.test.mjs scripts/tests/acceptance-logistics-rbac.test.mjs

# 2. Nghiệm thu live E2E Logistics 5 bước + Domain 2 + RBAC âm tính
pnpm acceptance:logistics-rbac -- --origin=http://localhost:13014

# 3. Sao lưu toàn stack & diễn tập phục hồi cô lập (chỉ khi đã bật đủ Docker stack)
pnpm backup:stack
pnpm backup:rehearse-stack -- "output/backups/stack/<bundle-id>"
```

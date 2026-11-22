<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Sao lưu & Diễn tập Khôi phục Toàn Stack (`Issue #60`)

Tài liệu này mở rộng quy trình [sao lưu PostgreSQL NocoBase](native-database-recovery.md) sang toàn bộ 5 thành phần có trạng thái của **LatticeDX DX-OS**, phục vụ **Giai đoạn 6 / Issue #60** mà **không bao giờ ghi đè** dữ liệu đang chạy.

---

## 1. Phạm vi 5 Thành phần được Bảo vệ

| Thành phần | Container mặc định / Biến override | Cơ chế Backup (Chỉ đọc) | Cơ chế Rehearsal (Cô lập hoàn toàn) |
| --- | --- | --- | --- |
| `nocobase-db` | `NATIVE_DATABASE_CONTAINER` (`lattice-dx-nocobase-db-1`) | Gọi `backupNative()` (`pg_dump --format=custom`) | Gọi `rehearseNative()` đổ vào DB tạm `dx_restore_<UUID>` rồi `DROP DATABASE` |
| `uploads` | `NATIVE_APP_CONTAINER` (`lattice-dx-nocobase-1`) | `tar -czf - -C /app/nocobase/storage uploads`, kiểm tra chặn path traversal | Kiểm `SHA-256`, kiểm danh sách tar entry, giải nén vào `mkdtemp` riêng rồi xóa ngay |
| `keycloak` | `KEYCLOAK_DB_CONTAINER` (`lattice-dx-postgres-1`) | `pg_dump` DB `keycloak` + chụp `infra/config/keycloak/lattice-realm.json` | Kiểm `SHA-256`, khôi phục vào DB tạm `dx_restore_<UUID>`, đối soát bảng rồi `DROP DATABASE` |
| `orion-mongo` | `ORION_MONGO_CONTAINER` (`lattice-dx-orion-mongo-1`) | `mongodump --archive --gzip` | Kiểm `SHA-256`, chạy `mongorestore --archive --gzip --dryRun` (không ghi DB sống) |
| `n8n` | `N8N_CONTAINER` (`lattice-dx-n8n-1`) | `n8n export:workflow --all` (chỉ workflow JSON, không xuất bảng credential) | Kiểm `SHA-256`, parse JSON hợp lệ và đối soát số lượng workflow (`workflowCount`) |

Ngoài 5 artifact trên, `manifest.json` chỉ ghi **cờ hiện diện boolean** (`APP_KEY`, `ENCRYPTION_FIELD_KEY`, `DB_PASSWORD`, `N8N_ENCRYPTION_KEY`, `AGENT_API_KEY`: `true`/`false`), tuyệt đối **không ghi giá trị secret** ra đĩa hoặc stdout.

---

## 2. Lệnh Chạy

```powershell
# Sao lưu toàn stack (hoặc chọn thành phần bằng --components=nocobase-db,uploads,...)
pnpm backup:stack

# Diễn tập khôi phục an toàn từ thư mục bundle stack-<32hex> vừa in ra
pnpm backup:rehearse-stack -- "output/backups/stack/stack-<32hex>"
```

Khi chạy trên lab sạch (`pnpm native:clean`), truyền tên container tương ứng qua biến môi trường:

```powershell
$env:NATIVE_DATABASE_CONTAINER = "lattice-native-clean-<id>-nocobase-db-1"
$env:NATIVE_APP_CONTAINER = "lattice-native-clean-<id>-nocobase-1"
pnpm backup:stack
```

---

## 3. Nguyên tắc An toàn & Kiểm chứng Bắt buộc

1. **Fail-closed trước khi khôi phục:** Mọi artifact trong `manifest.json` được kiểm tra kích thước (`<= 256 MiB`), tệp thường không symlink (`lstatSync` / `realpathSync`) và `SHA-256` **trước khi** mở bất kỳ DB tạm hoặc thư mục tạm nào. Sai checksum hoặc sai byte sẽ dừng ngay lập tức.
2. **Báo cáo trung thực:** `fullStackVerified: true` chỉ được đặt khi **đủ 5/5 thành phần** đều chạy qua diễn tập. Khi chạy tập con (`--components=...`), trường `skippedComponents` liệt kê rõ các thành phần chưa chạy và `fullStackVerified: false`.
3. **Không đưa artifact backup lên Git:** Mọi dữ liệu dump và báo cáo nằm trong `output/backups/stack/` (đã nằm trong `.gitignore`).
4. **Quy trình cắt chuyển khi phục hồi sự cố thật:** Tạo môi trường mới theo cùng image digest `@sha256:` và 6 plugin Apache-2.0, nạp đủ biến môi trường bí mật từ trình quản lý secret ngoài Git, tắt worker/outbox trước khi mở traffic, khôi phục từng thành phần từ bộ backup đã diễn tập đạt, kiểm đăng nhập/ACL rồi mới bật lại luồng tự động.

# Sao lưu và thử khôi phục database NocoBase

Phần Platform của Duy, giai đoạn 6. Dùng `pg_dump/pg_restore` và guard phục hồi hiện có; không thay Collection Manager, ACL, Workflow hoặc trình dựng trang của NocoBase.

## Chạy

Docker và PostgreSQL NocoBase phải đang chạy. Không cần dừng hay khởi động lại app:

```powershell
pnpm backup:native
pnpm backup:rehearse-native -- "C:\path\to\repo\output\backups\native\core-<id>.dump"
pnpm test:native-recovery
```

Thay đường dẫn bằng artifact thật của lệnh đầu. Nguồn mặc định là container `lattice-dx-nocobase-db-1`, database/user `nocobase`. `NATIVE_DATABASE_CONTAINER` cho phép chọn container PostgreSQL khác khi kiểm thử; không thay database nguồn thành đích restore. Công cụ không đọc `.env`, không cần password trên dòng lệnh và không in stdout/stderr của lệnh database khi lỗi.

Lệnh backup lấy snapshot nhất quán của PostgreSQL, khôi phục thử vào database có tên tự sinh `dx_restore_<UUID>`, rồi lập inventory của snapshot đã restore. Chỉ ghi artifact hoàn chỉnh sau khi kiểm đủ các store native bắt buộc. Lệnh rehearse kiểm file thường, đường dẫn, giới hạn 256 MiB, header custom dump, SHA-256, scope và inventory; sau đó restore lại vào database thử mới. Không có tùy chọn ghi đè database đang chạy.

Inventory gồm số dòng và fingerprint nội dung của từng bảng `public`, không chứa giá trị bản ghi, token hay credential. Fingerprint sắp xếp theo nội dung để không phụ thuộc thứ tự vật lý sau restore; SHA-256 của dump kiểm tính toàn vẹn artifact. Metadata trang, roles/permissions, collections/fields, workflow, execution/job và dữ liệu native cùng nằm trong snapshot. Database thử luôn được dọn; khi restore và cleanup đều lỗi, lệnh thất bại thay vì báo thành công.

`test:native-recovery` tạo thêm một database nguồn thử từ snapshot hiện tại, ghi fixture bytes ở đó và kiểm backup/restore. Sau backup, nó sửa bytes và thêm một dòng trong nguồn thử để chứng minh restore vẫn theo snapshot; kiểm artifact hỏng bị chặn trước khi gọi PostgreSQL. Chỉ bản sao nhận fixture writes; database gốc không đổi. Các database thử được dọn, artifact/báo cáo được giữ. Fixture này không phải kiểm ClamAV hoặc tải tệp qua UI.

Artifact và báo cáo nằm trong `output/backups/native`, đã được git ignore. Dump có dữ liệu nhạy cảm như tài khoản, phiên và cấu hình credential trong database: chỉ lưu ở máy có quyền truy cập phù hợp, không commit, upload hoặc gửi vào chat. Không có encryption/offsite/retention tự động. Checksum không phải chữ ký xác thực người tạo; chỉ restore artifact tin cậy do mình quản lý.

## Phạm vi kiểm chứng

- `scope: nocobase-database-only`, `fullRecoverability: false`, `objectsVerified: false`, `applicationHealthVerified: false`.
- Tệp của bản thử `lattice_native_request_attachments` nằm dưới dạng `bytea` trong database được giữ và đối chiếu cùng snapshot. `nativeAttachmentBytesVerified` chỉ là `true` khi snapshot có bảng này và có tệp; không thay kiểm tra tải tệp qua API/ACL.
- Không bao gồm uploads ngoài DB, S3/MinIO, key mã hóa, plugin/source/build, database ngoài NocoBase, Keycloak, broker, n8n hoặc store legacy. Để sao lưu và diễn tập khôi phục mở rộng cho **uploads, Keycloak, Orion-LD/MongoDB và n8n**, dùng `pnpm backup:stack` / `pnpm backup:rehearse-stack` theo [tài liệu sao lưu toàn stack](stack-backup-and-recovery.md); tham khảo [phục hồi store legacy](recovery.md) cho core store.
- Thử restore dữ liệu không chứng minh app đã lên health, luồng browser hay provider hoạt động. Không tự cutover, reset dữ liệu nguồn hoặc chạy lại event/outbox trong app thử.
- Native backup/export của host có thể dùng riêng theo edition/plugin đang bật. Công cụ này dành cho snapshot PostgreSQL gồm cả bảng riêng của extension; không giả định export cấu hình host bao gồm các bảng đó.

## Khi chuyển môi trường thật

Giữ image/plugin đúng phiên bản và cung cấp keys/credential qua cơ chế vận hành riêng. Chuẩn bị file/object store cùng snapshot nhất quán; cấu hình native app vào database đích riêng. Chặn worker/outbox/n8n và lưu lượng thật trong lúc kiểm health, metadata, đăng nhập, quyền, tải tệp và workflow. Chỉ mở lại từng writer sau nghiệm thu chung. Công cụ rehearsal không tự thực hiện các bước này.

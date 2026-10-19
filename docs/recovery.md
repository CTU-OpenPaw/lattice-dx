# Backup và thử khôi phục database local

Chạy từ thư mục repo:

```powershell
pnpm backup:core
pnpm backup:rehearse -- "E:\pmnm2026\output\backups\core-<id>.dump"
```

Lệnh đầu in đường dẫn artifact thật. Thay `<id>` bằng tên đó; đây không phải wildcard. Có thể kiểm một record đã có trước lúc backup bằng `--record-id <UUID>` sau dump path.

Backup dùng `pg_dump --format=custom` của container PostgreSQL, tạo snapshot nhất quán của database `lattice`. Dump là bytes, không qua text redirection PowerShell. Metadata lưu SHA256, byte length và thời điểm UTC; không ghi password hoặc connection URL. Artifact nằm trong `output/backups`, được git ignore vì có dữ liệu nghiệp vụ và nội dung tệp đã lưu trong database.

Rehearsal kiểm regular file, đường dẫn thực không qua link, giới hạn256MiB, byte length và checksum trước khi restore. Luôn tạo database tên `dx_restore_<UUID>` mới, không có chế độ restore vào `lattice` hoặc `keycloak`. `pg_restore --exit-on-error` khôi phục dữ liệu/constraints; kiểm các store và lập inventory số dòng. Record sentinel tùy chọn phải tồn tại đúng một dòng. Mỗi lượt tạo báo cáo riêng, cho phép thử lại cùng bản backup.

Cuối lượt, chỉ database fixture đã kiểm tên được drop, có FORCE để ngắt các kết nối restore còn sót. Nếu restore và cleanup đều lỗi, cả hai lỗi được giữ. Dump không bị xóa, database chính và volume không bị reset.

Đã thử restore thực tế27 bảng và record sentinel; test policy kiểm không được đụng database nguồn, checksum sai, byte length, file quá lớn trước đọc, lỗi cleanup và timeout tạo fixture. Đây là công cụ local cho core database. Chưa backup database Keycloak, NocoBase, file ngoài PostgreSQL hoặc cung cấp encryption/offsite/retention; không coi toàn bộ vận hành doanh nghiệp hoàn thiện chỉ vì rehearsal này đạt.

## Phạm vi báo cáo và tệp ngoài database

Các báo cáo mới ghi `scope: "database-only"`, `objectsVerified: false` và `fullRecoverability: false`. Khôi phục thành công database không xác nhận đã khôi phục tệp chuyển sang filesystem.

Công cụ ghép dump và inventory object đã chạy với tệp thật được ClamAV quét, chuyển sang filesystem và tải lại đúng bytes. Inventory lấy từ chính dump đã restore vào fixture. Thử chuyển thêm một tệp ngay sau dump chứng minh inventory vẫn theo snapshot, không theo database đang thay đổi. Rehearsal đã restore object vào root riêng, tải qua loader của ứng dụng và trả `objectsVerified:true`, `downloadVerified:true`. Thiếu object, sai checksum và bỏ tham chiếu khỏi manifest đều bị từ chối.

```powershell
pnpm backup:full
pnpm backup:rehearse-full -- "E:\pmnm2026\output\backups\full-<id>"
pnpm test:full-recovery
```

Thay `<id>` bằng thư mục thực do lệnh đầu in ra. Giữ nguyên cả dump, `manifest.json` và thư mục `objects` như một bộ. Manifest giới hạn8MiB,10.000object,1MiB/object, tổng1GiB; dump tối đa256MiB. Final manifest chỉ xuất hiện sau khi mọi bản sao được kiểm checksum. `test:full-recovery` tạo hai tệp demo trong local, giữ chúng cùng artifact để kiểm tra; không xóa dữ liệu nguồn.

Khi cần phục hồi thủ công vào môi trường thay thế: chạy rehearsal trước; dừng mọi writer trong môi trường đích; tạo database mới và root object riêng thuộc runtime user; restore dump bằng `pg_restore --exit-on-error` vào database mới; chép đúng các key trong manifest vào root, kiểm size/SHA256 từng object; cấu hình `DATABASE_URL` và `FILE_STORAGE_ROOT` của môi trường đích; khởi động API với các worker tắt, kiểm readiness, quyền và tải tệp; chỉ chuyển lưu lượng và bật worker sau khi kiểm chứng. Giữ môi trường nguồn và bộ backup để có thể quay lại. Công cụ rehearsal không tự chuyển lưu lượng hoặc ghi đè database nguồn.

Báo cáo `downloadVerified:false` (ví dụ inventory rỗng) không chứng minh tải object. Phạm vi này chỉ gồm database LatticeDX và object của engine; Keycloak/NocoBase, encryption, offsite và HA cần quy trình riêng. Xem [storage contract](filesystem-storage.md).

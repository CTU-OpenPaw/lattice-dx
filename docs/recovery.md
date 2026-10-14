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

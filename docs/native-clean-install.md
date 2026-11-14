# Cài và nghiệm thu native trên môi trường sạch

Đây là đường tái tạo phần nền NocoBase từ source đã commit, dùng image chính thức được khóa digest trong `infra/compose/native-rehearsal.yml`. Collections, ACL, UI schema và workflow vẫn do host thực thi; LatticeDX cài ba plugin của nhóm, migration và cấu hình mẫu. Không dựng thêm engine.

## Chạy

Yêu cầu: Git, tar, Node24 có npm, pnpm10.23 và Docker Desktop với context `desktop-linux`. Từ checkout repo:

```powershell
pnpm native:clean
# Chọn cổng khác khi 13004 đang dùng:
pnpm native:clean --port=13005
```

Chỉ nhận cổng13004–13999 và bind `127.0.0.1`. Script không mở firewall, không chọn project `lattice-dx`, không reset hay dùng lại lab cũ. Mỗi lượt tạo project `lattice-native-clean-<id>` và volume mới. Không có lệnh down/reset/delete tự động; lỗi giữ report và môi trường để kiểm tra, không chạy lại trên database dở dang.

Các bước thực hiện:

1. Kiểm tra project chưa có container/volume/network; xuất **HEAD đã commit** bằng Git archive vào `output/native-clean/<id>/source`. Code chưa commit và dữ liệu local không được copy.
2. Tạo PostgreSQL riêng và xác nhận schema public có **0 bảng trước khi khởi động NocoBase**. Không dùng dump/restore từ máy người dựng.
3. Bootstrap host, backup DB trước cài plugin, build/install ba package từ source export. npm dependencies của Enterprise Login được phục hồi theo lockfile với scripts tắt. Cả build lẫn bind mount đều nằm trong source export; không ghi dist vào checkout đang chạy app khác.
4. Chạy upgrade native, kiểm phiên bản2.2.38 và tất cả tên migration Foundation trong source. Kiểm plugin registry và phiên bản package khớp source.
5. Chạy lại acceptance native foundation (mapping, org/reference/ACL) và documents (Request/Order, manual tasks, chống xử lý lặp, revoke và chart scope). Tạo lại trang mẫu native và ba tài khoản thử bằng script/config đã có trong repo.
6. Ghi `report.json`: SHA nguồn, phiên bản package/runtime, migration, checks, page URL và giới hạn. `complete:true` chỉ là hoàn tất các bước native trong báo cáo, không phải hoàn tất DX-OS.

Chỉ in phase, project, đường dẫn và kết quả an toàn. Output lỗi của lệnh con được giữ kín; không in token hoặc `.env`. Backup vẫn có thể chứa dữ liệu/credential trong database, nên không commit hoặc chia sẻ cả thư mục output. Chạy trên máy có quyền truy cập phù hợp.

## Tự kiểm tra

Mở `pageUrl` do lệnh trả về. Root fixture của host: `admin@nocobase.com` / `admin123`. Tài khoản nghiệp vụ mẫu:

- `native.lab.employee@example.invalid`
- `native.lab.manager@example.invalid`
- `native.lab.worker@example.invalid`

Mật khẩu fixture nghiệp vụ: `NativeLab-2026!`. Chỉ dùng localhost, không phải cấu hình production. Đăng xuất giữa các vai trò. Dùng form **Tạo và gửi**, quản lý vào Workflow To-do để duyệt, người thực hiện hoàn thành. Người nhận nằm trong cấu hình workflow mẫu, không phải cơ chế điều phối logistics hoàn chỉnh.

Với source chứa PR #47, mở `/admin/lattice-workspace` trên cùng cổng để vào Workspace. [Hướng dẫn Workspace theo vai trò](native-workspace-roles.md) có các bước kiểm menu, trang được cấp quyền và hộp công việc. Lệnh cài sạch kiểm API và lưu cấu hình UI mẫu. Dùng trình duyệt để nghiệm thu từng thao tác.

## Kiến trúc và phạm vi bàn giao

| Năng lực | Nơi thực thi |
|---|---|
| Collections, fields, quan hệ, trang native | NocoBase và Foundation |
| Native session, role/field/data ACL | Host; guard của nhóm bổ sung org/identity/integrity |
| Approval, task, execution/job | Workflow/manual node của host |
| Keycloak login | Enterprise Login extension; provider riêng, chưa nghiệm thu live bởi lệnh này |
| Context/outbox, ingress/proposal tools | Foundation; broker/n8n/model cần cấu hình và kiểm thử riêng |
| Tệp chung | Overlay `native-files.yml`, API/core DB/ClamAV/ObjectStore; chưa bật trong lab native tối thiểu |
| Legacy `/lattice` và store cũ | Giữ tương thích; không tự cutover hoặc xóa vì lab native đã lên |

Báo cáo inventory giấy phép chỉ liệt kê `name/version/license` của ba package nhóm. Dependency bundled và host giữ giấy phép/NOTICE upstream; đây không phải SBOM đầy đủ hay kết luận giấy phép của toàn runtime. Xem [contract native](native-platform-contract.md), [kho tệp chung](native-shared-file-storage.md), [phục hồi store cũ](recovery.md) và PR45 về phục hồi DB native.

## Dừng lab

Giữ nguyên source export và overlay của lượt chạy. Dùng project/path chính xác từ báo cáo; không thay bằng project chính:

```powershell
docker --context desktop-linux compose -p lattice-native-clean-ID -f PATH_TO_SOURCE/infra/compose/native-rehearsal.yml -f PATH_TO_OVERLAY stop
```

Lệnh stop giữ volume và dữ liệu. Cài mới thành công không chứng minh đã backup/restore toàn hệ thống, n8n/model/broker có dữ liệu live, HA hay rollback dữ liệu tùy ý. Giai đoạn7 chỉ chốt khi cả nhóm nghiệm thu các phần đó trên cùng bản ghép.

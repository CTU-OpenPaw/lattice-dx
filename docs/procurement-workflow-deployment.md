# Triển khai workflow mua sắm trên runtime hiện có

2026-10-13. Code ở nhánh feat/nocobase-workflow-integration; Foundation 0.7.0, NocoBase 2.2.22. PR #5 đã được tích hợp vào nhánh local, không tự merge GitHub/main.

## Dùng thử

Mở http://localhost:13000/lattice/apps/purchasing. Đăng nhập NocoBase bằng tài khoản local đang dùng, sau đó Kết nối tài khoản nghiệp vụ. Hai phiên riêng; sau restart bridge phải kết nối lại.

| Tài khoản demo | Thao tác |
| --- | --- |
| alice | Tạo yêu cầu workflow → Gửi yêu cầu |
| manager | Mở yêu cầu submitted → Duyệt hoặc Từ chối (cần lý do) |
| warehouse | Nhận hàng → Nghiệm thu → Bàn giao |

Fixture password mới là local-<username>-password, PUBLIC và chỉ dùng local. Không dùng các fixture này làm tài khoản production. Đăng nhập NocoBase không tự cấp quyền nghiệp vụ; API quyết định quyền từ token Keycloak.

Form workflow ở phần trên, khác với form hồ sơ nền cũ bên dưới. Run có record UUID nền nhưng không chuyển trạng thái bằng task approval cũ.

1. Alice nhập Nội dung workflow và tạo; run draft/version 1. Gửi yêu cầu thành submitted/version 2.
2. Manager thấy run, Duyệt thành approved/version 3. API trả availableTransitions theo role và trạng thái; UI không tự mở các bước trái quyền.
3. Warehouse mở run approved; chọn tệp bằng chứng tối đa 1 MiB, upload phải scan clean. Copy ID tệp vào ID tệp biên nhận; Nhận hàng thành received/version 4.
4. Nhập ghi chú Nghiệm thu; run accepted/version 5.
5. Bàn giao cần assetId, signed subject người nhận đã self-register, Department/Location lấy từ references API và UUID tệp clean. Run handed_over/version 6.
6. Actor được policy workflow cho phép đọc có thể tải tệp đã liên kết; người ngoài đơn vị không được đọc. Người nhận bàn giao không tự có quyền đọc run chỉ vì nằm trong membership.

Danh sách thường và checkbox inbox chỉ trong tối đa 100 run API trả về. UI hiện lọc procurement sau khi tải danh sách; nếu bị 100 run workflow khác chiếm hết, cần filter/pagination phía server. Chưa có directory người nhận; nhập subject thật, không nhập username.

## Xử lý lỗi

- Mỗi create/transition dùng Idempotency-Key mới. Nếu lỗi mạng/5xx/429 chưa rõ kết quả, UI giữ nguyên body/key và chỉ cho thử lại lệnh cũ; không auto retry.
- Sau success, UI tải lại detail/history thật, không coi snapshot replay là trạng thái mới nhất.
- 4xx xác định (trừ 429) bỏ lệnh pending. Với 409 hãy tải lại run/version. Quyền và expectedVersion vẫn do API kiểm.
- Key pending chỉ giữ trong bộ nhớ trang. Đóng/reload trang có thể mất key: phải kiểm danh sách/history trước khi tạo lệnh thay thế, không chứng nhận dedup xuyên reload.
- Upload file là API bootstrap chưa idempotent; khi timeout kiểm kết quả trước khi upload lại. Tệp error/rejected không dùng cho workflow.
- Phiên bridge tối đa khoảng 5 phút. Hết phiên ngắt thao tác, dữ liệu riêng bị dọn theo trạng thái kết nối; kết nối lại để tiếp tục run đã lưu.
- Giao diện create/upload vẫn có thể xuất hiện với người thiếu role; API trả 403. Các nút chuyển bước được lọc bằng availableTransitions. Chưa thay thế bằng role directory UI tổng quát.

## Runtime và bảo toàn dữ liệu

- Core API/Gateway được cập nhật từ worktree tích hợp, giữ postgres/keycloak/clamav volume. Compose project name vẫn lattice-dx.
- NocoBase chạy từ D:/AI/OSS/nocobase_test/docker-compose.yml, image/database/storage cũ. Chỉ đổi mount Action Bridge sang worktree tích hợp, không bật Compose NocoBase 2.2.20 trong repo.
- Trước deploy đã sao lưu ba database và compose NocoBase vào output/backups trong worktree; các file này không commit vì chứa dữ liệu/cấu hình nhạy cảm.
- Backup: lattice-pre-workflow-20261013.dump (8687 byte), keycloak-pre-workflow-20261013.dump (255517 byte), nocobase-pre-workflow-20261013.dump (273692 byte). Không xóa backup hoặc volume.
- API image trước deploy: sha256:9f66b28f32c83d6f3564f2a99d210138b848f8f80c66ec5ed0bd72bc0640b004. Giữ để rollback code khi cần.
- Sau schema/realm/membership seed, số hàng cũ vẫn 14 records / 9 tasks / 9 files. Sau hai lần UI smoke: 16 / 9 / 11, tăng đúng 2 record workflow + 2 evidence files. Không reset hoặc sửa dòng cũ.
- Worker outbox tắt: WORKFLOW_EVENT_URL và WORKFLOW_EVENT_TOKEN rỗng khi recreate API. Một event bàn giao được lưu pending/attempts 0, chưa gửi tới n8n/broker/hệ thống ngoài.

## Bằng chứng

- 23 Node tests Foundation/bridge PASS; 120 Vitest tests/12 file PASS; typecheck API và git diff --check PASS.
- Browser script scripts/smoke-lattice-procurement.cjs: Alice → Manager → Warehouse, tệp clean, nhận/nghiệm thu/bàn giao, Manager tải tệp chia sẻ và đối chiếu bytes; không pageerror.
- Run PASS 5627f345-65e8-4b50-a654-6a2a1ead1801; file 5315e247-efc7-4f18-a5ae-1b89ea1cf6ec. SQL có audit create/submit/approve/receive/accept/handover version 1–6; event pending/0.
- Bob org-b đọc run và tệp trên đều 404 trên API thật.
- Lần smoke đầu dừng ở select label chưa có tên truy cập rõ; đã thêm aria-label. Run 4a2cbcde-bacc-4bf7-bdb1-de73bf7de140 giữ accepted/version 5 để kiểm tra, không xóa/ép thành PASS.
- Hình output/lattice-procurement-workflow.png là artifact local, không thuộc source Git.

## Còn thiếu / ngoài phạm vi

- Order/Shipment logistics, UI onboarding, directory và individual assignment, chia sẻ record/task cũ, list/pagination server, designer và connector n8n/NGSI-LD thật.
- Department/Location dùng registry workflow bootstrap của API, chưa đồng bộ với collection nền NocoBase. assetId là mã nhập trong bước bàn giao; chưa có thao tác cập nhật tài sản NocoBase hoặc inventory/ERP thực tế.
- Reject là nhánh có nút/API và unit tests, chưa có phép browser end-to-end reject riêng trong lượt deploy này.
- Chưa bật event delivery hoặc chứng nhận production/SSO. Chưa tự thay main, push code hay merge PR trên GitHub.

Rollback ưu tiên quay về API image/source và plugin Foundation 0.6.0, mount bridge cũ và compose đã backup; giữ nguyên tất cả table/data. Không tự restore dump đè dữ liệu mới hoặc xóa workflow tables. Việc restore database chỉ làm theo quyết định riêng nếu thật sự cần.

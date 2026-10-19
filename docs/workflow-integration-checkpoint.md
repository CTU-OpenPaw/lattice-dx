# Checkpoint tích hợp workflow — chỉ code

Ngày 2026-10-13. Nhánh feat/nocobase-workflow-integration kết hợp checkpoint plugin b71e500cf76157b5ee7ba98395a55fbb73c13a87 và PR #5 của Duy, head 06797e0abb401ae018ea7caf367d1f74a807020d.

## Đã làm

- Tạo worktree riêng D:/AI/OSS/LatticeOSS-workflow-integration; không switch/reset/stash thư mục gốc D:/AI/OSS/LatticeOSS.
- Merge lịch sử PR vào nhánh tích hợp, không copy code thủ công; không phát sinh conflict. Script test:nocobase:form được giữ cùng hai script workflow mới.
- Source plugins/nocobase giữ nguyên so với b71e500; các block, bridge file/list, Workspace và test hồi quy không bị thay thế.
- Cài dependency theo frozen lockfile và ignore-scripts trong worktree riêng; không sửa lockfile để qua gate.
- Build Foundation/Action Bridge PASS; 20 Node tests plugin/bridge PASS.
- 120 Vitest tests/12 file PASS khi chạy tuần tự --maxWorkers=1, giữ timeout mặc định 5 giây và assertion. Lần chạy đầu cùng lúc build web có 6 timeout; không sửa code hoặc tăng timeout để bỏ qua.
- Chạy lại song song sau khi build hoàn tất: 120/120 PASS, timeout mặc định vẫn giữ nguyên. Chưa chứng nhận chạy test/build đồng thời ổn định trên mọi mức tải máy.
- Typecheck contracts/API/agent-worker/logistics và web PASS. Build API/agent-worker/web PASS. Kiểm Compose core/nocobase bằng config --quiet PASS.
- CLI pnpm wrapper của máy cố chạy lại install với môi trường khác và bị no-TTY; các gate được gọi trực tiếp từ executable đã cài. Không tuyên bố pnpm check literal PASS; ghi rõ các gate tương đương đã chạy.

## Chưa làm trong checkpoint này

- Chưa push nhánh, chưa merge PR #5 trên GitHub, chưa sửa main.
- Chưa recreate/start/restart container, sync realm, seed workflow, chạy migration database hoặc worker outbox; runtime và dữ liệu hiện tại giữ nguyên.
- Chưa gọi smoke-workflows lên dịch vụ đang chạy; kết quả local hiện tại chỉ xác nhận tích hợp source, unit tests và build, không phải workflow UI/database end-to-end.
- Bridge hiện chưa có proxy workflow endpoints. Workspace/block chưa dựng form/run/inbox/transition/history từ API workflow mới.
- API mới có procurement/onboarding; không có definition Order/Shipment logistics. Membership recipientId chỉ áp dụng workflow, không sửa task assigneeId cũ. Shared file chỉ áp dụng tệp đã liên kết và policy workflow, không tự mở quyền mọi record/tệp cũ.

## Bước tiếp theo cần xác nhận

Trình bày phạm vi triển khai API và nối UI workflow mua sắm. Chốt runtime NocoBase 2.2.22 đang dùng (không tự khởi động Compose NocoBase 2.2.20 tạo database khác), bảo toàn database/storage và dữ liệu thử hiện có. Giữ worker outbox tắt khi chưa có receiver được duyệt. Chỉ sau triển khai mới chạy smoke database/UI mới và cập nhật nghiệm thu.

## Lệnh đối chiếu

```powershell
git log -1 --format='%h %p %s'
node plugins/nocobase/action-bridge/build.mjs
node plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs
node --test plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs plugins/nocobase/action-bridge/tests/*.test.cjs
node node_modules/vitest/vitest.mjs run --maxWorkers=1
# Typecheck/build gọi trực tiếp node_modules/typescript/bin/tsc với tsconfig tương ứng.
# Web: next typegen, tsc --noEmit, next build (trong apps/web).
docker compose -f infra/compose/core.yml config --quiet
docker compose -f infra/compose/nocobase.yml config --quiet
```

Các thư mục node_modules/dist/.next là build output bị Git bỏ qua. .env runtime, backup, log, secret và thư mục output/reports/tmp ở checkout gốc không được đưa vào nhánh tích hợp.

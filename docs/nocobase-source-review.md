# NocoBase: bản nguồn khảo sát

Ngày kiểm tra: 2026-10-06.

Cập nhật runtime 2026-10-11: thêm `infra/compose/nocobase.yml` chạy image chính thức 2.2.20 với digest khóa. Version server trong container xác nhận 2.2.20; smoke API/frontend đạt. Submodule vẫn giữ nguyên commit, không cài dependency/sửa source. Runtime là dịch vụ riêng, chưa SSO Keycloak hoặc plugin của nhóm. Các nhận xét giấy phép dưới đây vẫn là giới hạn cần xử lý, không được coi là chứng nhận tuân thủ dự thi.

Cập nhật runtime 2026-11-18: cả `infra/compose/nocobase.yml` và `infra/compose/native-rehearsal.yml` đã nâng cấp và khóa digest cố định tại `nocobase/nocobase:2.2.38@sha256:90028473fe54b1fd1929b1ab0669a12e48a9a8f100d41662c98bc3c618225f4e`, chạy cùng `postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50`. Ba plugin của nhóm (`@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-enterprise-auth`, `@latticedx/plugin-action-bridge`) khai báo `"license": "Apache-2.0"` và `"sdkProvidedByHost": true`, gọi host SDK qua runtime mount read-only, không chỉnh sửa mã nguồn upstream và giữ nguyên thông báo bản quyền giao diện theo Điều 5.2 (`Powered by NocoBase`, phiên bản `v2.2.38`, `License settings` dẫn tới `nocobase.com`). Submodule `upstream/nocobase` không được đóng gói vào gói phát hành nguồn (`pnpm release:tarball`).

- Nguồn: https://github.com/nocobase/nocobase.git
- Commit: `5b47bec116c52239348c09d360e4bd2649c99efc` trên nhánh `main` tại thời điểm clone.
- Bản nguồn: `upstream/nocobase/`, được đăng ký làm Git submodule của dự án chính và khóa tại commit trên.
- Clone bằng `git clone --filter=blob:none`: giữ lịch sử Git, tải blob bổ sung khi cần.
- Working tree upstream sạch sau clone; chưa sửa source, cài dependencies hoặc chạy NocoBase.

## Phân biệt vị trí

`upstream/nocobase/` là toàn bộ nền tảng lấy từ upstream để đọc và khảo sát. `plugins/nocobase/` dành cho plugin nhóm viết theo SDK của NocoBase. Cấu hình chạy dịch vụ đặt trong `infra/compose/nocobase.yml` và `infra/compose/native-rehearsal.yml`.

## Kết quả kiểm tra giấy phép ban đầu

`package.json` khai báo Apache-2.0 và có `LICENSE-APACHE.txt`. Tuy nhiên `LICENSE.txt` ghi ngày cập nhật 24/02/2026, điều 4.2 yêu cầu tuân thủ các điều khoản bổ sung và ưu tiên chúng khi có khác biệt với Apache-2.0. Điều 5.4 hạn chế cung cấp công khai SaaS/PaaS dạng no-code, low-code hoặc nền tảng AI. Điều 5.2 hạn chế thay đổi thông tin thương hiệu trên giao diện.

Header `packages/core/server/src/application.ts` lại ghi AGPL-3.0 và NocoBase Commercial License. Chưa xác định phạm vi và cách giải quyết khác biệt giữa các thông báo này.

Không kết luận toàn bộ checkout là Apache-2.0 thuần hoặc đủ điều kiện dự thi. Thể lệ yêu cầu giấy phép OSI-approved; các hạn chế lĩnh vực sử dụng cần được đối chiếu với Open Source Definition. Đây là kiểm tra ban đầu, không phải kiểm toán toàn bộ file/plugin/dependency.

Nguồn đối chiếu:
- https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html
- https://opensource.org/osd

Giữ nguyên LICENSE, header bản quyền và lịch sử upstream. Giấy phép Apache-2.0 của mã nhóm không thay thế giấy phép upstream. Submodule giúp tải đúng bản nguồn cùng dự án; chưa đưa checkout vào workspace pnpm, build hoặc runtime. Cách tổ chức bằng submodule tách biệt rõ ranh giới giữa mã Apache-2.0 của nhóm (đóng gói qua `pnpm release:tarball`) và host runtime NocoBase 2.2.38.

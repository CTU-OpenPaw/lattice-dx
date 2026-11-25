# NocoBase: đánh giá giấy phép và ranh giới host runtime

Ngày kiểm tra ban đầu: 2026-10-06.

Cập nhật PoF `v0.4.0` (2026-11-26): Theo phán quyết tuân thủ OSI của BTC OLP PMNM 2026, kho mã nguồn Git chính thức của LatticeDX (`https://github.com/CTU-OpenPaw/lattice-dx`) và gói phát hành nguồn `latticedx-0.4.0-src.tar.gz` **đã gỡ bỏ hoàn toàn Git submodule `upstream/nocobase` và tệp `.gitmodules`**. **100% mã nguồn trong kho Git là thuần chuẩn OSI** (mã gốc `Apache-2.0` của nhóm + dependency npm chuẩn OSI). Host runtime `nocobase/nocobase:2.2.50@sha256:04b75164936e7314ef74d82844bc56c9f34ed7ff1ca976ca53ffac2d3c88d777` chỉ được nạp **độc lập lúc chạy (runtime)** dưới dạng **OCI container bên ngoài kho Git** — không lưu, không sửa và không đóng gói mã nguồn NocoBase vào kho Git hay gói `.tar.gz`.

Cập nhật runtime 2026-11-22 (`v0.3.0` -> `v0.4.0`): `infra/compose/nocobase.yml`, `infra/compose/native-rehearsal.yml` và `infra/compose/prod.yml` đều khóa digest cố định tại `nocobase/nocobase:2.2.50@sha256:04b75164936e7314ef74d82844bc56c9f34ed7ff1ca976ca53ffac2d3c88d777`, chạy cùng `pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337` (hoặc `postgres:16.16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d`). Bảy plugin của nhóm (`@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-enterprise-auth`, `@latticedx/plugin-action-bridge`, `@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-blocks`, `@latticedx/plugin-dxos-studio`, `@latticedx/plugin-dxos-ai`) đều khai báo `"license": "Apache-2.0"`, `"testedRuntime": "2.2.50"` và `"sdkProvidedByHost": true`, gọi host SDK qua runtime mount read-only, không chỉnh sửa mã nguồn upstream và giữ nguyên thông báo bản quyền giao diện theo Điều 5.2 (`Powered by NocoBase`, phiên bản `v2.2.50`, `https://www.nocobase.com`, `License settings`).

Thông tin bản nguồn tham chiếu lúc khảo sát ban đầu (2026-10-06, đã gỡ khỏi kho Git từ `v0.4.0`):
- Nguồn: https://github.com/nocobase/nocobase.git
- Commit tham chiếu khảo sát: `5b47bec116c52239348c09d360e4bd2649c99efc` trên nhánh `main`.
- Ghi nhận lịch sử: trước `v0.4.0`, bản nguồn từng được gắn tạm dưới dạng submodule chỉ-đọc `upstream/nocobase/` để khảo sát và chưa từng sửa source hay đưa vào workspace pnpm / `pnpm release:tarball`. Do kết quả rà soát giấy phép bên dưới, từ `v0.4.0` toàn bộ tham chiếu submodule và `.gitmodules` đã bị xóa khỏi cây Git (`pnpm pof:check` kiểm tra tự động `upstream-clean`).

## Phân biệt vị trí

Kho Git LatticeDX không chứa `upstream/nocobase/` hay `.gitmodules`. Thư mục `plugins/nocobase/` chỉ chứa 7 plugin gốc `Apache-2.0` do nhóm CTU-OpenPaw viết theo hợp đồng SDK host (`"sdkProvidedByHost": true`). Cấu hình nạp container host NocoBase `2.2.50` bên ngoài đặt trong `infra/compose/nocobase.yml`, `infra/compose/native-rehearsal.yml` và `infra/compose/prod.yml`.

## Kết quả kiểm tra giấy phép upstream (cơ sở tách ranh giới Git/Container)

`package.json` của upstream khai báo Apache-2.0 và có `LICENSE-APACHE.txt`. Tuy nhiên `LICENSE.txt` ghi ngày cập nhật 24/02/2026, điều 4.2 yêu cầu tuân thủ các điều khoản bổ sung và ưu tiên chúng khi có khác biệt với Apache-2.0. Điều 5.4 hạn chế cung cấp công khai SaaS/PaaS dạng no-code, low-code hoặc nền tảng AI. Điều 5.2 hạn chế thay đổi thông tin thương hiệu trên giao diện.

Header `packages/core/server/src/application.ts` của upstream lại ghi AGPL-3.0 và NocoBase Commercial License.

Vì những ràng buộc ngoài chuẩn OSI này của mã nguồn upstream, LatticeDX không giữ bất kỳ bản sao hay submodule `upstream/nocobase/` nào trong kho mã nguồn Git hoặc gói phát hành `latticedx-0.4.0-src.tar.gz`, chỉ tách hoàn toàn thành dịch vụ runtime container OCI bên ngoài và giữ nguyên nhận diện Điều 5.2 trên giao diện host.

Nguồn đối chiếu:
- https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html
- https://opensource.org/osd

Giữ nguyên ranh giới bản quyền: giấy phép Apache-2.0 của mã nguồn LatticeDX (`apps/`, `packages/`, `plugins/nocobase/`, `scripts/`, `infra/`, `solutions/`, `tests/`) không thay thế giấy phép của host container NocoBase `2.2.50`, và gói phát hành nguồn (`pnpm release:tarball`) chỉ đóng gói mã thuần OSI của LatticeDX.

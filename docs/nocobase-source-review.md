# NocoBase: bản nguồn khảo sát

Ngày kiểm tra: 2026-10-06.

- Nguồn: https://github.com/nocobase/nocobase.git
- Commit: `5b47bec116c52239348c09d360e4bd2649c99efc` trên nhánh `main` tại thời điểm clone.
- Bản nguồn: `upstream/nocobase/`, được đăng ký làm Git submodule của dự án chính và khóa tại commit trên.
- Clone bằng `git clone --filter=blob:none`: giữ lịch sử Git, tải blob bổ sung khi cần.
- Working tree upstream sạch sau clone; chưa sửa source, cài dependencies hoặc chạy NocoBase.

## Phân biệt vị trí

`upstream/nocobase/` là toàn bộ nền tảng lấy từ upstream để đọc và khảo sát. `plugins/nocobase/` dành cho plugin nhóm viết theo SDK của NocoBase. Cấu hình chạy dịch vụ sẽ đặt trong `infra/` khi tích hợp.

## Kết quả kiểm tra giấy phép ban đầu

`package.json` khai báo Apache-2.0 và có `LICENSE-APACHE.txt`. Tuy nhiên `LICENSE.txt` ghi ngày cập nhật 24/02/2026, điều 4.2 yêu cầu tuân thủ các điều khoản bổ sung và ưu tiên chúng khi có khác biệt với Apache-2.0. Điều 5.4 hạn chế cung cấp công khai SaaS/PaaS dạng no-code, low-code hoặc nền tảng AI. Điều 5.2 hạn chế thay đổi thông tin thương hiệu trên giao diện.

Header `packages/core/server/src/application.ts` lại ghi AGPL-3.0 và NocoBase Commercial License. Chưa xác định phạm vi và cách giải quyết khác biệt giữa các thông báo này.

Không kết luận toàn bộ checkout là Apache-2.0 thuần hoặc đủ điều kiện dự thi. Thể lệ yêu cầu giấy phép OSI-approved; các hạn chế lĩnh vực sử dụng cần được đối chiếu với Open Source Definition. Đây là kiểm tra ban đầu, không phải kiểm toán toàn bộ file/plugin/dependency.

Nguồn đối chiếu:
- https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html
- https://opensource.org/osd

Giữ nguyên LICENSE, header bản quyền và lịch sử upstream. Giấy phép Apache-2.0 của mã nhóm không thay thế giấy phép upstream. Submodule giúp tải đúng bản nguồn cùng dự án; chưa đưa checkout vào workspace pnpm, build hoặc runtime. Cách tổ chức bằng submodule không tự giải quyết nghĩa vụ cấp phép hay xác nhận đủ điều kiện dự thi.

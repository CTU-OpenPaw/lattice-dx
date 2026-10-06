# Contributing

Dùng Node.js 24, pnpm 10.23.0. Chạy `pnpm install --frozen-lockfile` rồi `pnpm check` trước khi gửi thay đổi. Sửa core deployment thì kiểm tra Compose config và chạy `pnpm test:infra` với Docker.

Đặt server độc lập vào apps, thư viện tái sử dụng vào packages và extension nền tảng vào plugins. Kiểm thử hành vi mới; không import source app khác trong production. Chỉ dùng public exports của package và API giữa dịch vụ.

Thêm SPDX Apache-2.0 cho mã gốc hỗ trợ comment; định dạng JSON giữ license theo manifest hoặc tài liệu nguồn tương ứng. Không thay header/license upstream. Không commit `.env`, token, dữ liệu thật hoặc checkout `upstream/`.

Khi repo GitHub được tạo, dùng Issues để ghi lỗi và Pull Requests để review. Hiện chưa có remote được cấu hình.

# Contributing

Tài liệu hướng dẫn đóng góp mã nguồn cho **LatticeDX** (`https://github.com/CTU-OpenPaw/lattice-dx`), phát hành theo giấy phép **Apache-2.0**.

## 1. Môi trường phát triển
- Yêu cầu **Node.js 24** (`>=24 <25`), **pnpm 10.23.0**, **Git**, **tar** và **Docker Compose v2+** (khi kiểm tra stack container).
- Clone và cài đặt đúng lockfile:

```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
pnpm install --frozen-lockfile
```

- Chi tiết quy trình build từ nguồn xem tại [hướng dẫn build từ mã nguồn](docs/build-from-source.md).

## 2. Quy ước cấu trúc & Chất lượng mã
- Đặt server độc lập vào `apps/`, thư viện dùng chung vào `packages/` và extension NocoBase vào `plugins/nocobase/`.
- Giữ tệp mã nguồn gọn, phân tách trách nhiệm rõ ràng (**khuyến nghị dưới 300 dòng/tệp** cho mã mới).
- Không import trực tiếp mã nội bộ của app khác trong production; giao tiếp qua public exports của `@dx/contracts` hoặc HTTP/REST API.
- Bắt buộc gắn header `SPDX-License-Identifier: Apache-2.0` theo chuẩn CTU-OpenPaw cho mọi tệp mã nguồn gốc có hỗ trợ comment (`.ts`, `.tsx`, `.js`, `.jsx`, `.cjs`, `.mjs`, `.yml`, `Dockerfile`). Không chỉnh sửa tệp tự sinh `apps/web/next-env.d.ts` và tuyệt đối **không sửa mã hay license trong `upstream/nocobase/`**.
- Không thêm dependency mới khi chưa kiểm tra tương thích giấy phép và cập nhật `docs/dependency-inventory.md` + `NOTICE`.
- Không commit `.env`, token, khóa bí mật (`*.pem`, `*.key`), dữ liệu thật hoặc bản build/checkout lọt vào `upstream/`.

## 3. Theo dõi lỗi & Quy trình Pull Request
- Kho mã chính thức: **https://github.com/CTU-OpenPaw/lattice-dx**
- Báo lỗi hoặc đề xuất tính năng qua **GitHub Issues** bằng các biểu mẫu có sẵn trong `.github/ISSUE_TEMPLATE/`:
  - [Báo lỗi (`bug_report.yml`)](.github/ISSUE_TEMPLATE/bug_report.yml)
  - [Đề xuất tính năng (`feature_request.yml`)](.github/ISSUE_TEMPLATE/feature_request.yml)
- Sử dụng Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`) và mở Pull Request nhắm vào nhánh đích phù hợp.

## 4. Checklist bắt buộc trước khi gửi PR
1. Chạy `pnpm check` (`typecheck`, `vitest`, `build`) — tất cả phải đạt.
2. Chạy `pnpm pof:check` để xác minh SPDX headers, cấu trúc giấy phép/NOTICE, cô lập plugin và khóa digest `@sha256:` của Compose.
3. Nếu sửa plugin NocoBase hoặc scripts PoF/demo, chạy `node --test plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs plugins/nocobase/action-bridge/tests/*.test.cjs plugins/nocobase/plugin-enterprise-auth/tests/*.test.cjs scripts/tests/*.test.mjs`.
4. Nếu sửa `infra/compose/*.yml`, kiểm tra lại mọi image mới đều pin `@sha256:` và xác thực bằng `docker compose -f <file> config --quiet` cùng `pnpm test:infra` khi Docker sẵn sàng.
5. Tự rà soát `git diff` để bảo đảm không còn `TODO` chưa giải quyết, log debug hoặc thông tin nhạy cảm.

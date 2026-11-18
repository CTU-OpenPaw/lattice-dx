# Báo cáo tự kiểm toán PoF — OLP PMNM 2026 (VFOSSA)

Tài liệu đối chiếu **6 nhóm tiêu chí Proof of Freedom (PoF — 50 điểm)** theo [Thể lệ OLP PMNM 2026 (VFOSSA)](https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html) với bằng chứng xác thực trong kho mã `CTU-OpenPaw/lattice-dx`.

## 1. Bảng đối chiếu 6 nhóm PoF (50 điểm)

| # | Nhóm tiêu chí PoF | Trạng thái repo | Bằng chứng xác thực trong kho mã |
| --- | --- | --- | --- |
| **1** | **Giấy phép OSI, `NOTICE` & SPDX Headers** | Sẵn sàng | Toàn văn `Apache-2.0` tại [`LICENSE`](../LICENSE) và 3 tệp `plugins/nocobase/*/LICENSE`. Tệp [`NOTICE`](../NOTICE) theo Apache-2.0 §4(d) phân tách 4 phạm vi giấy phép (first-party Apache-2.0, NocoBase host/submodule, dịch vụ container độc lập, dependency MIT đóng gói). Toàn bộ tệp nguồn do nhóm viết gắn `SPDX-License-Identifier: Apache-2.0` (đã bổ sung 31 tệp `apps/api/src/**/*.test.ts` + `tests/workspace-install.test.ts`; loại trừ sạch tệp tự sinh `apps/web/next-env.d.ts` và `upstream/`). |
| **2** | **Tách bạch mã nguồn thứ ba & Ranh giới NocoBase** | Sẵn sàng sau hợp nhất nhánh UI | Submodule `upstream/nocobase` giữ nguyên commit `5b47bec116c52239348c09d360e4bd2649c99efc`, không đưa vào Vitest, Docker build API hay gói phát hành `.tar.gz`. Ba plugin trong `plugins/nocobase/` khai báo `"license": "Apache-2.0"` và `"sdkProvidedByHost": true`; giữ nguyên attribution NocoBase Clause 5.2 (`Powered by NocoBase`, `v2.2.38`, `License settings`, `nocobase.com`). Chi tiết xem [nocobase-source-review.md](nocobase-source-review.md). |
| **3** | **Khóa phụ thuộc & Digest Container (`@sha256:`)** | Sẵn sàng | Phụ thuộc npm khóa bằng `pnpm-lock.yaml` và `plugins/nocobase/plugin-enterprise-auth/package-lock.json`; kiểm kê `123` nhóm package tại [dependency-inventory.md](dependency-inventory.md) (`2026-11-18`). Toàn bộ image trong `infra/compose/core.yml`, `infra/compose/nocobase.yml`, `infra/compose/native-rehearsal.yml` và `infra/compose/integration.yml` đều khóa digest `@sha256:`, đã xác thực bằng `docker compose -f <file> config --quiet`. |
| **4** | **Tài liệu Build từ mã nguồn & Cài đặt sạch** | Sẵn sàng | [`README.md`](../README.md) liên kết trực tiếp tới [build-from-source.md](build-from-source.md) (hướng dẫn từ `.tar.gz` hoặc `git clone`, toolchain OSS 100% Node 24 + pnpm 10.23.0, zero chỉnh sửa thủ công) và [native-clean-install.md](native-clean-install.md) (`pnpm native:clean` dựng từ `HEAD` lên DB trống). |
| **5** | **Quản trị cộng đồng, Issue Tracking & Bảo mật** | Sẵn sàng | [`CONTRIBUTING.md`](../CONTRIBUTING.md) gắn remote `https://github.com/CTU-OpenPaw/lattice-dx`, quy trình PR, kiểm tra PoF và chuẩn code. [`CHANGELOG.md`](../CHANGELOG.md) ghi đủ lịch sử từ `2026-10-06` đến `2026-11-18`. [`SECURITY.md`](../SECURITY.md) cảnh báo rõ fixture mật khẩu local và hướng dẫn báo cáo qua GitHub Security Advisories. Biểu mẫu [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) gồm `config.yml`, `bug_report.yml`, `feature_request.yml`. |
| **6** | **Kiểm toán PoF tự động, CI & Phát hành `.tar.gz`** | Sẵn sàng | Lệnh `pnpm pof:check` (`scripts/verify-pof-readiness.mjs`) kiểm tra tự động 6 hạng mục PoF; `pnpm release:tarball` (`scripts/build-oss-release-tarball.mjs`) đóng gói `output/release/latticedx-<version>-src.tar.gz` + `.sha256` từ `git archive` (không kèm `node_modules/`, `output/`, `.env`, `.git/` hay mã nguồn `upstream/nocobase/`). Kiểm thử đơn vị tại `scripts/tests/oss-pof-audit.test.mjs`; CI chạy tại [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). |

## 2. Các bước kiểm tra tự động trước phát hành

```sh
pnpm check
pnpm pof:check
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:tarball
```

## 3. Ba thao tác thủ công bắt buộc trước khi nộp bài

Các thao tác sau cần quyền quản trị viên kho GitHub `CTU-OpenPaw/lattice-dx` và phải thực hiện thủ công trước hạn nộp:

1. **Chuyển kho `CTU-OpenPaw/lattice-dx` sang Public** trước mốc **2026-12-06 17:00** (giờ Việt Nam) để Ban Giám khảo VFOSSA truy cập trực tiếp mã nguồn, lịch sử commit và release.
2. **Mở các GitHub Issues khởi tạo (Bug / Task)** trực tiếp trên `https://github.com/CTU-OpenPaw/lattice-dx/issues` bằng biểu mẫu `.github/ISSUE_TEMPLATE/` để minh chứng quy trình theo dõi lỗi thực tế.
3. **Tạo GitHub Release gắn tag annotated `v0.1.0`** và đính kèm bộ tệp nguồn do `pnpm release:tarball` sinh ra (`latticedx-0.1.0-src.tar.gz` và `latticedx-0.1.0-src.tar.gz.sha256`).

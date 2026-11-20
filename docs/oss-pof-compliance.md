# Checklist nguồn mở — OLP PMNM 2026

Sáu mục dưới đây theo bảng PoF (50 điểm) của [thể lệ VFOSSA](https://www.vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html). Kiểm tra trên đúng commit phát hành. Hạn nộp là 17:00 ngày 06/12/2026 theo [đề thi](https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html).

| Tiêu chí | Bằng chứng cần đối chiếu trên bản nộp |
| --- | --- |
| 1. Kho mã công khai (5) | Mở repo, source, lịch sử commit và trang release bằng phiên không đăng nhập. |
| 2. Giấy phép OSI-approved (10) | Có toàn văn [LICENSE](../LICENSE), header SPDX của mã nhóm và [NOTICE](../NOTICE). Kiểm tra các license đi kèm, phạm vi sử dụng và điều khoản của NocoBase theo [hồ sơ nguồn](nocobase-source-review.md). |
| 3. Phát hành (5) | Tạo GitHub Release cho tag phiên bản trên commit đã nghiệm thu trước hạn nộp. Đính kèm gói nguồn `.tar.gz` và checksum. |
| 4. Build từ source (10) | Làm theo [hướng dẫn build](build-from-source.md) từ gói đã giải nén trên môi trường sạch. Kiểm tra cấu hình trước build, công cụ build, cài đặt và chạy từ thư mục triển khai, sau đó chạy các luồng nghiệm thu. |
| 5. Thư viện và gói đi kèm (10) | Đối chiếu [kiểm kê phụ thuộc](dependency-inventory.md), lockfile, Compose và [thông tin bên thứ ba](third-party.md) với nội dung gói nguồn. Kiểm tra license, notice, các dependency do hệ thống cung cấp và nguồn upstream được lấy riêng. |
| 6. Tài liệu và giao tiếp (10) | [README](../README.md), [CHANGELOG](../CHANGELOG.md), hướng dẫn cài/vận hành, [CONTRIBUTING](../CONTRIBUTING.md) và issue tracker có ghi nhận lỗi hoặc đầu việc thực tế. |

## Trước khi phát hành v0.1.0

1. Sau review và hợp nhất, chọn commit từ bản tích hợp, chạy CI và nghiệm thu trên bản cài sạch. Lưu kết quả thử theo vai trò, cấu hình cần thiết và giới hạn đã biết.
2. Đồng bộ phiên bản trong manifest dự án, changelog, tag và tên gói phát hành. Ở thời điểm phát hành, đổi mục `[Unreleased]` thành `[0.1.0] — YYYY-MM-DD` theo ngày thực tế.
3. Chạy `pnpm check`, `pnpm pof:check` và `node --test scripts/tests/oss-pof-audit.test.mjs`. Sinh gói bằng `pnpm release:tarball --ref=v0.1.0`; kiểm tra checksum, danh sách tệp và làm lại phép build/cài sạch từ gói. Gói source loại trừ `node_modules/`, `output/`, tệp cấu hình chứa secret và mã nguồn trong submodule NocoBase.
4. Rà secrets và dữ liệu private trong lịch sử Git, thống nhất công khai repo với nhóm, rồi kiểm tra repo và release bằng phiên không đăng nhập. Ghi nhận đầu việc thực tế trên Issues và lưu link release vào hồ sơ nộp.

`pnpm pof:check` kiểm tra một số điều kiện trong cây mã. Hồ sơ PoF cần thêm bằng chứng truy cập công khai, phát hành, cài/chạy từ gói và review giấy phép trên commit đã chọn.

# Checklist nguồn mở — OLP PMNM 2026

Sáu mục dưới đây theo bảng PoF (50 điểm) của [thể lệ VFOSSA](https://www.vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html). Kiểm tra trên đúng commit phát hành. Hạn nộp là 17:00 ngày 06/12/2026 theo [đề thi](https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html).

| Tiêu chí | Bằng chứng cần đối chiếu trên bản nộp |
| --- | --- |
| 1. Kho mã công khai (5) | Mở repo, source, lịch sử commit và trang release bằng phiên không đăng nhập. |
| 2. Giấy phép OSI-approved (10) | Có toàn văn [LICENSE](../LICENSE), [`COPYRIGHT.txt`](../COPYRIGHT.txt), header `@copyright` + SPDX Apache-2.0 của mã nhóm và [NOTICE](../NOTICE). Kiểm tra các license đi kèm, phạm vi sử dụng và điều khoản của NocoBase theo [hồ sơ nguồn](nocobase-source-review.md). |
| 3. Phát hành (5) | Tạo GitHub Release cho tag phiên bản trên commit đã nghiệm thu trước hạn nộp. Đính kèm gói nguồn `.tar.gz` và checksum. |
| 4. Build từ source (10) | Làm theo [hướng dẫn build](build-from-source.md) từ gói đã giải nén trên môi trường sạch và kịch bản [DEMO_PACK.md](DEMO_PACK.md). Kiểm tra cấu hình trước build, công cụ build, cài đặt 7 plugin từ thư mục triển khai và chạy các luồng nghiệm thu. |
| 5. Thư viện và gói đi kèm (10) | Đối chiếu [`COPYRIGHT.txt`](../COPYRIGHT.txt), [kiểm kê phụ thuộc](dependency-inventory.md), lockfile, Compose và [thông tin bên thứ ba](third-party.md) với nội dung gói nguồn. Kiểm tra `LICENSE` + `README.md` của từng plugin, dependency do hệ thống cung cấp và nguồn upstream được lấy riêng. |
| 6. Tài liệu và giao tiếp (10) | [README](../README.md), [CHANGELOG](../CHANGELOG.md), [DEMO_PACK](DEMO_PACK.md), hướng dẫn cài/vận hành, [CONTRIBUTING](../CONTRIBUTING.md) và issue tracker có ghi nhận lỗi hoặc đầu việc thực tế. |

## Cam kết Thuần khiết Giấy phép OSS (OSS License Purity Guarantee)

Mọi thành phần mới bổ sung từ nhánh `v0.3.0` trở đi tuân thủ nguyên tắc **không đưa phần mềm cấp phép BSL-1.1 / source-available độc quyền** vào kiến trúc dữ liệu, IIoT hay quan sát hệ thống:
- **Loại bỏ ThingsBoard & EMQX (BSL-1.1 / bản doanh nghiệp giới hạn):** Không sử dụng ThingsBoard hay EMQX để tránh rủi ro hạn chế thương mại hóa/phân phối nguồn mở theo BSL-1.1.
- **Thay thế 100% bằng thành phần chuẩn OSI:**
  - **Eclipse Mosquitto 2.0.21 (`EPL-2.0`)** cho broker MQTT biên nội bộ (`infra/compose/iiot.yml`).
  - **Node-RED 4.0.9 (`Apache-2.0`)** cho chuẩn hóa bản tin IIoT & định tuyến vào `dxosBlocks:telemetryIngest`.
  - **TimescaleDB OSS (`2.19.3-pg16-oss`, `Apache-2.0`)** cho kho chuỗi thời gian IIoT (chỉ dùng bản `-oss`, loại bỏ thành phần TSL).
  - **OpenTelemetry Collector & Prometheus (`Apache-2.0`)** cho chuẩn hóa telemetry & điểm đo `/api/dxos:metrics`.
  - **Gotenberg (`MIT`)** cho kết xuất tài liệu/PDF tách biên container nếu cần mở rộng.
- Bảo toàn tuyệt đối nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`) trên mọi giao diện portal và admin.

## Trước khi phát hành v0.3.0

1. Sau review và hợp nhất, chọn commit từ bản tích hợp, chạy CI và nghiệm thu trên bản cài sạch. Lưu kết quả thử theo vai trò, cấu hình cần thiết và giới hạn đã biết.
2. Đồng bộ phiên bản `0.3.0` trong manifest dự án, changelog, tag và tên gói phát hành (`latticedx-0.3.0-src.tar.gz`).
3. Chạy `pnpm check`, `pnpm pof:check` và `node --test scripts/tests/oss-pof-audit.test.mjs`. Sinh gói bằng `pnpm release:tarball --ref=v0.3.0`; kiểm tra checksum, danh sách tệp và làm lại phép build/cài sạch từ gói. Gói source loại trừ `node_modules/`, `output/`, tệp cấu hình chứa secret và mã nguồn trong submodule NocoBase.
4. Rà secrets và dữ liệu private trong lịch sử Git, thống nhất công khai repo với nhóm, rồi kiểm tra repo và release bằng phiên không đăng nhập. Ghi nhận đầu việc thực tế trên Issues và lưu link release vào hồ sơ nộp.

`pnpm pof:check` kiểm tra một số điều kiện trong cây mã. Hồ sơ PoF cần thêm bằng chứng truy cập công khai, phát hành, cài/chạy từ gói và review giấy phép trên commit đã chọn.

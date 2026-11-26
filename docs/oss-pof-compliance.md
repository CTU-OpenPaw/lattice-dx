# Checklist nguồn mở — OLP PMNM 2026 (`v0.4.2`)

Sáu mục dưới đây theo bảng PoF (50 điểm) của [thể lệ VFOSSA](https://www.vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html). Kiểm tra trên đúng commit phát hành **`v0.4.2`**. Hạn nộp là 17:00 ngày 06/12/2026 theo [đề thi](https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html).

| Tiêu chí | Bằng chứng cần đối chiếu trên bản nộp |
| --- | --- |
| 1. Kho mã công khai (5) | Mở repo `https://github.com/CTU-OpenPaw/lattice-dx`, source, lịch sử commit và trang release bằng phiên không đăng nhập. |
| 2. Giấy phép OSI-approved (10) | Có toàn văn [LICENSE](../LICENSE), [`COPYRIGHT.txt`](../COPYRIGHT.txt), header `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` của mã nhóm (`node scripts/source-headers.mjs --check`) và [NOTICE](../NOTICE). **100% kho Git (`https://github.com/CTU-OpenPaw/lattice-dx`) và gói `latticedx-0.4.2-src.tar.gz` chỉ chứa mã nguồn chuẩn OSI** (`Apache-2.0` + dependency npm chuẩn OSI), hoàn toàn không có submodule `upstream/nocobase` hay `.gitmodules`. Host NocoBase `2.2.50` chỉ nạp dưới dạng container OCI bên ngoài lúc chạy, bảo toàn `sdkProvidedByHost: true` và Điều 5.2 theo [hồ sơ nguồn](nocobase-source-review.md). |
| 3. Phát hành (5) | Tạo GitHub Release cho tag **`v0.4.2`** trên commit đã nghiệm thu trước hạn nộp. Đính kèm gói nguồn `latticedx-0.4.2-src.tar.gz`, tệp checksum `.sha256` và [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json). |
| 4. Build từ source (10) | Làm theo [hướng dẫn build](build-from-source.md) từ gói `latticedx-0.4.2-src.tar.gz` đã giải nén trên môi trường sạch (không có `.git/`), chạy `pnpm install --frozen-lockfile`, `pnpm check`, dựng bản sạch NocoBase `2.2.50` với 7 plugin `0.4.2`, nạp `pnpm seed:v100-showcase`, chạy `pnpm acceptance:headless-paas` và kịch bản [DEMO_PACK.md](DEMO_PACK.md) / [FINALS_15MIN_SCRIPT.md](FINALS_15MIN_SCRIPT.md). |
| 5. Thư viện và gói đi kèm (10) | Đối chiếu [`COPYRIGHT.txt`](../COPYRIGHT.txt), [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json) (`pnpm release:sbom` / `node scripts/generate-sbom.mjs --check` gồm `257` thành phần: `workspace=12, npm=226, oci=19`, `257/257` có giấy phép đã phân giải (`fsevents@2.3.3 = MIT`, `0` `NONE`); gồm `maplibre-gl@6.19.0` `BSD-3-Clause`, `@xyflow/react@12.12.1` `MIT`, `@dagrejs/dagre@3.1.3` `MIT`, `esbuild@0.28.2` `MIT`), [kiểm kê phụ thuộc](dependency-inventory.md), `pnpm-lock.yaml`, Compose (`@sha256:` toàn bộ `19` image) và [thông tin bên thứ ba](third-party.md). Kiểm tra `LICENSE` + `README.md` của từng plugin trong 7 plugin `plugins/nocobase/*`. |
| 6. Tài liệu và giao tiếp (10) | [README](../README.md), [CHANGELOG](../CHANGELOG.md), [DEMO_PACK](DEMO_PACK.md), [ma trận kiến trúc 1-1 OLP 2026](olp-2026-architecture-matrix.md), [kịch bản Chung kết 15 phút](FINALS_15MIN_SCRIPT.md), hướng dẫn cài/vận hành, [CONTRIBUTING](../CONTRIBUTING.md) và issue tracker có ghi nhận lỗi hoặc đầu việc thực tế. |

## Cam kết Thuần khiết Giấy phép OSS (OSS License Purity Guarantee)

Mọi thành phần từ nhánh `v0.3.0` đến bản phát hành **`v0.4.2`** tuân thủ nguyên tắc **không đưa phần mềm cấp phép BSL-1.1 / Business Source License độc quyền** vào kiến trúc dữ liệu, IIoT hay quan sát hệ thống:
- **Loại bỏ ThingsBoard & EMQX (BSL-1.1 / bản doanh nghiệp giới hạn):** Không sử dụng ThingsBoard hay EMQX để tránh rủi ro hạn chế thương mại hóa/phân phối nguồn mở theo BSL-1.1. Quy trình sinh SBOM (`scripts/generate-sbom.mjs`) chặn cứng mọi gói hoặc container có từ khóa `BSL-1.1`, `thingsboard`, `emqx`.
- **Thay thế bằng thành phần chuẩn OSI & ranh giới container rõ ràng (`infra/compose/*.yml`):**
  - **Valkey `8.1` (`valkey/valkey:8.1-alpine`, `BSD-3-Clause`)** cho session cache, pub/sub (`PUBSUB_ADAPTER=redis` tương thích giao thức) và rate-limiting trên `nocobase.yml` & `prod.yml`.
  - **Eclipse Mosquitto `2.0.21` (`EPL-2.0 OR BSD-3-Clause`)** cho broker MQTT biên nội bộ với Dynamic Security (`allow_anonymous false`, `$CONTROL/dynamic-security/v1`) & `BIRTH`/`DEATH` LWT (`infra/compose/iiot.yml`, `prod.yml`).
  - **Node-RED `4.0.9` (`Apache-2.0`)** cho chuẩn hóa bản tin IIoT, cầu nối LWT & downlink lệnh Digital Twin (`infra/compose/iiot.yml`, `prod.yml`); dữ liệu chuỗi thời gian IIoT lưu trực tiếp vào **PostgreSQL `16`** (`latticeTelemetryPoints`) nên không vận hành container `timescaledb` tách rời trong `iiot.yml`.
  - **OpenTelemetry Collector Contrib `0.123.0` (`Apache-2.0`)** và **Prometheus `v3.3.0` (`Apache-2.0`)** cho thu thập telemetry & điểm đo `/api/dxos:metrics` (`infra/compose/prod.yml`).
  - **Caddy `2.10` (`Apache-2.0`)**, **Apache APISIX `3.19.0` (`Apache-2.0`)**, **Keycloak `26.8.2` (`Apache-2.0`)**, **RustFS `1.0.6` (`Apache-2.0`)** cho biên bảo mật Zero-Trust & lưu trữ S3.
  - **Grafana OSS `11.5.8` (`AGPL-3.0-only`)** chạy như container quan sát độc lập (`infra/compose/prod.yml`, profile `observability`), giao tiếp qua HTTP tới Prometheus nội bộ.
  - **Gotenberg `8.20.1` (`MIT`)** cho kết xuất tài liệu/PDF tách biên container tùy chọn (`infra/compose/prod.yml`, profile `pdf`).
- **Kho mã nguồn Git thuần chuẩn OSI (không chứa `upstream/nocobase` submodule hay `.gitmodules`):** Theo phán quyết BTC OLP PMNM 2026, LatticeDX gỡ bỏ hoàn toàn `upstream/nocobase` và `.gitmodules` khỏi kho Git và gói phát hành `latticedx-0.4.2-src.tar.gz`. Host `nocobase/nocobase:2.2.50@sha256:04b75164936e7314ef74d82844bc56c9f34ed7ff1ca976ca53ffac2d3c88d777` chỉ được nạp **lúc chạy dưới dạng OCI container bên ngoài kho Git**, còn `n8nio/n8n:2.48.1` (`Sustainable Use License`) chỉ là **container tích hợp tùy chọn độc lập bên ngoài**, không thuộc lõi engine tự động hóa của LatticeDX.
- Bảo toàn tuyệt đối nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`) trên mọi giao diện portal và admin.

## Trước khi phát hành `v0.4.2`

1. Sau review và hợp nhất, chọn commit từ bản tích hợp, chạy CI và nghiệm thu trên bản cài sạch (`pnpm native:clean`, `pnpm setup:dxos-ai`, `pnpm seed:v100-showcase`, `pnpm acceptance:headless-paas`, `pnpm acceptance:dxos-ai-mcp`, `pnpm acceptance:logistics-rbac`).
2. Đồng bộ phiên bản **`0.4.2`** trong `package.json`, cả 7 `plugins/nocobase/*/package.json`, [`COPYRIGHT.txt`](../COPYRIGHT.txt), [`CHANGELOG.md`](../CHANGELOG.md), [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json) và tên gói phát hành (`latticedx-0.4.2-src.tar.gz`).
3. Chạy:
   ```sh
   node scripts/source-headers.mjs --check
   pnpm pof:check
   node --test scripts/tests/oss-pof-audit.test.mjs
   node scripts/generate-sbom.mjs --check
   pnpm check
   pnpm release:tarball --ref=v0.4.2
   ```
   Kiểm tra checksum `.sha256`, danh sách tệp trong gói `.tar.gz` và giải nén ra thư mục không có `.git/` để tái build & chạy lại `pnpm pof:check`. Kho Git và gói source loại trừ hoàn toàn `node_modules/`, `output/`, tệp `.env` chứa secret, `.gitmodules` và mọi tệp/thư mục `upstream/` (không nhúng mã nguồn upstream NocoBase).
4. Rà secrets và dữ liệu private trong lịch sử Git (`pnpm pof:check` kiểm tra `no-secrets`), xác nhận kho `https://github.com/CTU-OpenPaw/lattice-dx` công khai và đối chiếu GitHub Release bằng phiên không đăng nhập.

`pnpm pof:check` (`node scripts/verify-pof-readiness.mjs`) kiểm tra tự động 6 tiêu chí trong cây mã (`spdx-headers`, `governance-files`, `plugin-isolation`, `compose-digests`, `upstream-clean`, `no-secrets`). Hồ sơ PoF hoàn chỉnh còn bao gồm bằng chứng truy cập công khai, phát hành GitHub Release, cài/chạy sạch từ gói `.tar.gz` và đối chiếu `docs/sbom-cyclonedx.json`.

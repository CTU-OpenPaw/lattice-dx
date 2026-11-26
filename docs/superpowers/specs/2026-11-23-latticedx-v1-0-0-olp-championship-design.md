<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết Kế Kỹ Thuật LatticeDX v1.0.0 — DX-OS Open-Core Championship Edition (OLP PMNM 2026)

## 1. Mục tiêu & Căn cứ Đề thi VFOSSA 2026
Nâng cấp **LatticeDX** từ `v0.3.0` lên **`v1.0.0`** đạt độ phủ 100% đối với [Đề thi OLP PMNM 2026](https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html) (*"Xây dựng Hệ điều hành Chuyển đổi số bằng Công nghệ Lõi nguồn mở — DX-OS Open-Core"*) và [Thể lệ & Rubric 100 điểm (50 PoF + 50 Chung kết)](https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html):

- **Tầng 1 — Nền tảng Dịch vụ Lõi số Headless (PaaS):** Hoạt động độc lập qua API ngay cả khi tắt giao diện (Identity/SSO + Scoped API Keys, Zero-Trust APISIX Gateway cho `/api/*`, OLTP + PG RLS + Chữ ký số PKI Ed25519 + Sổ cái mật mã bất biến SHA-256/Merkle, OpenAPI 3.1 / AsyncAPI 3.0 sống, và Grafana + Prometheus Alertmanager).
- **Tầng 2 — 4 Không gian Năng lực `[H]–[P]–[D]–[I]`:**
  - **`[H]` Con người số:** Bảng **Kanban & Lịch** (`DxosKanbanScheduleBlockModel`), **Mobile Field PWA** ngoại tuyến (Manifest, Service Worker, hàng đợi offline, QR scanner, chữ ký tay + GPS tạo **ePOD**), và **Ủy quyền phê duyệt có thời hạn**.
  - **`[P]` Quy trình số:** **Động cơ Bảng quyết định DMN** trực quan + SLA giờ hành chính Việt Nam + **Động cơ trộn biểu mẫu chứng từ** (Phiếu Xuất Kho, Chứng thư ePOD) gắn chữ ký PKI & QR B2B tra cứu công khai.
  - **`[D]` Dữ liệu số Ấm/Lạnh & Phả hệ:** **Phân tầng Hot–Warm–Cold** (Frozen Snapshots + Kho Lạnh + Phòng đọc ảo), **Đồ thị Phả hệ Dữ liệu (`Data Lineage`)**, **Trạm Cách ly Dữ liệu lỗi (`Data Quality Quarantine`)**, **Bản đồ WebGIS (`DxosWebGisBlockModel`)** và **Digital Twin 2 chiều** (`desired ↔ reported` qua Node-RED MQTT downlink).
  - **`[I]` Trí tuệ số:** **OCR & Document AI** trích xuất XLSX/PPTX/Ảnh/PDF scan điền form tự động, **Enterprise GraphRAG + `pgvector` hợp nhất**, **`dxos_alarm_action` MCP tool**, **Proactive Incident Triage Agent** tự lập phương án vào HITL Queue, và đầy đủ **MCP Prompts / Resource Templates**.
- **Tầng 3 — Kinh doanh số Cắm-Rút (`OMS + WMS + TMS`):** Đơn hàng đa dòng (`latticeOrderLines`), quản lý Lô & Hạn dùng (`latticeStockLots`), tính **Mean Kinetic Temperature (MKT Arrhenius)** tự động cách ly lô vi phạm nhiệt và điều phối xuất kho **Dynamic FEFO**, kết thúc bằng giao nhận điện tử **ePOD**.
- **GitOps v3 & `50/50 PoF`:** **Solution Bundle v3** đóng gói trọn vẹn cây route & `flowModels` block + governance rules; đồng bộ `COPYRIGHT.txt`, `README.md`, `CHANGELOG.md`, `docs/sbom-cyclonedx.json` (CycloneDX 1.5), ma trận 1-1 theo đề thi và kịch bản demo 15 phút chung kết.

## 2. Ràng buộc Kiến trúc & Pháp lý Nguồn mở
1. **OSI Purity:** Mã nguồn nhóm là `Apache-2.0`; ZERO mã nguồn BSL-1.1 / AGPL-3.0 / GPL bị sao chép. Toàn bộ tính năng mới dùng thư viện chuẩn Node.js (`node:crypto`, `node:zlib`), Canvas/SVG thuần và `grafana/grafana-oss` (`Apache-2.0`, `@sha256` pinned).
2. **Bảo toàn NocoBase & `sdkProvidedByHost: true`:** 0 sửa đổi `upstream/nocobase`, 0 dependency npm bên thứ ba mới vào 7 plugin NocoBase, giữ nguyên nhận diện Điều 5.2 (`Powered by NocoBase`, `v2.2.50`, `License settings`).
3. **Dual-Entry `client-v2` Contract:** Toàn bộ `src/client-v2/index.js` của 7 plugin chỉ phụ thuộc `@nocobase/client-v2`.
4. **PostgreSQL RLS & Bảo mật mặc định Đóng:** Mọi bảng mới đều gắn `db.attachLatticeRlsPolicy()` qua migration thuận nghịch từ mốc `20261124000100+`; không lộ token/bí mật trong log hay báo cáo; mọi công cụ AI ghi đều đi qua RBAC + HITL.

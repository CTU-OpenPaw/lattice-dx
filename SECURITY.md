# Security Policy

## 1. Phiên bản được hỗ trợ
| Phiên bản / Nhánh | Trạng thái hỗ trợ |
| --- | --- |
| `0.4.x` (`main` trên `CTU-OpenPaw/lattice-dx`) | Được hỗ trợ cập nhật bản vá bảo mật |

## 2. Cảnh báo về cấu hình Fixture cục bộ
- Stack mặc định trong `infra/compose/*.yml` và tài liệu hướng dẫn (`docs/native-clean-install.md`, `docs/core-local.md`) sử dụng mật khẩu **fixture công khai** cho mục đích kiểm thử loopback trên `127.0.0.1` / `localhost` (ví dụ: `local-demo-password`, `local-admin-password`, `local-nocobase-password`, `admin123`, `NativeLab-2026!`, `local-nocobase-app-key-public-fixture`).
- Tuyệt đối **không sử dụng** các khóa/mật khẩu fixture này cho môi trường Internet hoặc dữ liệu thật. Luôn thay toàn bộ biến môi trường, khóa ký và chứng chỉ trước mọi triển khai ngoài loopback.

## 3. Ranh giới bảo mật đã triển khai
- **Xác thực & Định danh:** Core API xác minh JWT chữ ký từ Keycloak (`OIDC_ISSUER` / `OIDC_JWKS_URL`), kiểm tra `organization_id` và `expectedVersion` (khóa lạc quan) trước mọi thao tác thay đổi dữ liệu. Plugin `@latticedx/plugin-enterprise-auth` dùng Authorization Code + PKCE S256 cho đăng nhập NocoBase.
- **Kiểm soát truy cập (ACL / Scope):** Quyền đọc/ghi và chia sẻ thực thể được kiểm tra phía server trên từng request; metadata trên giao diện chỉ phục vụ hiển thị và không thay thế kiểm tra quyền backend.
- **Quét mã độc tệp tải lên:** Kho tệp chung trong cấu hình core và overlay `infra/compose/native-files.yml` quét nội dung qua ClamAV (`clamav/clamav:1.5.5`) qua TCP socket trước khi cho phép tải xuống.
- **Toàn vẹn hạ tầng container:** Toàn bộ OCI container images trong `infra/compose/*.yml` đều khóa phiên bản theo digest `@sha256:` bất biến.

## 4. Quy trình báo cáo lỗ hổng bảo mật
- Không công khai lỗ hổng, token, tệp `.env`, khóa riêng tư hoặc dữ liệu cá nhân trong GitHub Issues hoặc Pull Requests.
- Khi phát hiện vấn đề bảo mật, hãy báo cáo riêng tư qua **GitHub Security Advisories** của kho mã:
  - **https://github.com/CTU-OpenPaw/lattice-dx/security/advisories/new**
- Vui lòng đính kèm mô tả phạm vi ảnh hưởng, các bước tái hiện tối thiểu và phiên bản/commit SHA liên quan để nhóm bảo trì xử lý và phối hợp công bố bản vá kịp thời.

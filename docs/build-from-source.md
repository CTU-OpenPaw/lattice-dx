# Hướng dẫn Build từ Mã nguồn (Build from Source)

Tài liệu này mô tả quy trình tái tạo và biên dịch **LatticeDX** từ mã nguồn bằng bộ công cụ nguồn mở 100%, không sử dụng công cụ biên dịch độc quyền và không cần chỉnh sửa thủ công file nguồn hay header trước khi build.

## 1. Công cụ yêu cầu (100% OSS Toolchain)

| Thành phần | Phiên bản kiểm chứng | Vai trò |
| --- | --- | --- |
| **Node.js** | `24.x` (`>=24 <25`, kiểm trên `24.15.0`) | Runtime cho Next.js, Fastify API, worker và scripts |
| **pnpm** | `10.23.0` (`packageManager` trong `package.json`) | Quản lý workspace và lockfile (`pnpm-lock.yaml`) |
| **Git** & **tar** | Git + GNU/BSD `tar` | Kiểm tra nguồn hoặc giải nén gói `.tar.gz` |
| **Docker Engine & Compose** | Docker Compose v2+ (`v5.5.1`) | Tùy chọn — chạy container dịch vụ ngoài (`infra/compose/*.yml`) |

## 2. Lấy mã nguồn (Chọn 1 trong 2 cách)

### Cách A: Từ gói phát hành nguồn `.tar.gz`
```sh
sha256sum -c latticedx-0.1.0-src.tar.gz.sha256
tar -xzf latticedx-0.1.0-src.tar.gz
cd latticedx-0.1.0
```
> Trên Windows PowerShell có thể dùng `Get-FileHash .\latticedx-0.1.0-src.tar.gz -Algorithm SHA256` để đối chiếu với nội dung tệp `.sha256`.

### Cách B: Clone từ kho Git chính thức
```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
```
> Submodule `upstream/nocobase` (commit `5b47bec116c52239348c09d360e4bd2649c99efc`) chỉ dùng để khảo sát mã nguồn tham chiếu (`git submodule update --init --recursive`) và **không cần thiết** để build LatticeDX hoặc ba plugin.

## 3. Cấu hình biến môi trường trước khi build

1. Tham khảo toàn bộ giá trị mặc định trong [`.env.example`](../.env.example).
2. Khi chạy cục bộ qua `pnpm dev` hoặc build production, không sửa bất kỳ file nguồn hay header nào; thiết lập biến môi trường trên shell hoặc tạo tệp `.env` cục bộ (đã được `.gitignore` loại trừ):

```powershell
# Ví dụ trên PowerShell (tùy chọn, mặc định đã đủ cho build/test offline)
$env:API_PORT='4000'
$env:WORKER_PORT='4101'
$env:WORKER_URL='http://127.0.0.1:4101'
```

## 4. Cài đặt phụ thuộc & Biên dịch toàn bộ Monorepo

```sh
pnpm install --frozen-lockfile
pnpm check
```

Lệnh `pnpm check` thực thi tuần tự ba bước kiểm chứng từ nguồn:
1. `pnpm typecheck`: Kiểm tra kiểu TypeScript cho toàn bộ workspace và `solutions/logistics/tsconfig.json`.
2. `pnpm test`: Chạy bộ kiểm thử Vitest (`tests/**/*.test.ts`, `apps/*/src/**/*.test.ts`, `packages/*/src/**/*.test.ts`, `plugins/nocobase/*/*.test.ts`, loại trừ `upstream/**`).
3. `pnpm build`: Biên dịch ứng dụng Next.js (`@dx/web`) và mã TypeScript của `@dx/contracts`, `@dx/api`, `@dx/agent-worker`.

## 5. Build & Kiểm thử ba Plugin NocoBase của nhóm

Ba plugin Apache-2.0 (`@latticedx/plugin-action-bridge`, `@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-enterprise-auth`) khai báo `"sdkProvidedByHost": true` và không sao chép mã nguồn NocoBase vào kho build:

```sh
# 1. Cài phụ thuộc khóa lockfile của plugin-enterprise-auth (tắt lifecycle scripts)
npm ci --prefix plugins/nocobase/plugin-enterprise-auth --ignore-scripts --no-audit --no-fund

# 2. Build lần lượt 3 plugin
node plugins/nocobase/action-bridge/build.mjs
node plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs
node plugins/nocobase/plugin-enterprise-auth/build.mjs

# 3. Chạy kiểm thử đơn vị của plugin
node --test plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs plugins/nocobase/action-bridge/tests/*.test.cjs plugins/nocobase/plugin-enterprise-auth/tests/*.test.cjs
```

## 6. Kiểm toán PoF & Đóng gói `.tar.gz` phát hành nguồn

```sh
pnpm pof:check
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:tarball
```

- `pnpm pof:check` chạy được cả trên bản checkout Git lẫn trong thư mục giải nén từ gói `.tar.gz` (không cần `.git/`), để tự động kiểm tra SPDX headers, tài liệu quản trị, `NOTICE`, cô lập plugin NocoBase, digest `@sha256:` trong Compose, trạng thái `upstream/` và không lộ secret.
- `pnpm release:tarball` tạo gói phát hành `output/release/latticedx-<version>-src.tar.gz` kèm `latticedx-<version>-src.tar.gz.sha256` từ `HEAD` đã commit trên checkout Git (không bao gồm `node_modules/`, `output/`, `.env`, `.git/` hay source `upstream/nocobase/`).

## 7. Phân tách mã nguồn tự build vs Dịch vụ OCI bên ngoài

| Phạm vi | Cách build / vận hành | Tài liệu chi tiết |
| --- | --- | --- |
| **Mã nguồn LatticeDX** (`apps/`, `packages/`, `plugins/nocobase/`, `solutions/`, `scripts/`) | Biên dịch trực tiếp từ mã nguồn bằng Node 24 + pnpm 10.23.0 | Mục 4–5 ở trên |
| **Khởi tạo môi trường Native sạch từ source commit** | Xuất `HEAD`, dựng DB trắng 0 bảng, cài và nghiệm thu 3 plugin | [native-clean-install.md](native-clean-install.md) |
| **Dịch vụ hạ tầng OCI bên ngoài** (`PostgreSQL`, `Keycloak`, `APISIX`, `ClamAV`, `NocoBase 2.2.38`, `Orion-LD`, `MongoDB`, `n8n`) | Kéo container image khóa digest `@sha256:` qua `infra/compose/*.yml`; tương tác qua SQL/HTTP/TCP | [third-party.md](third-party.md), [`NOTICE`](../NOTICE) |

# Hướng dẫn Build từ Mã nguồn (Build from Source — `v0.4.2`)

Tài liệu này mô tả quy trình tái tạo và biên dịch **LatticeDX `v0.4.2`** từ mã nguồn bằng bộ công cụ nguồn mở 100%, không sử dụng công cụ biên dịch độc quyền và không cần chỉnh sửa thủ công file nguồn hay header trước khi build.

## 1. Công cụ yêu cầu (100% OSS Toolchain)

| Thành phần | Phiên bản kiểm chứng | Vai trò |
| --- | --- | --- |
| **Node.js** | `24.x` (`>=24 <25`) | Runtime cho dịch vụ TypeScript/Node.js (`file-scanner`, `agent-worker`, `api`) và scripts |
| **pnpm** | `10.23.0` (`packageManager` trong `package.json`) | Quản lý workspace và lockfile (`pnpm-lock.yaml`) |
| **Git** & **tar** | Git + GNU/BSD `tar` | Kiểm tra nguồn hoặc giải nén gói `.tar.gz` |
| **Docker Engine & Compose** | Docker Compose v2+ | Tùy chọn — chạy container dịch vụ ngoài (`infra/compose/*.yml`) |

## 2. Lấy mã nguồn (Chọn 1 trong 2 cách)

### Cách A: Từ gói phát hành nguồn `.tar.gz`
```sh
sha256sum -c latticedx-0.4.2-src.tar.gz.sha256
tar -xzf latticedx-0.4.2-src.tar.gz
cd latticedx-0.4.2
```
> Trên Windows PowerShell có thể dùng `Get-FileHash .\latticedx-0.4.2-src.tar.gz -Algorithm SHA256` để đối chiếu với nội dung tệp `.sha256`.

### Cách B: Clone từ kho Git chính thức
```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
```
> **Kho mã nguồn 100% thuần chuẩn OSI:** Kho Git chính thức và gói phát hành `latticedx-0.4.2-src.tar.gz` **không chứa submodule `upstream/nocobase` hay tệp `.gitmodules`** (không cần bước `git submodule`); runtime host `nocobase/nocobase:2.2.50` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài kho Git.

## 3. Cấu hình biến môi trường trước khi build

1. Tham khảo toàn bộ giá trị mặc định trong [`.env.example`](../.env.example) và [`infra/compose/prod.env.example`](../infra/compose/prod.env.example).
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
2. `pnpm test`: Chạy bộ kiểm thử Vitest (`tests/**/*.test.ts`, `apps/*/src/**/*.test.ts`, `packages/*/src/**/*.test.ts`).
3. `pnpm build`: Biên dịch mã TypeScript của `@dx/contracts`, `@dx/api`, `@dx/agent-worker` và `@dx/file-scanner`.

## 5. Build & Kiểm thử bảy Plugin NocoBase của nhóm (`0.4.2`)

Bảy plugin Apache-2.0 phiên bản **`0.4.2`** (`@latticedx/plugin-action-bridge`, `@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-enterprise-auth`, `@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-blocks`, `@latticedx/plugin-dxos-studio`, `@latticedx/plugin-dxos-ai`) khai báo `"sdkProvidedByHost": true` (`testedRuntime: "2.2.50"`) và không sao chép mã nguồn NocoBase vào kho build:

```sh
# 1. Cài phụ thuộc khóa lockfile của plugin-enterprise-auth (tắt lifecycle scripts)
npm ci --prefix plugins/nocobase/plugin-enterprise-auth --ignore-scripts --no-audit --no-fund

# 2. Build lần lượt 7 plugin
node plugins/nocobase/action-bridge/build.mjs
node plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs
node plugins/nocobase/plugin-enterprise-auth/build.mjs
node plugins/nocobase/plugin-dxos-para/build.mjs
node plugins/nocobase/plugin-dxos-blocks/build.mjs
node plugins/nocobase/plugin-dxos-studio/build.mjs
node plugins/nocobase/plugin-dxos-ai/build.mjs

# 3. Chạy kiểm thử đơn vị của 7 plugin + scripts PoF/demo + externals + đánh giá 163 ca tiếng Việt tự nhiên
node --test plugins/nocobase/*/tests/*.test.cjs scripts/tests/*.test.mjs tests/nocobase-externals.test.mjs
node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95
```

## 6. Kiểm toán PoF, Sinh/Kiểm tra SBOM & Đóng gói `.tar.gz` phát hành nguồn

```sh
node scripts/source-headers.mjs --check
pnpm pof:check
node --test scripts/tests/oss-pof-audit.test.mjs
pnpm release:sbom
node scripts/generate-sbom.mjs --check
pnpm release:tarball
```

- `pnpm pof:check` chạy được cả trên bản checkout Git lẫn trong thư mục giải nén từ gói `.tar.gz` (không cần `.git/`), để tự động kiểm tra SPDX headers, tài liệu quản trị (`COPYRIGHT.txt`, `NOTICE`, `LICENSE`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`), cô lập 7 plugin NocoBase (kèm `LICENSE` + `README.md` riêng + `Clause 5.2`), digest `@sha256:` trong Compose, xác minh `upstream-clean` (không có `.gitmodules` hay `upstream/`) và không lộ secret.
- `pnpm release:sbom` / `node scripts/generate-sbom.mjs --check` tạo và đối chiếu hồ sơ CycloneDX 1.5 [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json) (`257` thành phần: `workspace=12, npm=226, oci=19`, trong đó `257/257` có giấy phép đã phân giải (`fsevents@2.3.3 = MIT`, `0` thiếu/`NONE`)), đồng thời chặn cứng giấy phép `BSL-1.1` và các công nghệ bị loại trừ (`thingsboard`, `emqx`).
- `pnpm release:tarball` tạo gói phát hành `output/release/latticedx-0.4.2-src.tar.gz` kèm `latticedx-0.4.2-src.tar.gz.sha256` từ `HEAD` đã commit trên checkout Git (không bao gồm `node_modules/`, `output/`, `.env`, `.git/`, `.gitmodules` hay bất kỳ mã nguồn upstream NocoBase nào).

## 7. Nghiệm thu Runtime Sạch & Phân tách Mã nguồn vs Dịch vụ OCI

Sau khi dựng môi trường NocoBase `2.2.50` sạch bằng `pnpm native:clean --port=13014`, chạy trọn bộ nghiệm thu E2E `v0.4.2`:

```sh
node scripts/setup-native-multi-portal-demo.mjs "<path-to-report.json>"
node scripts/setup-native-workspace-demo.mjs "<path-to-report.json>"
pnpm setup:dxos-ai -- --origin=http://localhost:13014
NOCOBASE_ADMIN_PASSWORD="<admin-password>" node scripts/seed-v030-demo-showcase.mjs --origin=http://localhost:13014
NOCOBASE_ADMIN_PASSWORD="<admin-password>" pnpm seed:v100-showcase -- --origin=http://localhost:13014
pnpm acceptance:headless-paas -- --origin=http://localhost:13014
pnpm acceptance:dxos-ai-mcp -- --origin=http://localhost:13014
pnpm acceptance:logistics-rbac -- "<path-to-report.json>"
```

| Phạm vi | Cách build / vận hành | Tài liệu chi tiết |
| --- | --- | --- |
| **Mã nguồn LatticeDX** (`apps/`, `packages/`, `plugins/nocobase/`, `solutions/`, `scripts/`) | Biên dịch trực tiếp từ mã nguồn bằng Node 24 + pnpm 10.23.0 | Mục 4–5 ở trên |
| **Khởi tạo môi trường Native sạch từ source commit** | Xuất `HEAD`, dựng DB trắng 0 bảng, cài và nghiệm thu 7 plugin `0.4.2` | [native-clean-install.md](native-clean-install.md) · [DEMO_PACK.md](DEMO_PACK.md) |
| **Dịch vụ hạ tầng OCI bên ngoài (`19` images khóa `@sha256:`)** (`PostgreSQL 16.16`, `pgvector 0.8.1`, `Valkey 8.1`, `RustFS 1.0.6`, `Caddy 2.10`, `Keycloak 26.8.2`, `keycloak-config-cli 6.5.1-26`, `APISIX 3.19.0`, `ClamAV 1.5.5`, `NocoBase 2.2.50`, `Orion-LD 1.12.0`, `MongoDB 8.0`, `n8n 2.48.1` tùy chọn, `Mosquitto 2.0.21`, `Node-RED 4.0.9`, `OTel Collector 0.123.0`, `Prometheus v3.3.0`, `Grafana OSS 11.5.8`, `Gotenberg 8.20.1`) | Kéo container image khóa digest `@sha256:` qua `infra/compose/*.yml`; tương tác qua SQL/HTTP/MQTT/TCP | [third-party.md](third-party.md), [`COPYRIGHT.txt`](../COPYRIGHT.txt), [`NOTICE`](../NOTICE), [`sbom-cyclonedx.json`](sbom-cyclonedx.json) |

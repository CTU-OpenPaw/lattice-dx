## Summary / Tóm tắt thay đổi

<!-- Describe the problem solved, architectural scope, and key behavioral changes. -->

Related issue / Issue liên quan: Fixes # <!-- or Refs # -->

## Type of Change / Loại thay đổi

- [ ] `feat`: New feature or DX-OS capability / Tính năng mới
- [ ] `fix`: Bug fix or regression patch / Sửa lỗi
- [ ] `docs`: Documentation or community governance / Tài liệu
- [ ] `refactor`: Internal code restructuring without behavior change / Tái cấu trúc
- [ ] `test`: Tests or verification scripts / Kiểm thử
- [ ] `chore` / `infra`: Build, CI, Docker Compose, or dependency maintenance / Hạ tầng & bảo trì

## Pure-OSI Apache-2.0 & PoF Compliance Checklist

- [ ] 6-line `LatticeDX` Apache-2.0 SPDX header present on all new/modified source & config files (`node scripts/source-headers.mjs --check`)
- [ ] Pure-OSI compliance passing (`pnpm pof:check` & `pnpm release:sbom -- --check`)
- [ ] Strict pre-major (`0.4.x`) version lock respected (no unapproved major bump)
- [ ] NocoBase `2.2.50` Clause 5.2 attribution preserved (`Powered by NocoBase`, `"sdkProvidedByHost": true`, zero `upstream/` or `.gitmodules`)
- [ ] Multi-tenant PostgreSQL 16 `FORCE RLS` & RBAC verified (if touching data models, migrations, or API routes)
- [ ] Zero secrets/PII, zero unpinned container images (`@sha256:`), and zero forbidden legacy terms
- [ ] `pnpm typecheck`, `pnpm test`, and `node --test` passing locally

## Verification / Kiểm chứng

<!-- Paste concise command results or test summary. -->

- [ ] `pnpm check`
- [ ] `node scripts/source-headers.mjs --check`
- [ ] `pnpm pof:check`
- [ ] `pnpm release:sbom -- --check`

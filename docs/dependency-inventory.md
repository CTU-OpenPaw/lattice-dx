# Installed dependency license inventory — 18 November 2026

Generated from the installed, locked workspace using `pnpm licenses list --json`. The local raw report is `output/dependency-licenses.json` (ignored). This records package metadata, not a legal compatibility opinion or a complete distribution audit.

| Declared license expression | Package entries |
| --- | ---: |
| MIT | 102 |
| Apache-2.0 | 7 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |
| BSD-3-Clause | 4 |
| ISC | 5 |
| MPL-2.0 | 2 |
| CC-BY-4.0 | 1 |
| 0BSD | 1 |

Counts are grouped package entries across **123 total entries** (updated from 121 entries on 2026-10-14 after workspace additions in `MIT`, now `102` entries); an entry can contain more than one installed version. Platform-specific binaries reflect this Windows installation. A Linux container distribution requires its own inventory.

The combined expression belongs to `@img/sharp-win32-x64` 0.35.5. The Apache-2.0 entries cover `@swc/helpers` 0.5.23, `@typescript/typescript-win32-x64` 7.0.2, `baseline-browser-mapping` 2.11.27, `detect-libc` 2.1.2, `expect-type` 1.4.0, `sharp` 0.35.5, and `typescript` 7.0.2. The MPL-2.0 declarations belong to `lightningcss` and `lightningcss-win32-x64-msvc` 1.33.0. The data package `caniuse-lite` 1.0.30001814 declares CC-BY-4.0, and `tslib` 2.8.1 declares 0BSD. Keep their original licenses/notices when distributing applicable artifacts. The root Apache-2.0 license applies to the team's original code and does not replace these declarations.

NocoBase source/runtime, bundled dependencies inside `plugins/nocobase/plugin-enterprise-auth` (`openid-client@6.8.9`, `jose@6.2.15`, `oauth4webapi@3.8.8` — all MIT), container operating-system packages, and external OCI services (`PostgreSQL`, `Keycloak`, `APISIX`, `FIWARE Orion-LD`, `MongoDB`, `n8n`, `ClamAV`) are outside this pnpm workspace report. The three additional Apache-2.0 DX-OS plugins (`@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-blocks`, `@latticedx/plugin-dxos-studio`) depend only on Node.js built-ins and host-provided NocoBase/React/Antd SDK globals (`sdkProvidedByHost: true`) with zero extra bundled npm packages. Their separate terms and pinned digests are documented in [`COPYRIGHT.txt`](../COPYRIGHT.txt), [`NOTICE`](../NOTICE), [third-party sources](third-party.md), and [NocoBase source review](nocobase-source-review.md).

Reproduce this package metadata snapshot from the repo root with:

```powershell
pnpm licenses list --json | Out-File output/dependency-licenses.json -Encoding utf8
```

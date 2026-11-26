# Installed dependency license inventory — 25 November 2026

Generated from the installed, locked workspace using `pnpm licenses list --json`, together with the deterministic CycloneDX 1.5 SBOM (`pnpm release:sbom -- --check` -> [`docs/sbom-cyclonedx.json`](sbom-cyclonedx.json)). The local raw report is `output/dependency-licenses.json` (ignored). This records package metadata, not a legal compatibility opinion or a complete distribution audit.

| Declared license expression | Package entries |
| --- | ---: |
| MIT | 115 |
| ISC | 21 |
| BSD-3-Clause | 8 |
| Apache-2.0 | 4 |
| BSD-2-Clause | 2 |
| MPL-2.0 | 2 |
| (MIT OR Apache-2.0) | 1 |

Counts are grouped package entries across **153 total entries** (`MIT` `115`, `BSD-3-Clause` `8`, `ISC` `21`, `BSD-2-Clause` `2`, `(MIT OR Apache-2.0)` `1` after adding WebGIS `maplibre-gl@6.19.0` alongside LatticeFlow v2 DAG Studio build-time dependencies); an entry can contain more than one installed version. Platform-specific binaries reflect this Windows installation. A Linux container distribution requires its own inventory.

The Apache-2.0 entries cover `@typescript/typescript-win32-x64` `7.0.2`, `detect-libc` `2.1.2`, `expect-type` `1.4.0`, and `typescript` `7.0.2`. The BSD-3-Clause entries cover `@mapbox/vector-tile` `3.0.0`, `d3-ease` `3.0.2`, `fast-uri` `3.1.9, 4.2.3`, `light-my-request` `6.6.0`, `maplibre-gl` `6.19.0`, `pbf` `5.2.0`, `secure-json-parse` `4.1.0`, and `source-map-js` `1.2.2`. The BSD-2-Clause entries cover `@mapbox/tiny-sdf` `2.3.0` and `@mapbox/unitbezier` `1.0.0`. The `(MIT OR Apache-2.0)` entry is `@maplibre/mlt` `1.3.0`. The ISC entries cover `@maplibre/geojson-vt` `6.3.3`, `@maplibre/maplibre-gl-style-spec` `26.9.0`, `d3-color` `3.1.1`, `d3-dispatch` `3.0.2`, `d3-drag` `3.0.1`, `d3-interpolate` `3.0.2`, `d3-selection` `3.0.1`, `d3-timer` `3.0.2`, `d3-transition` `3.0.2`, `d3-zoom` `3.0.1`, `earcut` `3.2.4`, `fastq` `1.20.3`, `kdbush` `4.1.0`, `pg-int8` `1.0.1`, `picocolors` `1.1.1`, `potpack` `2.1.0`, `semver` `7.8.5`, and `split2` `4.2.0`. The MPL-2.0 declarations belong to `lightningcss` and `lightningcss-win32-x64-msvc` `1.33.0`. The MIT entries include Fastify, Vitest, `esbuild` `0.28.2`, `@esbuild/win32-x64` `0.28.2`, `@maplibre/vt-pbf` `4.3.3`, and the LatticeFlow v2 DAG Studio build-time graph libraries (`@xyflow/react` `12.12.1`, `@xyflow/system` `0.0.84`, `@dagrejs/dagre` `3.1.3`, `@dagrejs/graphlib` `4.0.6`, `zustand` `4.5.7`, and `@types/d3-*`). Keep their original licenses/notices when distributing applicable artifacts. The root Apache-2.0 license applies to the team's original code and does not replace these declarations.

The full CycloneDX 1.5 SBOM (`docs/sbom-cyclonedx.json`) tracks **257 components** (`workspace=12`, `npm=226`, `oci=19`), with **256/257 resolved licenses** — only the macOS-optional `fsevents@2.3.3` package remains unresolved on Windows.

Host runtime NocoBase (`nocobase/nocobase:2.2.50` external OCI container), bundled dependencies inside `plugins/nocobase/plugin-enterprise-auth` (`openid-client@6.8.9`, `jose@6.2.15`, `oauth4webapi@3.8.8` — all `MIT`), container operating-system packages, and the external OCI services (`PostgreSQL 16.16`, `pgvector 0.8.1`, `Valkey 8.1`, `RustFS 1.0.6`, `Caddy 2.10`, `Keycloak 26.8.2`, `keycloak-config-cli 6.5.1-26`, `APISIX 3.19.0`, `FIWARE Orion-LD 1.12.0`, `MongoDB 8.0`, optional standalone `n8n 2.48.1`, `ClamAV 1.5.5`, `Mosquitto 2.0.21`, `Node-RED 4.0.9`, `OTel Collector 0.123.0`, `Prometheus v3.3.0`, `Grafana OSS 11.5.8`, `Gotenberg 8.20.1`) are documented across the lockfile/SBOM rather than inside `pnpm licenses list --json`. Among the 7 Apache-2.0 NocoBase plugins (all declaring `"nocobase": { "sdkProvidedByHost": true }`): `@latticedx/plugin-dxos-studio` declares `@xyflow/react@12.12.1` (`MIT`), `@dagrejs/dagre@3.1.3` (`MIT`), and `esbuild@0.28.2` (`MIT`) under `devDependencies` (bundling its MIT DAG canvas and layout packages into `dist/client/index.js` at build time); `@latticedx/plugin-dxos-blocks` declares `maplibre-gl@6.19.0` (`BSD-3-Clause`) and `esbuild@0.28.2` (`MIT`) under `devDependencies` (bundling WebGIS MapLibre into `dist/client/index.js` at build time while keeping NocoBase SDK, `react`, `react-dom`, and `antd` strictly host-external); the other DX-OS plugins (`@latticedx/plugin-action-bridge`, `@latticedx/plugin-lattice-foundation`, `@latticedx/plugin-dxos-para`, `@latticedx/plugin-dxos-ai`) depend only on Node.js built-ins and host-provided NocoBase/React/Antd SDK globals with zero extra bundled npm packages. Their separate terms and pinned digests are documented in [`COPYRIGHT.txt`](../COPYRIGHT.txt), [`NOTICE`](../NOTICE), [third-party sources](third-party.md), and [NocoBase source review](nocobase-source-review.md).

Reproduce this package metadata snapshot from the repo root with:

```powershell
pnpm licenses list --json | Out-File output/dependency-licenses.json -Encoding utf8
pnpm release:sbom -- --check
```

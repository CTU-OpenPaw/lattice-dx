# Installed dependency license inventory — 14 October 2026

Generated from the installed, locked workspace using `pnpm licenses list --json`. The local raw report is `output/dependency-licenses.json` (ignored). This records package metadata, not a legal compatibility opinion or a complete distribution audit.

| Declared license expression | Package entries |
| --- | ---: |
| MIT | 100 |
| Apache-2.0 | 7 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |
| BSD-3-Clause | 4 |
| ISC | 5 |
| MPL-2.0 | 2 |
| CC-BY-4.0 | 1 |
| 0BSD | 1 |

Counts are grouped package entries; an entry can contain more than one installed version. Platform-specific binaries reflect this Windows installation. A Linux container distribution requires its own inventory.

The combined expression belongs to `@img/sharp-win32-x64` 0.35.5. The MPL declarations belong to `lightningcss` and `lightningcss-win32-x64-msvc` 1.33.0. The data package `caniuse-lite` 1.0.30001814 declares CC-BY-4.0. Keep their original licenses/notices when distributing applicable artifacts. The root Apache-2.0 license applies to the team's original code and does not replace these declarations.

No dependencies or lockfile versions were added by the backend completion increment. NocoBase source/runtime, container operating-system packages and future adapter/model/data dependencies are outside this npm report. Their separate obligations remain described in [third-party sources](third-party.md) and the upstream source review. This report does not certify competition compliance.

Before a distributable release, inventory the exact packaged artifacts, retain required notices/license texts, and check obligations against the actual distribution. Reproduce this package metadata snapshot with:

```powershell
pnpm licenses list --json | Out-File output/dependency-licenses.json -Encoding utf8
```

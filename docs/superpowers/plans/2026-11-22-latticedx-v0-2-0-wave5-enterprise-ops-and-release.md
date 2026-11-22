# LatticeDX v0.2.0 — Wave 5 Implementation & Official Release Plan

> **For agentic workers:** Execute task-by-task in worktree `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` on branch `feat/v0.2.0-enterprise-hardening`.

**Goal:** Deliver Wave 5 (Record Chatter with `@mention` & field-diff audit trail, immutable `Submit`/`Cancel`/`Amend` ERP vouchers, column-RBAC governed CSV/XLSX/PDF export, GitOps Solution Bundle JSON export/diff/import, invisible-chrome Command Palette `Cmd+K`, and official `LatticeDX v0.2.0` release with cleanroom tarball & local annotated tag `v0.2.0`).

**Architecture:** All Wave 5 capabilities live strictly inside the first-party Apache-2.0 NocoBase plugins (`plugin-lattice-foundation`, `plugin-dxos-blocks`, `plugin-dxos-studio`) with zero new runtime npm dependencies (`sdkProvidedByHost: true`), explicit short Postgres index names (`<= 55` chars), reversible `up()`/`down()` migrations, and fail-closed tenant/RBAC boundaries.

## Global Constraints
- Every new JS/MJS/CJS file carries the CTU-OpenPaw Apache-2.0 SPDX header.
- Every new database index in schemas AND collections declares an explicit short name matching `/^u?idx_lattice_[a-z0-9_]+$/` (`<= 55` ASCII chars).
- Every migration uses a unique 14-digit timestamp (`20261122000900`, `20261122001000`) with both `up()` and `down()`.
- Client modules bundled by plugin `build.mjs` have zero non-relative `require(...)` calls.
- Command Palette opens strictly via `Ctrl+K` / `Cmd+K` with zero permanent floating buttons.
- Preserve `tenantCodeCollections.length === 10` in `schema.js` (`latticeRecordChatter` lives in `collections/record-chatter.js`) and `registerDxosBlockModels` registering the 7 existing `BlockModel` subclasses.

## Tasks
1. **Task 5.1:** Record Chatter (`@mention` resolution + field-diff audit trail) in `plugin-lattice-foundation`.
2. **Task 5.2:** Immutable ERP Vouchers (`Submit` / `Cancel` / `Amend` + lineage) in `plugin-lattice-foundation`.
3. **Task 5.3:** Governed Column-RBAC Reporting Export (CSV / native XLSX ZIP / PDF) in `plugin-dxos-blocks`.
4. **Task 5.4:** GitOps Solution Bundle JSON (`Export` / `Diff` / `Import` dry-run & apply + Studio Tab 6) in `plugin-dxos-studio`.
5. **Task 5.5:** Command Palette (`Cmd+K`) + Record Chatter & Export UI in `plugin-dxos-blocks`.
6. **Task 5.6:** Version bump (`0.2.0` / foundation `0.26.0`), `CHANGELOG.md`, live container double-upgrade & Wave 5 E2E verification (`localhost:13014`), default `2.2.50` rebuild + full offline checks, cleanroom tarball verification, and local annotated tag `v0.2.0`.

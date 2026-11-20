<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX Open-Core 6-Plugin Suite & NocoBase Admin Builder Design

## 1. Intent & Why
Expand LatticeDX into a complete **DX-OS Open-Core Platform (4 spaces: H–P–D–I)** for OLP PMNM 2026 (VFOSSA), where **an enterprise administrator can build, extend, compose blocks, configure workflows, and toggle modules directly from NocoBase 2.2.38 UI** — without writing React, without modifying NocoBase core (`upstream/nocobase`), and without relying on hidden CLI scripts during live operation. Simultaneously bring Proof of Freedom (`PoF /50`) compliance up to the BTC reference project (`nukeviet/nukeviet`).

## 2. Approaches Considered & Selected
- **Selected Hybrid A+ (LatticeDX Open-Core 6-Plugin Suite):** Keep all 3 existing plugins (`action-bridge`, `plugin-lattice-foundation`, `plugin-enterprise-auth`) and all 8 existing `Lattice*BlockModel` compatibility blocks intact (**add, do not replace**), and add **3 new modular Apache-2.0 NocoBase plugins**:
  1. `@latticedx/plugin-dxos-para` (`[H]` P.A.R.A. Knowledge & Document Vault collection + org isolation + ACL + summary API)
  2. `@latticedx/plugin-dxos-blocks` (`[H][P][D][I]` Library of 6 native v2 configurable `BlockModel` subclasses in `Add block` + 2 org-scoped ACL-checked read APIs)
  3. `@latticedx/plugin-dxos-studio` (`[P][H][D]` Admin Control Studio at `/admin/settings/dxos-studio`, 4 Poka-yoke native workflow templates including Logistics 5-step, multi-block portal composer, plugin ecosystem view, PoF readiness dashboard, and second domain `latticeServiceTickets`)
- Plus NukeViet-grade PoF compliance (`COPYRIGHT.txt`, standardized `@copyright (C) 2026 CTU-OpenPaw` + `SPDX-License-Identifier: Apache-2.0` headers, clean external-judge `README.md`, `docs/DEMO_PACK.md`, and extended `pnpm pof:check` / tarball checks).

## 3. Architecture & Technical Decisions
1. **Multi-Block Portal Composition:** NocoBase 2.2.38 `flowSurfaces:applyBlueprint` accepts only the 17 built-in block types. `dxosStudio:composePortals` provisions native pages via `flowSurfaces:applyBlueprint` and attaches `Dxos*BlockModel` items into `BlockGridModel` (`subKey: 'items'`) of dedicated multi-block Overview pages via `flowModels` (`FlowModelRepository`), using deterministic UIDs so re-runs are idempotent and preserve existing Admin UI Editor customizations.
2. **Preserving `plugin-lattice-foundation` Security Boundaries:** Keep `latticeAgentProposals:list` and `latticeContextSync:status` `root`-only as verified by acceptance suites. Expose `dxosBlocks:proposals` and `dxosBlocks:contextTelemetry` in `plugin-dxos-blocks` with explicit collection ACL + organization-scoping checks for `ldx_*` roles and clean preview mode for `root`.
3. **Logistics 5-Step Workflow Without Breaking `latticeOrders` Schema:** Maintain `latticeOrders` schema unchanged; update `assigneeId` at every stage handoff (`Manager -> Warehouse -> Dispatcher -> Driver`) so `ldx_warehouse` and `ldx_driver` satisfy their existing `own`-scoped `view` ACLs, check role/org identity before & after each manual task, and terminate rejections at `endRejected` (`endStatus: 1`).
4. **Manual Tasks ACL Compliance:** `DxosWorkflowTasksBlockModel` calls `workflowManualTasks:listMine` (matching NocoBase 2.2.38 `'loggedIn'` ACL permissions) instead of `workflowManualTasks:list`.
5. **Graceful Degradation:** Each of the 3 new plugins handles sibling plugin absence (`404` / missing collection / disabled plugin) cleanly without throwing unhandled runtime exceptions.

## 4. Constraints & Non-Goals
- Never modify `E:\pmnm2026` or `upstream/nocobase/`.
- Preserve NocoBase Clause 5.2 UI attribution (`Powered by NocoBase`, `v2.2.38`, `License settings`).
- Keep 0 external npm dependencies in all 3 new plugins (`sdkProvidedByHost: true`).
- Do NOT merge to `main`, flip repo public, or publish tag/Release `v0.1.0` during this session.

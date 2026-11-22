<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX v0.3.0 Full-Platform Expansion & Hardening Plan

> **Branch:** `feat/v0.3.0-enterprise-platform` (from `origin/main` `6b49fd7`)  
> **Scope:** Package 1 (UX & Wave 5 Wiring, Unicode PDF, Persistent AI Quota, Bidirectional Keycloak SSO), Package 2 (Notification Center, SLA Escalation, Full GitOps Solution Bundle Apply + Rollback, `/mobile` Portal), Package 3 (Neural Embeddings + `pgvector <=>` + PDF/DOCX Chunking, AI HITL Approval Queue, OSI-Clean IIoT Mosquitto/Node-RED/TimescaleDB Time-Series), Package 4 (Lean `apps/file-scanner`, Zero `pnpm audit`, CodeQL Remediation, PostgreSQL RLS, OpenTelemetry/Prometheus `/api/dxos:metrics`, `v0.3.0` Docs & Demo Seeder), and Wave 5 Live Runtime + Browser E2E Verification.

## Global Constraints
- Preserve Apache-2.0 SPDX headers on every first-party source file (`@file LatticeDX — Open Digital Enterprise Platform`, `SPDX-License-Identifier: Apache-2.0`).
- Preserve NocoBase Clause 5.2 attribution (`Powered by NocoBase`, dynamic host version, `https://www.nocobase.com`).
- Strictly one floating AI Agent button (`PortalAgentLauncher`) per portal page; Notification Bell anchors at top header without overlapping bottom-right chat launcher.
- `plugins/nocobase/*/src/client/*.js` must only use relative `./` `require(...)` and guard `window`/`document`/`Blob`/`crypto` for Node tests.
- All container images in `infra/compose/*.yml` must carry verified `@sha256:<64-hex>` digests and strictly OSI-compatible licenses (`Apache-2.0`/`MIT`/`BSD`/`EPL-2.0` — never BSL-1.1).
- Migrations start at `20261123000100` (`000100`..`000600`) with idempotent `up()` and clean `down()`.
- Sequelize SQL named replacements always have whitespace around operators (e.g. `"lockedAt" < :cutoff`).

## Wave & Task Map
- **Wave 1 (Parallel):** Task 1.1 (`plugin-dxos-blocks`), Task 1.2 (`plugin-dxos-ai`), Task 1.3 (`plugin-enterprise-auth`), Task 1.4 (`plugin-dxos-studio` portal/settings/version).
- **Wave 2 (Parallel):** Task 2.1 (`plugin-lattice-foundation` notifications/SLA/vouchers/workspace), Task 2.2 (`plugin-dxos-studio` GitOps bundle v2 + rollback), Task 2.3 (`plugin-dxos-blocks` alarm->notification bridge + mobile/VN polish).
- **Wave 3 (Parallel):** Task 3.1 (`plugin-dxos-para` neural embeddings + pgvector + PDF/DOCX chunking), Task 3.2 (`plugin-dxos-ai` HITL approval queue + RAG chunk search), Task 3.3 (`plugin-dxos-blocks` + `infra/compose/iiot.yml` time-series + rule engine + Mosquitto/Node-RED/TimescaleDB).
- **Wave 4 (Parallel):** Task 4.1 (`apps/file-scanner`, `apps/agent-worker` zero fastify, `apps/api` CodeQL fixes), Task 4.2 (`plugin-lattice-foundation` PG RLS, `/api/dxos:metrics`/`health`, security headers, bundler/backup CodeQL fixes), Task 4.3 (`infra/compose/prod.yml`, observability/pdf profiles, PITR archive script, CI updates), Task 4.4 (`0.3.0` version bump, OLP docs sync, `scripts/seed-v030-demo-showcase.mjs`).
- **Wave 5:** Live Docker + `9router` restart, plugin mirror deploy, double `yarn nocobase upgrade`, showcase seed, PostgreSQL RLS live proof, HTTP & acceptance suites, Playwright multi-role + mobile E2E verification.

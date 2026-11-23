<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX `v1.0.0` Completion Implementation Plan (Chặng A, B, C)

> **For agentic workers:** Follow strict TDD, run per-task tests + builds, verify SPDX Apache-2.0 headers (`node scripts/source-headers.mjs --check`), and commit cleanly after each task inside `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` on `feat/v1.0.0-olp-championship`. STOP before push/PR/merge/release.

**Goal:** Deliver a genuinely complete, non-trivial Unified Broker Plane, Secrets/Connector Vault, Native Automation + DMN Engine, live 2-way `n8n` integration, Visual Domain Builder, 1-click Multi-Tenant Provisioning, and CMMS pack directly inside LatticeDX `v1.0.0`, verified live on Docker with NocoBase `2.2.50` + Valkey + Mosquitto + Node-RED + Orion-LD + n8n.

**Spec:** [`docs/superpowers/specs/2026-11-23-v100-builder-broker-automation-design.md`](../specs/2026-11-23-v100-builder-broker-automation-design.md)

---

## Global Constraints
- Keep version pinned at `1.0.0` (do NOT bump to `1.1.0`).
- Remove `timescaledb`; replace `redis:7.4-alpine` with pinned `valkey/valkey:8.1-alpine@sha256:...` (`BSD-3-Clause`).
- Zero new npm runtime dependencies in the 7 NocoBase plugins (`sdkProvidedByHost: true`).
- All 8 new tenant tables MUST appear in `TENANT_RLS_TABLES` and attach PG RLS in their migrations (`20261125000100`–`20261125000300`).
- Every first-party file MUST include the CTU-OpenPaw `SPDX-License-Identifier: Apache-2.0` header.

## Task Breakdown
1. **Task A.1 — Clean OSI Infrastructure, Mosquitto DynSec & Node-RED LWT/Orion-LD:** Remove dead `timescaledb`, switch Redis to verified `valkey/valkey:8.1-alpine@sha256:...`, update SBOM license resolver & compose security tests, configure Mosquitto Dynamic Security (`allow_anonymous false`) + `init-dynsec.sh`, bring `mosquitto` & `nodered` into `prod.yml`, and upgrade Node-RED `flows.json` with LWT status & optional Orion-LD mirror.
2. **Task A.2 — Connector Vault & CloudEvents/Webhook Bus (`plugin-lattice-foundation`):** Collections + migration `20261125000100` + RLS, AES-256-GCM `dxosVault` (`list`, `save`, `rotateSecret`, `delete`, `testConnection`, `resolveConnectorSecrets`), `dxosEvents` CloudEvents 1.0 + Standard Webhooks (`FOR UPDATE SKIP LOCKED`, backoff, Circuit Breaker, DLQ Replay, cron drainer), `voucher-lifecycle.js` event emission, and unit tests.
3. **Task A.3 — Broker Control Plane (`plugin-dxos-blocks`):** Collections + migration `20261125000200` + RLS, minimal pure-`node:net` MQTT 3.1.1 publish client for Mosquitto `$CONTROL/dynamic-security/v1`, `dxosBroker` (`provisionDevice`, `revokeDevice`, `deviceStatusIngest`, `orionEntities`, `orionListSubscriptions`, `orionCreateSubscription`, `orionToggleSubscription`, `orionDeleteSubscription`, `orionNotify`), emission from `alarm-engine.js` & `digital-twin.js`, and unit tests.
4. **Task B.1 — Native Automation Engine (`plugin-dxos-studio`) + AI Integration (`plugin-dxos-ai`):** Collections + migration `20261125000300` + RLS, `dxosAutomations` (`Trigger -> DMN -> Actions`, `maxDepth`, template interpolation, HITL Twin bridge, `stepTracesJson`, `replayRun`), `wms-engine.js` event emission, Solution Bundle v3 `governance` sync, `dxos_manage_workflows` extension (`listAutomations`, `runAutomation`) preserving the 17-tool matrix, and unit tests.
5. **Task B.2 — Live 2-Way `n8n` Workflows:** Native v1.0 flows `dxos-coldchain-alert-orchestrator.json` and `dxos-epod-partner-sync.json` verifying Standard Webhooks HMAC-SHA256 and calling NocoBase via `ldx_pat_*`, plus `scripts/tests/n8n-native-flows.test.mjs`.
6. **Task C.1 — Visual Domain Builder, Tenant Provisioner & CMMS Pack:** `dxosBuilder` in `plugin-dxos-studio` (`createDomain`, `listDomains`, `listBusinessPacks`, `installBusinessPack` for `cmms-maintenance`, `listTenants`, `provisionTenant`), dynamic `/api/dxos:openapi` schema generation for `latticeCustom*` tables in `plugin-lattice-foundation`, and unit tests.
7. **Task C.2 — Unified Studio UI & Browser Polish Fixes:** `builder-broker-panels.js` (Tabs 7–9 in `/admin/settings/dxos-studio`), `Bundle v2 -> v3` heading fix, fix background `400`/`403` calls in `webgis-block.js`, `chatter-panel.js`, and `notification-center.js`, plus UI tests.
8. **Task C.3 — Seeder, Closed-Loop Acceptance, Docs/SBOM Sync & Live Docker `2.2.50` Verification:** Seed CMMS/Connector/Automation/Device/Webhook idempotently; add `acceptance-broker-automation-builder.mjs`; sync docs & CycloneDX SBOM; run all offline gates (`pnpm check`, `node --test`, `eval-vietnamese-nl-agent`, `source-headers`, `release:sbom`, `pof:check`, `pnpm audit`, `docker compose config`); deploy & upgrade twice on live NocoBase `2.2.50` + companion Docker services (`mosquitto`, `nodered`, `orion-ld`, `n8n`, `valkey`); run all 4 live acceptance suites & Playwright Browser E2E.

<!--
  @file LatticeDX — Open Digital Enterprise Platform
  @author CTU-OpenPaw
  @copyright (C) 2026 CTU-OpenPaw
  @license Apache-2.0
  @see https://github.com/CTU-OpenPaw/lattice-dx
  SPDX-License-Identifier: Apache-2.0
-->

# LatticeDX v0.2.0 — Enterprise Hardening & Single-Engine Architecture Design

> **Base branch:** `feat/dxos-ai-workforce-mcp` (`e282b31`)
> **Target branch:** `feat/v0.2.0-enterprise-hardening`
> **Source Blueprint:** Pre-v0.2.0 Live Probes + Full Source Audit (21 Critical, 26 High, 22 Medium, 13 Low) & 40+ OSS Benchmarks.

## 1. Architectural Decisions (Approved)

1. **Single-Engine Consolidation (Fix Split-Brain):**
   - **NocoBase + 7 Apache-2.0 Plugins (`plugin-lattice-foundation`, `plugin-dxos-para`, `plugin-dxos-blocks`, `plugin-dxos-studio`, `plugin-dxos-ai`, `plugin-enterprise-auth`, `plugin-native-storage`)** is the single authoritative application engine and database of record (`nocobase-db`).
   - Retire disconnected prototype **`apps/web`** (eliminates 2 Critical Next.js RCE CVEs + 1 High DoS CVE and mock hardcoded UI state), remove raw `EICAR_STANDARD_TEST_STRING` literal from **`@dx/contracts`**, and fix **`pnpm-workspace.yaml`** package globs.
   - Retain & harden **`apps/api`** for legacy/sidecar responsibilities (`/internal/native-request-files` ClamAV scan sidecar, `/v1/*` compatibility until deprecated), eliminating fail-open/cross-tenant/poison-pill/pool-exhaustion defects.
2. **PostgreSQL Unified Data Plane:**
   - Consolidate vector (`pgvector`), full-text (`tsvector`), and time-series workloads inside PostgreSQL rather than adding separate Qdrant/InfluxDB services, keeping PITR backup single-stream.
3. **Sequential 5-Wave Delivery (`Wave 1 → Wave 5`):**
   - **Wave 1 (Critical Security, Multi-Tenant, SSRF, Live Telemetry & Split-Brain):** Fail-closed unified RBAC/tenant scoping across all plugins (`latticeCustom*`, `params.filter`, `charts:queryData`, `pageSize` clamp, `X-Role`, `lockFields` + `writeToACL`, SSRF/JWT leak guards, `latticeAiProfiles` scope/hooks, Orion-LD `?local=true`, `latticeContextOutbox` `state` schema fix, Creative Studio live telemetry, remove `2.6s` double polling + `location.reload()`, prompt-injection sanitization, `403`/empty-portal UX) + `apps/web` retirement + `apps/api` Critical fixes.
   - **Wave 2 (Zero-Trust Production Infra, Stack Upgrades & Real DR):** `infra/compose/prod.yml` (TLS Edge, 4 isolated networks, Redis PubSub/auth, RustFS S3, resource limits, non-root/`cap_drop`), stack upgrades (`NocoBase 2.2.50`, `Keycloak 26.8.2` prod + `keycloak-config-cli` + Group Sync + Backchannel Logout, `Orion-LD 1.12.0` + `MongoDB 7/8 --auth`, `ClamAV 1.5.5`, `Postgres 16.16`, `n8n 2.48` Postgres), cross-platform CI/scripts (remove `--context desktop-linux` hardcoding), real ephemeral-container DR + app boot verification, Trivy/CodeQL/Compose/E2E CI gates.
   - **Wave 3 (DB Indexes, Outbox Durability, Redis Realtime & UX):** Add 41 missing indexes, composite `(organizationId, code)` uniqueness, optimistic `version` locking, migration `down()`, Redis `PubSubManager` + SSE UI sync, Outbox `SKIP LOCKED` + backoff + DLQ replay.
   - **Wave 4 (Enterprise AI & IT/OT v4):** ACL-aware hybrid search (`tsvector` + `pgvector` + P.A.R.A. extraction citations), token/cost quota + PII redactor, Vietnamese Natural-Language Eval (`>=95%` across Admin/Employee/Manager), `timeseries-line` + Alarm Deduplication (`Ack`/`Clear`).
   - **Wave 5 (Enterprise Record Lifecycle & v0.2.0 Tag):** Record Chatter + immutable `Submit`/`Cancel`/`Amend` vouchers, column-RBAC PDF/XLSX export, GitOps Solution Bundle JSON, Command Palette `Cmd+K`, official `v0.2.0` release tag & cleanroom tarball.

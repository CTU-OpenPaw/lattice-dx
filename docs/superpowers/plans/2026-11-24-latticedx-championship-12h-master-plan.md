<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX v1.0.0 Championship 12-Hour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire every incomplete subsystem end-to-end across all 7 plugins and infrastructure configs (zero cuts, zero fake stubs), elevating LatticeDX into a self-healing Enterprise App Builder Agent platform backed by enforced PostgreSQL RLS, live OpenTelemetry/PITR, Stock n8n REST v1 external-app orchestration, real LLM telemetry, MapLibre GL WebGIS, ISO QR public tracking, and IndexedDB Mobile Field PWA.

**Architecture:** Preserve the 7 modular Apache-2.0 NocoBase 2.2.50 plugins (`sdkProvidedByHost: true`) alongside unmodified external OCI containers (`nocobase:2.2.50`, `n8n:2.48.1`, `pgvector:0.8.1-pg16`, `valkey:8.1-alpine`, `mosquitto:2.0.21`, `nodered:4.0.9`, `otel-collector-contrib:0.123.0`). Add reversible migrations starting at `20261127000100+`, bundle client UI libs via `esbuild` from plugin `devDependencies`, and isolate `client-v2` to `@nocobase/client-v2`.

**Tech Stack:** Node.js 24, pnpm 10.23.0, PostgreSQL 16 + pgvector + RLS, Valkey 8.1, NocoBase 2.2.50, Stock n8n 2.48.1 Public REST API v1, React 18/19 UMD externals, `@xyflow/react@12.12.1`, `maplibre-gl` (BSD-3-Clause), OpenTelemetry OTLP/HTTP JSON, ISO/IEC 18004 QR SVG, IndexedDB.

**Spec:** [docs/superpowers/specs/2026-11-24-latticedx-championship-12h-master-design.md](../specs/2026-11-24-latticedx-championship-12h-master-design.md)

## Global Constraints

1. Work ONLY inside `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` on branch `feat/v1.0.0-olp-championship`. Never modify `e:\pmnm2026`.
2. Never modify `n8nio/n8n:2.48.1` or `nocobase/nocobase:2.2.50` upstream code; never iframe-embed or white-label n8n (open n8n Editor in a new tab only).
3. Every created or modified source file must carry `@copyright (C) 2026 CTU-OpenPaw` and `SPDX-License-Identifier: Apache-2.0`. New npm dependencies must be Pure-OSI (`MIT`, `BSD-3-Clause`, or `Apache-2.0`) placed in plugin `devDependencies` only, preserving `"sdkProvidedByHost": true` and `react`/`react-dom`/`antd`/`@nocobase/client` host-externals.
4. Keep `plugins/nocobase/*/src/client-v2/index.js` dependent ONLY on `@nocobase/client-v2` (`node --test tests/nocobase-externals.test.mjs` must pass).
5. Preserve NocoBase Clause 5.2 attribution (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`) and ensure `git grep -in "copilot" -- . ":!docs/superpowers/*"` stays at `0` hits.
6. All new database migrations start at `20261127000100+`, implement `up()` and `down()`, and attach PostgreSQL RLS via `attachRlsPolicyToTable`.
7. Never log or commit secret values from `.env.agent` or `.env*`. Stop before `git push`, PR creation, or branch merge.

## Review Focus

1. Fail-closed `FORCE ROW LEVEL SECURITY` breaking NocoBase bootstrap/login/migrations or non-Postgres mock unit tests when `app.current_org` is unset -> must pass explicit `app.rls_bypass = 'on'` inside system/bootstrap transaction scopes while failing closed on unguarded tenant queries.
2. PostgreSQL `pitr.conf` loading without breaking stock container initialization (`pgvector:0.8.1-pg16` default `postgresql.conf`) -> must use `-c wal_level=replica -c archive_mode=on -c archive_command=...` or `include_if_exists` safely tested against `infra-compose-security.test.mjs`.
3. OAuth2 single-flight token refresh race conditions or SSRF bypass via internal connector allowlist -> internal service allowlist (`DX_ALLOW_INTERNAL_CONNECTORS=true`) must restrict strictly to named compose services (`n8n`, `orion-ld`, `nodered`, `mosquitto`) and block link-local/metadata/arbitrary RFC1918 targets.
4. Backward compatibility of the 17-tool MCP matrix & existing NL evaluation tests when expanding App Builder Agent capabilities -> existing tool names and contract tests stay passing while expanding actions and NL eval to `>= 100` cases.
5. `maplibre-gl` UMD/esbuild bundling under NocoBase runtime and pure offline fallback -> keep React/AntD/NocoBase externals unbundled, pass `tests/nocobase-externals.test.mjs` and `pnpm release:sbom -- --check`, and render offline WGS84 vector layers when tile fetches fail.

---

## Wave 1: Security, Enforced PG RLS, `prod.yml` Completeness, OTel, PITR, Workflow & Governance

### Task 1: Enforce Fail-Closed PostgreSQL RLS & Seal Tenant Leaks

**Files:**
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js:245-395`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/native-scope.js:45-60,265-300`
- Modify: `infra/config/postgres/init-prod.sh`
- Create: `infra/config/postgres/init-nocobase-db.sh`
- Modify: `infra/compose/prod.yml:117-158,449-505` and `infra/compose/prod.env.example`
- Create: `plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261127000100-force-rls-and-oauth2-connectors.js`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/pg-rls-and-observability.test.cjs`, `plugins/nocobase/plugin-lattice-foundation/tests/native-scope.test.cjs`

**Interfaces:**
- Produces: `withSystemRlsBypass(db, fn)` exported from `pg-rls.js`; `FORCE ROW LEVEL SECURITY` + fail-closed `lattice_tenant_isolation` policy on all 42 `TENANT_RLS_TABLES` + `latticeCustom*`; migration `20261127000100` adding OAuth2/App columns on `latticeConnectors` (`appType`, `capabilitiesJson`, `oauthConfigJson`, `oauthAccessTokenEnc`, `oauthRefreshTokenEnc`, `oauthTokenExpiresAt`, `oauthScope`, `oauthStateNonce`, `n8nCredentialId`).

- [ ] **Step 1: Write failing tests for fail-closed RLS SQL, system bypass helper, and restricted chart/collection tenant scopes**
  In `plugins/nocobase/plugin-lattice-foundation/tests/pg-rls-and-observability.test.cjs`, assert `buildRlsPolicySql('latticeOrders').enableSql` contains `FORCE ROW LEVEL SECURITY`, `createSql` includes `app.rls_bypass`, `createSql` does NOT contain fail-open `IS NULL`, and `withSystemRlsBypass` executes `SELECT set_config('app.rls_bypass', 'on', true)`. In `native-scope.test.cjs`, assert `charts:queryData` rejects non-root access to `latticeRecordChatter`, `latticeContextOutbox`, `latticeIntegrationInbox`, `latticeAgentProposals`, `latticeAiQuotaUsage`, `latticeUiSnapshots`.
- [ ] **Step 2: Run targeted tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-lattice-foundation/tests/pg-rls-and-observability.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/native-scope.test.cjs`
  Expected: FAIL on missing `FORCE ROW LEVEL SECURITY`, fail-open predicate present, and undefined `withSystemRlsBypass`.
- [ ] **Step 3: Harden `pg-rls.js` and `native-scope.js`**
  Update `buildRlsPolicySql` in `pg-rls.js` to emit `ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ALTER TABLE ... FORCE ROW LEVEL SECURITY;` and predicate `"organizationId" = current_setting('app.current_org', true) OR current_setting('app.current_org', true) = '*' OR current_setting('app.rls_bypass', true) = 'on'`. Export `withSystemRlsBypass(db, fn)` (transaction + `set_config('app.rls_bypass', 'on', true)`). Expand `SENSITIVE_CHART_COLLECTIONS` in `native-scope.js` to block non-root `charts:queryData` on all 7 sensitive tables (`latticeRecordChatter`, `latticeContextOutbox`, `latticeIntegrationInbox`, `latticeAgentProposals`, `latticeAiAuditLogs`, `latticeAiQuotaUsage`, `latticeUiSnapshots`, `latticeAiProfiles`, `latticeAiApprovalQueue`) and ensure direct `list`/`get`/`update`/`destroy` scope them strictly to `actor.organizationId`.
- [ ] **Step 4: Wire non-superuser `nocobase_app` role in `infra/compose/prod.yml`, `infra/config/postgres/init-nocobase-db.sh`, `prod.env.example`, and create migration `20261127000100`**
  Create `init-nocobase-db.sh` (LF line endings, SPDX Apache-2.0) creating `nocobase_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`) owning database `nocobase` so `nocobase` runs migrations/DDL yet cannot bypass `FORCE ROW LEVEL SECURITY`. Mount it in `prod.yml` `nocobase-db`, set `NOCOBASE_APP_DB_USER` on `nocobase`, document in `prod.env.example`. Create reversible migration `20261127000100-force-rls-and-oauth2-connectors.js` re-attaching `FORCE` RLS on all `TENANT_RLS_TABLES` and adding `latticeConnectors` OAuth2/n8n columns (`up` and `down`).
- [ ] **Step 5: Run tests to verify GREEN and commit**
  Run: `node --test plugins/nocobase/plugin-lattice-foundation/tests/pg-rls-and-observability.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/native-scope.test.cjs scripts/tests/infra-compose-security.test.mjs`
  Expected: PASS.
  Commit: `git add ... && git commit -m "feat(security): enforce fail-closed PG FORCE RLS, non-superuser DB role, and OAuth2 connector columns"`

---

### Task 2: Real OpenTelemetry OTLP/HTTP Telemetry & Real PostgreSQL PITR WAL Archiving

**Files:**
- Create: `plugins/nocobase/plugin-lattice-foundation/src/server/otel-exporter.js`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/index.js` and `observability.js`
- Modify: `apps/api/src/app.ts` and `apps/file-scanner/src/server.ts`
- Modify: `infra/config/postgres/pitr.conf`, `infra/compose/prod.yml:72-158,449-539,693-709`, `infra/compose/prod.env.example`, `scripts/stack-recovery.mjs`, `scripts/tests/stack-recovery.test.mjs`, `scripts/tests/infra-compose-security.test.mjs`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/otel-exporter.test.cjs`

**Interfaces:**
- Produces: `otel-exporter.js` exports `createOtelExporter({ serviceName, endpoint })`, `traceMiddleware()`, `recordSpan(span)`, `parseTraceparent(header)`, `formatTraceparent(traceId, spanId)`, `flushOtel()`, `getOtelStats()`; `/api/dxos:health` & `/api/dxos:metrics` include real OTel span/export metrics; `prod.yml` `postgres` and `nocobase-db` actively archive WAL via `pitr-archive.sh` into `postgres-wal-archive` volume.

- [ ] **Step 1: Write failing tests for OTLP exporter, traceparent propagation, bounded queue, and PITR compose/recovery wiring**
  In `plugins/nocobase/plugin-lattice-foundation/tests/otel-exporter.test.cjs`, test W3C `traceparent` parsing/generation, queuing spans, flushing OTLP/HTTP JSON (`resourceSpans`) to a mock `http.createServer` at `/v1/traces` without blocking requests or leaking `authorization`/`x-api-key` attributes, and clean drop under queue overflow (>256). Update `scripts/tests/infra-compose-security.test.mjs` and `scripts/tests/stack-recovery.test.mjs` to assert `archive_command=${PG_ARCHIVE_COMMAND:-/bin/sh /etc/postgresql/pitr-archive.sh %p %f}`, `postgres-wal-archive` volume, and `OTEL_EXPORTER_OTLP_ENDPOINT` in `prod.yml`.
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-lattice-foundation/tests/otel-exporter.test.cjs scripts/tests/infra-compose-security.test.mjs scripts/tests/stack-recovery.test.mjs`
  Expected: FAIL (`otel-exporter.js` missing, `prod.yml` still defaults `archive_command` to `/bin/true`).
- [ ] **Step 3: Implement `otel-exporter.js` and wire into `plugin-lattice-foundation`, `apps/api`, `apps/file-scanner`**
  Implement pure-Node OTLP/HTTP JSON exporter in `otel-exporter.js` (HTTP header redaction for secrets/tokens, `AbortSignal.timeout(2000)`, fail-silent when collector offline). Wire middleware in `plugin-lattice-foundation/src/server/index.js` + stats in `observability.js`. Add lightweight `traceparent` + OTLP push hook in `apps/api/src/app.ts` and `apps/file-scanner/src/server.ts`.
- [ ] **Step 4: Wire real WAL PITR in `pitr.conf`, `prod.yml`, `prod.env.example`, and `scripts/stack-recovery.mjs`**
  Configure `pitr.conf` with `archive_command = '/bin/sh /etc/postgresql/pitr-archive.sh %p %f'`, mount `postgres-wal-archive:/var/lib/postgresql/wal-archive` on `postgres` and `nocobase-db`, pass `-c include_if_exists=/etc/postgresql/pitr.conf` + default `${PG_ARCHIVE_COMMAND:-/bin/sh /etc/postgresql/pitr-archive.sh %p %f}`, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` on `nocobase`, and verify WAL archive dir readiness inside `scripts/stack-recovery.mjs`.
- [ ] **Step 5: Run tests to verify GREEN and commit**
  Run: `node --test plugins/nocobase/plugin-lattice-foundation/tests/otel-exporter.test.cjs scripts/tests/infra-compose-security.test.mjs scripts/tests/stack-recovery.test.mjs` & `pnpm --filter @dx/api test`
  Expected: PASS. Commit changes cleanly.

---

### Task 3: Fix `prod.yml` SSO/Valkey, IIoT/Mosquitto/Node-RED, APISIX, Caddy & `action-bridge`

**Files:**
- Modify: `plugins/nocobase/plugin-enterprise-auth/src/server/policy.js:13-26,164-173`
- Modify: `infra/compose/prod.yml`, `infra/compose/iiot.yml`, `infra/compose/prod.env.example`, `infra/config/nodered/settings.js`, `infra/config/apisix/apisix.prod.yaml`, `infra/config/caddy/Caddyfile`
- Modify: `plugins/nocobase/action-bridge/server.cjs`
- Test: `plugins/nocobase/plugin-enterprise-auth/tests/policy.test.cjs`, `plugins/nocobase/action-bridge/server.test.ts`, `scripts/tests/infra-compose-security.test.mjs`

**Interfaces:**
- Produces: `deploymentConfig` accepts `https://` public `DX_NATIVE_AUTH_ISSUER` paired with `http://keycloak:8080/...` `DX_NATIVE_AUTH_INTERNAL_ISSUER`; `resolveCacheOptions` honors `DX_NATIVE_AUTH_SESSION_REDIS_URL`; `prod.yml` connects `nocobase` to `iiot-net` + passes IIoT/n8n/internal-allowlist env vars; `Caddyfile` serves `{$N8N_DOMAIN}`; `action-bridge/server.cjs` degrades gracefully if env is unconfigured.

- [ ] **Step 1: Write failing tests for HTTPS issuer + internal backchannel, `DX_NATIVE_AUTH_SESSION_REDIS_URL`, graceful `action-bridge` load, and hardened `prod.yml` / `nodered` / `Caddyfile`**
  Add test cases in `policy.test.cjs` for `DX_NATIVE_AUTH_ISSUER='https://auth.latticedx.example.com/realms/lattice'` + `DX_NATIVE_AUTH_INTERNAL_ISSUER='http://keycloak:8080/realms/lattice'` and `DX_NATIVE_AUTH_SESSION_REDIS_URL='redis://:pw@redis:6379/2'`. Add Vitest test in `action-bridge/server.test.ts` verifying `load()` registers `dxActions:status` returning `503` `{ configured: false }` rather than crashing boot when `DX_BRIDGE_*` is absent. Update `infra-compose-security.test.mjs` for `N8N_DOMAIN`, `NODERED_CREDENTIAL_SECRET`, `DX_IIOT_INGEST_TOKEN` on `nocobase`, `iiot-net` connectivity, and APISIX `enterpriseAuth` route.
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-enterprise-auth/tests/policy.test.cjs scripts/tests/infra-compose-security.test.mjs` and `pnpm exec vitest run plugins/nocobase/action-bridge/server.test.ts`
  Expected: FAIL on HTTPS issuer + internal transport and `action-bridge` crash.
- [ ] **Step 3: Implement fixes in `policy.js`, `action-bridge/server.cjs`, `prod.yml`, `settings.js`, `apisix.prod.yaml`, `Caddyfile`, `prod.env.example`**
  Update `policy.js` (`resolveCacheOptions` + `deploymentConfig`), make `action-bridge/server.cjs` register degraded `dxActions` actions cleanly when unconfigured while preserving full strict behavior when configured, wire `iiot-net` + IIoT/n8n env vars + `n8n` `profiles: ["n8n"]` + `N8N_PUBLIC_API_DISABLED: "false"` in `prod.yml`, add `NODERED_CREDENTIAL_SECRET` & `NODERED_ADMIN_USER`/`NODERED_ADMIN_PASS_HASH` env support in `settings.js`, add `/api/enterpriseAuth:*` + `/api/dxosLedger:verifySignature` to `apisix.prod.yaml` (keeping `dxos-oidc-bridge` compatibility), and add `{$N8N_DOMAIN}` block to `Caddyfile`.
- [ ] **Step 4: Rebuild affected plugins and run verification**
  Run: `node plugins/nocobase/plugin-enterprise-auth/build.mjs && node plugins/nocobase/action-bridge/build.mjs && node --test plugins/nocobase/plugin-enterprise-auth/tests/*.test.cjs scripts/tests/infra-compose-security.test.mjs` and `pnpm exec vitest run plugins/nocobase/action-bridge/server.test.ts`
  Expected: PASS. Commit changes cleanly.

---

### Task 4: Wire `latticeflow.approval` HITL, Durable Snapshots/Payloads, Cron/Delay/Timeout Engine, `latticeDelegations` Enforcement & PAT Scope Lock

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-resource.js:55-65,580-780`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/migrations/20261127000300-flow-snapshot-and-schedule.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/cron.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/flow/executor.js`, `durable-store.js`, `nodes/control.js`, `automation-engine.js`, `delegation-engine.js`, `index.js`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/paas-api-keys.js`, `voucher-lifecycle.js`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs`, `plugins/nocobase/plugin-dxos-studio/tests/flow-executor.test.cjs`, `plugins/nocobase/plugin-dxos-studio/tests/wms-dmn-delegation.test.cjs`, `plugins/nocobase/plugin-lattice-foundation/tests/paas-pki-ledger.test.cjs`

**Interfaces:**
- Produces: `SUPPORTED_HITL_TOOLS` includes `'latticeflow.approval'`; `delegation-engine.js` exports `resolveEffectiveDelegatedRoles(db, { organizationId, userId, scope })`; `flow/cron.js` exports `matchesCron(expr, date)`, `computeNextCronRun(expr, fromDate)`; `paas-api-keys.js` denies mutating actions by non-`write` PATs when no resource-specific scope override exists.

- [ ] **Step 1: Write failing tests covering cross-plugin `latticeflow.approval` Approve/Reject -> `resumeFlowRun`, pinned graph snapshot + replay payload, `node.timeoutMs`, 5-field cron evaluator, delay/approval-expiry ticker, live `latticeDelegations` enforcement, and PAT narrow-scope mutation rejection**
- [ ] **Step 2: Run targeted tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/ai-resource-and-ui.test.cjs plugins/nocobase/plugin-dxos-studio/tests/flow-executor.test.cjs plugins/nocobase/plugin-dxos-studio/tests/wms-dmn-delegation.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/paas-pki-ledger.test.cjs`
  Expected: FAIL on `HITL_UNSUPPORTED_TOOL` for `latticeflow.approval`, missing cron/snapshot, un-enforced delegation, and missing PAT write guard.
- [ ] **Step 3: Implement HITL bridge, snapshot pinning, `timeoutMs`, cron/delay scheduler, delegation enforcement, and PAT scope lock**
  1. Add `'latticeflow.approval'` to `SUPPORTED_HITL_TOOLS` in `ai-resource.js`; implement Approve (`decision: 'approved'`) and Reject (`decision: 'rejected'`) invoking `plugin-dxos-studio`'s `resumeFlowRun`.
  2. Create migration `20261127000300` (`graphSnapshotJson`, `triggerPayloadJson` on `latticeAutomationRuns`; `cronExpression`, `nextRunAt` on `latticeAutomationRules` with `up`/`down`). Pin `graphSnapshotJson` on suspend, use it on resume, store `triggerPayloadJson` on run creation, and reuse it on `replayRun`.
  3. Implement `flow/cron.js` (`matchesCron`, `computeNextCronRun`), enforce `node.timeoutMs` in `flow/executor.js` (cleanup timer), and wire `DX_FLOW_DELAY_TICK_MS` default `15000` (with `'0'` disabling cleanly in unit tests) to tick `trigger.schedule`, `control.delay`, and overdue `control.approval` expiry under PG advisory lock.
  4. Implement `resolveEffectiveDelegatedRoles` in `delegation-engine.js` and enforce it in `ai-resource.js` HITL, `flow/durable-store.js` resume, and `voucher-lifecycle.js` (`submit`/`cancel`/`amend`), capturing `delegatedFromUserId` & `delegationUid` in audit & ledger metadata.
  5. Enforce `'write'` scope in `paas-api-keys.js` on default mutating routes lacking an explicit scoped guard (`iot`/`dmn`/`ai`/`ledger`/`read` cannot bypass writes).
- [ ] **Step 4: Run tests to verify GREEN and commit**
  Run all tests from Step 2 -> Expected: PASS. Commit changes cleanly.

---

### Task 5: Upgrade GitHub Actions CI & CodeQL Security Gates

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`

**Interfaces:**
- Produces: CI pipeline running SPDX header check, `pof:check`, `release:sbom -- --check`, `eval-vietnamese-nl-agent`, `pnpm audit --prod --audit-level=low`, and brand check alongside `pnpm check` and `node --test`.

- [ ] **Step 1: Inspect `.github/workflows/ci.yml` and `.github/workflows/codeql.yml` and update workflow steps & branches**
- [ ] **Step 2: Validate YAML syntax + `pnpm pof:check` + Wave 1 full gate**
  Run: `pnpm check && node --test plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs plugins/nocobase/plugin-enterprise-auth/tests/*.test.cjs plugins/nocobase/plugin-dxos-studio/tests/*.test.cjs plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs scripts/tests/infra-compose-security.test.mjs scripts/tests/stack-recovery.test.mjs && pnpm pof:check`
  Expected: PASS. Commit Wave 1 CI changes.

---

## Wave 2: Pillar 2 — Stock n8n Public REST API v1, OAuth2 Vault, 1-Stop Connected Apps Hub & Flagship Enterprise Use Case

### Task 6: Stock n8n Public REST API v1 Client & OAuth2 PKCE + Single-Flight Refresh in Vault

**Files:**
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/server/connector-vault.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/n8n-api-client.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/automation-engine.js` and `index.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/n8n-api-client.test.cjs`, `plugins/nocobase/plugin-lattice-foundation/tests/vault-and-event-bus.test.cjs`

**Interfaces:**
- Produces: `connector-vault.js` exports `APP_CONNECTOR_CATALOG`, `oauthStart`, `oauthCallback`, `getFreshConnectorToken(db, connectorId, deps)` (single-flight lock, refreshes 180s early); `n8n-api-client.js` exports `createN8nApiClient({ baseUrl, apiKey, fetchFn })` with `healthCheck`, `listWorkflows`, `getWorkflow`, `createWorkflow`, `updateWorkflow`, `activateWorkflow`, `listExecutions`, `getExecution`, `retryExecution`, `listCredentials`, `createCredential`, `syncConnectorCredentialToN8n`; resource `dxosN8n` (`status`, `appCatalog`, `workflows`, `getWorkflow`, `createWorkflow`, `updateWorkflow`, `activateWorkflow`, `executions`, `retryExecution`, `syncCredential`).

- [ ] **Step 1: Write failing tests for OAuth2 PKCE + single-flight concurrent refresh (only 1 upstream refresh call for 5 concurrent waiters!), strict internal-service allowlist (`n8n`/`orion-ld`/`nodered` vs blocking `169.254.169.254` & arbitrary RFC1918), and all `n8n-api-client.js` REST v1 methods & RBAC guards**
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/n8n-api-client.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/vault-and-event-bus.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Implement Vault OAuth2 + `n8n-api-client.js` + `dxosN8n` routes**
  Implement AES-256-GCM encrypted OAuth2 token persistence, PKCE `S256`, single-flight refresh mutex (`Promise` cache keyed by `connectorId` + 180s buffer), named internal host allowlist (`DX_INTERNAL_SERVICE_HOSTS`), and full Stock n8n Public REST API v1 client (`X-N8N-API-KEY` + `Idempotency-Key`) mounted on `dxosN8n:*` for `root`/`admin`/`ldx_admin`.
- [ ] **Step 4: Run tests to verify GREEN and commit**
  Run tests from Step 2 -> Expected: PASS. Commit cleanly.

---

### Task 7: Unified 1-Stop "Connected Apps & n8n" UI Hub (Activepieces/Odoo Pattern)

**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/connected-apps-panel.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/flow/n8n-setup-modal.js`, `src/client/index.js`, `src/client/builder-broker-panels.js`, `src/client/studio-settings.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs`, `plugins/nocobase/plugin-dxos-studio/tests/builder-broker-ui.test.cjs`

**Interfaces:**
- Produces: `ConnectedAppsPanel` rendered inside `Workflow -> Connectors & n8n` combining App Catalog cards (`telegram`, `email_smtp`, `gmail_oauth2`, `google_sheets_oauth2`, `slack`, `discord`, `teams`, `github`, `rustfs_s3`, `n8n_api`, `partner_webhook`), OAuth2 / Token connect wizard modal, `Kiểm tra` & `Đồng bộ sang n8n`, and Live Stock n8n Workflows + Executions + `Retry` + external `Mở trên n8n Editor ↗` link (removing duplicate connector form from Studio Tab 8 in favor of deep-link).

- [ ] **Step 1: Write failing UI unit tests verifying `ConnectedAppsPanel` renders App Catalog cards, capability badges, OAuth2/API Key modal hooks, live `dxosN8n:workflows` & `dxosN8n:executions` + `retryExecution`, and Studio Tab 8 no longer duplicates Connector setup**
- [ ] **Step 2: Run UI tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs plugins/nocobase/plugin-dxos-studio/tests/builder-broker-ui.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Implement `connected-apps-panel.js`, update `n8n-setup-modal.js` to load live `dxosN8n:workflows`, wire into `Workflow -> Connectors & n8n`, and deduplicate Studio Tab 8**
- [ ] **Step 4: Build `plugin-dxos-studio` and run UI tests to verify GREEN**
  Run: `node plugins/nocobase/plugin-dxos-studio/build.mjs && node --test plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs plugins/nocobase/plugin-dxos-studio/tests/builder-broker-ui.test.cjs`
  Expected: PASS. Commit cleanly.

---

### Task 8 & Task 9: Heavyweight 22-Node 2-Way Enterprise n8n Use Case (`Cold-Chain Incident-to-Partner Settlement`) + Builder Business Pack

**Files:**
- Modify: `infra/config/n8n/dxos-enterprise-compliance-orchestrator.json`
- Create: `infra/config/n8n/dxos-enterprise-error-handler.json`
- Create: `infra/config/n8n/dxos-external-app-inbound-callback.json`
- Modify: `infra/config/n8n/dxos-coldchain-alert-orchestrator.json`, `dxos-epod-partner-sync.json`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/flow/blueprints/enterprise-n8n-compliance.json`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/domain-builder.js` (`BUSINESS_PACK_CATALOG` adds `coldchain-partner-settlement`)
- Modify: `scripts/seed-v100-championship-showcase.mjs`
- Test: `scripts/tests/n8n-native-flows.test.mjs`, `plugins/nocobase/plugin-dxos-studio/tests/domain-builder.test.cjs`

**Interfaces:**
- Produces: 22+ node Stock n8n workflow with HMAC verification, risk/DMN evaluation, parallel internal sync (PKI Ledger, Orion-LD, Node-RED) + parallel real external-app branches (`Telegram`, `SMTP Email`, `Google Sheets / Partner Ledger`, `Slack/GitHub`), `retryOnFail: true`, `saveDataErrorExecution: "all"`, `Error Trigger` handler workflow, 2-way inbound external callback workflow, and 1-click `coldchain-partner-settlement` business pack in `domain-builder.js`.

- [ ] **Step 1: Write failing tests in `scripts/tests/n8n-native-flows.test.mjs` and `domain-builder.test.cjs`**
  Assert orchestrator has `>= 20` nodes including real external-app node types/branches (Telegram, Email/SMTP, Google Sheets, Slack/GitHub/Partner), `saveDataErrorExecution: "all"`, `retryOnFail: true` on external HTTP/app nodes, presence/structure of `dxos-enterprise-error-handler.json` (`n8n-nodes-base.errorTrigger`) and `dxos-external-app-inbound-callback.json` (verifies callback & updates NocoBase via `ldx_pat_*`), and `coldchain-partner-settlement` installable via `installBusinessPack`.
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test scripts/tests/n8n-native-flows.test.mjs plugins/nocobase/plugin-dxos-studio/tests/domain-builder.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Upgrade n8n workflow JSONs, blueprint, `coldchain-partner-settlement` pack (`latticeCustomPartnerClaims` + DMN table + LatticeFlow v2 + `/p/partner-claims`), and showcase seeder**
- [ ] **Step 4: Run tests + rebuild `plugin-dxos-studio` to verify GREEN and commit Wave 2**
  Run: `node plugins/nocobase/plugin-dxos-studio/build.mjs && node --test scripts/tests/n8n-native-flows.test.mjs plugins/nocobase/plugin-dxos-studio/tests/*.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/*.test.cjs`
  Expected: PASS. Commit cleanly.

---

## Wave 3: Pillar 0 (North Star) — Enterprise App Builder Agent, Real LLM Telemetry & Flexible PARA RAG

### Task 10: Full-Stack App Builder Agent + Deterministic Verifier & Self-Healing Orchestrator

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-tools-core.js` (`ALLOWED_BLOCK_MODELS` + WebGIS/Kanban)
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-builder-tools.js` (`belongsTo`/`json` fields, fix `aiAssist` `AbortError` -> `LLM_TIMEOUT`, 45s timeout)
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/n8n-bridge-tool.js` (add `list_n8n_workflows`, `create_n8n_workflow`, `update_n8n_workflow`, `activate_n8n_workflow`, `list_n8n_executions`, `retry_n8n_execution`, `sync_n8n_credential`, `list_connected_apps`)
- Create: `plugins/nocobase/plugin-dxos-ai/src/server/app-builder-orchestrator.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-nl-router.js`, `ai-schemas.js`, `src/client/portal-agent-launcher.js`
- Test: `plugins/nocobase/plugin-dxos-ai/tests/app-builder-orchestrator.test.cjs`, `plugins/nocobase/plugin-dxos-ai/tests/ai-builder-tools.test.cjs`, `scripts/eval-vietnamese-nl-agent.mjs`

**Interfaces:**
- Produces: `app-builder-orchestrator.js` exports `orchestrateEnterpriseAppBuild(ctx, db, actor, spec, deps)` and `verifyEnterpriseApp(ctx, db, actor, target, deps)` implementing: pre-build `Snapshot` -> collection + relations + PG RLS + OpenAPI -> RBAC + Multi-Portal pages (all 10 BlockModels) -> DMN table -> LatticeFlow v2 DAG -> Stock n8n external-app workflow -> Deterministic Verifier (`checks[]`) -> 2-round targeted Self-Healing (`repairs[]`). Preserves 17-tool matrix names (`dxos_provision_role_workspace` adds `operation: 'build_enterprise_app' | 'verify_app'`; `dxos_configure_workflow` adds `dmn_*` and `n8n_*` operations; `portal-agent-launcher.js` forwards full `nodeSummary`).

- [ ] **Step 1: Write failing tests for App Builder Orchestrator (full build + intentional failure in verify -> auto self-heal PASS on round 2), `belongsTo`/`json` field creation, `DxosWebGisBlockModel`/`DxosKanbanScheduleBlockModel` placement, `aiAssist` timeout (`LLM_TIMEOUT` vs refusal), `portal-agent-launcher` `nodeSummary`, full 2-way n8n agent actions, and expanded `>= 100` case NL eval**
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/app-builder-orchestrator.test.cjs plugins/nocobase/plugin-dxos-ai/tests/ai-builder-tools.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Implement Task 10 components & update NL router/eval (`>= 100` Vietnamese NL test cases)**
- [ ] **Step 4: Run tests + `node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95` -> must hit 100%, and commit**

---

### Task 11: Real LLM Calls (`ai.agent` Node & Proactive Triage) & Real Provider Token Usage Telemetry

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/ai.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/proactive-triage.js`, `ai-governance.js`, `ai-tools-core.js`, `ai-schemas.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-nodes.test.cjs`, `plugins/nocobase/plugin-dxos-ai/tests/proactive-triage.test.cjs`, `plugins/nocobase/plugin-dxos-ai/tests/ai-governance.test.cjs` (or existing governance test)

**Interfaces:**
- Produces: `ai.agent` node and `proactive-triage.js` execute real LLM gateway via `callLlmJson` with deterministic offline fallback tagged `mode: 'llm' | 'offline_fallback'`; `recordAiAuditLog` & quota accounting accept `usage: { promptTokens, completionTokens, totalTokens }` recording `tokenSource: 'provider' | 'estimated'`.

- [ ] **Step 1: Write failing tests verifying real LLM invocation + usage capture (`tokenSource: 'provider'`) and clean offline fallback (`tokenSource: 'estimated'`, `mode: 'offline_fallback'`) in `ai.agent`, `proactive-triage.js`, and `ai-governance.js`**
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-nodes.test.cjs plugins/nocobase/plugin-dxos-ai/tests/proactive-triage.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Implement real LLM paths & authentic token telemetry**
- [ ] **Step 4: Run tests to verify GREEN and commit**

---

### Task 12: Complete `plugin-dxos-para` (Flexible `pgvector`, Batched Embeddings, Vietnamese PDF CMap, Client UI)

**Files:**
- Create: `plugins/nocobase/plugin-dxos-para/src/server/migrations/20261127000200-para-flexible-vector-dimension.js`
- Modify: `plugins/nocobase/plugin-dxos-para/src/server/para-hybrid-search.js`, `document-extractor.js`, `para-resource.js`, `src/client/index.js`
- Test: `plugins/nocobase/plugin-dxos-para/tests/para-hybrid-search.test.cjs`, `plugins/nocobase/plugin-dxos-para/tests/para-chunking-and-extractor.test.cjs`, `plugins/nocobase/plugin-dxos-para/tests/ocr-office-autofill.test.cjs`

**Interfaces:**
- Produces: Flexible un-locked `vector` storage supporting `DX_EMBEDDING_DIM` (default `1536`, accepts `768`/`1024`/`1536` matching embedding vector length), batched embedding calls (`<= 16` inputs/request), logged retry metadata on `afterCommit` failures, PDF `ToUnicode` CMap UTF-8 Vietnamese decoder, and client route/settings UI `/admin/settings/dxos-para` for P.A.R.A. index health & OCR test.

- [ ] **Step 1: Write failing tests for non-1536 (768-dim) batched embeddings, PDF `ToUnicode` CMap Vietnamese text (`Kho lạnh Cần Thơ`), and non-empty `plugin-dxos-para` client plugin registration**
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-para/tests/*.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Implement Task 12 across migration, search, PDF decoder, and client UI; rebuild `plugin-dxos-para`**
- [ ] **Step 4: Run tests (`plugin-dxos-para`, `plugin-dxos-ai`, `plugin-dxos-studio`) + `eval-vietnamese-nl-agent` -> PASS, commit Wave 3**

---

## Wave 4: Pillar 3 — MapLibre WebGIS, ISO QR SVG, Public `/track/:code`, Visual DMN, Operational Portals & Mobile PWA

### Task 13: Real `MapLibre GL JS` WebGIS + Native Clustering + Offline WGS84 Vector Fallback + Desktop Twin Control

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-blocks/package.json` (add `maplibre-gl`, `esbuild` to `devDependencies`)
- Modify: `plugins/nocobase/plugin-dxos-blocks/build.mjs` (esbuild UMD wrapper matching `plugin-dxos-studio/build.mjs`, inline `maplibre-gl/dist/maplibre-gl.css`)
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/webgis-block.js`
- Test: `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`, `tests/nocobase-externals.test.mjs`, `scripts/tests/generate-sbom.test.mjs`

**Interfaces:**
- Produces: `DxosWebGisBlockModel` renders interactive `maplibre-gl` canvas with GeoJSON `FeatureCollection` `setData()`, `cluster: true`, cold-chain corridor lines, offline WGS84 vector fallback style, unlimited asset markers (no 6-asset cap), and marker-click Desktop Digital Twin Drawer invoking `dxosBlocks:twinSetDesired` (with HITL feedback when `|delta| > 2.0°C`).

- [ ] **Step 1: Add `maplibre-gl` & `esbuild` to `plugins/nocobase/plugin-dxos-blocks/package.json` `devDependencies` and run `pnpm install`** (Verify OSI `BSD-3-Clause`/`MIT` and `pnpm audit --prod --audit-level=low` clean!)
- [ ] **Step 2: Write failing tests for unlimited assets (>6), GeoJSON corridor conversion, offline fallback mode, and Desktop Twin setpoint control handler in `ui-v100-blocks.test.cjs`**
- [ ] **Step 3: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`
  Expected: FAIL.
- [ ] **Step 4: Upgrade `plugin-dxos-blocks/build.mjs` to `esbuild` host-external UMD bundler and implement `maplibre-gl` + offline fallback + Twin Control Drawer in `webgis-block.js`**
- [ ] **Step 5: Run `node plugins/nocobase/plugin-dxos-blocks/build.mjs`, `ui-v100-blocks.test.cjs`, `tests/nocobase-externals.test.mjs`, `pnpm release:sbom` -> PASS, commit cleanly**

---

### Task 14: ISO QR SVG Generator + Clean Printable Voucher + Public Zero-PII `/track/:code` Page

**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/qr-svg.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/wms-engine.js` (`printVoucher`)
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/chatter-panel.js` (fix sandboxed print)
- Create: `plugins/nocobase/plugin-lattice-foundation/src/client-v2/public-track-page.js`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/client-v2/index.js`, `src/client/index.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/qr-svg.test.cjs`, `plugins/nocobase/plugin-dxos-studio/tests/wms-dmn-delegation.test.cjs`, `plugins/nocobase/plugin-lattice-foundation/tests/public-track-page.test.cjs`

**Interfaces:**
- Produces: `qr-svg.js` exports `encodeQrMatrix(text)` & `renderQrSvg(text, { size })`; `printVoucher` embeds `<svg>` QR code linking `/v/track/<code>?token=...` + ePOD signature image; `chatter-panel.js` cleanly prints only the isolated voucher HTML; `/v/track/:code` & `/track/:code` render zero-PII shipment + Ed25519 signature verification button.

- [ ] **Step 1: Write failing tests for ISO QR SVG matrix validity &finder patterns, `printVoucher` SVG + signature output, safe printable flow, and `public-track-page.js` rendering zero-PII + verifySignature flow**
- [ ] **Step 2: Run tests to verify RED**
  Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/qr-svg.test.cjs plugins/nocobase/plugin-dxos-studio/tests/wms-dmn-delegation.test.cjs plugins/nocobase/plugin-lattice-foundation/tests/public-track-page.test.cjs`
  Expected: FAIL.
- [ ] **Step 3: Implement `qr-svg.js`, update `wms-engine.js` + `chatter-panel.js`, create `public-track-page.js`, wire routes cleanly**
- [ ] **Step 4: Rebuild `plugin-dxos-studio`, `plugin-dxos-blocks`, `plugin-lattice-foundation` and run tests -> PASS, commit cleanly**

---

### Task 15: Visual Interactive DMN Decision Table Studio + Operational WMS/Bulk-Import Block on `/p/logistics`

**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/dmn-visual-editor.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/governance-consoles.js`
- Create: `plugins/nocobase/plugin-dxos-blocks/src/client/wms-ops-block.js`
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/block-models.js`, `plugins/nocobase/plugin-dxos-studio/src/server/portal-composer.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/builder-broker-ui.test.cjs`, `plugins/nocobase/plugin-dxos-blocks/tests/ui-v100-blocks.test.cjs`

**Interfaces:**
- Produces: `DmnVisualEditor` interactive grid with Live Test Simulator; `DxosWmsOpsBlockModel` (exposed in `block-models.js` + attached onto `/p/logistics` via `portal-composer.js` and `ALLOWED_BLOCK_MODELS`) providing FEFO allocation, `issueStock`, `holdLotByMkt`, and 2-Phase Bulk Import Wizard directly to warehouse operators.

- [ ] **Step 1: Write failing tests for Visual DMN grid rule add/edit/simulate row highlight and `DxosWmsOpsBlockModel` FEFO/Bulk-Import interactions**
- [ ] **Step 2: Run tests to verify RED**
- [ ] **Step 3: Implement `dmn-visual-editor.js`, integrate into `governance-consoles.js`, implement `wms-ops-block.js`, register in `block-models.js` & `portal-composer.js` + `ai-tools-core.js`**
- [ ] **Step 4: Rebuild affected plugins and run tests -> PASS, commit cleanly**

---

### Task 16: Fix UI/Data Bugs, Topbar SSE Bell, Event Consistency & Multi-Tenant Un-Hardcoding

**Files:**
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/creative-studio-block.js` (`meta.count`)
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/kanban-schedule-block.js` (`unscheduled` bucket)
- Modify: `plugins/nocobase/plugin-dxos-blocks/src/client/command-palette.js` (unconditional React hooks + `?paraDocId=`) & `block-models.js`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/client/notification-bell.js` (Topbar mount + SSE subscription + `/v/mobile` badge)
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/wms-engine.js`, `automation-engine.js` (`epod.captured` / `epod.signed` consistency)
- Modify: Multi-tenant `'native-ui-lab'` & `role.startsWith('ldx_')` hardcoded spots across `plugin-lattice-foundation`, `plugin-dxos-studio`, `plugin-dxos-blocks`, `plugin-dxos-ai` + hide legacy `/lattice/*` links from active portal menus while preserving `apps/api` & `packages/contracts`
- Test: add regression tests covering `meta.count`, `unscheduled` kanban items, hook order safety, custom enterprise role visibility, and multi-tenant org context

- [ ] **Step 1: Write failing regression tests for each fix (`creative-studio`, `kanban`, `command-palette`, `notification-bell` SSE, multi-tenant non-`native-ui-lab` org & non-`ldx_` custom role)**
- [ ] **Step 2: Run tests to verify RED**
- [ ] **Step 3: Implement all Task 16 fixes cleanly across plugins**
- [ ] **Step 4: Rebuild plugins and run all regression tests -> PASS, commit cleanly**

---

### Task 17: Production Mobile Field PWA (`/v/mobile`) — IndexedDB, Camera Photo, Cross-Platform QR & Outbox Inspector

**Files:**
- Create: `plugins/nocobase/plugin-lattice-foundation/src/client-v2/mobile-offline-db.js`
- Modify: `plugins/nocobase/plugin-lattice-foundation/src/client-v2/mobile-field-pwa.js` and `src/client-v2/index.js`
- Test: `plugins/nocobase/plugin-lattice-foundation/tests/mobile-field-pwa.test.cjs`

**Interfaces:**
- Produces: `mobile-offline-db.js` IndexedDB queue (`enqueueOutboxItem`, `listOutboxItems`, `removeOutboxItem`, `updateOutboxStatus` with `localStorage`/memory fallback for unit tests); `/v/mobile` supports camera photo capture (`evidencePhotoDataUrl`), `BarcodeDetector` + camera canvas fallback QR scan, Outbox Inspector drawer, notification badge, and zero route conflicts.

- [ ] **Step 1: Write failing tests for IndexedDB queue fallback, photo attachment persistence in ePOD payload, manual/camera QR fallback, Outbox Inspector retry/delete, and notification count**
- [ ] **Step 2: Run tests to verify RED**
- [ ] **Step 3: Implement `mobile-offline-db.js` and upgrade `mobile-field-pwa.js`**
- [ ] **Step 4: Rebuild all 7 plugins (`build.mjs`) and run Wave 4 full gate (`pnpm check`, all `node --test`, `pnpm release:sbom`, `pnpm pof:check`) -> PASS, commit Wave 4 cleanly**

---

## Wave 5: Live Stack E2E Verification, Flagship Use Case Proof, Zero-Lie Docs/SBOM Sync & 8-Gate Audit

### Task 18: Live Stack Acceptance, Flagship n8n + App Builder Verification, Docs Sync & Final 8-Gate Audit

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/olp-2026-architecture-matrix.md`, `docs/FINALS_15MIN_SCRIPT.md`, `docs/dx-os-minimum-design.md`, `docs/oss-pof-compliance.md`, `docs/third-party.md`, `docs/dependency-inventory.md`, `docs/sbom-cyclonedx.json`
- Modify: `scripts/acceptance-headless-paas.mjs`, `scripts/acceptance-dxos-ai-mcp.mjs`, `scripts/acceptance-broker-automation-builder.mjs`

- [ ] **Step 1: Update live acceptance scripts to cover `latticeflow.approval` HITL, OAuth2/n8n API v1 + 22-node workflow, App Builder Agent self-healing synthesis, `publicTrack` QR/Ed25519, and `enforceDelegations`**
- [ ] **Step 2: Boot isolated live Docker rehearsal (`nocobase:2.2.50` + `n8n:2.48.1`), run `seed:v100-showcase`, verify live acceptance suites & headless browser check across App Builder Agent, Connected Apps & n8n, MapLibre GIS + Desktop Twin, Printable QR + `/v/track/:code`, and `/v/mobile`**
- [ ] **Step 3: Perform clean Docker teardown (`docker ps` clean) so host RAM/ports remain pristine**
- [ ] **Step 4: Update all docs, `CHANGELOG.md`, `README.md`, `FINALS_15MIN_SCRIPT.md`, `olp-2026-architecture-matrix.md`, and regenerate `docs/sbom-cyclonedx.json` (`pnpm release:sbom`) + source headers (`node scripts/source-headers.mjs --write`)**
- [ ] **Step 5: Run ALL 8 Final Verification Gates fresh on final commit HEAD (`pnpm check`, full `node --test` across plugins/scripts/externals, `eval-vietnamese-nl-agent --min-pass=95`, `pnpm release:sbom -- --check`, `pnpm pof:check`, `source-headers --check`, `pnpm audit --prod --audit-level=low`, `git grep -in "copilot"`) + confirm `git status` clean (NO `git push`)**

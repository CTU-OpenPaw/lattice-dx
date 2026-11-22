<!--
  @file LatticeDX — Open Digital Enterprise Platform
  @author CTU-OpenPaw
  @copyright (C) 2026 CTU-OpenPaw
  @license Apache-2.0
  @see https://github.com/CTU-OpenPaw/lattice-dx
  SPDX-License-Identifier: Apache-2.0
-->

# LatticeDX v0.2.0 — Wave 3 Implementation Plan (PostgreSQL Indexes, Optimistic Locking, Durable Outbox + DLQ UI, Realtime SSE/PubSub & Enterprise Auth)

> **Goal:** Eliminate all High/Medium database indexing, global unique-key collision, concurrent overwrite, blocking outbox/upload lock, surface polling, and stateless/revocation gaps across the NocoBase plugin suite (`plugin-lattice-foundation`, `plugin-dxos-para`, `plugin-dxos-studio`, `plugin-dxos-ai`, `plugin-dxos-blocks`, `plugin-enterprise-auth`).
> **Discipline:** Strict TDD (`superpowers:test-driven-development`), reversible `up()` + `down()` migrations, SPDX Apache-2.0 headers verified via `node scripts/source-headers.mjs --check`, `pnpm pof:check` PASS (`6/6`), and live Docker `localhost:13014` verification.

---

### Task 3.1: Database Indexes (45 Composite Indexes), Tenant-Scoped Uniqueness, Optimistic Locking (`version`), & Reversible Migrations (`down()`)
- **Files:**
  - Modify schemas/collections: `plugin-lattice-foundation/src/server/{schema.js,integration-schema.js,collections/context-outbox.js,native-scope.js}`, `plugin-dxos-para/src/server/{schema.js,para-scope.js}`, `plugin-dxos-studio/src/server/{service-schema.js,service-scope.js}`, `plugin-dxos-ai/src/server/ai-schemas.js`
  - Rename duplicate-timestamp migrations (`git mv`): `20261106000100-native-integration.js` -> `20261106000110-native-integration.js`, `20261106000200-integration-tools-permission.js` -> `20261106000210-integration-tools-permission.js`
  - Add reversible `down()` methods to all 15 existing migrations
  - Create 4 new index/uniqueness/column migrations (`20261122000100`..`20261122000400`)
  - Tests: `plugins/nocobase/plugin-lattice-foundation/tests/migrations-and-indexes.test.cjs`, update `native-scope.test.cjs`, `para-space.test.cjs`, `studio-resource.test.cjs`

### Task 3.2: Outbox Durability (`SKIP LOCKED`, Non-Blocking HTTP, Exponential Backoff + Jitter, DLQ Replay UI) & Upload/Reader Hardening
- **Files:**
  - Modify: `native-context-delivery.js`, `native-shared-upload.js`, `native-request-attachments.js`, `native-integration-reader.js`, `plugin-dxos-studio/src/server/studio-resource.js`, `plugin-dxos-studio/src/client/studio-settings.js`
  - Tests: `native-context-delivery.test.cjs`, `native-shared-upload.test.cjs`, `native-integration-reader.test.cjs`, `studio-resource.test.cjs`, `studio-client.test.cjs`

### Task 3.3: Realtime SSE / Redis PubSub UI Sync (Zero Polling Loops & Zero Destructive Reloads)
- **Files:**
  - Create: `plugin-dxos-ai/src/server/surface-events.js`, `plugin-dxos-ai/tests/surface-events.test.cjs`
  - Modify: `ai-surface-creative-tools.js`, `ai-resource.js`, `plugin-dxos-ai/src/server/index.js`, `portal-agent-launcher.js`, `plugin-dxos-blocks/src/client/creative-studio-block.js`, `ai-resource-and-ui.test.cjs`

### Task 3.4: `plugin-enterprise-auth` Hardening — Redis Session Store, Keycloak Backchannel Logout, Group→Role Sync & Unlink Mapping UI
- **Files:**
  - Modify: `plugin-enterprise-auth/src/server/{index.js,policy.js,oidc.js,routes.js}`, `plugin-enterprise-auth/src/client/index.js`, `infra/config/keycloak/lattice-realm.prod.json`
  - Tests: `plugin-enterprise-auth/tests/{policy.test.cjs,routes.test.cjs}`

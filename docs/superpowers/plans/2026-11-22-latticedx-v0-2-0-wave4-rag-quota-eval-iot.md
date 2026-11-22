<!--
  @file LatticeDX — Open Digital Enterprise Platform
  @author CTU-OpenPaw
  @copyright (C) 2026 CTU-OpenPaw
  @license Apache-2.0
  @see https://github.com/CTU-OpenPaw/lattice-dx
  SPDX-License-Identifier: Apache-2.0
-->

# LatticeDX v0.2.0 — Wave 4 Implementation Plan (ACL Hybrid Search, AI Quota & PII Redactor, Vietnamese NL Eval >=95%, Time-Series Telemetry & Alarm Deduplication)

> **Goal:** Upgrade LatticeDX knowledge retrieval, AI safety/economics governance, Vietnamese natural-language accuracy, and IoT operational observability across `plugin-dxos-para`, `plugin-dxos-ai`, `plugin-dxos-blocks`, and `plugin-lattice-foundation`.
> **Discipline:** Strict TDD (`superpowers:test-driven-development`), reversible `up()`/`down()` migrations guarded safely for both Postgres 16 + `pgvector/pgvector:0.8.1-pg16`, zero cross-plugin relative `require(...)`, SPDX Apache-2.0 headers (`source-headers`), `pnpm pof:check` (`6/6`), and live Docker `localhost:13014` verification.

---

### Task 4.1: ACL-Aware Hybrid Search (`tsvector` + `pgvector`/RRF + P.A.R.A. Citations)
- **Create:** `plugin-dxos-para/src/server/para-hybrid-search.js`, `plugin-dxos-para/src/server/migrations/20261122000500-para-hybrid-search-indexes.js`, `plugin-dxos-para/tests/para-hybrid-search.test.cjs`, `plugin-dxos-ai/src/server/ai-hybrid-search.js`
- **Modify:** `plugin-dxos-para/src/server/{schema.js,para-resource.js,index.js}`, `plugin-dxos-ai/src/server/ai-copilot-tools.js`

### Task 4.2: AI Token/Cost Quota Governance & Vietnamese PII Redactor
- **Create:** `plugin-dxos-ai/src/server/ai-governance.js`, `plugin-dxos-ai/src/server/migrations/20261122000600-ai-audit-quota-columns.js`, `plugin-dxos-ai/tests/ai-governance.test.cjs`
- **Modify:** `plugin-dxos-ai/src/server/{ai-schemas.js,ai-tools-core.js,ai-resource.js}`

### Task 4.3: Vietnamese Natural-Language Router & Automated `>= 95%` Eval Suite
- **Create:** `plugin-dxos-ai/src/server/ai-nl-router.js`, `plugin-dxos-ai/tests/vietnamese-nl-eval.test.cjs`, `scripts/eval-vietnamese-nl-agent.mjs`

### Task 4.4: Time-Series Line Telemetry Widget (`timeseries-line`) & Alarm Deduplication (`Ack`/`Clear`)
- **Create:** `plugin-dxos-blocks/src/server/alarm-engine.js`, `plugin-lattice-foundation/src/server/migrations/20261122000700-incident-alarm-dedup-columns.js`, `plugin-dxos-blocks/tests/alarm-and-timeseries.test.cjs`
- **Modify:** `plugin-lattice-foundation/src/server/schema.js`, `plugin-dxos-blocks/src/server/{blocks-api.js,index.js}`, `plugin-dxos-blocks/src/client/creative-studio-block.js`, `plugin-dxos-ai/src/server/ai-surface-creative-tools.js`

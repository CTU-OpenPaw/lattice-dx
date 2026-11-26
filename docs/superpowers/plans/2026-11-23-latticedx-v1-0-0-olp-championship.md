<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeDX v1.0.0 — OLP PMNM 2026 Championship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task cleanly with strict TDD and per-task code review.

**Goal:** Nâng cấp LatticeDX lên `v1.0.0` (DX-OS Open-Core Championship Edition) phủ trọn 3 tầng & 4 không gian H–P–D–I + OMS/WMS/TMS + 50/50 PoF theo đúng Đề thi OLP PMNM 2026.

**Architecture:** Mở rộng trên nền Single-Engine NocoBase `2.2.50` + 7 Plugin Apache-2.0 (`sdkProvidedByHost: true`, `0` runtime npm deps mới) với migration SQL thuận nghịch có PG RLS, API Gateway Zero-Trust APISIX + Grafana 360°, sổ cái mật mã Ed25519 + SHA-256/Merkle, chuỗi lạnh FEFO/MKT/ePOD/WebGIS/Digital Twin 2 chiều, Mobile PWA, OCR + GraphRAG + Proactive HITL Agent, Solution Bundle v3 và CycloneDX SBOM.

**Spec:** [2026-11-23-latticedx-v1-0-0-olp-championship-design.md](../specs/2026-11-23-latticedx-v1-0-0-olp-championship-design.md)

## Global Constraints
- Work ONLY in `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof`; NEVER touch `e:\pmnm2026` or `upstream/nocobase`.
- Apache-2.0 SPDX header (`@copyright (C) 2026 CTU-OpenPaw`, `SPDX-License-Identifier: Apache-2.0`) on EVERY code/config/script file.
- 0 new third-party npm dependencies in NocoBase plugins (`sdkProvidedByHost: true`); preserve NocoBase Clause 5.2 UI attribution (`Powered by NocoBase`, `v2.2.50`, `License settings`).
- `client-v2` bundles MUST import ONLY `@nocobase/client-v2` (verified by `tests/nocobase-externals.test.mjs`).
- All new migrations MUST have unique timestamps (`20261124000100+`), reversible `down()`, and PG RLS policies attached for tenant-scoped tables.
- Strict TDD per task (write failing test -> confirm RED -> minimal implementation -> confirm GREEN -> full plugin tests -> clean commit).

## Review Focus
1. Cross-tenant isolation on all new collections (`latticeApiKeys`, `latticeCryptoLedger`, `latticeFrozenSnapshots`, `latticeDataLineage`, `latticeDataQuarantine`, `latticeOrderLines`, `latticeStockLots`, `latticeEpodRecords`, `latticeDecisionTables`, `latticeDelegations`, `latticeTwinShadows`) via PG RLS & scope middleware.
2. Public endpoints (`dxos:openapi`, `dxos:asyncapi`, `dxos:manifest`, `dxos:sw`, `dxosWms:publicTrack`) MUST fail closed on invalid/untrusted tokens or host headers and return zero PII or secrets.
3. Scoped PaaS API Keys (`ldx_pat_*`) MUST never allow privilege escalation to `root` unless issued for root, must reject expired/revoked keys, and hashes (never plaintext tokens) must be stored in DB.
4. Cryptographic Ed25519 & Hash-Chain Ledger MUST encrypt private keys at rest (`AES-256-GCM`) and deterministically reject tampered payloads on `dxosLedger:verify`.
5. Digital Twin MQTT command downlink & Proactive Incident Agent MUST gate critical setpoint changes (`|delta| > 2°C`) and remediation writes through `latticeAiApprovalQueue` (HITL) and honor quotas.

---

## Wave Plan Overview
- **Wave 0:** Branch `feat/v1.0.0-olp-championship`, Design Spec, Plan, Ledger & Pre-flight Scan.
- **Wave 1:** Tasks 1.1 (`dxosApiKeys`, `dxosLedger`, OpenAPI/AsyncAPI), 1.2 (`assignee.userId`, RLS parity in Studio/PARA, VN SLA business-hours), 1.3 (APISIX/Caddy Zero-Trust `/api/*` alignment + Grafana 360° + Prometheus alerts).
- **Wave 2:** Tasks 2.1 (`dxosDataGov` Hot–Warm–Cold + Lineage + Quarantine + Arrhenius MKT), 2.2 (`dxosWms` OrderLines/Lots/FEFO/MKT Hold/ePOD/Print + `dxosDmn` + `dxosDelegations`), 2.3 (Digital Twin 2-Way Shadow + Node-RED downlink + 2-phase SHA-256 Bulk Import).
- **Wave 3:** Tasks 3.1 (`DxosWebGisBlockModel`, `DxosKanbanScheduleBlockModel`, Workbench PKI/Lineage/Print), 3.2 (Studio Governance Consoles UI), 3.3 (Mobile Field PWA `/v/mobile` + Offline Queue + QR + Canvas ePOD).
- **Wave 4:** Tasks 4.1 (OCR + XLSX/PPTX extractor -> form auto-fill), 4.2 (Unified `pgvector` + GraphRAG `#16` + `dxos_alarm_action` `#17` + MCP Prompts/Templates + 60-case NL eval), 4.3 (Proactive Incident Triage Agent -> HITL + AI Studio polish).
- **Wave 5:** Tasks 5.1 (GitOps Solution Bundle v3 + Portal Composer), 5.2 (`acceptance-headless-paas`, CycloneDX SBOM, `seed-v100-championship-showcase`, `1.0.0` version bump), 5.3 (`COPYRIGHT.txt`, PoF docs sync, OLP Matrix, 15-Min Finals Script).
- **Wave 6:** Whole-branch review + offline gates + Live deploy + Double `nocobase upgrade` + Live acceptance suites + Playwright Browser E2E.

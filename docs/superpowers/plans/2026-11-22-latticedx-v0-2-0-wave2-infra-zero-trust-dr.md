<!--
  @file LatticeDX — Open Digital Enterprise Platform
  @author CTU-OpenPaw
  @copyright (C) 2026 CTU-OpenPaw
  @license Apache-2.0
  @see https://github.com/CTU-OpenPaw/lattice-dx
  SPDX-License-Identifier: Apache-2.0
-->

# LatticeDX v0.2.0 — Wave 2 Implementation Plan (Zero-Trust Production Infra, Stack Upgrades, Cross-Platform Scripts, Real DR & DevSecOps CI)

> **Goal:** Eliminate all Critical/High infrastructure, supply-chain, cross-platform script, and Disaster Recovery rehearsal gaps while preserving local dev compatibility and 100% Apache-2.0 PoF readiness (`pnpm pof:check` PASS).
> **Discipline:** Strict TDD (`superpowers:test-driven-development`), verified `@sha256:` image digests in all `infra/compose/*.yml`, Apache-2.0 SPDX headers checked via `node scripts/source-headers.mjs --check`, and `docker compose config --quiet` validation on every compose stack.

---

### Task 2.1: Cross-Platform Docker Context Helper & Parameterized NocoBase Version
- **Files:**
  - Create: `scripts/lib/docker-context.mjs`, `scripts/tests/docker-context.test.mjs`
  - Modify: `scripts/lib/nocobase-externals.mjs`, `tests/nocobase-externals.test.mjs`
  - Modify: all 52 `.mjs` files under `scripts/` + `scripts/docker-desktop.ps1` replacing hardcoded `'desktop-linux'` / `'2.2.38'`
  - Modify: `tests/native-clean-install.test.ts`, `tests/workspace-install.test.ts`
- **Deliverables:**
  1. `resolveDockerContext`, `dockerContextArgs`, `dockerArgs` supporting `DOCKER_CONTEXT` override, `none`/empty disabling, and `win32`-only `'desktop-linux'` default.
  2. Parameterized `NOCOBASE_VERSION` defaulting to `'2.2.50'` across `nocobase-externals.mjs` and `native-clean-install.mjs`.

### Task 2.2: Zero-Trust Production Compose (`prod.yml`), Hardened Configs, Stack Upgrades & Worker Dockerfile
- **Files:**
  - Create: `scripts/tests/infra-compose-security.test.mjs`
  - Create: `infra/compose/prod.yml`, `infra/compose/prod.env.example`, `infra/config/caddy/Caddyfile`, `infra/config/apisix/config.prod.yaml`, `infra/config/apisix/apisix.prod.yaml`, `infra/config/postgres/init-prod.sh`, `infra/config/postgres/pitr.conf`, `infra/config/keycloak/lattice-realm.prod.json`, `apps/agent-worker/Dockerfile`
  - Modify: `apps/agent-worker/src/index.ts`, `apps/api/Dockerfile`, `infra/compose/{core,nocobase,integration,native-rehearsal,uc1-sample}.yml`
- **Deliverables:**
  1. 4-network zero-trust production compose (`edge`, `app`, `data`, `scanner`), Caddy HTTPS + security headers, Redis-backed APISIX (`ssl_verify: true`, rate limits), least-privilege PG roles + PITR WAL config, RustFS Apache-2.0 S3, Keycloak `26.8.2` `start` prod mode + `keycloak-config-cli:6.5.1-26` declarative realm without hardcoded passwords or ROPC grants, ClamAV `1.5.5`, Mongo `8.0 --auth`, Orion-LD `1.12.0 -mongocOnly`, n8n `2.48.1` Postgres backend, NocoBase `2.2.50` + Redis `PubSubManager`.
  2. Verified pinned `@sha256` digests and security hardening across all local compose files (`postgres:16.16-alpine`, `pgvector/pgvector:0.8.1-pg16`, `redis:7.4-alpine`, etc.).

### Task 2.3: Real Disaster Recovery — Streaming Disk I/O, Full-Stack Coverage, Ephemeral Container Restore Rehearsal, Automated Restore & PITR
- **Files:**
  - Modify: `scripts/lib/backup-policy.mjs`, `scripts/stack-recovery.mjs`, `scripts/native-database-recovery.mjs`, `scripts/tests/stack-recovery.test.mjs`
  - Create: `scripts/pitr-backup.mjs`, `scripts/tests/pitr-backup.test.mjs`, `docs/disaster-recovery-and-pitr.md`
- **Deliverables:**
  1. Streaming disk fd helpers (`sha256File`, `readFileHead`, `streamDockerToFile`, `streamFileToDocker`) bypassing 256 MiB heap buffer limits.
  2. 7-component stack backup (`nocobase-db`, `uploads`, `keycloak`, `orion-mongo`, `n8n` workflows+credentials, `lattice-db`, `engine-objects`), strict `tar -tvzf` symlink/hardlink/device rejection, `--ephemeral` isolated Postgres container restore + schema/app health verification, and safe guarded `restore --confirm-restore=<stack-id>`.
  3. WAL-G / pgBackRest S3 PITR planner & config checker (`scripts/pitr-backup.mjs`) + documented RTO/RPO runbook.

### Task 2.4: DevSecOps GitHub Actions CI Gates
- **Files:**
  - Create: `scripts/tests/ci-workflows.test.mjs`, `.github/workflows/codeql.yml`
  - Modify: `.github/workflows/ci.yml`
- **Deliverables:**
  1. Multi-job CI pipeline: build/unit/contract checks, PoF + SPDX check, `pnpm audit --prod --audit-level=high`, `docker compose config --quiet` across all 7 stacks, `aquasecurity/trivy-action`, and CodeQL JS/TS analysis.

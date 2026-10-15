# Entity query and block Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development, with task review after each deliverable. No Notion ticks.

Goal: provide typed query and usable builtin entity block catalog backed by the authoritative repository.
Architecture: entities/query.ts validates types and compiles parameterized predicates/order; small blocks routes/registry delegates existing repository operations. No framework/dependency.
Tech Stack: TypeScript, Fastify, pg, Vitest.

## Global Constraints

Exact spec docs/superpowers/specs/2026-10-14-entity-query-blocks.md. Existing APIs unchanged. Duy backend only, no upstream/UI/Nhi adapters/dependencies/credentials/volume deletion/Notion ticks. New mutations require Idempotency-Key and current ACL before replay. Keep schemaVersion typed query pinned. No raw SQL/code/URLs from payload. Preserve CV.pdf/a.png/output; no switch/push/merge by implementer.

### Task 1: Typed query and builtin blocks

Files: apps/api/src/entities/query.ts and tests; entities/types/database/routes; new blocks/{types,registry,routes}.ts and tests; app.ts registry wiring. Do not modify old actions contracts unless compiler requires an explicit backwards-compatible shared schema type; new blocks types are preferable. Parent owns scripts/docs/package/gateway.

- [ ] RED query parser rejects boolean gt, invalid decimal/date, unknown schema field and authority; signed block roles/version/strict bodies; same repository key forwarded.
- [ ] Implement query(input) with pinned publication validation; compiler returns SQL predicate/sort plus bound values, all field names parameterized. Numeric exact comparison, exists/contains semantics from spec; SQL ACL before LIMIT. Existing EntityError/Page errors preserved.
- [ ] Implement registry descriptors and run handlers for seven entity blocks with complete input/output schema. Use repository directly; never forge scope, duplicate mutation logic or copy role snapshots.
- [ ] Targeted tests plus pnpm --filter @dx/api typecheck and git diff --check. Commit scoped source/tests; full report output/reviews/entity-query-blocks-implementation.md with commands/output and RED evidence.

### Task 2: Live acceptance

Files: scripts/smoke-entity-query-blocks.mjs; docs/entity-query-blocks.md; package test command; gateway allowlist.

- [ ] Keycloak/Gateway tests cross REST/block create/update replay, wrong version400, wrong role403, unknownblock404, revoked grant404; pinned typed queries, filters/sort and body limits.
- [ ] Private UUID PG schema tests decimal values differing beyond JS precision, missing attributes, ne/exists, 105 page rows ACL filtering, deterministic sort, wrong schema publication404, freshpoolmax1.
- [ ] Full check and enterprise/share/create/workflow regressions; review spec/report/diff, fix important issues and rerun covering checks.
- [ ] Update progress/evidence and current PR scope; no auto merge/release.

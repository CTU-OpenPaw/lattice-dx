# Enterprise Engine Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Implement one source task at a time; parent owns acceptance/docs/integration and dispatches fresh reviewers.

**Goal:** Make existing enterprise primitives compose through explicit context, committed events, safe computation, business bindings and scoped data/operations.

**Architecture:** Extend current repositories through narrow caller-client helpers. Configuration defines behavior; backend remains authority. Keep transient projected values separate from public workflow evidence and asynchronous delivery separate from entity mutations.

**Tech Stack:** TypeScript/Fastify/pg/Vitest/Node filesystem and crypto; existing dependencies only.

## Global Constraints

Exact spec `docs/superpowers/specs/2026-10-14-enterprise-composition.md`. Current branch/PR13, no switch/push/merge by implementer. No UI/upstream/Nhi adapters/deps/credentials/Notion/volume reset/userfile edits. Preserve CV.pdf/a.png/output. One implementation subagent at a time, read-only review may overlap independent parent acceptance. Avoid dense new files; split policy/client/runtime by responsibility. No stage `output/` reports. Do not infer completion from passing mocked tests.

## Task sequence and review gates

### Task 1: entity context and bidirectional navigation

Files: `packages/contracts/src/workflows.ts`, workflow policy/database/types/routes/schema, new `apps/api/src/workflows/entity-context.ts` and tests. Detailed plan `2026-10-14-entity-workflow-context.md`.

Produces optional `CreateWorkflow.entityContext`, immutable association store, `WorkflowRepository.entityContext(id,actor)` and `listEntityWorkflows(entityId,actor,page)`.

- [ ] Write failing strict-body, no implicit grant, replay-revocation and ACL-before-page tests.
- [ ] Implement new-run association/current replay check on caller client, preserving run/record identity and optional contract compatibility.
- [ ] Add signed routes and bootstrap, then targeted tests/typecheck/scoped commit.
- [ ] Parent PG concurrent/replay/rollback/max1 and HTTP acceptance, independent review/fixes, handoff. Gate before Task2.

### Task 2: metadata event journal

Files: new `apps/api/src/entities/events.ts`, shared `entities/client.ts`, migration data-tools module, entity initialization/tests.

Interface: `appendEntityEventWithClient(client,scope,{operation,entityId,schemaId,schemaVersion,fromVersion,toVersion}):Promise<void>`. DDL initializer runs before entity mutations. Persist actor from scope, timestamp server-side, unique `(entity_id,to_version,operation)`; operation whitelist create/update/archive/link/unlink/migration only.

```ts
expect(await eventCount(entity.id)).toBe(1);
await repository.create(scope,input,sameKey);
expect(await eventCount(entity.id)).toBe(1);
```

- [ ] RED actual mutation/noop/replay classification and transaction failure rollback (entity,audit,event,receipt).
- [ ] Emit only at canonical mutation points; do not acquire workflow locks or call external services. Event metadata excludes attribute values/credentials/role snapshots.
- [ ] Targeted tests/typecheck/PG event rollback via workflow late receipt failure; independent review/commit.

### Task 3: declarative automations and durable dispatcher

Files: new `apps/api/src/automations/{types,policy,database,worker,routes}.ts` plus tests, database/app/index wiring; reuse service actor resolver and workflow caller-client methods.

Repository outputs: create/update/list rules, list deliveries, retry delivery, `tickOne():Promise<{deliveryId,status}|undefined>`. Rule includes fixed schema/pin/operation, serviceId, pinned workflow definition, metadata/literal input mappings and optional interactive transitionId. Signed role `data:automate`, with current designer role and provisioning checks; no public service profile creation.

- [ ] RED actor/tenant injection, pin/start roles/current source, invalid mapping, current rule disabled/retry capability negatives.
- [ ] Implement immutable per-event/rule-revision delivery staging, bounded worker lease/backoff and unique run-start key.
- [ ] Create and optional transition atomically on one client under configured current actor; attach entityContext/provenance, sanitize failures. Persist no source JWT.
- [ ] Test five workers one run, queued grant/profile revoke, event after archived source, crash before receipt, no recursive processing in entity transaction, max1 restart. Parent signed API/runtime acceptance, review/commit.

### Task 4: safe typed expression evaluator

Files: `packages/contracts/src/expressions.ts` exported through contracts; new `apps/api/src/workflows/{expressions,decimal}.ts` and tests.

Interface `evaluateExpression(expr,environment):TypedScalar`; bounded explicit AST, no resource ID evaluation. Decimal uses BigInt coefficient/scale, maximum digits80, scale18; division precision18 half-away-from-zero. References are explicit allowed environment keys, not JS property paths.

```ts
expect(evaluateExpression(add(decimal('9007199254740993.10'),decimal('0.20')),{}))
  .toEqual({type:'decimal',value:'9007199254740993.30'});
```

- [ ] RED arithmetic precision, signed rounding, integer overflow, type mismatch, missingref, divisionzero, AST node/depth/unsafekey limits.
- [ ] Implement pure evaluator/decimal helper; no eval/deps/SQL. Typecheck/contracts validation and independent review.

### Task 5: private projections/calculation/assert blocks

Files workflow contracts, block policy/database/catalog/bundles and tests; focused new executor helper for transient private values.

Outputs `entities.project`, `data.evaluate`, `data.assert`, expression attribute bindings with declared typed results. Projection requires actual data:read/current entity ACL and <=20 pinned declared fields. IDs stay standard string bindings, not expression or query output IDs. Public action input/result omit values.

- [ ] RED unknown/missingfields/forwardrefs/resourceID expression rejection; correctrole and currentACL.
- [ ] Extend complete descriptors/portable validation; keep private maps transaction-local and prelock plan unchanged.
- [ ] Implement evaluation/assertion and typed attribute use; false assertion409 rolls back earlier effects.
- [ ] Test executions/history/jobs/run/receipt contain no private projected/calculated values; pin/currentgrant/restart/max1 tests and existing timer/service regressions. Review/commit.

### Task 6: business module bindings

Files modules types/policy/database/routes/tests, optional manifest `bindings`, workflow subject constraints.

Interface `startBinding(moduleId,version,bindingId,{entityId,title,input},actor,key)` delegates existing workflow creation after exact publication/current role/context checks. Installed own schema pin1; enable resolves exact published workflow mapping; no invented arbitrary pin acceptance.

- [ ] RED unknownresources/schema-pin/workflow-context mismatch/dependencybinding/capability negatives and oldmanifest compatibility.
- [ ] Implement preview/install/enable gate validation and bound start endpoint; immutable hash includesbindings, noUIlayout/codeauthority.
- [ ] PG failed install/enable rollback, disabled start, concurrent start/disable, importedmanifestoldbehavior and max1. Review/commit/handoff.

### Task 7: scoped exact aggregates

Files new `apps/api/src/entities/{aggregate-types,aggregate-policy,aggregate-database,aggregate-routes}.ts` and tests, app/database wiring. Reuse query filter compiler/current ACL.

API `POST /v1/entities/aggregate`: fixed schema/pin/filter, <=10 metrics count/sum/min/max/avg, <=2 group fields/200groups, 3s statement timeout. Decimal/count strings, count0 and numeric aggregatesnull onempty, missing field excluded from numeric metrics. Guard casts independent of queryplanner.

- [ ] RED exact large decimal sum/avg, wrong metric type, constructor/rawSQL, groupedbound and mixed-schema SQL cases.
- [ ] Implement same-client parameterized aggregation; current ACL applied before aggregation and group names validated by publication.
- [ ] PG full/partialgrant/revoke/tenant, emptygroups, >100 visible entities, max1 and read-only behavior; review/commit.

### Task 8: frozen report snapshots with current visibility

Files focused snapshot repository/routes/types/tests using aggregate helper. Creation stores query/results and private source IDs at consistent boundary, max5000 source IDs, owner namespace/key. Read revalidates every source under current ACL, denied if any lost. Lists only metadata, no result/source leak. No recomputation overwrites frozen result.

- [ ] RED snapshot after revoke/move/archived source denial, samekey receipt currentACL, bounds/tenant, numeric precision preserved.
- [ ] Implement atomic snapshot/dependencies/audit/receipt and access-checked get/list.
- [ ] PG source update keeps frozenresult but revoke denies read, race/currentlocks/forcedreceipt rollback/max1; review/commit.

### Task 9: concrete filesystem object provider

Files `apps/api/src/files/{object-store,filesystem-store,storage-database}.ts`, foundation-database/readfile integration/bootstrap and tests. Existing upload limit/scan/auth contract stays compatible; default PostgreSQL storage unchanged.

DB initially retains bytes. Optional provider writes generated immutable UUID object, verifies size/SHA, then switches metadata and clears DB bytes transactionally; copy failure leaves DB fallback. Reads validate object key/root/size/digest and current scan/access before returning. Root from server configuration only, no public path/provider selection.

- [ ] RED traversal/symlink/overwrite/digest/partialcopy/SQLswitch failure cases and legacyprovider compatibility.
- [ ] Implement local provider and bounded storage migration/runtime with recoverable lifecycle; no auto orphan deletion or user-data purge.
- [ ] Real temp-root +PG migration/read/failure/restart and scan/revoke regression; object inventory/backup verifier docs. Review/commit. No remote provider claimed.

### Task 10: ACL-aware full text search

Files new entity search policy/client/routes/tests and schema index. API `POST /v1/entities/search` with bounded plainquery/optionalschema/limit/offset, `data:read` plus SQL current ACL. PostgreSQL simple-config fulltext for title/attributes, no unsanitized HTML snippets.

- [ ] RED search injection/unknownbody/pagination/currentgrant/foreignrows and mixedschemas.
- [ ] Implement parameterized fulltext query and GIN index with compatible migration; no byte extraction from arbitrary documents.
- [ ] PG >100 paging/revoke/restart and queryplan index evidence, review/commit.

### Task 11: observable configured runtime

Files operations telemetry/policy/routes/index wiring/tests; docs and optional additive worker env keys. In-process low-cardinality counters/latencies, signed platform metrics with no tenant/subject/token/body labels; scoped queue diagnostics/status/retry surfaces.

- [ ] RED public/foreignmetrics diagnostics denial, failure counters, bounded route labels and worker config validation.
- [ ] Implement metadata-only instrumentation and queue observability; no arbitrary client URL/service provisioning. Worker opt-in and clean drain onshutdown.
- [ ] Real HTTP signed metrics/requestcorrelation +configuredautomationruntime and restart smoke; full check. Review/commit.

### Task 12: whole composition acceptance and delivery

Parent scripts/docs/APIindex/verification/masterledger, no teammate UI/adapters edits.

- [ ] Compose an isolated scenario: entity create → persisted event → current service starts linked run → authorized projection/calculation/assert → entity update → scoped report; prove schema pin, revocation and atomic rollback.
- [ ] Run `pnpm check`, all new acceptance commands and affected legacy suites with Gateway rate-limit spacing.
- [ ] Independent whole-branch review, fix/reverify every P1/P2; verify dependency/NOTICE inventory and no output/user artifacts staged.
- [ ] Update PR13 around final scope, push once reviewed, attach artifact and verify latest-head CI. No auto merge/release; Notion untouched.

## Execution ledger

| Task | Status | Evidence |
| --- | --- | --- |
| 1 | Planned | Entity context spec/plan drafted next |
| 2–3 | Planned | Event journal +current-service dispatcher |
| 4–5 | Planned | Pure expressions +transient private projections |
| 6 | Planned | Declarative business bindings |
| 7–8 | Planned | Exact scoped aggregates +revocable snapshots |
| 9–11 | Planned | Concrete local object provider/search/observable runtime |
| 12 | Planned | Full scenario/review/CI only after implementations |

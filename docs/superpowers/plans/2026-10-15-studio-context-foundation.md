# Studio and context foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete the twelve agreed backend improvements through four independently reviewed increments.

**Architecture:** Extend existing engine repositories and validators. Add a small Studio facade and a separate context-links service; retain NocoBase and receiver ownership boundaries.

**Tech Stack:** TypeScript, Fastify, PostgreSQL/pg, Vitest, Node.js 24, pnpm 10, existing Gateway/Keycloak.

## Global Constraints

- Engine PostgreSQL remains authoritative for business data. NocoBase remains Studio/UI. No upstream/plugin source, teammate branch, credential, native page, existing volume or Notion tick changes.
- Additive endpoints/contracts; legacy action, workflow and history callers retain their behavior. Do not globally replace existing error envelopes.
- Current JWT tenant and resource authorization are checked at every read/write. Catalogs are guidance, never authority. No user-supplied SQL, arbitrary URLs, executable configuration or actor/tenant override.
- Idempotent mapping mutations require an Idempotency-Key and mapping revision. Versioned writes and audit must commit atomically. No secret or arbitrary workflow input in public audit.
- No automatic receiver deployment or simulated broker-success data. Broker observations remain distinct from business entity and workflow states.
- Original code Apache-2.0; no new runtime dependencies unless a demonstrated need cannot be met locally. Preserve CV.pdf, a.png and ignored artifacts.
- Prefer focused modules and existing validators/repositories. Source implementation is sequential, with focused TDD and independent review at each gate.

## Task 1: Studio facade

**Files:** Create apps/api/src/studio/{routes,catalog,policy}.ts and focused tests; modify apps/api/src/app.ts; minimally export reusable descriptors from existing registries/actions if needed. No Gateway/runtime/source plugin changes in this task.

**Interfaces:** registerStudio(app, options) accepts existing identity/entities/workflows/definitionRegistry/modules/foundation/records/directory options; route registration is called from createApi. GET /v1/me/capabilities, GET /v1/studio/catalog, POST /v1/studio/preflight and GET /v1/studio/modules/:id/versions/:version/dependencies exactly follow increment 1 of the approved design. Use a dedicated typed StudioError/envelope with error machine code plus message; configuration issues use {valid:false,issues:[{code,path,message}]}. Reuse ModuleRepository.preview/get and trusted descriptors. Strict envelopes/query; no network calls/writes on preflight. No invented capabilities for unconfigured repositories. Only roles from verified JWT, never arbitrary resource-level grants.

- [ ] Write failing signed Fastify tests for unauthorized/unconfigured cases, role-filtered catalog, valid and conflicting/invalid preview, no calls to install, cross-tenant dependency reads, unsupported body/query and safe error envelopes.
- [ ] Run `pnpm exec vitest run apps/api/src/studio` and record expected failing route/import evidence.
- [ ] Implement minimal policy/catalog/routes, register once, reuse existing descriptors instead of cloning business validators.
- [ ] Run focused tests and `pnpm --filter @dx/api typecheck`; run git diff --check.
- [ ] Commit only task files; report paths, interfaces, red/green evidence and limitations under output/reviews/studio-context-task-1-report.md. Reviewer checks diff before task 2.

Example behavioral assertion: `expect((await app.inject({method:'POST',url:'/v1/studio/preflight',headers:designerHeaders,payload:{manifest}})).json()).toMatchObject({valid:false,issues:expect.any(Array)}); expect(install).not.toHaveBeenCalled();`.

## Task 2: History paging and immutable reason

**Files:** Modify apps/api/src/workflows/{types,database,routes}.ts and focused tests; packages/contracts workflow audit type only if needed. Add a focused history helper if it reduces database.ts complexity. No Studio/context/UI changes.

**Interfaces:** Add optional `historyPage(id:string,actor:WorkflowActor,query:PageQuery):Promise<Page<WorkflowAudit>>` to WorkflowRepository. Existing `history` returns <=100 legacy rows unchanged. GET history with limit/offset uses historyPage; no query retains `{items}`; unsupported keys rejected. SQL stable order version,id, limit+1 and offset after ordinary authorization. Existing custom test repositories lacking historyPage fail controlled 503 only when paged mode is requested. Audit transition metadata may gain only reason copied from a configured validated `text` field called reason, <=2000 Unicode code points; no historical backfill, no entire inputs/data, no overwrite of entity/binding metadata.

- [ ] Write failing route and SQL policy tests: backward response, explicit pages across >100 events, stable order/page bounds, permission/tenant denial, unsupported q, unavailable paging.
- [ ] Write failing transition test: declared reason stored in immutable metadata in same transaction, other inputs not copied, failure leaves no audit/version effect, later run.data edits cannot change old reason.
- [ ] Implement optional method and route branching, parameterized query and bounded reason metadata using existing input validation.
- [ ] Run focused workflows tests and contract/API typecheck. Record actual red/green evidence, commit scoped files and report output/reviews/studio-context-task-2-report.md.

Example no-query assertion: `expect(body.page).toBeUndefined(); expect(body.items).toHaveLength(100);` versus explicit `{limit:2,offset:2}` returning nextOffset only when more rows exist.

## Task 3: Context mappings and authorized observations

**Files:** New apps/api/src/context-links/{types,policy,routes,database,projection}.ts plus focused tests. Register in app.ts/database.ts/index.ts and runtime config/lifecycle as needed, with tests for strict opt-in. No apps/api/src/ngsi-ld files, broker/n8n/UI or teammate branch edits.

**Interfaces:** `contextLinksDatabase(pool, entities, {projectionEnabled?:boolean})` returns a typed repository; `ContextLinksOptions` adds optional contextLinks to createApi. GET/PUT/DELETE /v1/entities/:id/context-links/ngsi-ld, GET history and GET /v1/entities/:id/context. PUT `{externalId,expectedRevision}` and DELETE `{expectedRevision}`, mandatory bounded idempotency key, creation revision0 and monotonic versions thereafter. Auth: data:read plus current entity readability always; mutation also data:design. Context mapping errors carry stable codes, input and query allowlists are strict. Database repository must enforce tenant/entity policy even on receipt replay; writes, history, receipt and uniqueness are atomic under resource locks. Reuse entity ACL SQL/helper where needed to authorize inside transaction without pool starvation (test max1).

Mapping uniqueness is organization/entity/provider and active organization/provider/externalId. Allowed externalId exact `urn:ngsi-ld:Asset:<organizationId>:<bounded businessId>`; organization comes from actor, never input. Removal tombstones retain monotonic revision/history and permit safe rebind. Duplicate external ID and stale revision return409. Exact key replay returns accepted result only under current authorization.

Context DTO `{version:1,entityId,mapping,status,freshnessThresholdSeconds:300,observation}` with status not_linked/source_unavailable/no_observation/fresh/stale; observation null except valid reads; valid observation contains provider/externalId/status/observedAt/receivedAt, no secret/raw notification. No synchronization-success assertion. Strict date/status and scope validation; invalid source data controlled503. Read-only optional adapter for known `public.ngsi_ld_asset_context`, enabled only by NGSI_LD_CONTEXT_READ=true. Disabled/missing relation source_unavailable; query failure controlled503. Never create/write receiver table. Hook strict boolean flag into bootstrap connection options without forcing receiver configuration or weakening existing config checks.

- [ ] Red tests for routes/codes/body/query, denied and cross-tenant entities, mapping versions/idempotency/conflicts, opt-in/missing projection and freshness/provenance validation.
- [ ] Red database tests for receipt rollback, conflicting key, unique active external IDs, remove/recreate monotonic revision, current ACL on replay and fixed read-only projection SQL.
- [ ] Implement policy/types, original table DDL, transactional repository, source adapter, routes and bootstrap wiring in that order. No unrestricted URL adapter or secret browser endpoint.
- [ ] Green focused tests and API typecheck; prepare actual PostgreSQL acceptance helper or export repository methods for task 4 live verification. Report migrations and behavior precisely, commit scoped source/test files and write output/reviews/studio-context-task-3-report.md.

Example negative gate: entity find returns undefined =>404 and projection is not queried; disabled projection with existing readable mapping =>source_unavailable and observation:null, never a fabricated Asset status.

## Task 4: Gateway, OpenAPI, handoff and acceptance

**Files:** infra/config/apisix/apisix.yaml; docs/studio-context-api.openapi.json; docs/studio-context-foundation.md; scripts/smoke-studio-context.mjs and package.json; focused tests/studio-context-contract.test.ts and SQL acceptance helper if needed. Add no UI or receiver endpoints.

**Interfaces:** Gateway routes allowlist exact new families/methods behind existing openid-connect/request-id/rate-limit style, reusing existing entity/workflow protection where routes already covered. OpenAPI3.1 documents every new endpoint, legacy-versus-paged history and stable errors/DTO shapes. Smoke authenticates existing local demo fixtures, creates unique schema/entity/module/workflow fixtures via ordinary APIs, checks scoped catalog/preflight, history/immutable reason, mapping mutation/replay/conflicts/freshness-unavailable, and cross-tenant/denied access. Source absent is explicitly unavailable, not successful broker delivery. Never change credentials/directory/volumes or teammate artifacts; retain own fixtures and print only IDs/results, not tokens.

- [ ] Red contract test parses static OpenAPI and verifies new registered endpoint coverage/secured Gateway families, response schema requirements and no executable/secret examples.
- [ ] Add document and startup/consumer guidance with curl/JSON examples, roles, status/error codes and limitations; include package `test:studio-context` command.
- [ ] Run focused contract tests, complete pnpm check, plugin Node regression only if changed interfaces justify, then independent final review with a durable diff package.
- [ ] Before deploying reviewed API, take `pnpm backup:core` database snapshot (no restore/reset). Rebuild only API and reload/restart Gateway if necessary; leave NocoBase/broker/n8n/agents unchanged.
- [ ] Run actual PostgreSQL acceptance for mappings: max1 pool/no nested starvation, uniqueness under concurrent creation, stale/replay/rollback, retained audit after unbind; source adapter may use only a temporary isolated database/schema fixture, never mutate teammate projection. Run signed Gateway smoke and validate history >100 independently through dedicated fixtures.
- [ ] Record evidence and remaining boundaries in docs/verification.md and ledger. Commit/push one reviewed PR, attach it, verify latest-head CI. No automatic merge/release or Notion ticks.

## Ledger

Baseline: main9e74bf7; user files CV.pdf and a.png untracked and preserved. Work on codex/studio-context-foundation in the existing checkout per the established preference for one branch, no extra worktree. Baseline test result is recorded after completion. Tasks must not be declared complete before independent review and actual checks.

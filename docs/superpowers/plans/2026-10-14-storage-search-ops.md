# Storage, Search, and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Master plan permits one source implementer at a time; parent owns acceptance/scripts/docs/package changes.

**Goal:** Deliver optional verified filesystem bytes, ACL-aware PostgreSQL full-text search, and an explicitly configured observable runtime for master Tasks 9–11.

**Architecture:** Central caller-client content loading keeps authorization and scan checks ahead of storage access. PostgreSQL generated search vectors reuse current SQL authorization. Small process-local telemetry and signed metadata routes extend existing operations modules without adding an infrastructure service.

**Tech Stack:** TypeScript/Fastify/pg/Vitest/Node filesystem and crypto; existing dependencies only.

## Global Constraints

- Exact contract: `docs/superpowers/specs/2026-10-14-storage-search-ops.md`; master `2026-10-14-enterprise-composition.md` remains the integration ledger.
- Default PostgreSQL byte storage remains unchanged. Existing uploads remain at most 1,048,576 decoded bytes and the existing 1,450,000 HTTP body bound.
- All nested operations use the caller's PoolClient. Pool max1 must work. No transaction helper may acquire another connection while a caller holds one.
- No automatic object deletion, garbage collection, volume reset, overwrite, source purge, or destructive migration rollback. Preserve existing user files and output artifacts.
- Source implementers own API modules/tests; parent owns scripts, package commands, deployment documentation and full acceptance. Stay on current branch; no switch/push/merge.
- No new dependencies/framework/S3 implementation, no teammate UI/adapters changes. Stage exact owned paths, never output, CV.pdf or a.png. This plan describes future work, not implementation completion.

## File map and interfaces

Create `apps/api/src/files/object-store.ts` (pointer/store contracts), `filesystem-store.ts` (bounded isolated filesystem operations), `storage-database.ts` (DDL/switch/worker candidate client helpers), `content.ts` (all-path access and byte loader), `storage-worker.ts` (single flight), and corresponding `.test.ts` files. Modify foundation, workflow shared-file and entity attachment repositories/routes/types together, plus `database.ts`, `app.ts`, `index.ts` wiring.

Create `apps/api/src/entities/search-policy.ts`, `search-client.ts`, `search-routes.ts` and tests. Modify entity types/database initialization/repository and app registration. Create `apps/api/src/operations/telemetry.ts`, `runtime-config.ts`, `queues.ts`, their tests, and extend existing operations types/routes/database/tests. Keep existing operations diagnostics/retention API.

Parent creates `scripts/lib/object-backup-policy.mjs`, policy tests under the existing scripts-test convention, `scripts/smoke-storage-search-ops.mjs`; extends `scripts/backup-core.mjs`, `package.json`, `docs/api-index.md` if present (otherwise parent identifies existing API index), and existing deployment/recovery docs. Parent resolves documentation filenames before edits; source implementers never edit package/scripts.

Canonical signatures, defined here for later tasks:

```ts
type StoragePointer =
 | {provider:'postgres';objectKey:null;sha256:null;size:number}
 | {provider:'filesystem';objectKey:string;sha256:string;size:number};
interface ObjectStore {
 writeVerified(content:Buffer):Promise<{objectKey:string;size:number;sha256:string}>;
 readVerified(pointer:Extract<StoragePointer,{provider:'filesystem'}>):Promise<Buffer>;
}
type FileAccessContext={kind:'foundation'}|{kind:'entityAttachment';entityId:string};
type FileReadActor={subject:string;organizationId:string;roles:string[]};
type FileContent={filename:string;content:Buffer};
// FileItem remains the existing metadata shape from foundation.ts.
readFileMetadataWithClient(client:PoolClient,actor:FileReadActor,fileId:string,context:FileAccessContext):Promise<FileItem|undefined>;
loadFileContentWithClient(client:PoolClient,actor:FileReadActor,fileId:string,context:FileAccessContext,store:ObjectStore|undefined):Promise<FileContent|undefined>;
offloadFileWithClient(client:PoolClient,fileId:string,expectedStorageVersion:number,store:ObjectStore):Promise<'switched'|'already_switched'>;
type EntitySearch={q:string;schemaId?:string;schemaVersion?:number;limit:number;offset:number};
parseEntitySearch(input:unknown):EntitySearch;
searchEntitiesWithClient(client:PoolClient,scope:Scope,query:EntitySearch):Promise<Page<Entity>>;
```

## Task 9A: immutable filesystem provider and switch (master 9)

**Files:** create file object-store/filesystem-store/storage-database/storage-worker plus tests; modify foundation-database initializer. This task can be reviewed separately from route integration but is not deployable alone.

**Consumes:** existing foundation_files row and caller PoolClient. **Produces:** ObjectStore, additive storage columns and `offloadFileWithClient`; no public path/provider API.

- [ ] Write failing filesystem tests with Vitest temporary root under the test-owned directory; retain failed fixtures. Example assertions:

```ts
const value=Buffer.from('verified');
const object=await store.writeVerified(value);
expect(object.size).toBe(value.length);
expect(await store.readVerified({provider:'filesystem',...object})).toEqual(value);
await expect(store.readVerified({provider:'filesystem',...object,objectKey:'../escape'})).rejects.toThrow();
await expect(store.readVerified({provider:'filesystem',...object,sha256:'0'.repeat(64)})).rejects.toThrow();
```

Add exclusive collision, partial write, oversize, root symlink/junction, regular-file/identity replacement and digest mismatch fixtures. Inject filesystem operations only at narrow test seam; integration uses real Node fs.
- [ ] Run `pnpm exec vitest run apps/api/src/files/filesystem-store.test.ts`; confirm failure is absent implementation/expected behavior, not a broken fixture.
- [ ] Implement flat UUID-v4 exclusive `wx` objects, sync/descriptor verification/path verification and bounded reads exactly as spec. Enforce root isolation precondition and no deletion, including failure cleanup. Keep error sanitization separate from low-level errors.
- [ ] Add storage-shape migration and row lock/version tests. Execute the spec's additive DDL with introspected named constraints; validate legacy size before constraint attachment. Unit query spies must assert no call to pool.connect inside caller helper.
- [ ] Implement switch using spec SQL after writeVerified resolves. Outer transaction owns commit; helper never commits. Force write, verify, update and commit failures in real PostgreSQL acceptance; verify durable bytes remain. Commit failure must be tested at transaction boundary, not only mocked helper.
- [ ] Implement one-row tick with caller transaction, oldest candidate, FOR UPDATE SKIP LOCKED, clean PostgreSQL rows only. Start helper receives repository tick function and returns idempotent stop that drains one active tick; no startup side effect at import.
- [ ] Run `pnpm exec vitest run apps/api/src/files` and `pnpm --filter @dx/api typecheck`; require pass. Parent runs real temp-root+PG two-worker/restart/failure cases before final task9 acceptance.
- [ ] Review/stage only file modules and foundation initializer changes; commit `feat: add verified immutable filesystem storage`.

## Task 9B: central authorization and all four read paths (master 9)

**Files:** create `apps/api/src/files/content.ts` and `content.test.ts`; modify `foundation.ts`, `foundation-database.ts`, `workflows/database.ts`, workflow repository types, `entities/data-tools-database.ts`, data-tools types, `database.ts`, `app.ts`. Reuse Task9A contracts.

**Consumes:** ObjectStore and caller clients. **Produces:** metadata-only lookup and current-authorized content loader; routes keep existing URLs/status semantics.

- [ ] Write failing owner/task/workflow/entity-attachment tests proving denied or nonclean reads never invoke readVerified. Explicitly test metadata pending/rejected with broken/unconfigured filesystem store; metadata still succeeds without loading bytes.

```ts
expect((await app.inject({url:`/v1/files/${pendingId}`,headers})).statusCode).toBe(200);
expect(readVerified).not.toHaveBeenCalled();
expect((await app.inject({url:`/v1/files/${pendingId}/content`,headers})).statusCode).toBe(409);
expect(readVerified).not.toHaveBeenCalled();
```

Fixture builders create signed actor/IDs/status rather than testing fixed fake tokens. Test entity route requires both files:read and data:read and current attachment; generic foundation download must not gain attachment-only rights.
- [ ] Run `pnpm exec vitest run apps/api/src/files/content.test.ts apps/api/src/foundation.test.ts apps/api/src/entities/data-tools-database.test.ts`; capture relevant RED.
- [ ] Separate metadata from bytes in repository types; remove eager content selects from metadata paths. Implement centralized foundation fallback on same client; refactor workflow definition lookup to accept that client. Entity helper uses existing contextual entity authority and link checks before central bytes.
- [ ] Preserve resource-before-file locking and re-evaluate current policy after locks. Add scan FOR SHARE protection. Query content only after clean metadata; filesystem branch never selects/falls back to old DB bytes. Return fixed503 for committed missing/corrupt objects.
- [ ] Wire provider injection from database connection into every affected repository. New constructor arguments are optional for PostgreSQL default compatibility. Offload worker and read provider are independent: disabled worker still reads existing filesystem rows.
- [ ] Parent acceptance uses pool max1 for every path and concurrent revocation/scan update, confirms old authorized transaction versus later denied read semantics. Restart after switch retains readable files; corruption fails closed and metadata still returns.
- [ ] Run targeted suites and `pnpm --filter @dx/api typecheck`; independently review all four path integration before scoped commit `feat: authorize file content through one storage loader`.

## Task 9C: snapshot-matched full recovery (parent only)

**Files:** `scripts/backup-core.mjs`, new `scripts/lib/object-backup-policy.mjs`, tests, `package.json`, recovery docs. **Consumes:** storage columns and immutable object keys. **Produces:** explicit DB-only reports and full paired backup/rehearsal commands.

- [ ] Add failing bounded manifest tests: count10001, manifest8MiB+1, object1MiB+1, sum1GiB+1, duplicate keys/IDs, extra fields, traversal, invalid digest, noninteger size. Use existing script-test discovery from `rg --files scripts | Select-String 'test'`.
- [ ] Add explicit scope/fullRecoverability to DB-only report without claiming external-byte restoration. Keep approved dump and fixture target validation,256MiB dump bound.
- [ ] Implement dump→disposable restore→inventory query, never live inventory. Use exact query:

```sql
SELECT id AS "fileId",object_key AS "objectKey",size,content_sha256 AS sha256
FROM foundation_files WHERE storage_provider='filesystem' ORDER BY id;
```

Process up to10001 rows to detect overflow before copying. Bound subprocess buffers and parsed manifest bytes; verify integer sums before allocation. Empty external inventory is valid.
- [ ] Create exclusive generated backup directory and copy/verify one object at a time; final manifest only after success. Preserve incomplete artifacts. No recursive cleanup. Rehearsal restores dump, independently queries expected inventory and requires exact manifest equality before using objects.
- [ ] Parent smoke races new offloads/uploads with backup, verifies snapshot inventory excludes later rows yet includes every restored pointer. Missing/corrupt/omitted/duplicate objects fail. Download from restored DB/root through actual central loader with authorized clean fixture proves bytes, beyond counts.
- [ ] Add commands `backup:full` and `backup:rehearse-full`, recovery instructions, storage-root ownership/mount requirements. Run policy tests and real full rehearsal; report bounds and exact observed counts. Commit owned script/doc/package files separately.

## Task 10: parameterized current-ACL search

**Files:** new `entities/search-policy.ts`, `search-client.ts`, `search-routes.ts` and tests; modify `entities/types.ts`, `entities/database.ts`, `app.ts`. **Consumes:** existing accessPredicate/publication/pageResult and caller client. **Produces:** EntitySearch and searchEntitiesWithClient signatures above plus repository `search(scope,query)`.

- [ ] Add parser RED cases:

```ts
expect(parseEntitySearch({q:'  invoice ',limit:100,offset:10000})).toEqual({q:'invoice',limit:100,offset:10000});
for(const input of [{q:''},{q:'a',offset:10001},{q:'a',schemaId:'invoice'},{q:'a',rawSql:'1=1'}]) {
 expect(()=>parseEntitySearch(input)).toThrow();
}
```

Include UTF-8/codepoint/control bounds, zero/negative/fraction pagination and pin overflow; unknown fields rejected.
- [ ] Run `pnpm exec vitest run apps/api/src/entities/search-policy.test.ts`; confirm RED, then implement exact4KiB/200codepoint/800byte bounds and schema pair validation.
- [ ] Install generated vector+GIN DDL from spec idempotently. Index title and JSON scalar values only, using simple regconfig. Verify update/import/migration automatically refresh generated column.
- [ ] Implement same-client SQL with `plainto_tsquery`, ACL/tenant/archive/pin WHERE predicates before LIMIT, stable created_at/id descending, limit+1 and pageResult. Wrapper uses transaction with SET LOCAL statement_timeout='3s'. No dynamic client identifiers or ts_headline.
- [ ] Wire signed data:read POST route with bodyLimit4096, strict parser and sanitized timeout503. Return ordinary entity metadata/attributes only for current authorized records; no total or HTML field.
- [ ] Parent PG fixture creates106+ authorized matches and invisible higher-order matches, checks full page and next page, revoke/disable/member move/tenant/archive and mixed pins. Injection remains plaintext; Unicode behavior is PostgreSQL simple, not language stemming. Capture ANALYZE/EXPLAIN index evidence on selective realistic fixture, label forced-index diagnostics honestly.
- [ ] Run `pnpm exec vitest run apps/api/src/entities/search-policy.test.ts apps/api/src/entities/search-client.test.ts apps/api/src/entities/search-routes.test.ts` and API typecheck. Parent max1/restart/signed route gates then review/scoped commit `feat: add current-ACL full text entity search`.

## Task 11A: explicit runtime configuration and drain

**Files:** new `operations/runtime-config.ts`, `runtime-config.test.ts`; modify `index.ts`, optional `database.ts` options and worker modules/tests where needed. **Consumes:** current worker start APIs and Task9 store. **Produces:** `parseRuntimeConfig(env):RuntimeConfig` and all-worker drain.

- [ ] Add failing pure config tests for five worker booleans absent/false/true/invalid, missing DB, filesystem root/provider prerequisites, invalid connector protocol/token/ports. Assert bootstrap database spy not called on invalid configuration.

```ts
expect(parseRuntimeConfig({}).workers.waitTimeouts).toBe(false);
expect(()=>parseRuntimeConfig({WORKFLOW_WAIT_TIMEOUT_WORKER:'yes'})).toThrow();
expect(()=>parseRuntimeConfig({WORKFLOW_OUTBOX_WORKER:'true'})).toThrow();
```

- [ ] Run config tests RED. Implement parsing before connectRecords. Keep filesystem reads configured when offload is false; reject postgres selection with filesystem rows unless readable root is provided after DB initialization check. Do not start workers before initialization succeeds.
- [ ] Start only explicit true workers. Outbox additionally requires configured connector; root is server-only. Existing wait-timeout default changes to false and parent must document enabling it.
- [ ] Test single flight with unresolved tick promise; call stop, verify new ticks stop immediately and pool.close is not called until release. Stop all scheduling before awaiting; allSettled drains all workers if one fails, then pool closes. Startup failure closes resources; duplicate signals share one close path.
- [ ] Run `pnpm exec vitest run apps/api/src/operations/runtime-config.test.ts apps/api/src/automations/worker.test.ts` and existing timer/outbox tests discovered by `rg --files apps/api/src/workflows -g '*test.ts'`. API typecheck, review, commit scoped runtime changes.

## Task 11B: bounded metrics and scoped queue diagnostics

**Files:** new `operations/telemetry.ts`, `queues.ts`, tests; extend operations types/database/routes/tests; app/index hooks and worker observation seams. **Consumes:** runtime flags and existing queue tables. **Produces:** signed metrics/queues routes and createTelemetry API defined in spec.

- [ ] Write telemetry RED test sending1000 random unknown request paths and fixed allowlisted templates. Snapshot label cardinality must not grow; no URL/subject/tenant/body/request ID appears. Fake monotonic clock proves fixed histogram boundaries and process recreation resets counters.
- [ ] Implement bounded enums and <=128 route template allowlist, saturating counters, fixed `[10,50,100,500,1000,5000]` buckets. HTTP completion hook records once; worker catches record failure and retain drain promise lifecycle. Generate server UUID request ID for response/log correlation only.
- [ ] Add signed routes with existing platform:operate preHandler; metrics query empty, queues query empty. Queue SQL always filters actor organization before aggregation. Build explicit mapping from current outbox/timer/wait/automation schema status enums; do not expose raw rows. Counts strings, nullable oldestPendingAt, fixed empty rows.
- [ ] Test unsigned401, wrongrole403, unexpected query400, unavailable DB503, tenantA never sees tenantB counts, queues have no raw payload/error/profile. Metrics explicitly scope process and available only to platform:operate; no implied tenant-specific process totals. Existing retry endpoints unchanged and tested not widened by operate role.
- [ ] Run `pnpm exec vitest run apps/api/src/operations` and API typecheck. Parent signed HTTP confirms real worker success/failure, fixed labels and request correlation without token leakage. Review/scoped commit `feat: expose bounded signed runtime diagnostics`.

## Parent acceptance and handoff

- [ ] Add `scripts/smoke-storage-search-ops.mjs` and matching package command to exercise actual PostgreSQL/filesystem/signed HTTP. Use isolated generated fixture IDs/database/root, existing provisioning and no replacement of teammate accounts. Preserve object directories. Bound each test and log sanitized evidence under output without staging it.
- [ ] Run meaningful negative matrix from spec, including every file path max1, SQL/commit failure bytes retention, post-switch failclosed, metadata preservation, snapshot-derived inventory,106+ search paging, before-DB config rejection and draining active workers.
- [ ] Update API/deployment/recovery docs with implemented contracts only. Explicitly label process-local counters, opt-in wait timeout, local filesystem limits and DB-only rehearsal limits. Do not claim remote storage/full recovery without paired manifest rehearsal.
- [ ] Independent read-only review checks all spec requirements and current diff; resolve findings before whole `pnpm check`. Run affected foundation/entity sharing/data-tools/workflow regressions and new real smoke with Gateway rate-limit spacing.
- [ ] Record exact commit/test evidence in master ledger. No push/merge/release in source handoff. Parent handles existing PR13/latest-head CI under master authorization after whole composition acceptance.

## Document self-review

Coverage: Tasks9A/9B implement storage lifecycle and all-path authorization;9C covers snapshot-consistent recoverability;10 covers query/index/ACL paging;11A covers config/drain;11B covers metadata routes and bounded telemetry. Parent acceptance covers real runtime, restart, concurrency and poolmax1. No source feature is counted complete from this documentation commit.

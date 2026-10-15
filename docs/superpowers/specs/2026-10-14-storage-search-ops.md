# Storage, search, and observable runtime design

Date: 2026-10-14. Detailed design for master enterprise-composition Tasks 9–11. This document is a future implementation contract, not a claim that these features are implemented.

## Scope and invariants

- Fastify/TypeScript/pg, Node filesystem/crypto, existing dependencies only. No framework, S3 adapter, HA, offsite DR, arbitrary document extraction, or UI work.
- Default PostgreSQL byte storage remains unchanged. Existing uploads remain at most 1,048,576 decoded bytes and the existing 1,450,000 HTTP body bound.
- JWT capabilities and current resource authorization precede byte loading. Pending/rejected metadata remains readable under existing access policy; bytes require current clean scan status.
- All nested operations use the caller's PoolClient. Pool max1 must work. No transaction helper may acquire another connection while a caller holds one.
- No automatic object deletion, garbage collection, volume reset, overwrite, source purge, or destructive migration rollback. Preserve existing user files and output artifacts.
- Source implementers own API modules/tests; parent owns scripts, package commands, deployment documentation and full acceptance. Stay on current branch; no switch/push/merge.

## Existing seams

`foundation-database.ts` stores `foundation_files.content bytea NOT NULL` and reads owner/task bytes directly. `foundation.ts` shares the same read methods between metadata and content routes and checks scan status after fetching bytes. `workflows/database.ts.readSharedFile` checks workflow policy then fetches content, resolving definitions through its pool. `entities/data-tools-database.ts.attachmentContent` owns a transaction and fetches content before its clean check. All four paths must change together.

`entities/access.ts.accessPredicate` implements current person/department membership and tenant ACL. Reuse it for search; do not copy a stale role snapshot into an index. `operations/routes.ts` already has signed platform:operate diagnostics and retention preview. Extend that registration. `index.ts` currently defaults wait-timeout processing on and validates connector configuration after database connection; Task 11 makes every worker explicit opt-in and parses configuration before connection. `scripts/backup-core.mjs` currently creates a bounded dump and disposable DB-only restore fixture; this is not full filesystem recovery.

## Task 9: content storage

### Internal interfaces and public routes

```ts
type StoragePointer =
 | {provider:'postgres'; objectKey:null; sha256:null; size:number}
 | {provider:'filesystem'; objectKey:string; sha256:string; size:number};
type FileAccessContext =
 | {kind:'foundation'} // owner, workflow sharing, then non-workflow task fallback
 | {kind:'entityAttachment'; entityId:string};
type FileReadActor = {subject:string; organizationId:string; roles:string[]};
interface ObjectStore {
 writeVerified(content:Buffer):Promise<{objectKey:string; size:number; sha256:string}>;
 readVerified(pointer:Extract<StoragePointer,{provider:'filesystem'}>):Promise<Buffer>;
}
type FileContent = {filename:string; content:Buffer};
// Helpers take PoolClient, never Pool. They do not begin/commit/release transactions.
readFileMetadataWithClient(client:PoolClient,actor:FileReadActor,fileId:string,context:FileAccessContext):Promise<FileItem|undefined>;
loadFileContentWithClient(client:PoolClient,actor:FileReadActor,fileId:string,context:FileAccessContext,store:ObjectStore|undefined):Promise<FileContent|undefined>;
offloadFileWithClient(client:PoolClient,fileId:string,expectedStorageVersion:number,store:ObjectStore):Promise<'switched'|'already_switched'>;
```

Keep `POST /v1/files`, `GET /v1/files/:id`, `GET /v1/files/:id/content`, and `GET /v1/entities/:id/attachments/:fileId/content`. There is no public provider/path/key selection or storage migration route. Metadata contains existing FileItem fields only, never objectKey, digest, provider, physical path or Buffer. Attachment lists likewise stay metadata-only. Invalid/missing/not-authorized IDs remain 404, missing route capability 403, pending/rejected bytes 409, corrupt/unavailable configured storage 503 with fixed `file_storage_unavailable` code and no filesystem error text. Missing provider configuration for an existing filesystem row fails closed rather than treating it as a PostgreSQL row.

The central loader performs: validate UUID/context; evaluate current authority for the requested path; lock file metadata FOR SHARE; require clean; fetch provider bytes; verify size and digest; return bytes. Metadata helper never calls the store or selects content. Foundation access tries owner, workflow sharing, then task policy on the same client, without loading bytes for a failed branch. Use definition lookup with the supplied client instead of calling the pool. Entity context checks current data:read/files:read, entity/archive policy and current attachment link before file read; it does not grant generic foundation access.

Retain existing workflow-run-before-entity lock ordering. Shared workflow access locks its qualifying run before file metadata; task access locks the qualifying task/record before file; entity attachment access locks entity then attachment link then file. Re-evaluate authority after obtaining locks. Existing entity grant revocations serialize on entity rows; directory membership uses current checkAccess locking. Do not hold a file lock and then acquire a workflow/entity lock. A transaction that acquired current authorization first may finish its bounded read while a concurrent revoke waits; subsequent reads observe committed revocation. No promise to recall bytes already sent. All content routes hold their read transaction through verification, then commit and send the bounded Buffer; verification failure rolls back.

### Additive schema

Run initialization after foundation_files creation and before repositories serve requests. Use migration-name existence checks for constraints; do not assume ADD CONSTRAINT IF NOT EXISTS syntax. Validate legacy rows before attaching constraints and fail startup on invalid existing sizes, without deleting rows.

```sql
ALTER TABLE foundation_files ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'postgres';
ALTER TABLE foundation_files ADD COLUMN IF NOT EXISTS object_key uuid;
ALTER TABLE foundation_files ADD COLUMN IF NOT EXISTS content_sha256 text;
ALTER TABLE foundation_files ADD COLUMN IF NOT EXISTS storage_version integer NOT NULL DEFAULT 1;
ALTER TABLE foundation_files ALTER COLUMN content DROP NOT NULL;
-- Named CHECK foundation_files_storage_shape:
CHECK (storage_version > 0 AND size BETWEEN 0 AND 1048576 AND (
 (storage_provider='postgres' AND content IS NOT NULL AND object_key IS NULL
  AND content_sha256 IS NULL AND octet_length(content)=size)
 OR
 (storage_provider='filesystem' AND content IS NULL AND object_key IS NOT NULL
  AND content_sha256 IS NOT NULL AND content_sha256 ~ '^[a-f0-9]{64}$')
));
CREATE UNIQUE INDEX IF NOT EXISTS foundation_files_object_key_unique
 ON foundation_files(object_key) WHERE object_key IS NOT NULL;
```

CHECK is shown as its expression; install via ALTER TABLE ADD CONSTRAINT after introspection. New uploads first commit PostgreSQL bytes and preserve existing scanner behavior. Offload only clean rows; pending/rejected retain bytes and metadata unchanged. A single-flight opt-in worker processes one row per tick, oldest created_at/id first, locking `FOR UPDATE SKIP LOCKED` with limit1. Expected storage_version supports repeat/race checks; reread under lock, return already_switched for a verified existing filesystem pointer, reject mismatched PostgreSQL revision. No user-visible file version is added. Scan transitions retain their current semantics and cannot race the file lock.

### Filesystem lifecycle and threat boundary

`FILE_STORAGE_PROVIDER` is absent/postgres/filesystem, default postgres. Filesystem requires `FILE_STORAGE_ROOT`, an existing absolute directory created by the deployment operator. Root is server-only and fixed for process lifetime. Validate every component with lstat and canonical realpath; reject symlinks/junctions, non-directory ancestors and differing canonical resolution (case-normalized on Windows). Reject a root shared with writable untrusted users. Node portable APIs cannot eliminate replacement races by a privileged local actor; ownership/ACL isolation is an explicit deployment precondition. Use O_NOFOLLOW where supported plus pre/post lstat, file-descriptor fstat and realpath identity checks; unsupported platforms still require isolated root and rejection tests, never claim kernel-enforced path resolution everywhere.

Objects are flat lowercase canonical generated UUID-v4 names, without extension or user-derived filename. Reject all keys not matching that exact grammar before joining root. Open final UUID path exclusively (`wx`, mode0600); this exclusively reserved file is the unpublished staging object. Write at most1MiB, sync, reread via descriptor, verify exact length and SHA256, close, reopen/verify pathname identity and bytes. Do not rename over a destination. Only then publish its key in DB. Partial/unpublished objects remain orphans for manual inspection; no automatic cleanup. Cap any attempted read to expected size+1 before allocating; reject non-regular files, symlinks, inode/identity change, too-short/long data, wrong digest. Revalidate root on each operation. Never log root/key/raw error details to API responses or metrics.

Within the same caller transaction/client, after verified write:

```sql
UPDATE foundation_files SET storage_provider='filesystem',object_key=$2::uuid,
 content_sha256=$3,content=NULL,storage_version=storage_version+1
WHERE id=$1 AND storage_provider='postgres' AND storage_version=$4
 AND scan_status='clean';
```

Require one updated row. Write, verification, UPDATE or COMMIT failure leaves durable PostgreSQL bytes intact (rollback); successful object writes may be orphaned. Never clear bytes before verification. Restart retries select database state, not directory listings. Once switch commits there is no database fallback: missing/corrupt object returns503 even if an unrelated copy exists. Disabling offload stops future switching; reads of existing filesystem rows still require their configured store/root. Switching provider to postgres with existing filesystem rows must keep FILE_STORAGE_ROOT readable or fail startup. No reverse migration or garbage collection in this increment.

### Recovery contract (parent implementation)

Existing `backup:core`/`backup:rehearse` remain explicitly `scope:'database-only'`; reports say `fullRecoverability:false` whenever external objects are referenced. Never infer complete recovery from row counts/sentinel alone.

Add explicit `backup:full` and `backup:rehearse-full` commands using a new `scripts/lib/object-backup-policy.mjs`. Dump first (existing 256MiB bound), restore that dump into generated `dx_restore_<32hex>` fixture, and query the complete filesystem inventory from that restored DB, ordered by file ID. Do not inventory the changing live DB before/after dump. This inventory defines exactly the immutable objects required by that snapshot; source writes can continue because referenced objects are never automatically deleted.

Full manifest version1 contains dump basename/SHA256/bytes, createdAt, scope:'database-and-objects', inventory entries `{fileId,objectKey,size,sha256}`, count and totalBytes. Bounds: manifest <=8MiB before parse, <=10,000 entries, each size0..1MiB, total <=1GiB, unique fileId and objectKey, UUID grammar, lowercase 64hex digest, no extra fields or arbitrary paths. Checked integer sums must equal count/totalBytes. Abort if bounds exceeded; never truncate inventory or label a partial set complete. Copy each validated source to an exclusive file in a new generated backup directory, one object at a time, verify source and copied bytes and exact size. Final manifest is written exclusively only after all copies verify; an incomplete directory has no valid final manifest and remains untouched for inspection.

Full rehearsal validates bounded manifest/dump, restores into fresh generated DB, derives inventory again, requires exact set equality including all IDs/digests/sizes, copies objects into a fresh isolated restore root, verifies every object, then exercises at least one filesystem-backed download via central loader and clean authorized actor. Missing/corrupt/extra-manifest/omitted-reference/duplicate entry fails report; extra unreferenced directory objects are reported and never used. Report includes actual count/bytes and no HA/offsite claim. Fixture DB cleanup remains narrowly generated and existing-policy checked; object directories are retained, never recursively deleted automatically. Parent updates deployment docs with paired root mount and dump/object backup retention, startup ownership checks, and an explicit manual recovery procedure.

## Task 10: full-text entity search

`POST /v1/entities/search` requires signed data:read. Strict JSON body `{q,schemaId?,schemaVersion?,limit?,offset?}`; schemaId/schemaVersion must appear together or neither. q trimmed 1..200 Unicode codepoints, <=800 UTF-8 bytes, no NUL/control characters; body <=4096 bytes. Pin version integer1..2147483647; slug uses existing schema policy. limit integer1..100 default50; offset integer0..10000 default0. Reject unknown fields, filters, raw SQL, operator AST, sort, HTML options and mismatched pins with400. Existing publication lookup confirms an optional pin is available in current tenant; invisible/nonexistent publication returns404. Empty lexeme query yields empty page. Inputs such as `x | y` are plain text, never tsquery syntax.

Search indexes title and scalar attribute values using PostgreSQL simple configuration, not JSON property names. Boolean/numeric/string JSON values are included; attachment bytes and workflow private projection values are excluded.

```sql
ALTER TABLE enterprise_entities ADD COLUMN IF NOT EXISTS search_vector tsvector
 GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig,coalesce(title,'')) ||
  jsonb_to_tsvector('simple'::regconfig,attributes,'["string","numeric","boolean"]'::jsonb)
 ) STORED;
CREATE INDEX IF NOT EXISTS enterprise_entities_search_idx
 ON enterprise_entities USING gin(search_vector);
```

Use a parameterized `plainto_tsquery('simple'::regconfig,$q)` with `search_vector @@ ...`. Exact current tenant/accessPredicate('e',actor,org,'read'), `archived_at IS NULL`, optional schema/pin are all in WHERE before ORDER/LIMIT/OFFSET. Return normal Entity items and existing pageResult page metadata; no total count, HTML snippets, highlighted markup, private ranking evidence, or inaccessible metadata. Order `created_at DESC,id DESC`, fetch limit+1 for hasMore. Each request observes current ACL at its statement snapshot; pages are not a frozen snapshot. Revoke/membership/archive between requests must remove rows on the next request. Use caller client, SET LOCAL statement_timeout='3s', commit/rollback/release; timeout maps503 `search_unavailable`, no SQL details. No dynamic SQL identifiers from clients.

Interfaces: `parseEntitySearch(input:unknown):EntitySearch`, `searchEntitiesWithClient(client:PoolClient,scope:Scope,query:EntitySearch):Promise<Page<Entity>>`; EntitySearch has the normalized fields above. Repository wrapper owns one transaction; direct caller helper owns none. DDL updates automatically on create/update/import/migration; no separate asynchronous index synchronization. Startup DDL may lock/rewrite this bounded store; deployment must schedule it and measure real-table impact, not claim an online migration. Verify EXPLAIN on populated fixture with ANALYZE and representative selective query; small fixtures may legitimately choose sequential scan. Planner eligibility diagnostic may disable seqscan locally but must be labeled diagnostic, never performance proof.

## Task 11: configured runtime and operations

`parseRuntimeConfig(env:NodeJS.ProcessEnv):RuntimeConfig` is pure and called before connectRecords, app creation, worker starts or listen. Parse all booleans strictly: absent/false disabled, true enabled; reject every other string. Keys: ENTITY_AUTOMATION_WORKER, WORKFLOW_TIMER_WORKER, WORKFLOW_WAIT_TIMEOUT_WORKER, WORKFLOW_OUTBOX_WORKER, FILE_STORAGE_WORKER. The last requires filesystem provider/root; all enabled workers require DATABASE_URL. Outbox requires existing configured HTTP(S) WORKFLOW_EVENT_URL and nonempty WORKFLOW_EVENT_TOKEN, not a public URL input. Existing scanner/API port ranges1..65535 are checked before DB. Preserve valid current configuration but document that previously default-on wait timeout must now be explicitly enabled. No credentials, URLs or root paths in returned diagnostics.

`RuntimeConfig` carries storage provider/root, worker flags, validated port and connector configuration for internal use only. Start single-flight workers after repositories and HTTP app are ready; shutdown stops all scheduling first, awaits all active ticks, then closes pool. Each worker exposes `stop():Promise<void>` idempotently; close hook uses allSettled to drain every worker even when one stop fails, closes pool afterward, reports a sanitized failure. Do not Promise.race a drain timeout and close a live client's pool. Failed bootstrap stops anything already started and closes the database before rethrowing. SIGINT/SIGTERM repeated signals do not start parallel drain paths.

Extend existing signed platform:operate routes:

- `GET /v1/operations/metrics`: no query/body. Returns process-local counters/duration buckets, process startedAt and scope:'process'; no tenant totals. Require platform:operate and current verified organization exactly as diagnostics. This is explicitly platform-wide aggregate operational data available to that capability, not tenant metrics.
- `GET /v1/operations/queues`: no query/body. Count statuses for only actor.organizationId; fixed queues `outbox`, `timers`, `waitTimeouts`, `automations`. Return fixed `{queue,status,count:string,oldestPendingAt:string|null}` records and configured-enabled flags. Map real table status enums explicitly, return zeros for empty tenant. No payload, service profile, entity title, actor, path, exception text, token, run data or foreign tenant counts.

No generic retry/mutation endpoint is added. Existing workflow and automation retry APIs retain their own current capabilities, version/idempotency and resource policy; platform:operate alone does not grant workflow transition or data automation authority. Read-only queue diagnostics use one client/transaction with3s statement timeout; errors503 sanitized. Storage offload is a scan, not a durable delivery queue, so expose its worker enabled/status via diagnostics, not invented persistent delivery rows.

`createTelemetry():Telemetry` returns `recordHttp(route:RouteId,method:Method,statusClass:StatusClass,durationMs:number):void`, `recordWorker(worker:WorkerId,result:'success'|'failure'|'idle',durationMs:number):void`, `snapshot():MetricsSnapshot`. Enums are server-defined; unknown routes collapse to `unmatched`, methods to `other`, statuses to1xx..5xx. WorkerId is the five fixed workers. RouteId comes from a checked route-template allowlist capped128; never req.url/path/query, entity IDs or user label strings. Fixed duration buckets milliseconds `[10,50,100,500,1000,5000]` plus overflow; saturate counts at Number.MAX_SAFE_INTEGER, reject negative/nonfinite durations. Bound storage by enum product, no arbitrary Map growth. Never record body, JWT, subject, tenant, filename, object key, connector, error message or correlation ID as labels. Monotonic durations, process reset on restart, no persistence or cross-instance aggregation claims. HTTP hooks record one observation per completed response including errors; worker catch paths record failure without swallowing drain state. Generate a server UUID request ID for response/log correlation; untrusted supplied IDs are not echoed or used as labels.

## Verification and release gates

Task9 tests: default PostgreSQL compatibility; metadata pending/rejected never invokes store; all four paths current grants/scan first with store spy; clean filesystem round trip; too large/traversal/absolute/uppercase key/symlink/junction/nonregular/overwrite/partial write/wrong size/digest; write/verification/SQL/commit failure retains DB bytes; committed missing/corrupt pointer never falls back; two workers switch once; revoke and scan-change races; restart; max1 for every path including workflow definition and attachment caller. All runtime flags tested false/true/invalid without side effects.

Task10 tests: strict bounds/pin pair, SQL injection as text, index migration idempotency, attributes/title updated through all canonical writers, 106+ visible matching rows with invisible rows preceding page boundary, foreign tenant/disabled member/department move/grant revoke/archive, mixed schemas, timeout rollback and max1. Signed endpoint and real PG planner evidence required.

Task11 tests: unsigned401/wrongrole403, tenant-scoped queue zeros and foreign isolation, no sensitive fields, bounded labels under1000 random URLs, worker success/failure/duration and reset, malformed config before DB spy, explicit worker activation, overlapping ticks prevented, drain waits for active work and stops all workers on failure, restart resumes durable jobs under current service roles. Parent validates paired backup inventory against restored dump while live writes happen, deliberate missing/corrupt/duplicate/oversized manifests and DB-only report distinction. Review and targeted tests precede whole `pnpm check`; completion requires real PG/filesystem/signed HTTP evidence, not mocks alone.

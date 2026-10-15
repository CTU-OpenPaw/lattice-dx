# Enterprise engine composition increment

User approved the direction and requested a long plan followed by autonomous implementation on 14 October 2026. This follows the accepted bounded backend v1, not a replacement of its ownership/transaction model.

## Outcome

An enterprise system can declare its data/workflow bindings, attach runs to real business entities, react to committed data changes, use explicitly authorized projected fields in bounded calculations, and request scoped aggregates/search. Studio remains Hưng's implementation; external broker/n8n/agent adapters remain Nhi's implementation. Backend configuration/runtime/contracts belong to Duy.

## Global constraints

- Engine owns shared PostgreSQL data; NocoBase is Studio/UI. Preserve existing independent run/record IDs.
- One current branch `codex/entity-sharing-permissions`, existing PR13, no new branch/worktree, no auto merge/release or Notion ticks. Preserve CV.pdf, a.png, output and all persistent volumes.
- Fastify/TypeScript/pg, small focused modules, no new framework. This increment uses existing dependencies. File storage first supplies a concrete local filesystem provider; remote provider deployment is a separate integration, not a fabricated S3 implementation.
- JWT supplies actor/tenant/roles. Current resource policy applies independently of workflow/task readership. Installers, event payloads, projected attributes and module manifests cannot create authority.
- New mutations require idempotency and expected version/revision. Mutation, audit, internal event and receipt share a transaction; delivery occurs after commit. Pool max1 must support new execution and replay.
- Existing resource lock order: existing workflow run first, then known entity UUIDs sorted, then resource authority checks. Entity mutation never synchronously locks an existing workflow. Immutable association creation is confined to new runs.
- Expressions can affect attribute values and predicates, never resource IDs, actors, tenant, roles, connector URL or service selection. No eval, JavaScript, raw SQL, templates executing code or arbitrary property traversal.
- Private projections/calculations stay transient inside the transaction; ordinary workflow evidence contains identifiers, versions, names of selected fields and status only. Do not widen existing reader roles or persist projected values in run data/receipts.
- Each delivery is performed by a configured current service profile, never by replaying stored JWTs or originating actor role snapshots.
- Runtime features must be wired and exercised. Interfaces alone are not counted complete. Adapter/service profiles are provisioned explicitly; no live fixture replaces/disables teammate accounts.

## A. Immutable entity context

Optional workflow start `entityContext:{entityId}` links one existing readable active entity; persisted association derives schema ID/version and records entity version at start. Require data:read in addition to existing start permissions. Validate link/current access on replay before returning the receipt. Run recordId remains unchanged. Ordinary workflow readers see association metadata, not entity values; entity read access is not inherited.

`GET /v1/entities/:id/workflows` requires data:read and current entity access, returns a bounded page filtered by current canReadRun before LIMIT. `GET /v1/workflows/:id/entity-context` checks both run policy and current entity read, returns current entity metadata plus pinned-at-start context, not private attributes. Archived current entities follow existing owner/shared archive policy. Association is immutable; no ownership or context reassignment in this increment.

## B. Committed data events and trusted automation

Append metadata-only events at shared write/audit boundaries for actual entity create/update/archive/link/unlink/migration. Relation no-op and receipt replay produce no extra event. Grants/attachment mutations are not automatic business triggers in this version. Event taxonomy and exclusion are explicit.

Configured entity automations match fixed schema/pin/operation and start a pinned workflow in response. They reference a deployment-managed service profile and map only event metadata/literals into declared start inputs; entity attributes are obtained by authorized workflow projection later. One immutable delivery per event/rule revision; retries retain configured revision and dedupe key. Worker loads current rule enable state, service profile/roles, entity visibility, published definition and module start gate. Atomic delivery transaction creates workflow with entityContext, optionally executes one configured interactive transition using the real service actor, and stores receipt/provenance. No event-to-existing-run correlation or service-transition bypass is introduced. Rule change cannot rewrite an already accepted delivery. Bounded attempts/backoff, sanitized failure codes, opt-in worker, signed scoped status/retry APIs.

## C. Authorized projections and typed calculations

Add an explicit entity projection step for at most20 declared fields. Read with actual actor data:read/current ACL and pinned entity schema; capture values in a private executor map only. Public result remains entity metadata and selected field names.

Versioned expression AST supports typed literals, data/input references with explicit conversions, prior projection/evaluation references, exact decimal add/subtract/multiply/divide (bounded scale and documented rounding), comparisons, boolean all/any/not and coalesce. Max depth8/nodes100/arguments20/fields20; bounded strings and decimal digits. Reject unsafe keys/unknown operators/nonfinite numbers/missing required refs/type mismatches/divide-zero. Resource identity bindings remain unchanged. Evaluation/assertion steps and attribute bindings consume transient results; false assertion yields409 and rolls back prior effects. No attributes are copied into public execution evidence. Catalog and portable bundle validation describe these rules.

## D. Declarative business bindings

Extend module manifests with optional bounded `bindings` linking a named schema publication to a workflow definition and allowed actions. Own installed schemas are version1; workflow drafts are checked at install and exact published mapping at enable. External schema/workflow references require exact declared module dependencies and available pins. Starting by binding validates enabled module, schema/pin/entity and actual actor capabilities before normal workflow creation; shares no extra permission. Preview reports missing/mismatched bindings before writes. Existing manifests continue working unchanged.

## E. Aggregates and frozen reports

Typed aggregate API supports count/sum/min/max/average and bounded groupBy, reusing schema validation and SQL ACL before aggregation. PostgreSQL numeric provides precision; decimal and potentially large count results are strings with explicit empty/missing semantics. No rawSQL or arbitrary joins. Limit200 groups/10 metrics and bounded statement timeout; mixed-schema casts are guarded.

Owner-scoped report snapshots persist aggregate output and private source-ID dependencies at a consistent boundary, max5000 visible source entities. Snapshot read rechecks current read access to every dependency; revoke/department move/archive can deny historical snapshot read. New source values do not silently rewrite frozen output. Dependency IDs/private values do not leak through list metadata. Idempotent creation and replay obey current capability/visibility. No lakehouse or historical ACL bypass is claimed.

## F. Storage/search/operations

Optional filesystem object provider removes durable bytes from PostgreSQL after verified immutable object writes, while existing scanned upload/download contracts and default PostgreSQL provider remain compatible. DB retains bytes until the filesystem copy is proven; failures keep a readable fallback. Generated UUID keys, fixed validated root, exclusive staged writes, size/SHA256 verification and no arbitrary path input. No automatic deletion of user files; backup documentation includes object inventory/checksum and explicitly separates DB-only restore.

Full-text entity search uses PostgreSQL parameterized search and current ACL before result paging, bounded query length and index, no HTML snippets or cross-tenant metadata. Operational counters/queue diagnostics are metadata-only, with no token/body/subject metric labels; signed administrative metrics and current-tenant queue status. Deployment configuration enables only provisioned workers; smoke proves real configured runtime and restart behavior. This does not claim HA, offsite DR, arbitrary document extraction or remote object storage.

## Acceptance

Each subsystem needs meaningful RED/GREEN cases, signed API acceptance, isolated PG rollback/concurrency/max1/restart coverage and an independent review. Whole check/regression chain/latest-head CI before final completion. Current-ACL projection leakage, queued service revocation, no-op/replay event duplication, delivery crash recovery, module pin mismatch and snapshot revoke are mandatory negatives. Local plan status may be updated; Notion remains unchanged.

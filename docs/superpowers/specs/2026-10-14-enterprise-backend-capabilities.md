# Enterprise backend capabilities — Duy

User requests broad enterprise engine capabilities, not demo-specific backend. On 14 October Duy explicitly chose: engine owns common business data; NocoBase is Studio/UI. Original engine code stays Apache-2.0; upstream licenses untouched. Hưng owns plugin/UI; Nhi owns deployed n8n/broker/agent adapters. This specification covers backend services/contracts for them, never claims their integrations are delivered.

## Target capability groups and implementation order

1. **Typed enterprise data:** versioned schemas, typed CRUD, scoped relations, archive, paginated/filter queries, optimistic concurrency and durable audit. First increment below.
2. **Organization and access:** department references, members and responsible people, scoped permission policies, explicit sharing/revocation. Keep identity in Keycloak; directory remains a controlled snapshot until its refresh/revocation policy is extended.
3. **Task and approval lifecycle:** individual/department routing, claim/reassignment, cancellation, deadlines, approval outcomes and audit. Workflow-linked resources must update transactionally with the run; recipient replacement revokes old work authority.
4. **Action/block platform:** small server-owned registration contract, schemas for inputs/outputs, action versions, discovery and capabilities, record/entity read/query/update/link/archive and task lifecycle blocks. No uploaded arbitrary code. Reuse entity/task services, not independent shadow data stores.
5. **Workflow orchestration:** existing drafts/versioned execution/waits/conditions plus timers, compound conditions, cancellation and guarded automatic service steps. Later branching/parallel joins require a separate execution design; no blanket promise of BPMN completeness.
6. **Events and integration contracts:** event catalogue, tenant/source provenance, validated ingress, subscriptions and delivery/result recovery; server-held connector configuration and diagnostics. Nhi supplies external adapters and NGSI-LD mappings.
7. **Module lifecycle:** package manifest references schemas/actions/workflows/permissions/integrations, dependency checks, draft/publish/version, enable/disable/export/import. No implicit role grants or destructive upgrades to running versions.
8. **Operation and recovery:** readiness, scoped job/audit queries, correlation, backup and isolated restore verification. Retention policies for audit/receipts need explicit guarantees; app audit is not a legal immutable ledger.

Each group is accepted separately with real SQL and signed API tests. Completing group1 does not complete this target. Scope is platform capabilities, no domain-specific inventory/payroll/accounting engine. Use small Fastify/pg modules and packages/contracts. No additional service/framework merely to increase component count.

## Increment 1: typed enterprise data contract

Original generic records and workflow storage stay compatible. New typed entities use separate engine-owned tables; do not migrate or overwrite NocoBase collections. Each business data kind must have one authoritative source; UI refers to the engine entity ID, connectors map external IDs separately.

Schema draft has slug `id`, title, required field definitions and explicit relation definitions. Types: text, boolean, integer, decimal, date, enum. Field options: required; maxLength bounded for text; choices for enum. Decimal is a bounded plain decimal string to preserve precision; integer is a safe JSON integer; date is real YYYY-MM-DD. Empty required text rejected; unknown attributes and unsafe keys rejected. User metadata cannot set identity/tenant/owner/version/archive/audit. At most50 fields/20 relation definitions. JSON HTTP bounded by existing16KiB.

Routes designer JWT `data:design`:
POST/GET `/v1/entity-schemas` creates/lists scoped drafts;
GET/PUT `/v1/entity-schemas/:id` reads/saves expectedRevision;
POST `/v1/entity-schemas/:id/publish` expectedRevision creates immutable version, duplicate same revision returns same publication; stale revision409. Relation target schema IDs must exist as published in the same tenant at publication, except self-reference. No automatic migrations.

GET `/v1/entity-schemas/:id/versions/:version` requires data:read and returns explicit immutable published schema in the caller's tenant (never draft). Positive version bounded to PostgreSQL integer. Ordinary users need this to render an entity pinned to v1 after v2 publication; draft design permissions are not implicitly granted.

Entity routes:
POST `/v1/entities` `data:write`: `{schemaId,title,attributes}` uses latest publication, stores pinned schemaVersion. Require Idempotency-Key for new APIs (no pre-existing clients); creation receipt namespace entity.create reuses command helper with typed canonical fingerprint.
GET `/v1/entities` `data:read`: limit/offset/q/schemaId filter applied before paging, active caller-owned entities only.
GET `/v1/entities/:id` `data:read`: owner + signedtenant only, no org-wide default.
PATCH `/v1/entities/:id` `data:write`: `{expectedVersion,title,attributes}` complete replacement of mutable fields; validate pinned schema, lock entity, audit + version + command receipt atomic, require key; replay does not advance version twice. Missing/hidden404, conflicting state/version/key409.
POST `/v1/entities/:id/archive` `data:write`: `{expectedVersion}` audited softarchive; no hard delete. Active list excludes archived, detail owner can inspect archive; archived entity cannot mutate/link; require command key.

Relations declared by source schema `{name,targetSchemaId}`; cardinality many for initial increment, no automatic uniqueness or graph inference. POST `/v1/entities/:id/relations` data:write `{name,targetId,expectedVersion}` and DELETE `/v1/entities/:id/relations/:name/:targetId` expectedVersion body. Both endpoints require key and lock source/target in stable UUID order, verify same owner/tenant, active source, pinned source declaration and correct target schema ID. New link requires active target; unlink may remove a relation to an archived target so cleanup remains possible. Accepted-key replay returns its historical snapshot after current ownership checks, even if an entity was later archived. Linking/unlinking updates source version, audit and receipt atomically. Exact repeat with a new key is an idempotent set membership no-op (does not fabricate a second link); version policy must be documented. GET `/v1/entities/:id/relations` data:read uses paging and checks current readable targets so a changed target never leaks.

GET `/v1/entities/:id/history` data:read paginated tenant/owner filtered audit. Store actor, operation, from/to versions, occurredAt and bounded input/result; no tokens/secrets. Route has no update/delete audit endpoint.

Use signed JWT actor/tenant only and capabilities data:design/read/write. No role bypass for entity owner and no role granted by schema. Directory responsible/department sharing is deferred to group2; this restrictive baseline is explicit.

SQL transactions, single PoolClient, stable row lock ordering, safe parameterized queries. Scope all receipts by tenant+actor+operation+key, canonical typed JSON fingerprint rather than string-only input. Workflow command behavior remains unchanged. Domain-specific CRUD/table builders and UI are outside this increment.

## Acceptance

Strict typed schema/attributes and relation declarations; signedrole401/403 and crossowner/tenant404; schema publish/save races; v1 entity validation unchanged after v2publish; paginated complete data; equal/conflicting commands races; mutation/archive/link audit atomic; archived restrictions; link target hidden/wrongschema/archive rejected; source+target locking no nested pool acquisition; restart/pool persistence. Real private SQL, liveGateway/API smoke and pnpmcheck. No Notionticks/automerge/release/user-artifact cleanup. Later groups retain their own implementation acceptance before broad capability completeness is reported.

# Immutable business entity context for workflows

Task1 of enterprise composition. Parent scope/constraints are inherited from 2026-10-14-enterprise-composition.md. User already approved direction and execution; no extra confirmation gate.

## Contracts

`CreateWorkflow` gains optional `entityContext:{entityId:string}`; exact inner shape, UUID normalized lowercase, no schema/owner/roles input. Internal createWithClient keeps optional definitionVersion. Body without context remains compatible and fingerprints unchanged. New run response optional context metadata: `{entityId,schemaId,schemaVersion,entityVersion}` derived at creation. Context is immutable and does not change independent run.recordId.

Start with context requires data:read as well as existing workflow:start/startRole. Current entity scoped read is checked using transaction client under FOR SHARE after fixed new-run start lock; active entity only. Unknown/foreign/unshared entity404, archived source409, missing role403. Insert association plus run/audit/start receipt in same transaction. For accepted start replay, use stored association to check current entity access before fingerprint conflict or returning snapshot; same caller revoked returns404. Archived owner replay may return accepted snapshot if still owner-readable; shared archive denied. Current role still required. Do not reinterpret context after later schema migration; original pin/version remains history metadata.

Optional methods: `entityContext(runId,actor):Promise<{context:EntityWorkflowContext,current:{id,schemaId,schemaVersion,version,archivedAt}}>` and `listEntityWorkflows(entityId,actor,page):Promise<Page<WorkflowRun>>`. No raw attributes/title in context detail. Run with no association404 at context endpoint.

`GET /v1/workflows/:id/entity-context` requires data:read, canReadRun and current entity read. Run owner is not automatically entity owner. Use run FOR SHARE then entity FOR SHARE and shared authority locks to serialize revocation. `GET /v1/entities/:id/workflows?limit&offset&q` requires data:read and current entity read plus run policy filtering in SQL before LIMIT. Context ID metadata returned by normal run does not open entity endpoints.

## Persistence and locking

New workflow_entity_contexts table contains run_id unique/FK, organization_id, entity_id, schema_id, schema_version, entity_version and created_at; index org/entity/time/run. Existing entity source must be transactionally validated even if compatibility bootstrap initializes workflows without entity tables for legacy fixtures. Avoid causing all non-context workflows to require entity initialization. Prefer production ordering if adding entity FK; do not create a second entity schema or silently disable contextvalidation.

Existing run path locks run before entity. Creation has a new run and takes entity only after module start eligibility; it never acquires an existing workflow row after entity lock. Listing must not hold entity lock then get per-run locks in loop; use current visibility SQL and immutable definitions. No nested repository pool calls inside transaction. Extract small shared workflow read-predicate helper if needed so listEntityWorkflows agrees with normal list/canReadRun; pass safe aliases/parameter placeholders, never payloadSQL.

## Acceptance

Strict optional-body/parser compatibility; currentrole/read/start and no inheritedgrant; acceptedreplay after revoke/move disabled/changedcontext; pin preserved after entitymigration; context receipt/audit latefailure allornone; concurrentstart oneassociation; sourcearchive; listmixedvisible/hidden >100 filteredbeforepage; singlepoolclient freshcreate/replay/list/detail afterrestart. Existing module/event/timer/bundle/run smokes stay compatible. SignedHTTP and privatePG required, no live profile/snapshotreplacement. Independent review after source checkpoint.

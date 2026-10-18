# Entity Events and Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Journal/source checkpoint reviewed before dispatching automation implementer.

**Goal:** React to committed business data changes using explicitly provisioned current-service authority.

**Architecture:** Append events and stage immutable matching delivery snapshots inside entity transactions; dispatch runs asynchronously on the supplied workflow transaction client. No nested API calls or actor snapshots.

**Tech Stack:** Existing TypeScript/Fastify/pg/Vitest/Node; no dependencies.

## Global Constraints

Exact eventautomation spec counterpart +parent composition constraints. Samebranch/no implementerpushswitchmerge, no deps/UI/upstream/adapters/credentials/volumes/Notion/userfiles changes. Parent owns scripts/docs/package/gateway/coreenv. Source reports ignored. Existingentity/workflowhelper policy stays source of truth.

### Task 2: event journal

Files new entities/events.ts/events.test.ts, client.ts auditintegration, database.ts initializer, entityroutes integration/tests or focused events-routes.ts; no workflow factory dependency.

```ts
export type EntityEventOperation='entity.create'|'entity.update'|'entity.archive'|'entity.link'|'entity.unlink'|'entity.schema.migrate';
export async function appendEntityEventWithClient(client:Pick<PoolClient,'query'>,scope:Scope,change:{operation:EntityEventOperation;entityId:string;schemaId:string;schemaVersion:number;fromVersion:number;toVersion:number}):Promise<void>;
```

- [ ] RED helper metadata-only operation filter/unsupported noevent/realwrite/migration; create event exactlyonce even acceptedreplay; relationnoop none.
- [ ] Initialize enterprise_entity_events inside entity bootstrap, add narrow audit append after shared auditINSERT for whitelist. FKentity, indexorg/entity/time, uniquefence.
- [ ] Implement GET /v1/entities/:id/events with currentrole/entity read/pagination/error compatibility, no entityfields or credentials in metadata.
- [ ] Run `pnpm exec vitest run apps/api/src/entities` and API typecheck; source-only commit.
- [ ] Parent privatePG forcedjournal failure rollback, workflowlatefailureeventrollback, fivecreatekeyrace/migration/noop/pins/max1 +signedAPI; freshreview/repair gate beforeTask3.

### Task 3a: rules/staging contracts

Files automations/types.ts/policy.ts/database.ts/staging.ts/routes.ts plus tests; app/database wiring, entityeventhelper staging hookup. Databasefactory interface `automationsDatabase(pool,registry,workflows):Promise<AutomationRepository>`.

Repository signatures:

```ts
create(value:AutomationRuleInput,actor:WorkflowActor,key:string):Promise<AutomationRule>;
update(id:string,value:AutomationRuleInput&{expectedRevision:number},actor:WorkflowActor,key:string):Promise<AutomationRule>;
list(actor:WorkflowActor,page:PageQuery):Promise<Page<AutomationRule>>;
deliveries(id:string,actor:WorkflowActor,page:PageQuery):Promise<Page<AutomationDelivery>>;
retry(id:string,deliveryId:string,expectedVersion:number,actor:WorkflowActor,key:string):Promise<AutomationDelivery>;
tickOne():Promise<{deliveryId:string;status:AutomationDelivery['status']}|undefined>;
```

- [ ] RED strictbody/profiles/pins/startmappings/revision/capability and restricted optionalinitialtransition tests.
- [ ] Implement bounded immutable ruleversions/receipts/audit, configurecurrentservice roles through existing resolveServiceActor; noserviceprovision API.
- [ ] Stage matching snapshots only during newevent append sameclient. Don't retrodispatch pre-existingevents; disabled/changedcurrentrules cancel pending oldrevisions. Journal-onlyfixtures lackingrule tables staycompatible.
- [ ] Wire signedroutes andproductionfactory beforewrites; run targetedtests/typecheck/checkpointcommit. Parent review may inspect committedrules while worker proceeds only if no blocking finding.

### Task 3b: durable runtime

Files automations worker/database focused executor/tests, indexclean shutdown. Parent Compose passes opt-in env without changing defaultcredentials.

- [ ] RED dueclaim/freshprofile/entityACL/runcontext receipt/failedsavepoint/retry/concurrency tests beforeworker changes.
- [ ] Implement bounded candidates, due deliverylock SKIPLOCKED, currentrule/profile checks, savepoint create/optionaltransition/receipt atomicity, sanitizedfailures and versionedretry.
- [ ] Worker singleflight stop drains; `ENTITY_AUTOMATION_WORKER=true` enablesruntime and invalidenv rejected. No arbitrary HTTP/code.
- [ ] Run targetedautomation/workflow/entity tests, typecheck; scopedcommit/report stableDTOs. Parent signed/privatePG realworker/profiles/revoke/latefailure/max1/restart and journalregressions, independentreview/fix/fullcheck gate.

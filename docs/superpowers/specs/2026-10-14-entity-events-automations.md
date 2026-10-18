# Committed entity events and current-service automations

Tasks2–3 of approved enterprise composition. Constraints from parent spec apply. Two implementation/review gates: journal first, then automation runtime.

## Journal

Metadata schema: `{id,entityId,schemaId,schemaVersion,fromVersion,toVersion,operation,actorSubject,occurredAt}` plus organization internal scope. Operation whitelist `entity.create`, `entity.update`, `entity.archive`, `entity.link`, `entity.unlink`, `entity.schema.migrate`; no grant/attachment trigger in v1. Event IDs server UUID. Unique(entity_id,to_version,operation), journal FK entity. Immutable append in shared entity audit function after actual resource mutation/audit, all using caller query client. Schema publication changes alone do not emit entity events. Replay/no-op produce no extra entry. Event insert failure rolls back whole mutation; workflow late failure rolls back all newly appended events too.

Signed `GET /v1/entities/:id/events` requires data:read/currententityread, paginated SQL ACL and current archive semantics. Public result contains only metadata; originating actor is provenance, never an execution identity. New table `enterprise_entity_events` initialized by entityDatabase after entity DDL. Existing tests/fixtures get initializer with no workflow dependency.

## Rules and staging

Repository `automationsDatabase(pool,registry,workflows)` initializes rule/version/receipt/audit/delivery stores. Rule exact DTO:

```ts
type AutomationRuleInput={
 id:string; schemaId:string; schemaVersion:number;
 operations:EntityEventOperation[]; serviceId:string;
 definitionId:string; definitionVersion:number;
 title:{source:'literal';value:string}|{source:'event';field:'entityId'|'operation'};
 input:Record<string,{source:'literal';value:string}|{source:'event';field:'entityId'|'schemaId'|'schemaVersion'|'entityVersion'|'eventId'|'operation'}>;
 transitionId?:string; enabled:boolean;
};
```

Max100 rules/org, max10 enabled matches/schema publication/operation; mutation org advisory serialization. IDs existing slug conventions, max10 operations (actual whitelist6), max20 mappings; mapping must exactly satisfy declared required/optional workflow start fields with strict literal validation. `transitionId` optional: only an interactive transition from initial state with no required input fields (optional fields are not supported here), no assigneeField, current actual service must satisfy transition role/ownerOnly (new run owner actual service) and all block capabilities. Timers/connector steps follow their own runtime permissions.

Rule config requires workflow:design +data:automate; actual service profile must currently be enabled/currentdirectory/ workflow:service +workflow:start +data:read +startRole. Validate fixed entity publication/workflow definition; schema accessibility same tenant metadata. Never provision profiles/roles/grants via rule API. Rule config cannot validate rights to all future entities; dispatcher checks each entity.

`POST /v1/entity-automations` mandatorykey; `PUT /v1/entity-automations/:id` fullinput+expectedRevision/key; `GET` paginated with configuration role. `GET /v1/entity-automations/:id/deliveries` and retry require data:automate/workflow:design and currentorganization/rule scope, no role/profile subjects or payload-values in errors/metadata. `POST .../deliveries/:deliveryId/retry` body `{expectedVersion}` key; currentrule enable/revision/current service/published mapping validated before reset/replay. Accepted replay returns initial receipt but only after current capability/profile checks; existing success is not reset.

After Task3, journal append stages matching enabled rules in the **same entity transaction** using plain snapshot rule reads, without invoking workflow/runtime or taking rule FOR UPDATE. Insert immutable delivery snapshots `{eventId,ruleId,ruleRevision,ruleSnapshot}` unique(eventId,ruleId). Rule creation/change affects future event mutations; **no retroactive backfill** of journal rows. Enabling a new rule does not trigger existing entities. Config disabled/changed after enqueue cancels unexecuted old-revision delivery rather than substituting a new snapshot. Production creates stores before accepting entity writes. Legacy fixtures without rule stores keep journal-only behavior; explicit feature absence is supported, not a second source of truth.

## Worker

`tickOne():Promise<{deliveryId,status}|undefined>` candidate query releases pool; execution transaction locks one due delivery FOR UPDATE SKIP LOCKED (bounded20candidate scan). Statement timeout15s, lock timeout2s. Lock current rule FOR SHARE then load service profile/directory shares, current pinned definition and sourceentityread; explicit current data:read/workflow:start and configured transition capabilities. Use supplied workflow.createWithClient with exact definitionVersion/entityContext and unique `automation:<deliveryUUID>` start key; optional interactive transition via transitionWithClient, sameclient/key. Receipt/provenance, run/context/effects and successfuldelivery commit together. No scheduler-only service transition mode or originating actor impersonation.

Attempt savepoint lets a controlled failure store only sanitized code/attempt state with no partial run/audit/receipt. Retry transient DB errors/backoff5/10s maximum3 attempts; terminal authority/pin/entity/archive/rulechanged classified. Disabled/superseded delivery statuscancelled; no quiet success. Unknown errors sanitized internal_error, transientbounded; noSQL/body/token leak. Pending callback not handed to another system; no arbitrary HTTP execution in worker.

Worker opt-in `ENTITY_AUTOMATION_WORKER=true`; validate boolean configuration, singleflight/drain before poolclose. Optional env in coreCompose forwards setting, defaultfalse. Realserviceprofiles provisioned outsidepublicAPI; localacceptance fixture alone sets controlled profiles.

Lock ordering: entitywrite→event→delivery **never workflow**. Dispatcherdelivery→rule→service→module eligibility→sourceentity→newrun (notexisting). New-run context holds source FOR SHARE; entity blocks also prelock existing ID rows FOR UPDATE, including reads. To avoid concurrent lock upgrades, the optional initial transition in v1 only permits `entities.create`, `entities.query`, `records.create`, `tasks.create`, `connectors.dispatch`, `timers.schedule`. It excludes existing-ID entity read/update/archive/link/unlink/project blocks. Rich subsequent interactive workflows remain unrestricted under normal run-first sorted entity locking. This restriction is checked at configuration and dispatch, never silently skipped.

## Acceptance

Journal signedAPI and PG CRUD/relationnoops/migration/rollback/replay/max1. Rule strictactor/mapping/pin/config bounds; journalstage rollbackcoherence; fiveworkers one run/context, disabledrule/service/grantrevoked queuedafterstaging denial; optionalinitialtransition capability removal, lateworkflowreceipt rollback no run/effects, retryafterrepair, contextpins, restart/max1freshdelivery. Runtime opt-in/drain exercised; legacy inboundevent/module/timer/blocksmokes remain compatible. Independent review no public provisioner, no Notion ticks.

## Server-derived recursion limit

Journal stores hidden `automation_depth` from transaction-local `latticedx.automation_depth`, validated 0�8. A dispatched delivery sets depth to its source depth plus one. Events at depth eight remain journaled but stage no further deliveries. Clients cannot supply this depth or alter service authority through event payloads. Actual database journal timestamps are preserved in snapshots.

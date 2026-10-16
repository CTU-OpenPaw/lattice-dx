# Incident agent integration contract

Duy's backend provides the production workflow, entity, ingress and agent-job API paths below. Hung's model worker and Nhi's notification executor/transport call those APIs. The acceptance uses a **simulated worker**, generated RS256 JWTs and real PostgreSQL. It proves backend behavior; real model inference, broker delivery, UI integration and human notification receipt remain teammate integration.

Install `solutions/workflows/incident-module.json` through `POST /v1/enterprise-modules/install` with `{ "manifest": <file contents> }`, publish `POST /v1/workflow-drafts/incident-response/publish` with `{ "expectedRevision": 1 }`, then enable `POST /v1/enterprise-modules/incident/versions/1.0.0/enabled` with `{ "expectedRevision": 1, "enabled": true }`. Each mutation requires a fresh `Idempotency-Key`. Installation publishes schemas `incident-asset` and `incident-rule` v1; workflow publication assigns version 1. The module is installable configuration and does not reserve a builtin definition. Module administration requires `workflow:design` and `data:design`; workflow publication requires `workflow:design`.

The Asset schema is explicitly `incident-asset` v1, with required `status` (`ready`, `in_use`, `repair`, `retired`) and required text `serial`. The agent checks the schema ID on enqueue, context and human decisions/close. UC1 integration must use this engine schema and an explicit compatible mapping. Installing this module does not convert a NocoBase Asset collection. `assetEntityId` always identifies an authorized enterprise entity, not a NocoBase row or external collection ID.

All requests use `Authorization: Bearer <RS256 token>` with the configured issuer, audience and organization claim. Organization and actor come from verified identity. Directory records must be current and enabled; stored handler strings and JWT roles alone do not grant authority. Agent worker identities need both `connector:agent` and `agent:worker`. A worker remains barred from incident human operations even if additional human roles appear in its JWT or directory metadata.

## Rule CRUD for Nhi

Reuse the existing entity API; there is no separate rule API or backend threshold executor. A normal entity `version` is the editable rule revision; `schemaVersion: 1` pins the published field structure. Use `data:write` for create/edit/archive, `data:read` for reads and `data:share` plus owner authority for grants.

```http
POST /v1/entities
Authorization: Bearer <human-token>
Idempotency-Key: rule-create-001
Content-Type: application/json

{"schemaId":"incident-rule","title":"Pump temperature","attributes":{"assetEntityId":"11111111-1111-4111-8111-111111111111","attribute":"temperature","operator":"gt","threshold":"40","unit":"celsius","maxObservationAgeSeconds":"300","cooldownSeconds":"900","severity":"high","enabled":true,"workflowDefinitionId":"incident-response","workflowDefinitionVersion":"1","handlerId":"handler-subject"}}
```

Create returns HTTP 201 with entity `id`, `schemaId`, `schemaVersion`, `version`, `title` and `attributes`. List with `GET /v1/entities?schemaId=incident-rule&limit=50&offset=0`; read with `GET /v1/entities/:id`; retrieve immutable revision evidence with `GET /v1/entities/:id/history?limit=50&offset=0` (history entries include their `result` snapshot). Save the complete title and attributes:

```http
PATCH /v1/entities/<rule-id>
Idempotency-Key: rule-edit-002
Content-Type: application/json

{"expectedVersion":1,"title":"Pump temperature","attributes":{"assetEntityId":"11111111-1111-4111-8111-111111111111","attribute":"temperature","operator":"gt","threshold":"50","unit":"celsius","maxObservationAgeSeconds":"300","cooldownSeconds":"900","severity":"high","enabled":true,"workflowDefinitionId":"incident-response","workflowDefinitionVersion":"1","handlerId":"handler-subject"}}
```

The new version is returned; stale `expectedVersion` returns 409. Disable with the same PATCH and `enabled:false`. Archive with `POST /v1/entities/:id/archive`, `{ "expectedVersion": <current> }`. Share execution reads using `POST /v1/entities/:id/shares` and `{ "expectedVersion": <current>, "principal": { "kind": "person", "id": "executor-subject" }, "permission": "read" }`; shares also advance entity version.

Server schema validation bounds the allowed values: threshold strings `0,5,10,15,20,25,30,35,40,50,60,70,80,90,100`; observation ages `30,60,120,300,600`; cooldowns `0,60,300,900,3600`; operators `gt,gte,lt,lte`; attributes `temperature,humidity,batteryLevel`; units `celsius,percent`; severity `low,medium,high,critical`. Invalid enum values return 400. Numeric values are encoded as strings, while `enabled` is boolean. This version deliberately has finite sensor thresholds.

Nhi's executor must validate attribute/unit compatibility (`temperature=celsius`, `humidity` and `batteryLevel=percent`), numeric observation format, observation unit/time/age, enabled revision, threshold comparison, cooldown and current organization/Asset/handler authority before emitting. Generic schema validation does not enforce cross-field unit compatibility, UUID existence or directory authority when saving text fields. Convert only validated enum strings to numbers. Do not coerce an incompatible unit or treat stored text as permission.

## Notification ingress and trace

Create a subscription using `POST /v1/workflow-event-subscriptions` (HTTP 201, `workflow:design` and `workflow:integrate`). Pin `sourceSubject`, definition ID and definition version. The current source directory must grant `workflow:start` and `incident:create`. Example body:

```json
{"id":"incident-notifications","eventType":"incident-notification","sourceSubject":"notification-service","definitionId":"incident-response","definitionVersion":1,"title":{"source":"literal","value":"Sensor incident"},"input":{"assetEntityId":{"source":"event","field":"assetEntityId"},"handlerId":{"source":"event","field":"handlerId"},"notificationId":{"source":"envelope","field":"eventId"},"ruleEntityId":{"source":"event","field":"ruleEntityId"},"ruleEntityVersion":{"source":"event","field":"ruleEntityVersion"}},"enabled":true}
```

`source:event` retains its existing meaning: read from `data`. The new `source:envelope` binding accepts **only** `field:eventId`; it reads the canonical authenticated incoming event envelope. A supplied `data.notificationId` or `data.eventId` cannot override this mapping. For optional evidence use a separate subscription mapping `attachmentId` only when the source supplies it; absent optional data must not be mapped as a required event value.

The signed notification source (`workflow:event:receive`, `workflow:start`, `incident:create`) calls:

```http
POST /v1/workflow-events
Content-Type: application/json

{"eventId":"notification-unique-id","eventType":"incident-notification","occurredAt":"2026-10-16T08:00:00Z","data":{"assetEntityId":"11111111-1111-4111-8111-111111111111","handlerId":"handler-subject","ruleEntityId":"22222222-2222-4222-8222-222222222222","ruleEntityVersion":"2","ruleSchemaId":"incident-rule","ruleSchemaVersion":"1","ruleSnapshotHash":"<canonical-rule-hash>","attribute":"temperature","value":"60","unit":"celsius","observedAt":"2026-10-16T07:59:59Z","triggeredAt":"2026-10-16T08:00:00Z"}}
```

The receipt lists `{subscriptionId,runId}`. Exact replay creates one case; conflicting content under the same source/organization/event ID returns 409. `GET /v1/workflow-events/:eventId` returns only the scoped source receipt. Disabled or absent directory source returns 403. For a new matching event, current JWT and directory must both grant workflow start roles; removing a directory role blocks a stale JWT from starting a case. Exact existing receipt replay keeps the original receipt after the existing enabled-source authorization check; it creates no new run. Cross-tenant callers cannot read the original receipt.

Pin the evaluated `ruleEntityId` and `ruleEntityVersion` into the workflow input and retain schema/version/hash plus observation in event provenance. Immutable entity history provides the full evaluated source snapshot, even after later edits or disabling. `ruleEntityVersion` is optional positive-integer workflow input encoded as a string (1–1000000); manual incidents may omit rule fields. Source-supplied hash/revision is an assertion by the trusted executor, not independent backend proof that the observation met a rule. This adapter does not implement threshold execution or infer rule integrity from text.

## Human lifecycle and agent execution

Manual create: `POST /v1/workflows`, HTTP 201, `Idempotency-Key`, body `{ "definitionId":"incident-response", "title":"Pump incident", "input":{ "assetEntityId":"<asset-uuid>", "notificationId":"<notification-id>", "handlerId":"<current-handler-subject>" } }`. Optional `attachmentId` must be an explicit readable clean file UUID. Creation requires `workflow:start` and `incident:create`; the current directory validates the assigned `incident:handler`. Unknown/disabled/wrong-role handler is 400.

Read current state/version with `GET /v1/workflows/:id`. All transitions use `POST /v1/workflows/:id/transitions`, `Idempotency-Key`, and `{ "action":"<action>", "expectedVersion":<current>, "input":{...} }`. Stale version is 409; inaccessible cases return 404. Creator, current assigned reader and manager read rules still apply.

| Action | From → to | Current human authority | Input |
| --- | --- | --- | --- |
| assign | open → assigned | incident:manager | `{}`; creates one linked task for required start handler |
| accept | assigned → investigating | assigned incident:handler | `receiptNote` nonblank text; completes linked task |
| request_analysis | investigating → analyzing | assigned incident:handler, workflow:integrate, data:read and Asset ACL | `{}` |
| retry_analysis | analysis_failed → analyzing | same handler authority | `{}`; creates a new immutable wait/job |
| approve | review_pending → approved | incident:manager, data:read and Asset ACL | `reviewNote` nonblank text |
| reject | review_pending → rejected | same manager authority | `reason` nonblank text |
| rework | rejected → investigating | assigned incident:handler | `reworkNote` nonblank text |
| record_resolution | approved → resolved | assigned incident:handler | `resolutionNote` nonblank text |
| close | resolved → closed | incident:manager, data:read, data:write and Asset edit ACL | `closeNote` nonblank text |

Analysis dispatches connector `agent`, operation `incident.analyze`. Job ID equals wait ID and durable dispatch event ID. The server captures the human requester from the transition audit, Asset version, notification, case and optional explicit file binding. It never takes a worker-chosen base version. Wait timeout is 300 seconds, success `review_pending`, failure `analysis_failed`, result fields only `proposalId` and `agentJobId` text UUIDs.

| API | Request/authority | Result |
| --- | --- | --- |
| `POST /v1/agent-jobs` | human analysis requester, Idempotency-Key, `{runId,waitId}` | validates deterministic existing enqueue; never creates arbitrary work |
| `GET /v1/agent-jobs?runId=<uuid>&limit=50&offset=0` | authorized human case reader | `{items,page:{limit,offset,hasMore,nextOffset}}`; stable created_at DESC, id DESC; limit 1–100; no q/arbitrary resource filters |
| `GET /v1/agent-jobs/:id` | authorized human case reader or exact claimed worker | effective state, attempts/version/proposal; no lease token |
| `POST /v1/agent-jobs/:id/claim` | worker, `{}` | one winner; includes `leaseToken` |
| `GET /v1/agent-jobs/:id/context` | worker, header `X-Agent-Lease: <token>`, no query | bound case, Asset and optional `{id,filename,contentBase64}` explicit clean attachment |
| `POST /v1/agent-jobs/:id/result` | worker, `{leaseToken,proposal}` | immutable result and atomic workflow settlement |
| `POST /v1/agent-jobs/:id/fail` | worker, `{leaseToken,code}` | failed attempt; code model_unavailable, invalid_output, tool_denied or worker_error |
| `POST /v1/agent-jobs/:id/retry` | authorized human, Idempotency-Key, `{expectedVersion}` | requeues same still-live wait/job with version increment |

Hung's result example:

```json
{"leaseToken":"33333333-3333-4333-8333-333333333333","proposal":{"summary":"Repair after inspecting the temperature sensor","suggestedStatus":"repair","evidence":["temperature=60 celsius"]}}
```

Proposal accepts only these keys: nonblank summary ≤2000 characters, suggestedStatus in the four Asset statuses, at most 20 nonblank evidence strings ≤1000 characters each. Extra authority/resource fields return 400. Same completing worker, token and proposal replay returns the same result; different content is 409. Generic `/v1/workflow-waits/:id/complete` cannot settle this managed incident wait, even for a worker carrying `workflow:callback`. Unrelated connector callbacks retain existing behavior.

The execution job state is `queued`, `running`, `failed` or `completed`; effective expired state is `timed_out`. Lease is at most 60 seconds and never exceeds the absolute wait deadline. At most three attempts are allowed. Stale token/worker, expired lease, completed or superseded wait, wrong run version and content conflict produce 409. Current requester directory/case/Asset/file authority is rechecked, including after blocking reads. A revoked requester or inaccessible/unclean attachment is denied; context accepts no arbitrary resource identifiers. Cross-tenant IDs remain unavailable. Failed attempts can retry while the same wait is pending and unexpired; after timeout, the human uses retry_analysis from analysis_failed to make a new wait/job. Rejection uses rework then request_analysis, retaining the prior proposal unchanged.

Queue delivery state is separate: the durable `connector.dispatch` outbox remains available for Nhi's transport; acknowledgement proves dispatch delivery, not model execution. Claim proves an execution lease, result proves proposal settlement, and neither closes the incident. No polling worker discovery API is exposed; the transport delivers the stored event/job ID to the receiver.

Approval pins the existing immutable proposal/job and server-captured base Asset version in persisted decision evidence; caller input supplies commentary only. Rejection requires a reason. Close requires approved proposal plus handler resolution and uses the captured Asset version, preserving title and all other attributes. A stale Asset returns 409. Asset update, workflow state/audit and one `incident.closed` durable event commit atomically; late SQL failure rolls everything back. Exact close replay adds no event. Event envelope contains eventId, organizationId, runId/recordId, definitionId and workflow version; `data` contains Asset, canonical notification, handler, proposal/job IDs, resolution and close notes and optional rule revision. Use this trace to correlate receiver work. Durable outbox persistence does not prove human receipt.

## Reproducible backend acceptance

Run `pnpm test:incident-agent` with the local API/PostgreSQL compose services running. The wrapper bundles **current workspace engine source**, externalizes installed pg/Fastify/jose dependencies, and streams the bundle into a one-off Node process inside the API container. It does not rely on the container's older source image. The fixture creates a UUID-named schema, initializes production repositories, seeds directory identities only there, generates JWT signing keys in memory, installs/publishes the real module and exercises signed Fastify requests. SQL directly changes clocks and injects failure triggers only inside that schema. The >100-row history seed is isolated fixture data. Cleanup validates the exact generated schema and temporary bundle path before removal; max-one pools and reopen checks prove persistence without touching production identities or queues.

The complementary `node scripts/smoke-agent-jobs.mjs` exercises the lower-level real PostgreSQL lease-blocking, settlement rollback and proposal immutability boundaries. Neither command invokes a model, broker or external worker. After review, the deployment owner must rebuild only the API image to expose changed source; preserve the existing accounts and volumes.

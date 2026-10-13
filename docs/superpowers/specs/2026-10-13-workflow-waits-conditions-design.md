# Workflow completion, waits and conditions

Continue the approved engine expansion on PR #8. Ordinary TypeScript/pg/Fastify, no dependencies/framework, no Notion ticks, no source-platform changes.

## Bounded lifecycle

A transition may declare `wait` tied to its final task/connector step. Config includes stepId, successState, failureState, resultFields (text/positiveInteger only), timeoutSeconds (1..604800). Waiting resource ID is the task/event ID. Transition commits state and resource plus a pending wait atomically; no other transition from that run is allowed while the wait is pending. Existing definitions without waits preserve behavior.

Completion advances the run to the configured success/failure state, increments its version and audit, stores verified result fields in run data and records completion evidence atomically. This is automatic state advancement, not execution under invented system permissions. Subsequent action-bearing transitions still require signed caller roles through the normal runtime. This increment deliberately does not silently execute an arbitrary chain under the workflow owner's old role snapshot.

Task completion requires tasks:decide and exact original assignee in the same organization, updates the task and workflow together. Generic task decisions cannot bypass a workflow wait. Task reads expose workflowWaitId so UI knows which completion API to call; completing a task does not grant whole-workflow read access.

Connector completion requires workflow:callback and signed connector:<id> role corresponding to the pending dispatch in the same organization. Transport delivery acknowledgment does not equal business completion. Completion cannot select next state, organization, workflow version or overwrite input/subject/assignment fields. Connector-role fixtures are local service accounts, not broad grants to employees.

Result field names cannot overlap configured start/transition fields, assignment fields or unsafe names. Unknown result fields rejected. Failed completion has a bounded failure reason and no success data. Callback idempotency/fingerprint persists on wait; repeat accepted exact completion returns the stored minimal receipt, different payload conflicts. All authorization is checked before returning any replay. Concurrent outcomes resolve once. Callback response includes minimal wait/run state receipt, not private workflow data.

Timeout processing uses the same run-before-wait lock order, rechecks pending state/deadline and moves to failureState with timed_out evidence. No user-role snapshot or privileged follow-on action. Restart persistence and disabled worker test controls documented. Existing outbox retry is transport retry, not business wait retry; failed/timed-out process is recovered through configured ordinary transitions that create a fresh resource/wait.

## Conditions

Transition optional condition is a single declarative predicate: field, operator eq/gt/exists, optional literal string value. Field must be declared in start/transition/wait result data; no scripts, nested paths, regex or expressions. Strict finite numeric parsing for gt; missing/invalid numeric value fails closed. Predicate is evaluated before state change/block execution and filters availableTransitions/inbox. False guard is 409 when actor can read and is authorized. Waiting runs have no offered transitions. Two-pass configuration validation covers condition/wait states, step identity/action and safe output collisions.

## API

GET /v1/workflows/:id/waits is paginated and workflow-reader scoped. POST /v1/workflow-waits/:id/complete accepts {status:succeeded|failed,result:Record<string,string>,reason?:string}, requires Idempotency-Key and resource-scoped authorization above. Body cannot override authority or resume route. Task/connector actors can submit their assigned resource result without receiving the full workflow. Polling UI uses task workflowWaitId and authorized workflow wait listings. Gateway allows only intended routes.

## Acceptance

Real SQL/API demo creates IT task, blocks early transitions, accepts exact assignee completion and makes guarded next action available, dispatches connector, waits for trusted connector result and advances to completion. Wrong tenant/person/connector, invalid result, bypass generic decision, stale callback, duplicate conflict and concurrent outcomes rejected without partial writes. Timeout survives restart; late callback cannot override timeout. Numeric/exists/eq predicates fail closed; old Studio/blocks/Logistics/source workflows remain passing. Actual Nhi adapters and Hưng UI remain their integration work.

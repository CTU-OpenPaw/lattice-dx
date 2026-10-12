# Phase two — a small reusable workflow runtime

User approval: keep the existing six Duy phase-two tasks, build reusable internals instead of an order-specific backend, write a detailed plan and execute. Prefer simple functions and SQL over a general graph/BPMN engine. Work in the existing checkout on a feature branch; preserve user files and the other members' work.

## Chosen approach

Use trusted, versioned state-machine definitions in solution config. Alternative domain-specific handlers duplicate authorization/audit/retry; a general BPMN/graph execution system exceeds the current task. The chosen runtime executes a declared transition with one role, optional owner restriction and explicit input fields. There is no arbitrary expression/code execution or user-uploaded workflow editor.

Definitions expose role/department queues. A pending work item is the current state of a durable run and its available transitions; the engine does not create a second independent foundation task whose decision could drift from the run. Existing personal task APIs stay compatible. A run creates a backing records row in the same transaction, using the same UUID.

## Six Duy deliverables

1. Create/submit/approve/reject with signed organization scope, role and owner guards; rejection reason required.
2. Receive and accept only from the proper prior states, with clean file evidence and version checks.
3. Handover requires asset ID, registered recipient, scoped department/location and clean attachment. Save workflow state, audit, file association and outgoing event atomically before external delivery.
4. PostgreSQL outbox leases jobs, bounded exponential retry and stable eventId. No configured connector leaves jobs pending; failed connector never rolls back handover. Delivery is at least once, so Nhi must deduplicate eventId/upsert asset URN. Authorized manual retry only for failed jobs.
5. Append-only application audit per transition and read API, actor/time/from/to/version; no public update/delete audit endpoint.
6. Tests for roles, owner/organization isolation, state/input guards, duplicate request replay/conflicting key, concurrent decisions, attachment access/quarantine and connector failure/recovery.

## Definitions and APIs

UC1 procurement: draft → submitted → approved/rejected → received → accepted → handed_over. Employee submits; manager decides; warehouse receives/accepts/hands over. An internal onboarding template uses the same runtime across HR → manager → IT → administration, proving reuse without a new domain backend. Both configs are server-owned and immutable per version.

GET /v1/workflow-definitions; POST/GET /v1/workflows; GET /v1/workflows/:id; POST /v1/workflows/:id/transitions; GET /v1/workflows/:id/history and /sync; POST /v1/workflows/:id/sync/retry. Writes require Idempotency-Key. Create body is definitionId/title/input; transition body is action/expectedVersion/input. 400 malformed, 401 token, 403 role/owner, 404 hidden run, 409 state/version/key conflict, 503 missing dependency. Body scope overrides and unknown fields are rejected.

Exception: POST /v1/workflow-members/me is naturally idempotent through its signed (organization,subject) unique key and accepts no identity fields; it does not need an Idempotency-Key. Manual sync retry requires and persists a key/result; repeating that key never resets a later retry budget.

Creator and declared participant roles can read a run within the signed organization. Queue views expose only applicable transitions. Roles model department queues in this version; individual claiming/delegation and membership administration remain separate work. Registered recipient membership is learned from a signed self-registration endpoint, not arbitrary assignee input. Department/location references are scoped server registry rows, seeded only by the explicit local demo script; Hưng can supply adapters to real collections later.

File attachment must initially be readable by the attaching actor and clean. After an authorized transition links it to a run, declared participants in that same organization may read it through existing guarded file endpoints. Files remain 1 MiB PostgreSQL/ClamAV bootstrap; no broad organization-wide file access.

## Implementation and limits

Plain TypeScript policy/validation functions; Fastify routes; PostgreSQL transactions, row locks and unique idempotency records; separate small outbox worker. No new dependency, external queue, ORM, framework or upstream source changes. Original code Apache-2.0. Keep local fixtures public and bound to loopback. New identity roles/users must not change existing credentials or delete users/volumes.

Backend integration can be verified against a controlled HTTP receiver while Nhi's real broker connector is unavailable. That proves retry/outbox behavior, not actual NGSI-LD deployment. Do not mark the whole team phase complete or change Notion task wording. Latest user instruction: leave ALL Notion completion checkboxes unchanged, even when backend evidence passes. Report evidence in the repository/PR; real broker/UI integration remains pending.

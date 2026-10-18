# Duy phase 2–3 backend completion

The requested scope is the existing six phase-2 and seven phase-3 Duy checklist items. Teammate UI, broker, rule execution and model implementations remain separate. Completion is evidenced per checkbox; generic infrastructure alone is insufficient.

## Design

Reuse the current workflow state machine, signed inbound events, transactional blocks, entity ACL and outbox. Provide a versioned incident reference configuration and a small durable agent execution service. Do not fork the workflow engine or build another general purpose scheduler.

An agent job is tied to one workflow connector wait, requester and organization. It has queued/running/failed/completed states, bounded attempts, a deadline, a lease token and immutable proposal evidence. Authenticated connector workers claim only their organization's jobs. A lease is required for context reads and proposal submission; stale or expired attempts cannot complete. Retry creates a new attempt without duplicating the business case.

Tools expose only the bound case, its Asset and explicitly attached clean files. Reads recheck the requesting person's current resource permissions; no token claims supplied by the worker become delegated permissions. Workers have no general entity mutation or human approval authority. Completion writes proposal text/evidence and settles the bound connector wait into human review, never directly into closed. Human approval/rejection and final close remain role guarded workflow transitions. Close atomically persists its Asset change and notification outbox event with case/job/event correlation.

Incident rules use a versioned threshold configuration stored as engine entities, with existing CRUD, revision checks and sharing. Nhi reads the same published contract through the normal entity API and executes the threshold; the backend does not duplicate her executor. Signed inbound subscription deduplicates notifications and starts the incident workflow.

## Acceptance

- Procurement fresh signed HTTP test covers lifecycle, permissions, files, races and immutable audit; isolated worker test covers retry, lease fencing and durable handover without altering existing queues.
- Incident sample definition validates and runs through assignment/acceptance, agent request/result, human approval/rejection and close.
- Agent tests exercise concurrent claim, timeout/retry, duplicate result, stale lease, cross-organization denial, ACL revocation and file denial. A worker cannot approve or close a case.
- Live PostgreSQL and signed HTTP tests distinguish dispatch from completed model execution; test worker fixtures are labelled simulated. Real model/broker/UI integration remains teammate acceptance.
- Notion updates target only verified Duy boxes and include reproducible commands and commit/PR links. Existing page structure and teammate boxes are preserved.

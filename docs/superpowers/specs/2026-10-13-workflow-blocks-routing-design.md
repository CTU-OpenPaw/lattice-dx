# Workflow blocks and department routing

Continue the approved engine expansion, on top of Workflow Studio PR #7. Keep ordinary TypeScript helpers, existing pg transactions and existing outbox; no new framework/dependencies, no changes to upstream or Notion completion.

## Blocks

Published transitions may contain up to ten ordered declarative steps. Supported actions are `records.create`, `tasks.create`, and `connectors.dispatch`. Each step has a unique safe ID and explicit input bindings. Bindings select a literal string, a named run-data field, a named current-transition input field, a whitelisted context field or the ID returned by an earlier step. No scripts, templated code, arbitrary object paths or networking URLs. Definition validation verifies action/input shape, binding references/order and bounded values.

Runtime requires the caller's signed role for each action: records:write, tasks:assign, workflow:integrate. Transition authorization alone does not grant those capabilities. Internal writes, transition state, audit, block execution results, command replay and connector outbox entries commit or roll back together using the same PoolClient. A later failure rolls back earlier block writes. Replaying an accepted command never runs blocks again.

Action result rows are keyed by run/version/step and store actor, action, bounded input/result and timestamp. Authenticated `GET /v1/workflows/:id/executions` exposes results only to actors who can read the workflow. No separate globally-readable results API.

`records.create` creates an actor-owned tenant record. `tasks.create` validates an active recipient and any record link exactly as current REST/actions do. A record from an earlier records.create step can be linked to the task. Generic record sharing remains scoped to the assignee; these tasks do not automatically move workflow state and do not use Logistics' single-task workflow link table.

`connectors.dispatch` writes a durable job targeting allowlisted connector IDs `n8n`, `ngsi-ld`, `agent`, with a safe operation name and string input map. Delivery uses the existing server-configured outbox endpoint; payload includes the connector identity and stable event ID. No browser-provided endpoint or credential. This creates the backend adapter contract, not proof external tools are installed. Nhi owns adapter processing and returns use the existing authenticated API.

## Assignment and departments

Task recipient can be an explicit subject binding or a department assignment {department binding, required role}. Department routing uses the admin-managed directory snapshot in the same tenant and only active members with the required role. Exactly one eligible member succeeds; zero rejects 400 and multiple rejects 409 so the user must select a person explicitly. Never choose an arbitrary employee or claim a manager relationship absent from directory data.

`GET /v1/directory/departments` requires directory:read and returns paginated department IDs, display names where a reference exists, and active member counts derived from the directory snapshot. Role/q filters are applied before pagination. Department identity stays separate from organization identity. No public department write API or nested hierarchy in this increment.

## Acceptance

A configured HR process creates a handoff record, assigns a task to the sole eligible IT department member and emits an integration request. Another configured process explicitly chooses a person. Wrong role, foreign/disabled recipient, inaccessible record, missing/ambiguous department, malformed binding and unsupported action are rejected without partial state/writes. Replays create one record/task/job only; two commands with the same expectedVersion produce one success. Execution history is tenant/workflow scoped. Legacy source workflows, Studio publication, files and Logistics remain working. Add real SQL pool-max-1 rollback/concurrency plus live Gateway/Keycloak tests.

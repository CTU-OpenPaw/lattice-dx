# Enterprise composition backend

LatticeDX owns shared business schemas, entities and authorization on PostgreSQL. NocoBase supplies Studio and UI; adapters connect external systems. The backend composes reusable capabilities rather than hard-coding a single department or logistics process.

## Composition model

1. Publish a typed schema and a workflow definition. Publication versions are immutable contracts.
2. Create a business entity through an authorized API. It has its own ID and lifecycle, independent of workflow records.
3. Start one or more workflows with `entityContext`. Context is a reference, not an access grant; readers need the appropriate permissions for each resource.
4. An enabled automation rule can consume a future committed business event. The designated service account must still have current capabilities and entity access when execution begins.
5. A workflow can project authorized entity fields into a transient calculation context, evaluate typed expressions, assert conditions, and write validated results through the ordinary data policy. Public workflow evidence records resource IDs and operation metadata, not projected private values.
6. A module binding constrains which published schema and workflow belong together and which transitions a bound run may execute. Installation does not grant users or services permission.
7. Scoped aggregation and frozen report snapshots support reporting across authorized data. Snapshot ownership does not bypass current source access.

Items 5–7 are tracked implementation work until their corresponding acceptance gates are recorded. Consult the [execution ledger](superpowers/plans/2026-10-14-enterprise-composition.md) for the precise implemented state.

## Responsibilities and integration

| Capability | Backend responsibility | Studio/adapter responsibility |
| --- | --- | --- |
| Schema and entity | Validate types, publication pins, transaction and current access | Configure fields and display authorized forms |
| Workflow and task | Execute transitions, assignment, version checks and receipts | Render available transitions and department inboxes |
| Events and automation | Commit journal/delivery atomically; current service execution | Configure allowed rule mappings and monitor metadata |
| Private calculations | Bounded typed expressions and transaction-local values | Offer supported fields/operators and show validation errors |
| Enterprise module | Validate portable package and business bindings | Configure and install approved module packages |
| Broker/n8n/agent | Authorized ingress, outbox and tools | Map external models, events and adapter credentials |

Broker data is shared context from external sources; it does not replace the authoritative transaction store. n8n performs integration steps through APIs; it does not directly change workflow state or business tables. Agents use the same scoped tools and approval rules as other actors.

## Transaction rules

Mutations require an idempotency key and current resource version where relevant. Workflow effects, audit, entity events and command receipts commit together. A failed late step leaves no partial effects. Accepted command replay rechecks current authority before returning the stored result.

Existing workflow locks precede deterministically ordered entity locks. Entity mutation stages deliveries without executing or locking a workflow. Automation dispatch is asynchronous and uses a fresh service authority check; server-derived causation depth bounds recursive cascades.

No manifest, event payload or expression can choose an actor, tenant, roles, arbitrary SQL, executable code or an unrestricted network destination. Runtime configuration and service provisioning remain deployment responsibilities.

# Backend integration index

The engine is the authority for business data, workflows and permissions. Studio renders and calls these contracts. Adapters deliver external events or execute configured connector jobs. A successful login is not permission to read all organization data.

| Capability | Main API family | Detailed contract | Local acceptance command |
| --- | --- | --- | --- |
| Typed schema and entity lifecycle | `/v1/entity-schemas`, `/v1/entities` | [Enterprise data](enterprise-data.md) | `pnpm test:enterprise-data` |
| Person/department grants | `/v1/entities/:id/shares` | [Entity sharing](entity-sharing.md) | `pnpm test:entity-sharing` |
| Frozen reports with current source access | `/v1/entity-report-snapshots/*` | [Entity reporting](entity-reporting.md) | `pnpm test:report-snapshots` |
| Full text entity search | `/v1/entities/search` | [Entity search](entity-search.md) | `pnpm test:entity-search` |
| Exact scoped aggregates | `/v1/entities/aggregate` | [Entity reporting](entity-reporting.md) | `pnpm test:entity-aggregates` |
| Typed query and API data blocks | `/v1/entities/query`, `/v1/blocks` | [Query and blocks](entity-query-blocks.md) | `pnpm test:entity-query-blocks` |
| Contextual documents and batch data | `/v1/entities/:id/attachments`, `/v1/entity-imports/*`, `/v1/entities/export`, migration | [Data tools](entity-data-tools.md) | `pnpm test:entity-data-tools` |
| Task lifecycle and department queues | `/v1/tasks`, `/v1/task-queues` | [Task lifecycle](task-lifecycle.md) | `pnpm test:task-lifecycle` |
| Workflow authoring and publication | `/v1/workflow-drafts`, `/v1/workflow-definitions` | [Workflow Studio](workflow-studio.md) | `pnpm test:workflow-studio` |
| Workflow execution, waiting and cancellation | `/v1/workflows`, `/v1/workflow-waits` | [Runtime](workflow-runtime.md), [completion](workflow-completion.md), [lifecycle](workflow-lifecycle.md) | `pnpm test:workflow-lifecycle` |
| Business entity/workflow context | `/v1/entities/:id/workflows`, `/v1/workflows/:id/entity-context` | [Entity workflow context](entity-workflow-context.md) | `pnpm test:entity-workflow-context` |
| Private projection, calculation and assertions | `/v1/workflow-blocks` / workflow transitions | [Private blocks](private-workflow-blocks.md) | `pnpm test:private-workflow-blocks` |
| Committed-event automations | `/v1/entity-automations/*` | [Automations](entity-automations.md) | `pnpm test:entity-automations` |
| Committed business data events | `/v1/entities/:id/events` | [Entity event journal](entity-events.md) | `pnpm test:entity-events` |
| Durable designated-service timers | `/v1/workflow-services`, `/v1/workflows/:id/timers` | [Timers](workflow-timers.md) | `pnpm test:workflow-timers` |
| Organization metadata and directory snapshot | `/v1/organization/*` | [Organization](organization-directory.md) | `pnpm test:organization-operations` |
| Signed ingress and subscriptions | `/v1/workflow-events`, `/v1/workflow-event-subscriptions` | [Inbound events](inbound-events.md) | `pnpm test:inbound-events` |
| Incident rules, human resolution and durable agent proposals | `/v1/agent-jobs`, `/v1/workflows`, `/v1/entities?schemaId=incident-rule` | [Incident agent runtime](incident-agent-runtime.md) | `pnpm test:incident-agent` |
| Portable workflow bundles | `/v1/workflow-bundles/*` | [Bundles](workflow-bundles.md) | `pnpm test:workflow-bundles` |
| Declarative business bindings | `/v1/enterprise-modules/:id/versions/:version/bindings/:bindingId/start` | [Business bindings](module-business-bindings.md) | `pnpm test:module-bindings` |
| Versioned enterprise modules | `/v1/enterprise-modules/*` | [Modules](enterprise-modules.md) | `pnpm test:enterprise-modules` |
| Readiness, diagnostics and retention preview | `/health`, `/ready`, `/v1/operations/*` | [Operations](operations.md) | `pnpm test:organization-operations` |
| Local PostgreSQL recovery | CLI only, no browser restore endpoint | [Recovery](recovery.md) | `pnpm backup:core`, `pnpm backup:rehearse -- <dump>` |
| Verified filesystem objects and current authorized downloads | Existing file/content APIs, server-controlled provider | [Filesystem storage](filesystem-storage.md) | `pnpm test:file-storage`, `pnpm test:file-content` |
| Process telemetry and tenant queue diagnostics | `/v1/operations/metrics`, `/v1/operations/queues` | [Operations](operations.md) | `pnpm test:runtime-operations`, `pnpm test:runtime-config` |
| Paired database/object recovery | CLI only, generated isolated targets | [Recovery](recovery.md) | `pnpm backup:full`, `pnpm backup:rehearse-full -- <directory>` |

The contracts above include their exact request/response bodies and roles. REST entity blocks and workflow blocks have separate catalogs because workflow bindings are declarative and run inside the workflow transaction. Check the completion ledger before assuming an API capability also has a workflow executor.

## Shared request rules

- Send a verified bearer token to Gateway. Actor, organization and roles are taken from the token; never put them in business payloads.
- Follow the specific role and resource policy together. Ownership, current grants, active recipient membership and exact task assignment remain separate from route roles. Department hierarchy does not grant inherited entity access.
- New commands require an `Idempotency-Key` and their expected resource version/revision. Retry an uncertain request with the same key and unchanged body. A replay returns the original accepted result after checking current authority; it does not represent current resource state.
- Read current state before editing it. A stale version or changed command returns 409; read again and make a deliberate new command rather than silently forcing an update.
- Follow `page.hasMore` and `page.nextOffset`. A page of 100 rows is not the whole dataset. Typed query filters run after access scoping in SQL, before the page limit.
- `X-Request-Id` correlates a request with diagnostics. It does not carry authorization. Error responses use `{error}`; 401 means identity failed, 403 means route/action permission failed, 404 hides an unavailable or invisible resource, 409 means a state/version conflict, and 503 means a required backend capability is unavailable.
- Connector and service credentials stay on the server. Browser configuration cannot create a privileged actor or choose an arbitrary URL for the worker.

## Ownership of integration work

Shared seed, exact teammate branch contract review and the cross-actor acceptance checklist: [Team integration readiness](team-integration-readiness.md). `pnpm integration:seed --share` creates a fresh pending asset-review workflow and metadata-only local artifact; `pnpm test:team-integration` exercises a separate fixture. Neither command installs teammate UI/adapters or rewrites directory accounts.

Duy maintains these backend contracts and transaction policies. Hưng connects NocoBase UI/plugin to the documented APIs. Nhi connects n8n, NGSI-LD and agent adapters to ingress/outbox and authorized tools. Adapter setup and the final user-facing applications need their own integration acceptance; backend unit tests do not prove those systems are connected.

The current scope and evidence are maintained in [completion plan](backend-completion-plan.md) and [verification](verification.md). This index describes available integration contracts, not a production certification or an assertion that every feature is merged into main.

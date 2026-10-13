# Configurable workflow engine

Approved direction: move source-defined workflows into tenant-scoped, editable configuration without replacing the existing runtime. Keep TypeScript, Fastify, PostgreSQL and the existing outbox; no new dependencies. No Notion completion updates.

## First deliverable

An administrator with signed `workflow:design` role manages draft definitions in their organization. Drafts have optimistic revisions. Publishing validates the graph and creates an immutable definition version. New instances choose the newest published version; existing instances and file access resolve their original definition version. Built-in procurement, onboarding and logistics definitions remain immutable fallback templates and cannot be overridden by tenant drafts.

Configuration uses the existing WorkflowDefinition shape: fields, start role, readers, initial state and transitions. Version numbers are assigned by the server. Validation rejects unknown keys, unsafe names, unsupported field types, unreachable transitions, duplicate transition IDs and invalid assignment references. Tenant configuration supports ordinary transitions, form fields and event emission via the fixed server outbox connector. No executable JavaScript, arbitrary URLs, secret configuration or automatic role creation. Custom task hooks remain disabled until their lifecycle supports multiple tasks; existing trusted Logistics hooks are retained.

## API and persistence

`/v1/workflow-drafts` creates/lists drafts; `/:id` reads/updates one; `/:id/publish` publishes the expected draft revision. ID is a slug, organization comes exclusively from verified JWT. Published content is stored in PostgreSQL keyed by organization/id/version. Row locks serialize draft saves and publishes. Publishing the same revision returns the same immutable version. Updates and publishes record actor and timestamps. Lists are paginated.

`/v1/workflow-definitions` includes eligible tenant published definitions. Runtime create, transition, list/inbox, history and file sharing all resolve tenant-specific published definitions. Cross-organization IDs or matching definition names never share content. Definition versions are never deleted or edited by the API.

## Following increments

After this first deliverable: registered internal actions and n8n/NGSI-LD/agent connector blocks; then department-based routing. These require separate contracts and integration tests and must not be advertised as implemented by the draft API. Hưng owns Studio UI, Nhi owns external connectors. The current increment enables a new process without rebuilding the backend.

## Acceptance

An administrator publishes a new HR/IT process through API, starts it and executes its transitions. Publishing version 2 does not change a running version-1 instance. Draft conflicts return 409; malformed configuration 400; missing role 403; hidden data 404. Existing 145 tests and workflow/logistics smoke tests remain valid. Add real PostgreSQL coverage for concurrent publication, tenant isolation, paging, restart persistence and immutable-version execution.

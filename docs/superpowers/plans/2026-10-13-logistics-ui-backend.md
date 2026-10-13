# Implementation plan — Logistics UI backend

Constraints: E:/pmnm2026 in-place feature branch (existing user preference); preserve CV.pdf/a.png/output; no Notion writes/ticks, no merge/release. Original code Apache-2.0, no dependencies. User approved proposal; execute with review checkpoints.

## Task 1 — directory and shared assignee verification

- [ ] Implement `apps/api/src/directory.ts`, directory routes/database, local admin sync; tests first using RSA JWT and unknown/foreign/disabled members. Public interface `DirectoryPerson {subject,organizationId,displayName,departmentId?:string,roles:string[]}`; `DirectoryRepository.find(subject,organizationId)`, `list(organizationId,query)` returns page.
- [ ] Export `requireAssignee(subject,scope,directory,requiredRole?)`: reject invalid/unknown/disabled/foreign 400, missing/unavailable 503; return verified person. Add DirectoryOptions to createApi, shared REST/action path enforcement, errors caught as status. No directory bypass when omitted in runtime; update unit fake repositories and existing fixture smoke setup as needed.
- [ ] `GET /v1/directory/people` requires signed organization and directory:read, query role/department/q/limit/offset, response sanitized person fields plus page. Never expose credentials or enable unauthenticated registration.
- [ ] Admin local sync script reads paginated Keycloak users and roles, stores authoritative local snapshot in SQL via docker exec stdin, enabled flag reflects current users; no reset of passwords or role changes by snapshot sync. Add local directory:read roles for task assigners and sales. Explicit fixture source and bootstrap docs.

## Task 2 — reusable assignment workflow and order API

- [ ] Tests policy before implementation: assigned reader states/role, wrong assignee, optional evidence, positive quantity, no warehouse draft view. Extend WorkflowDefinition with `assignedReader`, optionalStartFields; WorkflowTransition with assigneeField/task hook. Validate input and authorize from trusted config.
- [ ] Add `logistics_order` source definition and strict order facade parser, routes and JWT checks. Create converts numeric quantity to validated string in run data. `GET /:id` verifies logistics definition, response quantity number/taskId. POST submit/receive builds generic command, no caller-provided action or scope override.
- [ ] SQL checks assignee active/correct role inside create transaction; `workflow_task_links` unique run/task, submit one foundation task, receive update linked task atomically; replay persists same task ID, no double state authority. Generic decisions guard linked workflows.
- [ ] Route API/Gateway/Docker startup wiring; add local logistics:sales and logistics:warehouse fixtures for sales/warehouse users without deleting baseline roles.

## Task 3 — pagination and scoped record/task/files

- [ ] Shared query parser rejects malformed/huge limits/offsets/filter lengths and page helper strips extra row. Add optional paged repository methods preserving unit fake interfaces but real runtime always uses paged SQL.
- [ ] Records/tasks/workflows/directory/orders page with stable sort and visibility WHERE before LIMIT/OFFSET, status/state/definitionId/recordId/q filters as appropriate. Add record detail and task detail; task creator/assignee policy explicit; list assignee scope stays.
- [ ] Record sharing only via authorized task from actual record owner; file sharing only same organization record/file owner + task assignee and files:read/clean guards. Protect upload/link routes from gaining write authority through shared read fallback. Generic decisions linked to workflow return 409.

## Task 4 — integration acceptance, review, documentation and PR

- [ ] Add `scripts/smoke-logistics.mjs` covering real identity/directory/action/task/record/files/engine, input/role/org denial, duplicates/concurrency, pagination beyond 100 (isolated SQL fixture or authorized seed), no change to old business states.
- [ ] Run check + existing compatibility smoke spaced for Gateway rate limits; Compose parse/whitespace. Keep infrastructure outages distinct from app regressions.
- [ ] Independent review, repair important findings and rerun affected tests. Write endpoint/request/response/roles/errors/limits handoff, exact verification evidence; no Notion tick.
- [ ] Commit/push PR targeting codex/phase-two-workflow-runtime while #5 open, attach PR, verify CI. If #5 merged first target main instead.

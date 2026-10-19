# Phase Two Workflow Runtime Implementation Plan

> For agentic workers: use executing-plans inline with test-first implementation and independent review checkpoints.

**Goal:** Finish Duy's six phase-two backend deliverables with a reusable, maintainable runtime and concrete integration handoff.

**Architecture:** Trusted solution definitions declare states, transitions, roles and input fields. PostgreSQL atomically persists each run/transition, idempotent result, audit and outgoing event. A separate worker delivers leased outbox jobs; the engine remains usable while connectors are down.

**Tech stack:** Existing Node 24, TypeScript, Fastify, pg, jose and Vitest. No dependency additions.

## Global constraints

- Branch codex/phase-two-workflow-runtime from merged origin/main, existing checkout; CV.pdf/a.png/output preserved.
- Keep Notion roles, six Duy tasks, phase dates and other members' implementation untouched. Do not tick any Notion task; local plan checkboxes track execution only.
- Plain focused functions/files; no BPMN designer, custom scripting or generic graph framework.
- Runtime HTTP payloads strictly validated; organization/actor from signed JWT only.
- Clean attachment and scoped registry checks before writes; no state update after invalid input.
- Expected version plus row lock; Idempotency-Key replays identical successful commands, changed request conflicts.
- Persist business transaction before delivery; at-least-once events with stable eventId and consumer dedupe.
- No automatic merge or release. Real broker/UI integration reported separately from controlled receiver tests.

## Task 1 — definitions, policy and contract

Files: packages/contracts/src/workflows.ts, solutions/workflows/definitions.ts, apps/api/src/workflows/policy.ts, tests/workflow-policy.test.ts.

Interfaces: WorkflowActor {subject,organizationId,roles}; WorkflowRun {id,recordId,definitionId,definitionVersion,title,state,version,ownerId,organizationId,data,createdAt,updatedAt}; TransitionCommand {action,expectedVersion,input}; planTransition(def,run,actor,command) returns transition + validated input or WorkflowError. getDefinition(id,version) pins immutable definitions.

- [x] Write tests: employee submits own draft; manager approves submitted; warehouse cannot approve; receipt before approval conflicts; rejection requires reason; input scope spoofing rejected; onboarding uses same policy.
- [x] Run `pnpm exec vitest run tests/workflow-policy.test.ts`; confirm missing feature fails.
- [x] Implement typed definitions and strict shape/string/UUID validators, canReadRun and availableTransitions. Core operation:
```ts
if (!actor.roles.includes(transition.role) || (transition.ownerOnly && actor.subject !== run.ownerId)) throw new WorkflowError(403, 'Forbidden');
if (run.state !== transition.from || run.version !== command.expectedVersion) throw new WorkflowError(409, 'State/version conflict');
```
- [x] Run targeted tests and contracts/API typechecks; commit the tested contract.

## Task 2 — transactional repository

Files: apps/api/src/workflows/database.ts, apps/api/src/workflows/types.ts; modify apps/api/src/database.ts. Tests: real smoke script in Task 4.

Interfaces: WorkflowRepository.create, transition, list, get, history, jobs, retryJobs, registerMember, references, readSharedFile. Repository owns authorization under lock and validates scoped references/files; routes never perform a read/write race. WorkflowJobs.claim/succeed/fail provided by Task 3.

- [x] Add regression tests for command replay/conflicting input and validation before writes in API tests; exercise real SQL in Task 4.
- [x] Add additive tables workflow_runs, workflow_commands, workflow_starts, workflow_audit, workflow_files, workflow_members, workflow_references and workflow_jobs. No changes to old task rows.
- [x] Create under transaction + advisory lock for (organization,actor,key); insert records/run/audit/start result. Transition transaction:
```sql
SELECT * FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE;
```
Authorize actor, replay only matching actor/fingerprint, enforce state/version, validate membership/references/clean file, then update run + insert audit/file association/command result/outbox. Roll back all writes on any error. Use parameterized SQL only.
- [x] Expose scoped list/detail/history/sync and participant-only shared file lookup; SQL filters organization before policy. Add authorized failed-job retry preserving eventId.
- [x] Commit only after route/unit and real database acceptance pass (Task 4).

## Task 3 — outbox worker

Files: apps/api/src/workflows/outbox.ts, apps/api/src/workflows/outbox.test.ts; modify apps/api/src/index.ts, infra/compose/core.yml and .env.example for explicit connector config.

Interfaces: WorkflowJobs.claim(): Promise<OutboxJob|undefined>; succeed(job), fail(job,error). OutboxJob includes id/payload/attempts/leaseToken. startOutboxWorker(jobs,send) returns async stop. sendHttpEvent(job,url,token) uses fixed server configuration, eventId and Bearer credential; no client-controlled destination.

- [x] Write/run failing tests: successful send; failure recorded; timeout/non-2xx rejected; repeated delivery keeps eventId; no worker when connector unconfigured.
- [x] Implement SQL claim with FOR UPDATE SKIP LOCKED and 60-second lease; increment attempts on claim, fence completion by leaseToken. Five attempts, backoff min(300,5*2^(attempts-1)) seconds; expired lease reclaimed. Failure message bounded and scrubbed.
- [x] Implement one-at-a-time polling, HTTP 10-second timeout and redirect rejection. Close worker before pool. The atomic delivery sequence is `claim → send → succeed`, with catch → fail.
- [x] Run targeted tests and typecheck, document at-least-once delivery and consumer dedupe; commit with repository after real checks.

## Task 4 — API, identity and integration verification

Files: apps/api/src/workflows/routes.ts, apps/api/src/workflows/routes.test.ts, scripts/smoke-workflows.mjs, scripts/seed-workflow-demo.mjs. Modify app.ts, foundation.ts, identity local fixture/sync script, Gateway config and package scripts.

- [x] Write/run failing route tests: missing token/org/config, wrong role/owner, malformed UUID/keys, hidden run, detailed errors, member self-registration, schema/catalog, no side effects on forbidden transition.
- [x] Register JWT-authenticated routes from the spec. Add conditional scoped readSharedFile fallback to existing metadata/download routes; keep files:read and clean guards. Unknown fields/body scope rejected.
- [x] Add local manager/warehouse/hr/it/admin/receiver fixture roles/users through non-destructive sync; seed scoped Department/Location references and self-register members. Preserve Alice/Bob baseline action tests.
- [x] `pnpm local:up`, identity sync and demo seed. Smoke two templates through different accounts, test duplicate creation/transition, concurrent approval, pre-approval receipt, rejection reason, cross-unit denial, clean/rejected evidence, history and handover pending outbox.
- [x] Controlled HTTP receiver: first fail/stop then recover, prove business commit survives and same event delivered once effectively with receiver dedupe. Verify worker leasing and fenced completion in real SQL. Do not label receiver as broker.
- [x] Run baseline foundation/actions/bridge smoke to confirm compatibility.

## Task 5 — handoff, review and completion

Files: docs/workflow-runtime.md, docs/verification.md, README.md, this plan. Existing Notion hub progress note only; no renamed tasks or dates.

- [x] Document schema, roles/accounts, API payloads, group queues, input constraints, idempotency, audit, connector credentials/event contract, retry commands, limits and bootstrap references.
- [x] Run `pnpm check`, Compose config and `git diff --check`; record actual results.
- [x] Independent review of policy/SQL/worker; fix important findings and rerun affected checks.
- [x] Commit/push, PR directly main, attach PR, verify CI. No merge/release.
- [x] Reconcile each of six Duy tasks with evidence in the PR/docs. Leave all Notion checkboxes unchanged per the latest user instruction; real broker/UI-dependent acceptance remains pending.

## Execution evidence

Implementation and review completed locally: pnpm check passes 120 tests/12 files, baseline container smoke passes, workflow REST/real SQL controlled-receiver smoke passes, and workflow/audit/outbox hashes persist across PostgreSQL/API restart. See docs/verification.md and docs/workflow-runtime.md for limitations and local stack recovery. Two important review findings fixed and reviewed again. No Notion checkbox was changed. Implementation was committed together after acceptance rather than as individual partial feature commits.

PR: https://github.com/TrDuy-pan3000/LatticeDX/pull/5 (open, attached). Push and PR CI checks passed for implementation commit 820b1df. CodeRabbit reported review rate limited, so its status is not treated as a completed review; the independent implementation review above is the review evidence. No merge, release or Notion edits.

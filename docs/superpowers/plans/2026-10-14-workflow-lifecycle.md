# Workflow lifecycle Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task-by-task, no Notion ticks.

Goal: bounded compound conditions, coherent workflow cancellation and task transfer.
Architecture: condition module shares validation/evaluation/SQL; workflow transactions own run/wait/task/job updates. Current directory protects transfer.
Tech Stack: existing TypeScript/Fastify/pg/Vitest.

## Global Constraints

Exact docs/superpowers/specs/2026-10-14-workflow-lifecycle.md. No dependencies/UI/Nhi adapters/upstream/credentials/volume deletion/Notion ticks. Same branch; implementer no push/switch/merge. Actor/org/roles from JWT, new mutations key/version, run-before-wait/task/job locks, historical publications/read permission preserved. Preserve CV.pdf/a.png/output.

### Task 1: conditions and lifecycle production

Files: packages/contracts/src/workflows.ts; workflows/{conditions,completion-policy,registry,policy,database,schema,types,routes,waits-database,job-database}.ts and focused tests. Can split lifecycle helper module to keep database maintainable; must be wired in repository/routes. Parent scripts/docs/package/gateway only.

- [ ] RED: nested groups validation bounds, evaluator/SQL malformed numerics, cancel route owner/role/key, transfer pending wait authority, job lease guards.
- [ ] Implement union parser/evaluator/parameterized SQL compiler and replace flat inbox guard. Preserve existing flat contracts.
- [ ] Add run status/cancellation metadata, migration waitcancelled constraint, transactional cancel resources/audit/receipt. Persist cancellation at one version and fence processing job token.
- [ ] Add task-transfer transaction per spec and current directory lock. Synchronize pending wait.version to new run.version. Shared legacy reader follows assigned field.
- [ ] Gate transitions/inbox/retries/jobclaim/completion/timeout for cancelled runs without hiding historic read data; add focused regressions to prevent deadlocks or resurrection.
- [ ] Targeted workflow tests, API/contracts typecheck and diffcheck; commit source/tests only. Full report output/reviews/workflow-lifecycle-implementation.md with RED/GREEN and actual commands.

### Task 2: real acceptance

Parent scripts/smoke-workflow-lifecycle.mjs, docs/workflow-lifecycle.md and package command.

- [ ] Signed HTTP create/publish nested definition, verify inbox/choices/direct consistency; transfer pending task and deny previous actor; cancel pendingconnector/job and deny late callback/transitions.
- [ ] Private PG forced receipt rollback, cancel/completion races, stale job token fencing, nonwait tasks, directory transfer active checks, freshpoolmax1. Verified UUIDschema only cleanup.
- [ ] Full check and workflow completion/bundles/blocks/foundation regressions; independent review/fixes/reverification, update master status as partial phase3 (timers/service authority still separate).

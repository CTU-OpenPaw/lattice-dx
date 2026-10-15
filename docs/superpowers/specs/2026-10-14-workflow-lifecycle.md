# Workflow lifecycle and compound conditions

Scope Duy backend; same TS/Fastify/pg and no new dependencies. Exact current actor/tenant authorization. Preserve source definitions, readers and pinned historic publications. No UI/upstream/adapters/Notion edits or releases. All mutations transactional with key/version and review/live tests.

## Compound conditions

Backward compatible WorkflowCondition = leaf {field,operator:'eq'|'gt'|'exists',value?} OR {all:WorkflowCondition[]} OR {any:WorkflowCondition[]}. Depth at most3, total20 nodes, children1..10; one shape exact per node. Leaf uses existing declared field/type/value rules. Evaluate persisted data with same strict string and numeric semantics. Parameterized SQL inbox compiler must match evaluator including missing fields, non-string input, invalid/overflow numeric values. No regex/script/NOT/client functions. AvailableTransitions and direct transitions and inbox must agree. Existing flat definitions unchanged.

## Cancel run

POST /v1/workflows/:id/cancel {expectedVersion,reason}, mandatory Idempotency-Key, workflow:start and current exact owner+tenant. No implicit manager/admin bypass. WorkflowRun gains optional status:'active'|'cancelled', cancellation metadata {actorId,reason,at} only owner-visible unless existing definition reader can read whole run. SQL status defaultactive; existing business state unchanged on cancel. Cancel increases version once, writes workflow audit, stores workflow_commands with namespaced cancel fingerprint; strict nonempty reason max500 codepoints. Samekey replay checks current owner/org and fingerprint then returns historical snapshot even cancelled. Differentkey cancelled/state/version409; hiddenowner404, role403, malformed400.

Cancel transaction locks run then pending waits, related pending tasks and jobs in stable ID order. Covers workflow_task_links, task waits and tasks created through workflow_action_results. Pending tasks cancelled (version+1); terminal decisions preserved. Pending/processing jobs cancelled and lease tokens cleared, terminal transport statuses preserved. Wait CHECK/types add cancelled with atomic additive migration; pending waits cancelled and evidence cancellation reason. No return to active or deletion. Cancelled runs have no availableTransitions, no inbox actions, no new transitions/retry; generic linked task API remains409. New job claims require active run and, for wait jobs, pending unexpired wait. Completion/timeout cannot revive cancellation. Already committed completion receipt may replay acknowledgement only.

Cancellation fences worker DB writes but cannot undo already delivered external actions. Do not promise distributed rollback. Job claim lock order must not invert run cancellation order. SQL reads/ref permissions remain for historical cancelled runs; do not hide definitions to enforce dispatch state.

## Coordinated task transfer

POST /v1/workflows/:id/task-transfer {taskId,expectedVersion,assigneeId,reason}, workflow:start+tasks:assign+exactowner, key mandatory. Active run only. v1 supports pending task wait or legacy task link; rejects unrelated task/action-only task409. New assignee active sameorg and required assigned-reader role if legacy. Lock run first then wait/task and directoryFORSHARE. Update task assignee+version; task wait assignee when applicable; legacy assignedReader data field when applicable; run.version++ and pending wait.version follows. Audit run transfer; receipt current owner checks. Prior recipient loses wait completion and assigned-reader run/evidence access; new recipient can complete. Previous committed completion receipt remains historical if actor still authorized by completion policy; never let old pending recipient complete after transfer. Lifecycle history metadata inserted for task if installed.

Timers/service actions and generic typed entity execution inside workflow remain separate tasks in master plan; this bounded increment must not mark those complete.

Acceptance: bounded parser/evaluator/SQL agreement, signed owner/role errors, cancel pending task+connector+non-wait task and processing lease fencing; cancel/complete/timeout concurrent races, transfer old recipient denial/new success, receipt/audit rollback and max1 restart; existing workflow bundles/completion/block regressions. No source-role snapshot authority.

# Task lifecycle foundation

Scope: Duy backend, preserve existing contracts. Add optional production lifecycle repository, new signed routes, additive SQL. Existing tasks.create and decisions unchanged except terminated-task shared visibility is removed. Do not tick Notion, change upstream, teammates UI/adapters, dependencies or secrets. Tests preserve CV.pdf/a.png/output and local volumes.

## Contracts

Task gains optional departmentId/dueAt fields. Existing assigneeId remains a string; department queue tasks use empty assigneeId and non-null department_id. Queue creation is separate POST /v1/task-queues with strict {title,departmentId,recordId?,dueAt?}; tasks:assign, mandatory Idempotency-Key. DueAt ISO UTC normalized, valid calendar timestamp and future, bounded 366 days from acceptance. Existing createTask remains supported and produces individual pending task.

GET /v1/task-queues?limit&offset&q returns pending unclaimed tasks only for active directory membership in that department + organization; tasks:read. Queue task detail requires creator or current active member. No queue membership automatically grants the linked record/file before claim.

POST /v1/tasks/:id/claim {expectedVersion}: tasks:assign; only active current member of task department, unclaimed pending. Assign current actor; one winner; clear department queue eligibility but retain departmentId provenance. POST /v1/tasks/:id/reassign {expectedVersion,assigneeId,reason}: creator only, tasks:assign, pending. Validate new assignee active sameorg in same transaction, directory row FOR SHARE. POST /v1/tasks/:id/cancel {expectedVersion,reason}: creator only, tasks:assign, pending; cancelled terminal status. POST /v1/tasks/:id/deadline {expectedVersion,dueAt|null}: creator only/tasks:assign/pending, normalize UTC. All lifecycle mutations mandatory key, return updated Task with incremented version.

GET /v1/tasks/:id/history?limit&offset: tasks:read + current task visibility. Metadata only {id,taskId,actorId,operation,fromVersion,toVersion,occurredAt}, no snapshot recipients or linked hidden record data. Lifecycle history immutable through API.

Use TaskLifecycleError 400 malformed/recipient, 404 hidden task/owner operation, 409 state/version/workflow-linked/key conflict, 503 unavailable repository. Roles missing403/token401. DTO unknown keys rejected. Reason trimmed nonempty max500 code points; titles follow existing max200 code point contract; principal100 bounds. UUID normalized.

All resource changes/audit/receipt atomic. Command namespace org/actor/operation/key; fingerprint canonical normalized input, current authority validated before replay. Terminal task mutation replay may return historical snapshot only if caller currently still has authority; revoked assignee cannot replay claim after reassign. Queue membership checked current snapshot, not JWT roles. Creator never gains blanket access to other tasks. List/history/detail must filter ACL before pagination. Old task read lists retain existing behavior unless expanded to creator safely.

Workflow-linked tasks (workflow_task_links or workflow_waits) reject new generic claim/reassign/cancel/deadline409 before mutation; no desynchronization of run/wait. Coordinated workflow lifecycle is a separate dependency in master plan, not counted complete by this increment.

Read sharing of record/file via task must require task noncancelled and current exact assignee. Reassign revokes old assignee immediately. Existing approved/rejected/completed task evidence access remains unchanged; only cancelled is excluded.

Acceptance: signed routes/missingroles/strictbody, department membership/crossorg/disabled checks, claim concurrency one winner +409, concurrent reassign/cancel one winner, currentauthority before replay, rollback audit/task/receipt on receipt failure, cancelled record/file access removed, history filtering and105 paging, freshpoolmax1 persistence. Regression all existing tasks/workflow decisions/create receipts keep passing.

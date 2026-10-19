# Foundation create reliability

Duy approved the day plan and execution. Scope is backend record/task independent creation reliability, strict input consistency, testing and handoff; preserve team boundaries and old no-key requests.

## Design

Extend `RecordRepository.create(title,ownerId,organizationId,key?)` and `FoundationRepository.createTask(input,key?)` with optional command key. Both REST and actions validate the same input using existing shared parsers. Key header, when present, matches `[A-Za-z0-9._:-]{1,128}`; malformed/duplicate headers reject400. No header keeps existing independent-create semantics. No mandatory key for existing callers.

One small create-command module owns domain error, optional-key parser, canonical fingerprint and PostgreSQL transaction wrapper. Table `foundation_create_commands` key `(organization_id,actor_id,operation,key)` stores fingerprint/result. Operations are `records.create` and `tasks.create`. A transaction-scoped advisory lock on a stable hash of the tuple serializes reads/writes; hash collision serializes extra work only. The exact tuple still gates results. Full transaction uses one PoolClient, no nested pool access.

Repository creation checks current authority and references in its transaction before replay: signed actor/org originate in routes; directory enabled+org is locked FOR SHARE; linked record must be owner+org locked FOR SHARE. No direct record/task DB insertion bypasses these scoped checks. Role remains checked by route before repository. Unknown/disabled assignee400, hidden record404, malformed400, key-content conflict409; use existing error mappings where feasible. Compare normalized title/UUID lowercase, preserve opaque assignee identity. First and replay record/task REST201, action200 with same envelope.

Insert entity and JSON result receipt in the same transaction. Rollback removes both on error, including receipt failure. Results are creation snapshots (task may later change; detail is current). Actor/org/operation separate key namespaces. Keyed REST/action cross-channel retry same creation returns same entity. Replays still validate current role/assignee/record access, so revoked references reject rather than leaking a cached result. Failure does not consume key. No retention pruning in this increment; no exact-once external-effects claim.

Keep generic task decisions and workflow execution unchanged. File create idempotency, NocoBase bridge propagation and n8n adapters are out of scope. HTTP REST create records/tasks strictly reject unknown keys (previously ignored); document this validation tightening. Current repository fixtures must not silently claim idempotency with mocks; live SQL proves guarantees.

## Acceptance

Policy/header parsing and scoped error tests; real signed REST/action first/replay/conflict/malformed and role denial; no-key creates remain distinct; UUID/title normalization; same key across channels; disabled assignee and revoked owner link reject replay. Real PostgreSQL multi-connection races with equal/different inputs, actor/org/operation isolation, snapshot after task decision, intentional receipt-insert failure rolling back entity/receipt then recovery, max1 connection and fresh pool reconnect. Full check and existing foundation/actions/workflow blocks/completion/bundles regressions pass before one reviewed PR. No merge, Notion ticks, dependencies, upstream/license changes or cleanup of user artifacts.

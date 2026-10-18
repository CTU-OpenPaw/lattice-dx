# Entity automations backend handoff

An enabled rule matches future committed entity events and stages an immutable delivery in the same transaction. The opt-in dispatcher starts an entity-linked workflow using the currently provisioned service account, optionally executes one initial transition, and commits effects and a receipt atomically. Rule changes cancel older pending revisions; enabling a rule does not backfill history.

Configuration endpoints require both `workflow:design` and `data:automate`. All requests are tenant scoped and mutation requests require `Idempotency-Key`.

| Endpoint | Input / result |
| --- | --- |
| POST `/v1/entity-automations` | Rule below; returns rule and revision, 201 |
| PUT `/v1/entity-automations/:id` | Full rule plus `expectedRevision`; returns new revision |
| GET `/v1/entity-automations` | `limit`, `offset`; paged rules |
| GET `/v1/entity-automations/:id/deliveries` | Paged status, attempts and receipt metadata |
| POST `/v1/entity-automations/:id/deliveries/:deliveryId/retry` | `{ "expectedVersion": 2 }`; resets an eligible failed delivery |

```json
{
  "id": "asset-created",
  "schemaId": "assets",
  "schemaVersion": 1,
  "operations": ["entity.create"],
  "serviceId": "asset-worker",
  "definitionId": "asset-onboarding",
  "definitionVersion": 1,
  "title": { "source": "event", "field": "entityId" },
  "input": { "assetId": { "source": "event", "field": "entityId" } },
  "enabled": true
}
```

Service profiles are deployment configuration, with no public provisioning endpoint. Their directory account must remain enabled with `workflow:service`, `workflow:start`, `data:read`, the workflow start role and any optional transition block capabilities. The account needs current source entity access; a rule grants no access itself. The dispatcher never impersonates the event author.

Optional `transitionId` is restricted to an initial interactive transition with no extra fields or assignment. Allowed actions are `entities.create`, `entities.query`, `records.create`, `tasks.create`, `connectors.dispatch`, and `timers.schedule`. Existing entity updates remain ordinary authorized workflow transitions.

Error codes are sanitized: `validation_failed` (400), `authority_denied` / `service_unavailable` (403), unavailable resources (404), and revision/version/idempotency conflicts (409). Deliveries have `pending`, `succeeded`, `failed`, or `cancelled` states. Transient dispatch errors back off with at most three attempts; a manual retry rechecks current service and entity authority before an accepted receipt is returned.

`ENTITY_AUTOMATION_WORKER=true` enables the process worker; the default is false. Invalid boolean settings fail startup. Shutdown drains the active operation before closing PostgreSQL. A server-derived depth limit of eight bounds cascading entity automations without discarding journal entries. No private entity attributes appear in delivery metadata.

Verification: `pnpm test:entity-automations` exercises actual PostgreSQL dispatch concurrency, current authority, replay denial after capability removal, rollback, revision cancellation, no backfill, an eight-level cascade, fresh pool size one, and worker drain; it also checks the signed Gateway catalog. The isolated test schema is removed after execution. No production queues are dispatched by this test.

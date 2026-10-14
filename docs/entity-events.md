# Committed entity event journal

The journal records committed business entity changes independently from workflow execution. Each event is appended on the same transaction connection as the resource mutation, audit and command receipt. A later failure rolls back the event too.

`GET /v1/entities/:id/events?limit=20&offset=0&q=...` requires `data:read` and current entity read access. It returns normal `{items,page}` metadata:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "entityId": "00000000-0000-4000-8000-000000000002",
  "schemaId": "asset",
  "schemaVersion": 1,
  "fromVersion": 1,
  "toVersion": 2,
  "operation": "entity.update",
  "actorSubject": "originating-account",
  "occurredAt": "2026-10-14T12:00:00.000Z"
}
```

The originating account is provenance, not delegated execution authority. Attribute values, titles, credentials and role snapshots are not event payloads. An archived source remains journal-readable by its owner; shared recipients receive404. The final selection repeats current read/archive predicates before pagination.

The six event operations are `entity.create`, `entity.update`, `entity.archive`, `entity.link`, `entity.unlink`, `entity.schema.migrate`. Actual relation no-ops and accepted command replay add no event. Grants and file attachment changes remain audited but are not business event triggers in this version. Publishing a new schema alone does not generate events for old entities.

Journal persistence does not itself run a workflow or invoke an external adapter. The separate automation capability stages matched deliveries and uses an explicitly configured current service identity after the entity transaction commits. Enabling rules does not retroactively process old journal rows.

Run `pnpm test:entity-events` for signed metadata/paging checks and isolated PostgreSQL six-operation coverage, concurrent create dedupe, event insert rollback, migration, archived shared denial, late workflow receipt rollback and fresh pool max1 persistence. Source review closed the archived-recipient regression after a real-PG failing test and rebuilt successful acceptance.

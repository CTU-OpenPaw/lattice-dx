# Business entity context

A workflow can refer to a real business entity while keeping its independent workflow record. This gives Studio bidirectional navigation without turning workflow readership into entity access.

Start example (`workflow:start`, definition start role and `data:read`, plus current entity read):

```json
{
  "definitionId": "asset-handover",
  "title": "Hand over asset",
  "input": {},
  "entityContext": {"entityId": "00000000-0000-4000-8000-000000000001"}
}
```

Send this to `POST /v1/workflows` with `Idempotency-Key`. A new source must be active and currently readable. Tenant, schema and version are derived by the engine; the body cannot supply ownership or permissions. Existing requests without `entityContext` work as before.

The run includes immutable context metadata `{entityId,schemaId,schemaVersion,entityVersion}` captured at creation. `recordId` remains the workflow's own record ID. A later entity update or explicit schema migration does not rewrite that original context. Context is not reassigned in this version.

| Navigation | Checks | Response |
| --- | --- | --- |
| `GET /v1/entities/:id/workflows?limit=20&offset=0&q=...` | `data:read`, current entity access and current run-read policy | Bounded workflow page; run permissions filter before pagination |
| `GET /v1/workflows/:id/entity-context` | `data:read`, current run access and current entity access | `{context,current}` with current entity ID/schema/version/archive metadata |

These endpoints return no entity attributes. Read full entity data separately through its authorized API. Being assigned a workflow/task does not automatically grant entity read or edit access. Similarly, having entity access does not expose all associated workflows.

Start replay checks the originally accepted entity's current access before returning its receipt or reporting a changed-body conflict. A revoked recipient receives404 even if the workflow start was accepted earlier. Archived owner-readable source may retain accepted replay/detail access; a new workflow on an archived source receives409, and shared archive access remains404.

Errors use normal `{error}`:401 identity,403 missing capability,404 invisible run/entity or absent context,409 archived new source/key conflict,400 invalid body/query. Run and association/audit/receipt persist together; no partial link is retained after a failed start.

Acceptance command: `pnpm test:entity-workflow-context` against the local core. It checks signed HTTP navigation/revocation and isolated PostgreSQL receipt rollback, concurrent start dedupe, schema pin/current distinction, mixed visible/hidden paging beyond100 and max1 restart/new execution.

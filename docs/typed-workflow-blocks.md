# Typed entity blocks inside workflows

The workflow executor uses the same entity validation and access policy as REST on the caller's transaction connection. A transition commits its entity changes, entity audit, action results, workflow state and command receipt together. It does not call an independently committed HTTP action.

The `/v1/workflow-blocks` catalog describes the supported bindings and output metadata. A workflow designer needs `workflow:design`; the actor actually executing a transition also needs each block's capability: `data:read` for read/query and `data:write` for create/update/archive/link/unlink. Current resource permissions still apply. Archive requires ownership. Services use their designated current identity and grants.

| Action | Input | Execution result |
| --- | --- | --- |
| `entities.create` | Fixed `schemaId`, `schemaVersion`; title string binding; typed attribute bindings | `id`, `version`, `schemaVersion` |
| `entities.read` | Entity ID string binding | Same metadata |
| `entities.query` | Fixed schema/version, typed filters, bounded limit | Metadata items and page information |
| `entities.update` | ID, expected version, title and complete attributes | Entity metadata |
| `entities.archive` | ID and expected version | Entity metadata |
| `entities.link` / `entities.unlink` | Source ID, target ID, declared relation name and expected source version | Source metadata |

Example transition steps:

```json
[
  {
    "id": "create_asset",
    "action": "entities.create",
    "input": {
      "schemaId": "asset",
      "schemaVersion": 1,
      "title": {"source": "context", "field": "title"},
      "attributes": {
        "quantity": {"source": "data", "field": "quantity", "as": "integer"},
        "active": {"source": "literal", "value": true}
      }
    }
  },
  {
    "id": "archive_asset",
    "action": "entities.archive",
    "input": {
      "id": {"source": "result", "stepId": "create_asset", "field": "id"},
      "expectedVersion": {"source": "result", "stepId": "create_asset", "field": "version"}
    }
  }
]
```

Attribute bindings are literals of string/number/boolean or `data`/`input` fields with an explicit `as` type: text, integer, decimal, boolean, date or enum. Existing string bindings remain string bindings. Conversion is strict: integer `02` and boolean `yes` are rejected, decimal precision is represented as a string, and the pinned publication validates the final attributes. Publishing schema version 2 does not change a block pinned to version 1.

Expected version is a positive integer literal, a strictly converted input/data integer, or the `version` of an earlier entity result. Entity ID may come from an earlier entity result. Query results cannot be used to inject arbitrary private attributes into later steps. Execution evidence stores metadata rather than entity titles or attribute snapshots, so workflow readers do not acquire entity read permission from workflow history.

Bundle portability does not transfer source entity IDs, actors, grants or existing data. A portable workflow refers to schema publications and receives destination entity IDs through inputs where necessary. Module installation does not grant the executing actor extra capabilities.

Run `pnpm test:typed-workflow-blocks` against the local core stack. The current acceptance status and any unfinished checks are recorded in [verification](verification.md) and [completion plan](backend-completion-plan.md).

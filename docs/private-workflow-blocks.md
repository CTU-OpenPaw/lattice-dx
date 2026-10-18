# Private data and calculation blocks

These declarative workflow blocks compose authorized entity data with bounded calculations. They are not JavaScript execution. Each requires `data:read`; ordinary entity writes additionally require `data:write` and current resource access.

| Action | Input | Public result |
| --- | --- | --- |
| `entities.project` | `{id: WorkflowBinding, fields: string[]}` | Entity ID/version/schema version and projected field names |
| `data.evaluate` | `{values: Record<string, Expression>}` | Evaluated key names |
| `data.assert` | `{condition: Expression}` | `{asserted: true}` |

Projection reads one to twenty fields from the entity's published schema. An absent optional field is typed null. A required or undeclared field cannot be silently substituted. Projected values stay in a transaction-local private map and do not appear in run data, execution evidence, receipts, audit or jobs.

Example calculation:

```json
{
  "id": "total",
  "action": "data.evaluate",
  "input": {
    "values": {
      "amount": {
        "op": "multiply",
        "args": [
          {"op": "ref", "source": "projection", "stepId": "source", "field": "price"},
          {"op": "ref", "source": "projection", "stepId": "source", "field": "quantity"}
        ]
      }
    }
  }
}
```

Later entity attribute/filter bindings can consume a value with `{"source":"expression","expression":...}`. IDs, expected versions and authorization cannot come from expressions. References are restricted to declared inputs and earlier projection/evaluation steps; self and forward references are rejected.

Decimal values use strings and exact BigInt arithmetic. Intermediate decimals are bounded to eighty digits and eighteen fractional places; stored entity decimals retain the existing thirty-eight-digit bound. Division rounds at eighteen fractional places, with ties away from zero. Type mismatches, overflow and division by zero fail rather than coercing values.

An assertion requires boolean true. False returns a sanitized 409 and rolls back every earlier effect in the transition, including entity changes and journal events. The same command can then be deliberately retried only under ordinary version/idempotency rules.

Acceptance command: `pnpm test:private-workflow-blocks`. Implementation and review status remain in the [composition ledger](superpowers/plans/2026-10-14-enterprise-composition.md) until that command is recorded as passing on the rebuilt API.

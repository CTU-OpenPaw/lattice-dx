# Scoped aggregates and frozen reports

The backend reporting API aggregates published entity fields within the caller's current tenant and access scope. It accepts declarative metrics, not SQL or arbitrary joins.

```json
{
  "schemaId": "balances",
  "schemaVersion": 1,
  "groupBy": ["department"],
  "metrics": [
    {"name": "items", "operation": "count"},
    {"name": "total", "operation": "sum", "field": "amount"}
  ]
}
```

`POST /v1/entities/aggregate` requires `data:read`. It supports up to ten metrics, two grouping fields and the existing typed filters. Numeric metrics work on integer/decimal fields. Results return numeric metrics as strings to preserve precision. Missing numeric fields are omitted from numeric metrics but their rows still count. More than two hundred result groups returns a conflict rather than an incomplete result. Ordinary aggregate source rows are not limited to a page of one hundred or to the snapshot limit.

`POST /v1/entity-report-snapshots` takes `{title,query}` and an `Idempotency-Key`. It captures an immutable result and all contributing source IDs at one database statement boundary, with at most five thousand sources. The command receipt stores only a snapshot ID.

`GET /v1/entity-report-snapshots` lists the caller's metadata only. `GET /v1/entity-report-snapshots/:id` returns frozen values after checking current access to every source. Editing a source does not rewrite the frozen report. Losing a grant, disabling shared membership or archiving a source prevents reading its report values. Snapshot ownership grants no additional access.

Empty ungrouped results contain a count of `"0"` and null numeric metrics; empty grouped results contain no groups. An unavailable source returns 404. Invalid metrics or fields return 400. Group/source limits return 409; bounded database timeouts are sanitized.

These contracts are implementation targets until the [composition ledger](superpowers/plans/2026-10-14-enterprise-composition.md) records PostgreSQL and signed API acceptance. Adapter dashboards must use returned page/limit semantics and must not infer a complete dataset from the first page.

# General configurable system blocks

The approved increment extends LatticeDX's current System Studio and module installer. It does not introduce another registry or business-specific CRUD service.

Recipes may carry owned entity schemas and `entityPages`, alongside existing workflow `pages`. A data page pins a schema publication, chooses visible fields, orders reusable create/list/detail/relations/history blocks and selects create/update/archive/link/unlink actions. All six existing entity scalar types are supported. Optional declarative filters and sort configure a view; they are not ACLs.

Compilation validates schema ownership, field references, action/block coherence, query types and bounds. Standalone workflow bundles remain nonempty; a data-bearing module may have zero workflows. The installer creates schema publication 1 and immutable module content in its existing transaction. Schema ID collisions are explicit: changing an installed schema requires a new schema ID, not silently replacing an earlier publication. Old workflow-only recipes retain byte-identical compiled output.

The existing module preview reports required data roles from declared operations. Runtime catalog visibility is scoped by signed organization and data-read or workflow roles. Only visible pages and their pinned schema definitions are returned. Record data and writes continue through existing repository ACLs, command receipts and expected-version checks. Configuration never supplies actor IDs, organization authority, code or arbitrary URLs.

Studio adds native schema and data-page controls; runtime navigation combines data and workflow pages. Entity commands use the existing immutable retry controller. The bridge adds fixed query/relation routes, bounded payloads and exact allowed fields. A switch of page, account or organization clears cached record state and rejects late responses.

Verification uses HR-like people, contracts and assets configurations on the same generic API, real disposable PostgreSQL, signed identities, creation replay, queries and pagination, relations, history, role/record/tenant denials, publication isolation and restart persistence. Existing workflow lifecycle tests remain in the same acceptance run. Frontend interaction tests cover authoring, typed fields, hidden-field preservation, action gating and stale session data.

This increment does not build accounting rules, arbitrary scripting, a new workflow engine or new agent/connector workers. Existing workflow configuration, n8n and broker integration remain available separately. Reusing data across module versions through external schema dependencies is beyond this first owned-schema page contract.

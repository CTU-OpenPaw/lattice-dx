# Entity Workflow Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development; source implementation followed by independent review and parent acceptance.

**Goal:** Attach workflow runs to actual business entities without replacing record identity or widening access.

**Architecture:** Immutable association table, strict optional start contract, current entity checks on the supplied start transaction, and two navigation methods/routes. Share SQL run-read policy with existing pagination.

**Tech Stack:** TypeScript/Fastify/pg/Vitest; existing deps.

## Global Constraints

Exact spec 2026-10-14-entity-workflow-context.md and parent composition constraints. Samebranch no implementer push/switch/merge/deps/UI/upstream/Nhi adapters/Notion/credentials/volumes/userfile edits. Parent owns scripts/docs/package/gateway; source/tests/wiring implementer-owned. Scope commits only explicit source files, never output reports. Current authorization before receipt, same-client, no implicit entity grants.

### Task 1: contract and creation

Files contracts/workflows.ts, workflows/policy.ts/schema.ts/database.ts/types.ts, focused workflows/entity-context.ts and tests, only required database bootstrap integration.

Produces:

```ts
type EntityWorkflowContext = {
  entityId:string; schemaId:string; schemaVersion:number; entityVersion:number;
};
type CreateWorkflow = {
  definitionId:string; title:string; input:Record<string,string>;
  entityContext?:{entityId:string};
};
```

- [ ] Write parser regression: valid context normalized, extra inner owner/schema/role rejected, omitted context preserves old normalized DTO.
- [ ] Run targeted parser test to observe RED.
- [ ] Implement exact parseCreate extension. Repository direct calls validate optional context too; no trusting TypeScript types at runtime.
- [ ] Write creation regression: context requires data:read, share revocation rejects accepted receipt before fingerprint; unknown/foreign hidden404, no context existingcreate unchanged.
- [ ] Implement context validation/association insert with actual locked entity and original schema/version on callerclient. Ensure run.recordId remains run.id and audit/receipt includes metadata only.
- [ ] Run targeted workflow/entity tests +API/contracts typecheck; commit creation checkpoint when stable.

### Task 2: scoped navigation

Files focused entity-context/read-predicate helpers, workflow database/routes tests and optional types.

Interfaces:

```ts
entityContext(runId:string,actor:WorkflowActor):Promise<{
  context:EntityWorkflowContext;
  current:{id:string;schemaId:string;schemaVersion:number;version:number;archivedAt:string|null};
}>;
listEntityWorkflows(entityId:string,actor:WorkflowActor,page:PageQuery):Promise<Page<WorkflowRun>>;
```

- [ ] RED route signedrole/404 and repository mixedreadpolicy beforeLIMIT SQL tests; hidden entity denies even readable run.
- [ ] Implement bounded methods with current role/resource checks, shared workflow readpredicate, no perrun filteredpagination or nestedpooltransactions.
- [ ] Wire GET /v1/entities/:id/workflows and /v1/workflows/:id/entity-context using existing workflow auth/error handler and strictquery/pagevalidation.
- [ ] Run all affected workflow/contracts/entity tests, typecheck and diffcheck; scopedcommit. Report stableinterfaces and tests toparent. Output report staysignored.

### Task 3: parent acceptance/review

Files scripts/smoke-entity-workflow-context.mjs, docs/entity-workflow-context.md, package/APIindex/gateway as needed.

- [ ] Signed scenario entity owner/readgrant → linkedrun → navigation; peer no inheritedread; revokecontextdetail/replay404; repeatkey changedentity409 while acceptedentityunavailable still404.
- [ ] Private PG forcedstartreceipt failure zero run/association/audit; five concurrentstarts oneassociation; entity pin/current version distinct afterschema migration; 105 visible contexts mixedhiddenrun paging; freshpoolmax1 newcreate/replay/list/detail.
- [ ] Independent review with source diff/spec; fix verified findings. Update local master ledger only after signed/PG evidence, not Notion.

# Organization directory Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. Local progress only, no Notion ticks.

Goal: manage department hierarchy/responsibility and revocable current directory snapshots without changing identity authority.
Architecture: organization module SQL repository with org advisory lock + revision/command receipts; current directory stores reused. Dedicated role-scoped routes.
Tech Stack: TypeScript/Fastify/pg/Vitest, no new dependencies.

## Global Constraints

Exact spec docs/superpowers/specs/2026-10-14-organization-directory.md. Duy backend only; preserve old directory APIs and Keycloak identity. No UI/upstream/Nhi adapters/deps/credentials/volume deletion/Notion ticks, branch switch/push/merge. Tenant from JWT, no hierarchy permission inheritance, service authority not provisioned by arbitrary directory roles. Preserve CV.pdf/a.png/output.

### Task 1: module and wiring

Files new organization/{types,policy,database,routes}.ts + tests; app/database/index option wiring. Parent gateway/localrealm/scripts/package/docs.

- [ ] RED strict parsers reject organization/credentials/unknown fields/duplicate subjects and bounds; signed adminrole/token checks; parentcycles/currentmanager checks.
- [ ] Implement Department create/update/list/history with scoped immutable receipts and current metadata versions; organization lock then resource/reference lookup; recursive cycle/depth check.
- [ ] Implement directoryState and replaceSnapshot expectedRevision with additive state/audit/receipt tables; updates directory rows (never JWT accounts), disables omitted sameorg only. Use one transaction/no nestedpool.
- [ ] Typecheck and targetedtests; scopedcommit report output/reviews/organization-directory-implementation.md.

### Task 2: acceptance/handoff

Files scripts/smoke-organization-directory.mjs and docs/organization-directory.md; package command/gateway rolefixtures.

- [ ] Signed HTTP roles/error metadata hierarchy; private UUID PG tests concurrent cycles, wrongtenantmanager, snapshot revoke/move with entity and taskqueue stores, forced receiptrollback, 105 paging, max1 restart.
- [ ] No live authoritative local snapshot replacement that disables teammate accounts; replacements tested privately only. Full check/regressions and independent review/fix loop.
- [ ] Handoff clearly distinguishes directory snapshot from Keycloak source, records external sync revision limitation and no inherited permissions; update master status only verified clauses.

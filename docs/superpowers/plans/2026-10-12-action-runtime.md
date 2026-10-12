# Action runtime — 12 October 2026

Approved scope: Duy's first shared engine interface. Execute in this session on `codex/action-runtime`, based on `codex/phase-one-foundation`.

## Goal and design

Provide a discoverable, versioned catalog of server-owned actions and a synchronous execution endpoint. NocoBase blocks and n8n connectors call the same interface. Initial actions are `records.create` and `tasks.create`; these demonstrate reusable capabilities, not a complete workflow engine.

GET `/v1/actions` requires valid identity and organization, and lists only available actions the caller has permission to execute. Each descriptor has id, version, title, requiredRole and inputSchema. POST `/v1/actions/:id/run` accepts `{version:1,input:{...}}`, verifies the action-specific role and signed scope, validates input, then invokes the existing repository. Returns `{actionId,version,status:"succeeded",result}` with HTTP 200. Unknown action is 404, bad input/version 400, missing token 401, missing scope/role 403, missing runtime/dependency 503. Expected errors never execute a write.

Registry definitions live in server code. Clients cannot register arbitrary code, change permissions or provide trusted organization/owner context. Input JSON schema and runtime validation agree, reject extra keys and enforce length/whitespace constraints. Existing REST endpoints keep their current behavior.

No automatic retry or idempotency guarantee for creation; no durable action-run journal, graph execution, scheduling, broker or n8n deployment in this change. Task assignee validation remains the existing trusted-caller limitation. UI authentication/SSO is a separate integration.

## Steps

- [x] 1. Add API tests in `apps/api/src/actions.test.ts` before implementation. Cover catalog permission filtering, authentication/scope, unknown action, malformed envelope, wrong version, role denial without writes, dependency unavailability, input constraints, signed scope and successful output for both actions. Run `pnpm exec vitest run apps/api/src/actions.test.ts` and observe missing-route failures.
- [x] 2. Define shared action descriptor/request/result types and exported input parsers in `packages/contracts/src/actions.ts`, exported by `index.ts`. Inputs are `{title}` and `{title,assigneeId}`; version must equal 1; reject arrays, null and undeclared fields. String lengths match existing API limits (title 200, assigneeId 100), trim title and reject blank assignee.
- [x] 3. Add server-owned registry/routes in `apps/api/src/actions.ts`; use `verifyIdentity`, existing `RecordRepository` and `FoundationRepository`. Register in `app.ts`. Filter catalog by role and repository availability; unavailable known action returns 503 only after role check. Keep repositories as the data boundary and never trust client scope. Run the action tests and fix until green.
- [x] 4. Add `/v1/actions` and `/v1/actions/*` to the existing authenticated APISIX route. Write `scripts/smoke-actions.mjs` using local Alice/Bob tokens (never printed), asserting real catalog access, role isolation, scoped record creation and durable task creation. Add `test:actions` package script. Each run creates one record and one task; do not delete shared data.
- [x] 5. Write `docs/action-runtime.md` with exact requests/responses, role table, UI and n8n integration instructions, credentials boundary, error handling, duplicate-creation warning and explicit incomplete engine capabilities. Link from phase-one handoff.
- [x] 6. Run `pnpm check`, both Compose config checks and `git diff --check`. Rebuild core with `pnpm infra:up`, then run `pnpm test:actions`, `pnpm test:infra`, `pnpm test:foundation`. Inspect every result. No repeated scanner-outage test unless scanner behavior changed.
- [x] 7. Review code locally for permission bypass, schema/validator mismatch, unintended existing-route changes and claims beyond implementation. Record verification in handoff. Commit only task files; preserve `CV.pdf`, `a.png`, `output/`.
- [ ] 8. Push foundation and action branches. Create or reuse foundation PR into main, and dependent action PR into foundation; attach created PRs to this chat. Do not merge PRs. Explain merge order and remaining team integration.

## Acceptance

Two different clients can use the documented interface; real gateway smoke proves both actions write through existing scoped repositories. Unauthorized calls do not invoke actions. CI checks pass. This is the first synchronous action runtime slice, not proof that block graphs, shared SSO or automated workflow already work.

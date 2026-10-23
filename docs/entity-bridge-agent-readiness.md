# Shared bridge and provider readiness — 19 October 2026

## Entity bridge for Hung

Action Bridge 0.1.2 adds fixed `list`, `create`, `update`, `archive` operations; existing
`detail` remains compatible. `attachApplicationApi` already forwards `api.entity` to
the session-bound server resource. No service credential is exposed to the browser.

```javascript
await api.entity('list', {query: {schemaId: 'incident-rule', limit: '50', offset: '0'}});
await api.entity('create', {
  body: {schemaId: 'incident-rule', title: 'Pump temperature', attributes: ruleAttributes},
  key: commandKey
});
await api.entity('update', {
  id: rule.id,
  body: {expectedVersion: rule.version, title: rule.title, attributes: updatedAttributes},
  key: updateKey
});
await api.entity('archive', {
  id: rule.id, body: {expectedVersion: rule.version}, key: archiveKey
});
```

Only the API's published attributes belong in `ruleAttributes`. Display name is `title`,
not an extra `name`/`code` attribute. Use schema `incident-asset` for the incident asset
selector; NocoBase collection rows and arbitrary `asset` schemas are not interchangeable.
The rule threshold choices and complete payload are in
[incident-agent-runtime.md](incident-agent-runtime.md).

The bridge rejects unknown operations/outer keys, URL/token/scope overrides, malformed
UUIDs, unexpected queries/read bodies, missing keys/versions, wrong envelopes and bodies
over 64 KiB. Query values use the existing bounded pagination validator. Backend keeps
schema, field-size, role, tenant and current entity authorization. An allowed proxy
operation is not an authorization grant. No schema publishing/share/delete endpoint is
exposed by this change. Archive is an explicit backend operation, not a delete alias.

Mutations never retry automatically. Preserve the exact key/body after uncertain results;
after success, adopt the returned entity version. Resolve 409 by reloading/reviewing before
issuing a changed command. List remains paged: follow `page.hasMore`/`nextOffset` or show
paging controls instead of assuming 100 rows are the whole dataset.

`pnpm test:entity-bridge` bootstraps a unique local module fixture and calls source bridge
code through the real Gateway/API/PostgreSQL with signed demo identities. OAuth token
exchange/userinfo are fixture seams; this is not a browser/SSO test. It verifies list,
create/replay, detail, denied users, update, stale version and archive. Only its own new
entity is archived. It retains other demo fixtures and never changes teammate schemas.
Bob's denial can be a missing-role denial; it is not independent proof of tenant isolation.

## Local 9router provider

The user-confirmed dashboard is `http://localhost:20128/dashboard/endpoint`; its local
OpenAI-compatible API at `http://localhost:20128/v1` was verified using `/models` and
`/chat/completions`. The supplied key is saved only in Git-ignored `.env.agent`, never
in the sample env, browser bundle, workflow export or source. The CLI smoke loads that
file explicitly:

```powershell
pnpm test:agent-provider
```

The model tested was `ag/gemini-3.8-flash-low`; the router reported resolved model
`gemini-3.8-flash-n`. Aliases depend on the local router configuration. Both a short
connectivity response and a synthetic incident proposal succeeded. The proposal cited
only fixture observation/rule IDs and required human approval.

The server/CLI provider client has explicit configured endpoints, a 45-second timeout,
512 output-token request, bounded 24 KiB messages and 64 KiB response, no redirects or
automatic retry. Only error codes/status are surfaced on failure; raw provider error
bodies are discarded. Unit tests use fake credentials and no network. Environment
examples contain placeholders only. The smoke sends synthetic observations, not business
records, user files, tokens from the engine or incident jobs.

This is provider readiness, not full agent-job integration. The existing `/run` worker
is still demo mode. No durable job was claimed, proposal written into a real case, human
approval skipped or workflow closed. Nhi's worker must still read authorized job context,
handle leases/timeouts, validate a structured proposal against the backend contract, and
settle via the existing API. One successful synthetic prompt is not a prompt-injection
or safety evaluation. The CLI's tiny evidence-only JSON is not the complete backend
proposal envelope.

## Verification

- New bridge regression observed failing before the operation expansion, then passing.
- Provider tests observed failing before the provider module existed, then 11 passed,
  including a response stalled after successful HTTP headers.
- Entity bridge + signed Gateway/API/PostgreSQL acceptance passed.
- Live local router connectivity and synthetic proposal passed.
- Full `pnpm check`: 620 tests / 113 files, typecheck and all production builds passed.
- Foundation/Action Bridge Node suite: 70 tests passed.
- Independent review correction: reject non-string operations before method lookup;
  array/object operation regression observed failing, then passed without dispatch.
  Re-review found no remaining actionable issue. NocoBase restarted with the mounted
  bridge 0.1.2; its sign-in endpoint returned HTTP 200. Foundation/UI sources unchanged.

Hung's Rule Editor/UI payload, manifest reachability, package workflow-ID mismatch and
dashboard pagination remain on his active branch; this change does not overwrite that
branch or certify those screens. Nhi's UC1 receiver implementation remains on her branch.
No Notion task was ticked and no model key is committed.

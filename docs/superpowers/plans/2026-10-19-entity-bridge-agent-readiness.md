# Entity bridge and provider readiness plan

**Goal:** Fix Duy's shared entity bridge boundary and verify the supplied local
9router provider without changing teammates' active feature branches.

**Design:** Keep the session-bound proxy and fixed gateway paths. Add explicit
list/create/update/archive operations using the existing entity REST contract,
strict outer/body/query allowlists and caller command keys. API remains responsible
for schema, identity, tenant and entity authorization. No delete alias or arbitrary
URL/token is accepted. Existing detail behavior remains compatible.

Provider credentials live only in ignored `.env.agent`. Verify OpenAI-compatible
models/completions against the user-confirmed localhost router. A bounded provider
client with sanitized failures supports a synthetic incident-proposal smoke; it
does not consume durable jobs or change workflow state. The existing demo worker
remains explicitly demo until Nhi integrates an actual worker lifecycle.

- [x] Verify review findings against current bridge and entity route contracts.
- [x] Save ignored credential; verify local models endpoint and one completion.
- [x] Write bridge regression tests, observe failure, implement fixed operations.
- [x] Write provider tests, observe failure, implement bounded request/response and
  safe error handling; no retries or redirect following.
- [x] Run synthetic incident model smoke and distinguish provider evidence from
  actual engine job acceptance.
- [x] Document exact requests Hưng must adopt and remaining worker integration.
- [x] Run project/plugin checks and independent review; correct operation-type finding.
- [ ] Publish one PR after final diff/credential checks.

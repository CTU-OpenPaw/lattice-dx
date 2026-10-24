# Submission integration

Goal: integrate existing team contributions into a verifiable submission candidate; freeze feature scope.

Architecture: keep main's authenticated canonical handover adapter as the engine's production path. Retain Nhi's durable worker/sample receiver as a separately configured external-source connector; give its export and tests distinct sample filenames. Preserve main's Studio/entity bridge and add Hưng's agent proxy. No changes to existing authorization, no fabricated live results.

- [x] Merge both teammate histories on feat/submission-integration, resolve Dockerfile and bridge conflicts by combining capabilities, keep production and sample n8n exports separate.
- [ ] Fix live Rule Editor envelopes, archive/version semantics, real incident source references and workflow field compatibility.
- [ ] Load real immutable agent proposals, block approval when missing, remove sample evidence from live screens and redundant malformed asset writes.
- [ ] Fix external broker connector append semantics and reconcile existing canonical Assets' relationship timestamps with conservative ordering.
- [ ] Run all workspace and plugin tests, fix actual integration regressions, review changes independently.
- [ ] Run disposable PostgreSQL and real broker acceptance, rebuild/install local services with backup, verify core runtime readiness.
- [ ] Create one integration PR with concrete test evidence, await CI and merge only passing candidate; no premature release tag or Notion completion.

Deadline scope: workflows, reusable Studio and team UC1/UC2 already implemented. No new blocks or providers. Preserve unrelated CV.pdf/a.png and ignored local credentials. Model calls, if needed, use combo only.

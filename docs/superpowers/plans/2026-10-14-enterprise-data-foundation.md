# Enterprise data foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Checkboxes are local implementation tracking, not Notion.

**Goal:** Implement the first enterprise capability group: typed versioned data, scoped CRUD/relations and audit through reusable engine APIs.

**Architecture:** Separate small entity policy/types, database, routes modules. Original records/workflows stay compatible; schema versions are immutable and entities are pinned. Use one PostgreSQL client per transaction and signed scope at every boundary.

**Tech Stack:** Fastify, TypeScript, pg, Vitest, JWT, existingAPISIX.

## Global Constraints

Read exact approved source: docs/superpowers/specs/2026-10-14-enterprise-backend-capabilities.md, increment1. Only backendDuy, no new dependencies, no NocoBase/plugin/adapter changes. PreserveCV.pdf/a.png/output; onebranch frommain; no Notiontick/merge/release.

### Task 1: Policy, typed storage and commands

Files: create apps/api/src/entities/{types.ts,policy.ts,policy.test.ts,database.ts,database.test.ts}. Modify create-command only if reusable typed fingerprint requires explicit operation expansion; retain original normalization guarantees.

- [ ] RED typed/date/decimal/enum/authority/schema constraints and pinned updates before production.
- [ ] Schema drafts/revision/publish, typed entity CRUD/archive/relations/history, scoped command receipts, stablelocks implemented in one focused repository. Keep pagination exact and validation complete before writes.
- [ ] Tests demonstrate domainbehavior, not only SQLstrings; targetedGREEN/typecheck before scopedcommit; implementationreport output/reviews/enterprise-data-storage.md.

### Task 2: Signed API and wiring

Files: create apps/api/src/entities/{routes.ts,routes.test.ts}; modify app.ts/index.ts/database.ts bootstrap, gatewayroutes, localrealmroles.

- [ ] RED missing route/auth and strictpayload tests.
- [ ] Signedactor/tenant roleenforcement, strictpaths/body/key/paging, domainerror mapping, explicit503 missingrepository.
- [ ] Forward PATCH/DELETE only entitypaths atGateway; no weakeningexistingroutes. Localfixture roles for alice only as needed; no resetting accounts.
- [ ] TargetedGREEN/typecheck, scopedcommit/report output/reviews/enterprise-data-api.md.

### Task 3: Acceptance, handoff and review

Files: script smoke-enterprise-data.mjs, docs/enterprise-data.md, packagejson smokecommand, README/docsverification/mastercapability status.

- [ ] RealPG private schema tests typeddata/schema-pin/audit/commandraces/rollback/relations/archive/paging and freshpoolmax1. Clean only verifiedprivatefixture.
- [ ] LiveJWTGateway CRUD/versionpin/relations/scopeddenial; installlocalroles withoutchangingcredentials. Build/recreateAPI/Gatewayonly, preservevolumes.
- [ ] pnpmcheck and impacted create/workflow regressions with existingratelimit windows.
- [ ] Independentreview, fiximportantfindings, reruncoveringchecks.
- [ ] OnePRmain, attach, inspectCI, noautomerge. Reportactualfirstincrementcompletion separately from groups2–8 stillplanned.

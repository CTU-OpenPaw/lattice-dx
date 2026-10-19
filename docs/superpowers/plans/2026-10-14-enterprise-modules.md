# Enterprise module Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development; noNotion ticks.

Goal: atomic reusable packageofschemas/workflowconfiguration withmodulelaunchgovernance.
Architecture: modules transaction store uses existingstrictvalidators and currentclient helpers; separatehistoricalregistryget fromnewstarteligibility.
Tech Stack: TS/Fastify/pg/Vitest, no newdependencies.

## Global Constraints

Exact docs/superpowers/specs/2026-10-14-enterprise-modules.md; no arbitrarycode/URL/secrets/rolegrants. Samebranch/implementernopush/switch/merge, no UI/upstream/adapters/deps/volumes/Notion, preserveuserfiles. Pinpublications/readhistory unchanged, installall-or-noneclienttransaction, module disable notdatadelete.

### Task 1: module production

Files modules/{types,policy,database,routes}.ts +tests; workflowscreateWithClient eligibility helper; registry-database transaction draftinsert helper; app/database/index. Parent docs/scripts/package/gateway.

- [ ] RED strictschemas/manifest/version bounds, previewconflicts withoutsideeffects, roles/tenant/currentcapabilities.
- [ ] Transactionalinstallmanifests/schema+pub/drafts/mapping/receipt withsourcebuiltinsreserved, dependency/relationsconflicts validated beforewrites.
- [ ] Toggle enabled/revision andfreeze moduleworkflow publicationmapping, module/normalstart gating underclientsharelock, historicalregistryget unchanged.
- [ ] Catalog/detail/auditpaginatedmetadatacurrenttenant, no opaqueexecutablehandlerregistration.
- [ ] Targetedtests/typecheck/diff/scopedcommit report output/reviews/enterprise-modules-implementation.md.

### Task 2: acceptance

Parent scripts/smoke-enterprise-modules.mjs/docs/enterprise-modules.md/gateway/package.

- [ ] RealHTTP preview/install/publish/enable/start/disable/replay, role/tenant andnewstartdenials; privatePG receiptfailureallresource rollback, dependency errors, toggleraces withstarts,max1restart andhistoricalrunaccess.
- [ ] Fullcheck +bundle/event/query/workflowregressions; independentreviewfixandhandoff; noRelease/Notionticks.

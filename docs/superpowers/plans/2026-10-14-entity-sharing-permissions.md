# Entity sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans. Local checkboxes only, no Notion ticks.

**Goal:** Add revocable user/department read/edit grants consistently throughout enterprise entity APIs.

**Architecture:** Small access-policy module owns commonSQLpredicate/writechecks; existingentitytransaction/helper owns atomicgrants/audit/receipts. Directory remainssnapshot; owner-onlycontrol separatefromedit.

**Tech Stack:** Fastify/TypeScript/pg/Vitest/JWT, no new dependencies.

## Global Constraints

Exactsource docs/superpowers/specs/2026-10-14-entity-sharing-permissions.md. BackendDuyonly; preserveCV.pdf/a.png/output, workflows/oldrecords APIs; onebranchPRmain, noautomerge/release/Notionticks.

### Task 1: access policy, repository and signed routes

Files: entities/access.ts, access.test.ts, existingtypes/policy/database/routes/tests; localrealmfixturedata:share.

- [x] RED role/owner/granttypedpayload/currentaccess/historyredaction/no-op tests before implementation.
- [x] Schema grants/table+sharedpredicate SQL forread/edit, singleclientlockedpermissionchecks anddirectory FOR SHARE onsharedwrites. Reusecalleridentity, noarbitraryprincipalcreation.
- [x] Create/update/link/unlink/archive andcommandreplay permissionscorrect; ACLchangesowneronly. StoreauditownerId fromentity.ownerId (not editor) so audit remainsatentityscope.
- [x] GET/POST/DELETEshares withkey/versionstrictbodies, paginatedownerlisting, roledata:share only.
- [x] TargetedGREEN/typecheck/diffcheck, scopedcommit andreport output/reviews/entity-sharing-implementation.md.

### Task 2: private/live acceptance and handoff

Files: smoke-entity-sharing.mjs, docs/entity-sharing.md, packagejsoncommand, verification/backendcapabilities/enterprisedocupdates.

- [x] RealPG share/revoke/person/departmentmembership/no-op/races/auditrollback/replaydenial/max1freshpool/pagination105 andrelations/historyredaction, cleanonlyprivateUUIDschema.
- [x] LocalJWTGateway scenario owner Alice, designatedsameorgrecipient+peer/foreigndenials; realm grants onlyneededlocalfixtures, syncpreservecredentials. Build/recreateAPIandGatewayonly.
- [x] pnpmcheck+test:enterprise-data/create-reliability/workflow-completionregressions, existingGatewayratelimit retained.
- [x] Independenttask/wholebranchreview, fiximportantissues andreruncoveringchecks.
- [ ] Commit/pushonePRmain/attach/inspectCI; reportgroup2shareincrementlimits, don'tmarkallorganizationcapabilitiesdone.

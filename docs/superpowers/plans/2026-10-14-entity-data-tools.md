# Entity data tools Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development; localprogressonly.

Goal: safe documents/import/export/explicitmigration withcommontransactioncliententityprimitives.
Architecture: entityclient extraction preservesACL/typedvalidation/audit, datatoolsrepository ownsonecommandtransaction andboundedparsers. No packages/framework.
Tech Stack: TS/Fastify/pg/Vitest.

## Global Constraints

Exactspec docs/superpowers/specs/2026-10-14-entity-data-tools.md. NoUI/adapters/upstream/deps/volumes/Notion/credentials,userfilespreserved. Samebranchnopush/switch/mergebyimplementer. All newmutationskey/version andcurrentauthoritybeforereplay. Explicitpinforimports/migrations, no nestedpool/txns, noalternativepolicy.

### Task 1: helpers and attachment store

Files entities/client.ts ortransaction-commands.ts, database.ts helperreuse, datatools{types,policy,database,routes} modules/tests; app/database/indexwiring. Parentdocs/scripts/package/gateway.

- [ ] RED callerclient helper atomic/no nestedpool, attachmentrole/scan/context strictbodies/key.
- [ ] Extractclientprimitives andcommandhelper, existingentitysuitegreenwithoutbehaviorchange; pinnedcreateexportedforworkflow.
- [ ] Attachmentlink/unlink/historyversionreceipt usingsharedentityauthority/filelocks andcontextcontentdownloadcleanscan/currentread, no independentfilepermissionexpansion.
- [ ] Targeted/typecheck/scopedcommit/report;reviewbeforetask2.

### Task 2: bounded import/export and owner migration

Same datatoolsmodule, may split csv.ts/import-policy.ts/migration.ts tomaintain focusedfiles.

- [ ] RED JSON/CSVboundsquotes/types/formulas/digest/migrationrelations andcurrentowner.
- [ ] Parse+dryrun no writes, commitoneclientbatch withsharedpinnedcreate+audit/receipt. Queryexportviaexistingquerypolicy/currentSQLACL.
- [ ] Migrationdryrun/commitexplicitnewattributes/targetpin/version/digest+relationscompatibility underentitylock, audit/receiptatomic.
- [ ] Targeted/APItypecheck/scopedcommit report output/reviews/entity-data-tools-implementation.md.

### Task 3: acceptance

Parent scripts/smoke-entity-data-tools.mjs/docs/entity-data-tools.md/package/gateway.

- [ ] SignedHTTPuploadscan/link/contextread/recipientrevocation; CSVimportdryrun/commit/exportandmigrationnewpin; forbiddenactor/tenant/body.
- [ ] PrivatePGconstraintsinjectmidbatchaudit/receiptrollback, concurrentimportonebatch, migrationupdateonewinner/incompatiblerelation, max1newexec/replay, scan/revokelocks; independentreviewfix/fullregressions.

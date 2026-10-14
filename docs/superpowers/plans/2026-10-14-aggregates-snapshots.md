# Aggregates and Report Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Aggregatecheckpoint before snapshots; parent real SQL acceptance andreview.

**Goal:** Accurate reusable enterprise reporting with current data visibility and frozen results.

**Architecture:** Shared typed field/filter compiler plus parameterized numeric SQL. Snapshots capture sources/result once under READ COMMITTED and hold sortedsource/currentACL locks through persistence.

**Tech Stack:** Existing TypeScript/Fastify/pg/Vitest; no dependencies.

## Global Constraints

Exact aggregates-snapshots spec and parentcompositionconstraints. No rawSQL/public joins/JSfloat money/receiptprivatevalues. No repeatableread change insharedcommandhelper. Onebranch/sourceonlycommits/noimplementerpushmerge/deps/UI/upstream/adapters/Notion/userfiles/volumes. Parent scripts/docs/package/gateway.

### Task7: scoped aggregate compiler/repository/routes

Files entities aggregate-{types,policy,database,routes}.ts andtests, sharedquerycompilerifneeded, app/database/index wiring.

Interface `aggregateEntitiesWithClient(client,scope,query):Promise<AggregateResult>`; repository `aggregate(scope,query)` owntransaction when public. Scalar SQLexpressions guardedCASE, values parameterized, inputpolicy validatesownpublication.

- [ ] RED metric/group/body/type/precision/unsafealias andemptydataset policy cases.
- [ ] Implement parameterized SQL ACL/filter-beforeaggregate withgroup201bound andnumerictextoutputs; compileallsource notpaginated100.
- [ ] Wire POSTentities/aggregate data:read, sanitizedtimeout, no write/keyneeded forpureaggregate.
- [ ] Targetedtypecheck/queryregressions; parentprivatePG exactlarge/mixedschema/empty/missing/201groups/readscope/max1; review/commit.

### Task8: frozen snapshots and dependency guards

Files entities reports-{types,policy,database,routes}.ts/tests withnarrow aggregate capturehelper. Define `captureAggregateWithSources(client,scope,query,maxSources=5000)` returningprivateids/result/asOf fromoneCTEstatement; `authorizeSnapshotSources(client,scope,ids)` bulksortedlocks/currentACL/activeguard.

- [ ] RED snapshotcapturebound/currentdependency includingmissingnumeric source/revoke/archivedowner/replay/privatevaluesdenial.
- [ ] Implement owner-scope immutable resource/dependency/audit andID-onlycommandreceipt. Same-client create/get/replay, no nestedpoolacquire.
- [ ] Wire POST/GETlist/GETid report-snapshot routes, listonlymetadata. Strictquery/title/key/bodyvalidation.
- [ ] Targetedtests/typecheck; parentPG capture-beforelock barrierchanges/revokes, frozenupdate/max1/fivekeyrace/receiptrollback/5001zeroeffect, signedAPInegative tests, independentreview/fix/commit.

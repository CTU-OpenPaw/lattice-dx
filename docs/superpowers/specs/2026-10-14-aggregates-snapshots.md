# Exact scoped aggregates and revocable frozen report snapshots

Tasks7–8 of approvedcomposition. No arbitrary SQL/joins or historical ACL bypass.

## Aggregate contract

`POST /v1/entities/aggregate`, data:read, exact:

```ts
type AggregateQuery={
 schemaId:string; schemaVersion:number;
 filters?:EntityQuery['filters']; groupBy?:string[];
 metrics:({name:string;operation:'count'}|{name:string;operation:'sum'|'min'|'max'|'avg';field:string})[];
};
type AggregateResult={
 schemaId:string;schemaVersion:number;groupBy:string[];
 groups:{keys:(string|boolean|null)[];metrics:Record<string,string|null>}[];
};
```

Metrics1..10 unique safe names, groupBy0..2 distinct publicationfields, filters<=10 matchingtypedqueryrules. Count is source-row count only. Numericmetrics restricted integer/decimalfields. Reject limit/offset/sort/rawSQL/expressions/unknownkeys. Groupsquerylimit201, over200returns409 ratherthantruncation. Source rows are not capped at100 or5000 for ordinaryaggregates. Scopedtransaction sets statementtimeout3s and boundedlocktimeout.

SQL currenttenant/readACL/activeentity/schemaID/pin/filter predicates apply **before aggregation**. Guardnumericcast inside CASE just like querycompiler, includingtype/decimalpattern bounds, regardless plannerorder. Return all numeric/count metrics asstrings; sum/min/max exact, avg `round(avg(value),18)::text`, PostgreSQL numeric ties awayfromzero. Numeric groupkeys strings, boolean keys bool, text/date/enum keysstrings, missingfieldnull. No JSONnumeric intermediate causing JSprecisionloss. Ungroupedempty datasetreturnsonegroup keys[]/count'0'/numericnull; groupedemptyreturnsnogroups. Missing numeric attributes excludedfromnumericmetrics but **remain source rows/dependencies/count**.

Extract sharedtyped filter/fieldexpression helpers ifneeded without changingexistingquerybehavior. `aggregateEntitiesWithClient(client,scope,query):Promise<AggregateResult>` uses suppliedclient/publication and parameterizedkeys, no nestedpoolrepoqueries.

## Snapshot contract

`POST /v1/entity-report-snapshots` data:read/keyrequired `{title,query:AggregateQuery}`. Immutable resource returnedversion1. `GET /v1/entity-report-snapshots` owner/tenant paginated **metadata only** `{id,title,version,createdAt}`. `GET /:id` owner/tenant/data:read plus current access to everydependencysource returns `{id,title,version,createdAt,query,result,asOf}`. Metadata list mayremainvisible afterrevocation; no counts/results/dependencyIDs exposed. No update/deleteendpoint.

Creation stores result and private complete source IDs, max5000 sources. Receipt stores only `{snapshotId}`, notprivateaggregatevalues; afterlookup reloadthroughcurrentauthorized snapshotgetter using sameclient. Owner/private metadataaudit andreceiptcommitatomically. Replay validatescurrentallsourceaccess beforefingerprint conflict orresultreturn. No extra authority fromsnapshotownership.

Capture consistency: **READ COMMITTED**, existingcommandadvisory lock thenreceiptlookup. One materializedeligible-source CTE returns both aggregateoutput and sourceIDs/asOf fromsame statement; boundedsourceCTE limit5001 onlysnapshotmode. Overflow rejectswithoutstoredpartialreport. Do notchange shared commandtransaction to repeatableread: lock SELECT couldestablishstalesnapshotbeforewaiting onconcurrentsamekeyreceipt.

Aftercapture, bulk lock all capturedentities sortedUUID using only ID/owner/org/archive metadata, thencurrent actor directoryFORSHARE ifanysharedsource, thenbulk currentACL/active check onallIDs. No5000per-row roundtripscanning. Result is frozen **as of capture statement**, notvaluesatcommit; edits between captureandlocking do notrewritecapture. Authorizationmustremaincurrentandheld throughcommit. Missing/foreign/archived/unreadable dependency denies404. Snapshotpolicy strictlydeniesanyarchivedsource evenowner-readable entity; explicitreportpolicy notentityACLchange.

GET/replay uses samesortedsource-lock/bulkcurrentcheckbeforeexposingfrozenresult. Sourcevalues/schema can laterchange andsnapshotresultremainsfrozen, aslongas everydependencyremainsreadable/unarchived. Newsourcegrant doesnot rewritepastreport. Revoke/departmentmove/disable sharedrecipient deniesreport. SnapshotsourceIDs notreturned or used tograntaccess. All source rows captured, including rowswithoutmetricfield.

Tables enterprise_report_snapshots(owner/org/query/result/asOf/version/time), enterprise_report_snapshot_sources(snapshotFK/entityFKunique,indexsnapshot), metadataaudit. Reuse enterprisecommandreceipt operation `entity.report.snapshot`. Query/group/source bounds/transactiontimeouts explicit; no scheduling/retention deletion or lakehouse claim.

## Acceptance

ExactsumaboveJSsafeinteger, signedroundedavg, empty/missingnumericfields, mixedschemainvalidnumericadversary, 201groups409, ordinaryaggregate>100/>5000 nottruncated, snapshot5001rejectzeroeffects. Frozenresultafterupdates/migration, archivedownersource/revoke/departmentmove denial, metadata lists noresults, replay currentaccess andsamekey five-wayrace. Capture/lock races checked at privatePGbarrier, forcedreceiptrollbackclears snapshot/dependencies/audit, singlepoolmax1 newexecution/replay/get. Bound statementtimeout/locktimeout errorssanitized. Independentreview/source+realacceptance.

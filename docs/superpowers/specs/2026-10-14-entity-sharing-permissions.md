# Entity sharing and revocation

Duy approved implementing read/edit sharing to people and departments across all entity read/mutation/relation/history/replay paths. Only engine backend; no NocoBase UI/adapter edits. PR12 stable prerequisite merged first, one new branch/PRmain.

## Sharing contract

POST `/v1/entities/:id/shares`, body `{expectedVersion,principal:{kind:"person"|"department",id},permission:"read"|"edit"}`, owner-only plus signed role `data:share`; key required. PUT semantics through POST: upsert one grant for principal, replace permission; current entityVersion guard, active source, validate person active sameorg or department has active sameorg members in directory. Existing exact grant with fresh key/current version is no-op; other grant/upgrades increment entityVersion + audit + receipt atomic.

DELETE `/v1/entities/:id/shares/:kind/:principalId`, body `{expectedVersion}`, same ownerrole/key. Revoke absentgrant no-op; deletion incrementsversion/audit/receipt. Do NOT require targetstillactive forrevoke (disabledrecipient mustremainremovable). GET shares paginated owner-only `data:share` and owner, no broad peer directory leak. Return `{items,page}` stored grants including permission, principal and created/updated timestamps. Successful mutation returns Entity with updatedversion, not rawreceipt.

EntityRepository optionalshare methods allowoldtestfixtureswithoutnewfeature returning503ratherthanunsafe behavior; productionmustimplement. No rolegrant imported frombody. Stored grant cannotgrant data:* capabilities; caller stillneeds signed route role. Sharingvalidwithinorg only; Keycloakidentitydirectorysnapshot remainsadministrativesync. Departmentmembership checkedat access time fromactive directory_people, no copying memberlist intogrant. Owneraccess unaffected by ACL and preserved; owner cannotchange via APIs.

## Access modes

`read`: owner OR explicitpersonread/edit grant OR activecurrentdepartmentread/edit grant, sameorg. Sharedactor mustexist active in directory snapshot. `edit`: owner OR explicit/currentdepartment edit, sameactivechecks. `owner`: exactsignedowner+org, requiredforarchive/grant/revoke/listshares; edit permission cannotarchive/share/delegate. Entitycreate remains signeddata:write ownentity. Create receipt replay usesreadpermission currententity, mutation replay rechecksrequired permission before exposinghistoricresult.

detail/list/relations/history use read. Update and source relationmutations use edit; targetneeds read only, not ownership/edit. StableUUIDlocks onboth entities beforeaccess decisions; targetactive fornewlink, unlinkmayarchive target. Grant neverpropagates alongrelationship. Relationlistingtargetreadpermission SQLbefore LIMIT/OFFSET; no targetattributes implied unlessrequestindividuallyauthorized.

Forhistory: owner retainsfullaudit snapshots; sharedreaders get metadataonly{id,entityId,actorId,operation,fromVersion,toVersion,occurredAt}, no input/result. This avoids old relationtargets or grant principalIDs leaking through historicinputs, and defines no historicaldataaccess extension. Currentaccesscheckedbeforepagedqueries andSQLscopematches. No broad organization manager bypass or fieldACL inthisincrement.

## Consistency and revocation

Grant/revoke locksourceentity beforechange andcommit. Sharedwrite lockentity first then currentgrant/membership check in sameclient. Directoryrow FOR SHARE neededwhenwriteauthorizedviaactive membership; ensures administrative update can'tdisable/movedepartment duringacceptedwrite. SQL list/query usecommonaccesspredicate withparameters, noJavascriptpost-filterafterpagination. Concurrentupdate/revoke serializeonentity; writeacceptedbefore revokecommit maycomplete, subsequentwrite/replaydenied404. Signedmissingrole403, resourcesnotreadable404, readablebutnotedit/owner404 (hidecapability details), malformed400, stale/keyconflict409, missingservice503. Body tenant/actor overridesblocked. Archivedsource grantscannotmutate but ownercanlist; exactacceptedkeyreplay obeyscurrentaccessandhistoricalsnapshotpolicy.

Revoke remits current ACL. Previously returned/downloaded copies cannotbe revoked; oldtokenmembership revocation dependsdirectorysync, signedroute role revocation dependsJWTexpiry/issuerpolicy. No automatic TTL/cleanup.

## Acceptance

Directread vsedit, sameorgpeerunsharedhidden, foreigntenantdenied, activepersonchecks, departmentcurrentmembership anddisable, editcannotarchive/delegate, targetreadnottransitive, metadatahistoryredaction, currentpermissionbeforecommandreplay, grant/revoke/no-op/version/auditatomic, simultaneoussameversioncommands, sharedwritevsrevoke anddirectorylock semantics, paging>100sharedrowsfilteredbeforelimit, relationtargetsfilteredbeforepaging, persistencefreshmax1pool. GatewayHTTPsignedsmoke and oldenterprise/workflow/create regressions +check. ReviewbeforeonePRmain; noautomerge/newdependencies/Notionticks/upstreamchanges. Original oldrecord/taskshare rules untouched.

# Workflow timers Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development; localprogressonly.

Goal: execute due declared service transitions atomically under currentlimiteddirectoryauthority.
Architecture: timerstore+worker wraps sameclient transitionhelper; deploymanagedserviceprofiles distinctfromworkflowauthoring.
Tech Stack: TS/Fastify/pg/Vitest, no dependencies.

## Global Constraints

Exactspec docs/superpowers/specs/2026-10-14-workflow-timers.md. No impersonation/savedJWT/usercontrolledURL/secret profiles; actorfromcurrentdirectorydesignatedprofile. Runfirstlocks,current ACL/caps,key/versions; no nestedpooltransactions. Samebranch/no implementerpush/switch/merge; no upstream/UI/Nhi/deps/Notion/volumes/credentials modifications; preserveuserfiles.

### Task 1: timer production

Files workflows/{timer-database,timer-worker,timer-policy}.ts+tests, registry/blockpolicy/blockdatabase/database/lifecycle/schema/routes/types; packages/contracts/workflows; database/indexwiring. Parent docs/scripts/gateway/profilefixture/package.

- [ ] RED definitiontimer/service shape+authorization bounds, serviceinteractive denial, pendingtimerguards, currentactorresolver.
- [ ] Extract transitionWithClient preservingoldreceipt/currentauth and add internalcontext only persistedtimer; timer block insertion/auditresults sameclient.
- [ ] Tick candidates/runlock/timerlock/currentprofile+directory/dueguards, savepoint failureclassification withoutpartialstepwrites, atomic success+timerreceipt andboundedretry.
- [ ] Worker enabled explicitly/singleflight/drain, timerread/retrysignedroutes andcancelintegration, currentread/canonicalkey replay.
- [ ] Targeted +typecheck +diffcheck sourcecommit/report output/reviews/workflow-timers-implementation.md; sendAPI/repositorysignaturesearly.

### Task 2: acceptance

Parent scripts/smoke-workflow-timers.mjs/docs/workflow-timers.md/profilefixture/gateway/package.

- [ ] PrivatePG currentserviceauthority revocation, concurrentdueoneeffect, receiptrollback no record/task/jobs, max1newtick/restart, cancelrace andretryclassification; HTTPprofilelisting/timerread/publicservice403 andworkflowcaproles.
- [ ] Fullchecks andworkflow/event/module regressions; independentreview/fix/evidence; masterphase3 remainspartialuntiltypedentityblocks executedinsideworkflow.

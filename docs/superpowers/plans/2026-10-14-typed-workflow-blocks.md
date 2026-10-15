# Typed workflow blocks Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development, localprogressonly.

Goal: make typeddata capabilities execute atomically insideworkflowunderactualactorpolicy.
Architecture: typedbindings andentityclienthelpers, sameworkflowtransaction andreceipt, bounded metadataresults.
Tech Stack: TS/Fastify/pg/Vitest/no dependencies.

## Global Constraints

Exactspec docs/superpowers/specs/2026-10-14-typed-workflow-blocks.md. Samebranch/noimplementerpushswitchmerge; noUI/upstream/adapters/deps/Notion/volumes/credentials,userfilespreserved. No nestedpooltxns/clienthandlercalls, actualactorcaps/currentACL, entitylockorder sortedUUID afterrun, pinpublication, queryresultsnoprivateattributes.

### Task 1: contracts and executor

Files packages/contracts/workflows; workflows/block-policy/block-database/registry/bundles/routes tests; entityclienthelper additionsifneeded. Parentdocs/scripts/package.

- [ ] RED strict typedbindingconversion, rolecaps/entityauthority, pinnedcreate andblockedmetadataresult exposure.
- [ ] Extenddefinition/bindingvalidators andportablebundlepreview/blockslistingwithcomplete descriptors; nolooseningexistingstringbindings.
- [ ] Resolve/prelockids/executesevenentitycommands oncallerclient, boundedactionmetadataresults; workflowretryreplayswithoutsecondentitymutation, failureatomic.
- [ ] Targeted/typecheck/diff/scopedcommit output/reviews/typed-workflow-blocks-implementation.md.

### Task 2: real acceptance

Parent scripts/smoke-typed-workflow-blocks.mjs/docs/typed-workflow-blocks.md.

- [ ] Signeddraftpublishtransitiontypedvaluechecks/caproles/privateentitygrant/revoke; privatePG forcedlatereceiptfailure rollsbackentity/run/audit/actionresult, max1concurrentcommandsoneeffect, schema pin1afterv2published.
- [ ] Existingworkflowtimer/events/module/bundleregressions andindependentreviewfix/evidence; masterphase3completesonlyallverifiedprimitives.

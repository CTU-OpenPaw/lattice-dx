# Inbound events Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development; no Notion ticks.

Goal: durable authenticated external event-to-start dispatch with pinned subscriptions and provenance.
Architecture: events module receives currentJWTactor and shares workflow transaction-client create helper; one commit for all derived effects.
Tech Stack: TS/Fastify/pg/Vitest, no newdependencies.

## Global Constraints

Exact docs/superpowers/specs/2026-10-14-inbound-events.md; calleridentity onlyverifiedJWT, current directory, no saved owner caps. Samebranch/no switch/push/merge byimplementer; no UI/upstream/adapters/deps/credentials/volume/Notion modifications. Preserve CV.pdf/a.png/output. Metadata-only receipts, no nestedpooltransactions, subscriptions pinpublishedversion.

### Task 1: production ingress

Files new events/{types,policy,database,routes}.ts +tests; workflows/database.ts extractcreateWithClient/types; contracts internal pinnedCreate optional; app/database/index wiring. Parent gateway/realm/scripts/package/docs.

- [ ] RED parsers+signed roles+deterministickey/canonical event; sourceactive/tenant boundaries; no implicit creator authority.
- [ ] Extract currentworkflow creation callback into sameclienthelper, keep old RESTcreate tests passing. registry.get withclient everywhere insidetransaction; explicitversion stored inrun.
- [ ] Add additive subscriptions/events/provenance/receipts/audit tables and transactionalcrud expectedRevision/key, references/source validation currentclient.
- [ ] Receive dedupe/dispatch atomic allsubscribers with sharedsubscriptionlocks/currentdirectory; no HTTP/remotehooks insideDBtxn.
- [ ] Targeted tests/APItypecheck/diffcheck scopedcommit, report output/reviews/inbound-events-implementation.md.

### Task 2: acceptance/handoff

Parent scripts/smoke-inbound-events.mjs/docs/inbound-events.md/package/gateway/selectedlocalroles.

- [ ] RealJWT subscriptions/current source +event replays; privatePG two concurrentreceivesoneID, mismatch409, two subscriber rollback, pin/schema inputrefs andcurrentdirectory; provenance failure consumesnone, max1restart.
- [ ] Fullcheck/workflowcreate/completion/lifecycle regression; independentreview/fix/reverification; integrationinstructionsforNhi without implementing heradapter.

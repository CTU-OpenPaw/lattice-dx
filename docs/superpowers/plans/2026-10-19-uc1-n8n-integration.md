# UC1 Integration Implementation and Acceptance Plan

Opened: 19 October 2026.
Last updated: 22 October 2026.
Owner: Thạch Thanh Nhi — Integration, Data & AI.

## Goal and scope

Implement UC1 intake, handover synchronization, Asset mapping,
broker delivery and source traceability. Preserve meaningful commits
and record verification evidence before integration into the team branch.

Current scope: local implementation and acceptance using synthetic
handover events.

Real backend procurement handover delivery through the workflow outbox
remains pending.

## Implemented architecture

### Intake

Authenticated source → n8n validation → Gateway → existing UC1 API.

The workflow calls POST /v1/workflows directly.
There is no separate intake integration service in this implementation.

Procurement v1 accepts a title and an optional empty input object.
The API creates a draft; it does not submit or approve the procurement.

### Handover

Authenticated source → n8n validation → sample server → PostgreSQL.

When broker mapping is enabled, the sample server stores the accepted
handover, delivery attempt and broker job in the same transaction.

A separate worker reads the frozen projection, verifies relationship
targets, creates or updates the Asset, checks the broker result and
records processing history.

A successful webhook response confirms durable acceptance into the
sample system. Broker synchronization may still be pending.

### Data ownership

- Backend services own business transactions and authorization.
- The sample system retains the original handover payload.
- The broker holds the Asset context projection.
- The integration tables retain mapping snapshots and delivery history.

## Technology

Node.js 24, pnpm 10.23.0, n8n, Fastify, PostgreSQL, Orion-LD,
Docker Compose and Vitest.

## Implementation guides

- [UC1 intake](../../uc1-intake-workflow.md)
- [Handover synchronization](../../uc1-handover-workflow.md)
- [Asset mapping](../../uc1-asset-mapping.md)
- [Broker jobs and trace](../../uc1-broker-jobs.md)
- [Broker recovery](../../broker-recovery.md)

## Progress recording rules

- [X]  Record completed work using code, appropriate checks and live evidence.
- [X]  Distinguish unit tests from live Docker acceptance.
- [X]  Distinguish synthetic source events from real backend outbox delivery.
- [X]  Commit meaningful changes after verification.
- [X]  Preserve actual authorship and commit history.
- [X]  Keep credentials, database archives and local configuration out of Git.
- [ ]  Complete the remaining end-to-end acceptance before final integration.

Do not mark an untested scenario as passed because a related unit test
or another machine's recovery succeeded.

## 1. Repository and environment checkpoint

- [X]  Confirm repository and feature branch.
- [X]  Resolve the earlier merge operation before UC1 implementation.
- [X]  Create feat/uc1-n8n-handover from baseline b13109c.
- [X]  Identify integration/v0.1.0 as the intended integration branch.
- [X]  Preserve PostgreSQL and MongoDB backups.
- [X]  Verify Docker-based Node 24 checks.
- [X]  Verify the local sample service readiness endpoint.
- [X]  Recover Orion-LD without deleting or modifying the original Mongo volume.
- [X]  Verify broker startup, subscription smoke and restart after recovery.
- [ ]  Confirm the origin URL has been updated locally to the moved repository.

Repository:
https://github.com/CTU-OpenPaw/lattice-dx

Feature branch:
feat/uc1-n8n-handover

Integration branch:
integration/v0.1.0

The feature has not yet been merged into the integration branch or main.

## 2. Task acceptance checklist

### Task 1 — Authenticated n8n intake and UC1 API invocation

Status: completed for the direct API intake scope.

- [X]  Review the procurement v1 creation contract.
- [X]  Accept a nonblank title and an optional empty input object.
- [X]  Reject unsupported fields instead of silently dropping them.
- [X]  Configure separate webhook and API Header Auth credentials.
- [X]  Call POST /v1/workflows through the Gateway.
- [X]  Verify HTTP 201 and a procurement draft response.
- [X]  Verify HTTP 400 for invalid payloads.
- [X]  Verify HTTP 403 for missing or incorrect webhook credentials.
- [X]  Normalize text responses into explicit HTTP status and JSON body.
- [X]  Export an inactive workflow without local credential IDs or pinned data.
- [X]  Pass 29 intake workflow tests.
- [X]  Commit and push the implementation.
- [ ]  Separately confirm published production webhook operation, if required.

Files:

- infra/config/n8n/uc1-intake.json
- tests/uc1-intake-workflow.test.ts
- docs/uc1-intake-workflow.md

Live workflow ID:
f621b8fd-ddad-4b5f-882e-2b68d10cc82c

### Task 2 — Intake idempotency

Status: completed within backend actor-scoped idempotency.

- [X]  Forward Idempotency-Key unchanged to the backend.
- [X]  Repeat the same payload and key; receive the same workflow ID.
- [X]  Change the payload under the same key; receive HTTP 409.
- [X]  Document that idempotency is delegated to the authenticated backend actor.
- [X]  Document that a different key does not provide source-record deduplication.
- [X]  Commit and push the verified intake behavior.

Not implemented or not independently verified:

- [ ]  Source-system/source-record deduplication across different keys.
- [ ]  A controlled live test losing the response after backend commit.
- [ ]  Permission-change testing against previously stored idempotency receipts.

These items must not be represented as completed intake guarantees.

### Task 3 — Handover synchronization to the sample system

Status: implemented and verified with synthetic events;
real backend outbox delivery remains pending.

- [X]  Create an authenticated handover webhook.
- [X]  Validate the procurement asset.handed_over event envelope.
- [X]  Require Idempotency-Key to equal eventId.
- [X]  Persist the accepted source event before returning HTTP 201.
- [X]  Return HTTP 200 duplicate for an identical event replay.
- [X]  Return HTTP 409 for the same event ID with a different payload.
- [X]  Confirm that a conflicting payload does not overwrite stored data.
- [X]  Persist accepted and duplicate delivery attempts.
- [X]  Verify sample data survives service restart.
- [X]  Verify replay after restart does not create another handover record.
- [X]  Export the canonical handover workflow.
- [X]  Pass 37 handover workflow tests.
- [X]  Document manual resend using the original event ID and payload.
- [X]  Commit and push the implementation.
- [ ]  Record live HTTP 502 evidence while the sample service is unavailable.
- [ ]  Agree routing for the shared backend outbox destination.
- [ ]  Verify a real backend procurement handover reaches this workflow.

The sample delivery and broker delivery have separate histories.
The broker worker's five-attempt retry budget does not describe
delivery from n8n to the sample system.

Files:

- infra/config/n8n/uc1-handover.json
- apps/api/src/uc1-sample/server.ts
- infra/config/uc1/sample-system.sql
- infra/compose/uc1-sample.yml
- tests/uc1-handover-workflow.test.ts

Sample fixture event:
uc1-demo-a97fe9d1-bd31-4340-9814-a4dc18bd206a

### Task 4 — Handover-to-Asset mapping

Status: completed for explicit local fixture mappings;
backend identity agreement remains pending.

- [X]  Resolve source IDs through explicit mapping configuration.
- [X]  Scope mappings by organization, source system and entity type.
- [X]  Preserve the same Asset URN across handovers and retries.
- [X]  Reject missing or ambiguous mappings.
- [X]  Validate the mapped URN type and tenant.
- [X]  Resolve Department and Location relationships explicitly.
- [X]  Verify Department and Location identities on the live broker.
- [X]  Preserve source occurredAt as the projected observedAt.
- [X]  Exclude transactional payloads, recipient IDs and attachment IDs
  from the Asset projection.
- [X]  Keep the mapping version and projection frozen in each broker job.
- [X]  Pass 18 mapping tests.
- [X]  Commit the mapping implementation.
- [ ]  Confirm real assetId, departmentId and locationId semantics with Duy.
- [ ]  Confirm the local asset.handed_over → in_use policy with the backend owner.

Files:

- apps/api/src/uc1-integration/asset-mapping.ts
- infra/config/uc1/asset-mapping.example.json
- tests/uc1-asset-mapping.test.ts
- docs/uc1-asset-mapping.md

The source ID is not automatically interpreted as a business ID or URN.
Existing Assets retain their display name during handover updates.

### Task 5 — Durable broker jobs, upsert and retry

Status: implemented and locally verified with synthetic source events.

- [X]  Create the broker job schema.
- [X]  Enqueue the frozen projection in the handover transaction.
- [X]  Keep job state unchanged when the accepted event is replayed.
- [X]  Reuse the existing Asset connector.
- [X]  Normalize the broker's expanded namespace terms.
- [X]  Verify relationship targets before writing.
- [X]  Read the Asset before deciding whether to create or update.
- [X]  Require broker read-back after a write.
- [X]  Scope job selection by organization.
- [X]  Serialize cooperating UC1 workers using a shared advisory lock.
- [X]  Implement leases and bounded retry with exponential backoff.
- [X]  Verify live Asset creation.
- [X]  Verify exact replay leaves job attempts unchanged.
- [X]  Verify broker outage records retry and retains the pending job.
- [X]  Verify recovery succeeds on attempt 2 using the same Asset URN.
- [X]  Verify newer source time updates the existing Asset.
- [X]  Verify an older event produces a stale job result.
- [X]  Unit-test equal-time conflict and lost-create-response retry.
- [X]  Pass 11 broker synchronization tests and 5 response normalization tests.
- [X]  Commit and push the implementation.

Remaining acceptance:

- [ ]  Independently read back the Asset after the live stale-event test.
- [ ]  Verify a live equal-time conflicting projection.
- [ ]  Verify lease recovery after abrupt worker termination.
- [ ]  Verify concurrent worker behavior under failure conditions.
- [ ]  Verify delivery from the real backend outbox.
- [ ]  Implement an administrative requeue mechanism if required.

The current implementation serializes all UC1 broker jobs.
It does not claim exactly-once delivery or coordinate unrelated broker writers.

### Task 6 — Source data, timestamps and reconciliation trace

Status: implemented and locally verified for accepted handover events.

- [X]  Store the original handover payload.
- [X]  Retain eventId, runId, recordId, definitionId and workflow version.
- [X]  Retain sourceSystem and mappingVersion on the job.
- [X]  Retain the frozen Asset projection and broker URN.
- [X]  Distinguish source time, receipt time and completion time.
- [X]  Retain the original timestamp text in the source payload and job.
- [X]  Record attempt number, outcome and sanitized error code.
- [X]  Retain failed attempts after a subsequent successful retry.
- [X]  Provide the asset_trace SQL view for reconciliation.
- [X]  Verify create and retry traces against live broker read-back.
- [X]  Document deployment, processing and investigation procedures.
- [X]  Commit and push the implementation.

Remaining scope:

- [ ]  Verify trace continuity from a real backend handover.
- [ ]  Add an authenticated trace API/UI if required.
- [ ]  Verify permissions for any future operator and retry endpoints.

Trace currently uses database queries. No public operator/retry API
or corresponding authorization test is implemented.

Intake sourceSystem/sourceRecordId receipts are not part of the direct
intake workflow and must not be claimed as implemented.

## 3. Verification evidence

### Automated checks

Latest combined local run:


| Test file                     | Passed |
| ------------------------------- | -------: |
| uc1-intake-workflow.test.ts   |     29 |
| uc1-handover-workflow.test.ts |     37 |
| uc1-asset-mapping.test.ts     |     18 |
| uc1-broker-sync.test.ts       |     11 |
| uc1-broker-response.test.ts   |      5 |
| ngsi-context-config.test.ts   |      2 |
| Total                         |    102 |

- [X]  Six test files passed, exit code 0.
- [X]  API TypeScript check passed, exit code 0.
- [X]  Compose configuration validation passed.
- [X]  Staged whitespace check passed before the broker jobs commit.
- [ ]  Full repository check/build on the final feature tip.
- [ ]  Required infrastructure checks from repository contribution guidance.

Unit tests cover behavior beyond the live cases below.
They do not establish live concurrency, lease recovery or backend
outbox acceptance.

### Live broker acceptance — 22 October 2026

Tenant: org-a.

Asset:
urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001

Department:
urn:ngsi-ld:Department:org-a:it

Location:
urn:ngsi-ld:Location:org-a:office-1


| Case               | Evidence                                                    |
| -------------------- | ------------------------------------------------------------- |
| Initial create     | Worker attempt 1 succeeded, result created                  |
| Source replay      | HTTP 200 duplicate; attempts and attempt records remained 1 |
| Initial read-back  | Status, relations, event ID and source time matched         |
| Broker outage      | Attempt 1 retry, BROKER_DELIVERY_FAILED                     |
| Broker recovery    | Attempt 2 succeeded, result updated                         |
| Recovery read-back | Same URN; newer event and original source time matched      |
| Older event        | Worker and trace recorded stale; attempt 1                  |

Event identifiers:

- Create:
  uc1-broker-bf9be745-e7c1-46f0-9168-c7eacfa1b8d5
- Retry/update:
  uc1-retry-6d20421d-d9bd-413d-b2f6-390936d8bc64
- Stale:
  uc1-stale-d258fa50-f062-442a-acb2-e268ced3df1b

Initial source time: 2026-10-22T15:39:51Z.

Updated source time: 2026-10-22T15:56:35Z.

The retry completed at 2026-10-22T16:02:08Z while retaining the updated
source time above.

All timestamps in this section are UTC.
Live fixtures use whole-second observations; millisecond fidelity
through the broker has not been established.

### Broker recovery

- [X]  Identify five persisted contexts with null URLs.
- [X]  Create and preserve a fresh MongoDB backup.
- [X]  Restore 24 Orion documents into a separate recovery volume.
- [X]  Compare source and restored documents.
- [X]  Repair exactly five context URLs on the copy.
- [X]  Verify all other document content remained unchanged.
- [X]  Verify broker startup and restart against the repaired copy.
- [X]  Switch the local Mongo service to the verified recovery volume.
- [X]  Verify subscription smoke and restart with the updated helper.

The original Mongo volume and backup were retained.
The recovery volume selector is local configuration and is not committed.

## 4. Recorded commits


| Commit  | Change                                                       |
| --------- | -------------------------------------------------------------- |
| 2104710 | Authenticated n8n intake with backend idempotency            |
| b27c1ad | Handover sample synchronization and delivery logging         |
| 07085f7 | Stable handover-to-Asset mappings                            |
| d9bfec3 | Cherry-picked broker context prevention and recovery support |
| e19aba2 | Durable Asset synchronization jobs, retry and trace          |

The broker fix preserves Duy's original authorship and references
upstream team commit b70bacc.

Do not create artificial commits, rewrite authors or change commit dates
to increase competition activity.

## 5. Remaining end-to-end acceptance

- [ ]  Agree shared outbox event routing with Duy.
- [ ]  Configure a published n8n destination and matching source credential.
- [ ]  Confirm the intended backend runtime workers and permissions.
- [ ]  Complete a real procurement workflow through handover.
- [ ]  Verify backend outbox → n8n → sample → broker.
- [ ]  Reconcile the real run, event, handover and Asset trace.
- [ ]  Update evidence and limitations after acceptance.
- [ ]  Confirm the original six-task acceptance with the team.

Do not route unrelated events into the handover-only receiver without
an explicit routing policy.

## 6. Integration branch and main merge

Intended sequence:

feat/uc1-n8n-handover → integration/v0.1.0 → main.

- [X]  Push the current implemented feature changes.
- [ ]  Commit this updated progress document.
- [ ]  Review outstanding acceptance and document agreed scope.
- [ ]  Preserve or move untracked raw n8n exports before switching branches.
- [ ]  Fetch current remote branches.
- [ ]  Integrate current team changes and resolve conflicts.
- [ ]  Open the feature-to-integration PR.
- [ ]  Preserve meaningful commits and original authorship.
- [ ]  Run required checks on the actual integration merge result.
- [ ]  Open the integration-to-main PR.
- [ ]  Complete required team review and checks.
- [ ]  Verify the merged main checkout and run post-merge smoke.

Do not treat an integration branch as a published Git release.
Create a version tag only after the team approves the release.

When merge commits preserve the feature SHA:

```powershell
$featureTip = "<actual-feature-tip>"
git merge-base --is-ancestor $featureTip main
$LASTEXITCODE
git log --graph --oneline --decorate -25
```

Exit code 0 confirms ancestry. For squash or rebase merges, verify the PR
and corresponding changes rather than relying on the original feature SHA.

## 7. Branch cleanup

- [ ]  Confirm main contains the required code and evidence.
- [ ]  Verify no unique work remains only on an old feature branch.
- [ ]  Confirm each branch belongs to Nhi and is not used by a teammate.
- [ ]  Preserve shared integration and backup branches as agreed.
- [ ]  Delete local merged branches using git branch -d.
- [ ]  Investigate a refused deletion instead of automatically using -D.
- [ ]  Delete selected remote feature branches only after team agreement.
- [ ]  Prune obsolete remote-tracking references.

Cleanup happens after the main merge and post-merge verification.
Deleting a feature branch does not remove commits preserved in merge history.

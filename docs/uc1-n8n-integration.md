
# UC1 — n8n Integration Guide

## Choose the appropriate flow

The repository contains a backend handover flow and a separate sample
integration flow. They have different validation and delivery contracts.


| Purpose                            | Workflow export                             | Production webhook path                   |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| Create a procurement draft         | `infra/config/n8n/uc1-intake.json`          | `/webhook/latticedx/uc1/orders`           |
| Synchronize a backend handover     | `infra/config/n8n/uc1-handover.json`        | `/webhook/latticedx/uc1/handovers`        |
| Test delivery to the sample system | `infra/config/n8n/uc1-handover-sample.json` | `/webhook/latticedx/uc1/sample/handovers` |

Use `/webhook-test/` while listening in the n8n editor. Publish the
workflow before using `/webhook/`.

Exports are inactive and contain no credential IDs or pinned data.
Configure credentials locally before publishing.

## Procurement intake

The intake workflow validates the request and calls
`POST /v1/workflows` through the gateway.

Accepted request:

```json
{"title":"UC1 demo purchase","input":{}}
```

The workflow creates a procurement draft. It does not submit, approve
or complete the handover.

Idempotency is delegated to the authenticated backend actor.
Retry uncertain requests with the same payload and Idempotency-Key.
Source-record deduplication across different keys is not provided.

See [Intake setup and tests](uc1-intake-workflow.md).

## Backend handover flow

The main handover workflow forwards the event and its Idempotency-Key
to `POST /v1/integrations/asset-handovers`.

The backend adapter verifies the canonical event against the backend
outbox, validates references, synchronizes the Asset and records a receipt
after broker read-back.

Use this flow for real procurement handovers. Synthetic sample events
are not substitutes for canonical backend events.

Follow [Backend handover setup and acceptance](uc1-handover-runtime.md)
for credentials, outbox filters, configuration scripts and runtime tests.
Review the backlog before enabling automatic outbox delivery.

## Sample integration flow

The sample workflow validates a handover envelope and sends it to
`http://uc1-sample:4100/sample/handovers`.

The sample service records the source payload and delivery attempts.
When broker mapping is configured, it enqueues a durable Asset sync job
in the same PostgreSQL transaction.

An accepted sample delivery does not mean broker synchronization has
finished. Check the job status, attempts and trace separately.

See:

- [Sample workflow setup](uc1-handover-workflow.md)
- [Asset mapping](uc1-asset-mapping.md)
- [Broker jobs, retry and trace](uc1-broker-jobs.md)

Use dedicated sample Asset URNs. The sample worker and backend adapter
use separate coordination mechanisms; do not configure both to write
the same Asset attributes.

## Local migration after merging

An existing n8n workflow is not changed by updating files in Git.

Before publishing the backend handover workflow, move any existing
sample webhook to `latticedx/uc1/sample/handovers`.
Update sample callers to use that path.

Preserve unrelated workflows and their credentials.
Keep tokens in local environment files or n8n credentials.

## Verification scope

The merged workflow and connector test selection passed 104 tests.
These checks do not establish live end-to-end behavior after the merge.

Verify the backend handover flow and sample flow separately.
Record the run ID, event ID, Asset URN and relevant receipt/job results.
Historical runtime evidence applies to the revision and environment
where it was collected.

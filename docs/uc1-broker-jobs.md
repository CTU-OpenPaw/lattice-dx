
# UC1 Asset broker jobs and trace

## Scope

Accepted procurement handovers can enqueue a frozen Asset projection
in the same PostgreSQL transaction as the handover and delivery log.

A separate worker delivers the projection to Orion-LD.

Local acceptance uses synthetic handover events through n8n.
Delivery from a real backend procurement outbox remains unverified.

## Setup

Prerequisites:

- Core PostgreSQL, n8n and Orion-LD are running.
- The sample-system schema has been applied.
- Department and Location targets exist in the configured broker tenant.
- The handover workflow has its separate webhook and sample API credentials.

Apply the broker schema from the repository root:

```powershell
Get-Content .\infra\config\uc1\broker-jobs.sql -Raw -Encoding UTF8 |
    docker exec -i lattice-dx-postgres-1 `
        psql -U lattice -d lattice `
        -v ON_ERROR_STOP=1 --single-transaction -f -
```

Copy `infra/config/uc1/asset-mapping.example.json` to
`infra/config/uc1/asset-mapping.local.json`.

Configure verified source IDs, stable broker URNs, Asset names and an
explicit mappingVersion. Exclude the local file from Git.

The Compose overlay mounts this file into the sample service and sets
UC1_BROKER_MAPPING_FILE. Without that setting, the sample does not enqueue
broker jobs.

See [Asset mapping](uc1-asset-mapping.md) and
[handover workflow](uc1-handover-workflow.md).

## Build and run

```powershell
docker compose --env-file .env.integration `
    -f infra/compose/core.yml `
    -f infra/compose/uc1-sample.yml `
    build uc1-sample uc1-broker-worker
```

```powershell
docker compose --env-file .env.integration `
    -f infra/compose/core.yml `
    -f infra/compose/uc1-sample.yml `
    up -d --no-deps uc1-sample
```

Process one due job:

```powershell
docker compose --env-file .env.integration `
    -f infra/compose/core.yml `
    -f infra/compose/uc1-sample.yml `
    run --rm --no-deps -T uc1-broker-worker `
    pnpm --filter @dx/api exec tsx `
    src/uc1-integration/worker-main.ts --once
```

Run continuous polling:

```powershell
docker compose --env-file .env.integration `
    -f infra/compose/core.yml `
    -f infra/compose/uc1-sample.yml `
    up -d --no-deps uc1-broker-worker
```

The worker uses the internal broker URL http://orion-ld:1026.
The current deployment assumes a trusted local Docker network.

## Processing and retry

- Jobs are scoped by organization and event ID.
- Each job retains its original mapping version, projection and Asset URN.
- Exact source-event replay does not reset an existing job.
- The worker validates relationship targets before writing.
- Existing Asset identity must match the projection.
- Newer observations update the same Asset URN.
- Older observations are recorded as stale without writing.
- Equal-time conflicting projections are recorded as conflict.
- Successful writes require a broker read-back check.
- Transient failures retry up to five attempts with exponential backoff.
- Continuous polling processes due retries automatically.
- In one-job mode, invoke the command again after available_at.
- Retry, failed and conflict outcomes return exit code 1 in one-job mode.

Workers share a PostgreSQL advisory lock and process broker jobs serially.
This coordination covers cooperating UC1 workers. Other writers must
follow the same ownership policy for these Asset attributes.

Jobs use 60-second leases. Expired attempts are recorded as abandoned.
Lease recovery after abrupt worker termination has not yet been verified
by a live acceptance test.

Terminal failed/conflict jobs require investigation. An administrative
requeue command is not implemented. Do not create a new event ID merely
to bypass a failed job or an idempotency conflict.

## Trace

Tables:

- uc1_sample.handovers: original payload, run/record IDs and receipt time.
- uc1_integration.asset_jobs: frozen projection and current delivery state.
- uc1_integration.asset_attempts: individual attempts and sanitized errors.
- uc1_integration.asset_heads: latest successful worker reconciliation.

View: uc1_integration.asset_trace.

Filter by organization_id and event_id when investigating delivery.
The original occurredAt is preserved separately from receipt and
processing timestamps. No credential is stored in the broker projection.

asset_heads is worker reconciliation history; the broker sourceEventId
can remain from an earlier event when an equal-time equivalent projection
is treated as duplicate.

## Local acceptance — 22 October 2026

Asset URN:
urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001


| Case                 | Observed result                                            |
| ---------------------- | ------------------------------------------------------------ |
| Initial handover     | 201 accepted; job pending                                  |
| First worker attempt | succeeded, created                                         |
| Exact webhook replay | 200 duplicate; job and attempt counts unchanged            |
| Asset read-back      | Correct identity, status, relations, event and source time |
| Broker stopped       | Attempt 1 retry; job retained as pending                   |
| Broker restored      | Attempt 2 succeeded, updated the same URN                  |
| Retry read-back      | New event applied; original event time retained            |
| Older event          | Worker returned stale; trace recorded stale                |

Evidence event IDs:

- Create: uc1-broker-bf9be745-e7c1-46f0-9168-c7eacfa1b8d5
- Retry/update: uc1-retry-6d20421d-d9bd-413d-b2f6-390936d8bc64
- Stale: uc1-stale-d258fa50-f062-442a-acb2-e268ced3df1b

## Limits and remaining verification

- Local live fixtures use whole-second source timestamps.
- Millisecond fidelity through Orion-LD is not established.
- Timestamp truncation is rejected by the read-back check.
- Existing projected attributes without observedAt require reconciliation.
- Live equal-time conflict, concurrent workers and lease recovery remain
  unverified; unit tests cover equal-time conflict behavior.
- No exactly-once delivery guarantee is claimed.
- Backend source IDs and the local handed-over to in_use policy still
  require confirmation with the backend owner.
- For Orion-LD context recovery, see broker-recovery.md.

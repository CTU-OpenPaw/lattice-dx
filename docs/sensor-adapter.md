
# UC2 Sensor Adapter

## Scope

The local CLI adapter records sensor readings in PostgreSQL and projects
valid measurements onto an existing tenant-scoped broker Asset.

It does not create Assets, modify Asset status, execute rules or create cases.
No public ingestion endpoint or automatic worker scheduler is included.

## Files

- `apps/api/src/sensors/policy.ts`: envelope and measurement validation.
- `apps/api/src/sensors/database.ts`: source receipts and duplicate detection.
- `apps/api/src/sensors/projection.ts`: NGSI-LD measurement mapping.
- `apps/api/src/sensors/broker-client.ts`: bounded broker requests.
- `apps/api/src/sensors/broker-sync.ts`: identity, ordering and read-back.
- `apps/api/src/sensors/worker.ts`: durable delivery processing.

## Database setup

Apply these files in order using psql with `ON_ERROR_STOP=1`:

1. `infra/config/uc2/sensor-readings.sql`
2. `infra/config/uc2/sensor-deliveries.sql`

Readings and delivery records are inserted in the same transaction.

Receipt identity is organization + source system + event ID.
Identical payload replay returns the original receipt.
Different payload under the same identity causes a conflict.

PostgreSQL JSONB comparison ignores object-key order.
Sequence gaps in reading IDs are normal after conflicting inserts.

## Validation and history

Supported attributes:


| Attribute    | Unit    | Accepted measurement             |
| -------------- | --------- | ---------------------------------- |
| temperature  | celsius | Finite JSON number               |
| humidity     | percent | Finite JSON number from 0 to 100 |
| batteryLevel | percent | Finite JSON number from 0 to 100 |

Quality is independently classified as good, missing or invalid.
Numeric strings are not coerced.

Valid envelopes with missing or invalid values remain in history.
Their deliveries are skipped without clearing an existing broker measurement.
Invalid identities or envelopes are rejected before storage.

The source payload, observedAt, receivedAt and simulated flag are retained.
Freshness is separate from measurement quality and belongs to rule evaluation.

## Broker projection

Each valid reading updates one measurement Property on the original Asset URN.
The Property includes observedAt, unitCode and source/quality/simulation metadata.

The adapter verifies Asset type, organization and business ID.
It rejects takeover of a measurement owned by another source or device.

Older observations are stale.
Equal-time matching observations are duplicates.
Equal-time disagreement is a conflict.

A write requires HTTP 204 and matching broker read-back.
Partial success is not acknowledged as completed delivery.

Exact timestamp preservation is checked. Live acceptance used whole-second
observations. Arbitrary millisecond precision on Orion-LD 1.10.0 is not certified.

## Local commands

Fixture ingestion, using Node.js 24:

```powershell
node --import tsx scripts/ingest-sensor-fixture.ts `
    "urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001" `
    "2026-10-25T10:30:44.000Z" `
    "uc2-live-v1" `
    "normal"
```

Requires DATABASE_URL and UC2_SENSOR_TENANT in the process environment.
The source system is fixed to latticedx-simulator.
This CLI generates fixtures; it is not an authenticated external sensor API.

Process at most one pending delivery:

```powershell
node --import tsx scripts/run-sensor-worker.ts --once
```

Requires DATABASE_URL, NGSI_LD_URL and UC2_SENSOR_TENANT.

Use addresses reachable from the execution environment:
inside the Compose network, PostgreSQL is postgres:5432 and
the broker is http://orion-ld:1026.

Keep credentials outside Git. The scripts do not automatically load an env file.

## Delivery and retry

States: pending, succeeded, stale, skipped and failed.

Transient failures remain pending until five committed attempts.
Permanent failures stop immediately. Retry reuses the stored source payload.
Replay does not reset a completed or failed delivery.

The CLI performs one attempt per invocation. There is no automatic loop,
backoff or operator requeue API in this version.

PostgreSQL locks serialize cooperating workers by tenant, Asset and attribute.
External writers do not share these locks.
There is no distributed transaction between PostgreSQL and the broker.

After an uncertain write or database commit, a later invocation checks the
broker state before writing again. Attempts count committed processing
outcomes, not every possible network request.

Only the latest delivery error is stored. Append-only attempt history and
authorized dashboard history APIs remain follow-up work.

## Verification

- Simulator, policy, projection, transport and synchronization tests.
- Real PostgreSQL acceptance: replay, conflict, concurrent receipt creation,
  delivery classification and connection-pool replacement.
- Live Orion-LD: reading 1 succeeded on attempt 1.
- Exact source replay returned reading 1 with no additional delivery attempt.
- Reading 3 encountered a simulated connection failure, remained pending,
  then succeeded against the real broker on attempt 2.

The connection failure used an unreachable URL for one worker invocation;
the shared broker was not stopped.

Concurrent worker execution and crash recovery have not been demonstrated
by the live acceptance above.

Rules, broker notification routing, case creation and agent execution are
outside this adapter acceptance.

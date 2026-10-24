
# Simulated Sensor Data

## Purpose

Generate five temperature-reading fixtures for UC2:
normal, anomalous, missing, stale and malformed.

The generator writes newline-delimited JSON to stdout.
It does not contact the broker, write to a database or create cases.

All readings contain `simulated: true`, source information and
a simulation scenario label. These labels describe fixtures;
the ingestion adapter must independently validate data quality.

## Run

From the repository root, using the project's Node.js 24 runtime:

```powershell
node .\scripts\simulate-sensor.mjs `
    "urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001" `
    "2026-10-24T08:00:00.000Z" `
    "uc2-demo-v1"
```

Arguments:

1. Asset URN: `urn:ngsi-ld:Asset:<organization>:<businessId>`.
2. Reference time: canonical UTC timestamp with milliseconds.
3. Optional seed: defaults to `uc2-demo-v1`.

The generator validates URN syntax but does not verify that the Asset
exists or that the caller has permission to access it.

## Scenarios


| Scenario  | Value            | Age relative to reference time |
| ----------- | ------------------ | -------------------------------- |
| normal    | 25               | 4 seconds                      |
| anomalous | 85               | 3 seconds                      |
| missing   | No value field   | 2 seconds                      |
| stale     | 85               | 1 hour                         |
| malformed | `"not-a-number"` | 1 second                       |

Attribute: `temperature`. Unit: `celsius`.

Values and ages are demonstration fixtures. A configured rule determines
whether a reading exceeds its threshold or freshness window.
The malformed fixture is valid JSON containing an invalid measurement value.

## Replay

Identical Asset URN, reference time and seed produce identical payloads
and event IDs. Changing any of these inputs produces different event IDs.

The seed identifies a fixture run; values are fixed, not random.
Event IDs are SHA-256 hashes of the generated reading content.

A fixed reference time supports reproducible tests. Live freshness tests
must deliberately choose a suitable reference time. Retry the original
payload without replacing its observation time.

Consumers must not assume output is sorted by observation time:
the stale fixture appears after the missing fixture.

## Verification

```powershell
docker run --rm `
    --mount "type=bind,source=$($PWD.Path),target=/work" `
    --workdir /work `
    node:24.15.0-alpine `
    node node_modules/vitest/vitest.mjs run tests/sensor-simulator.test.ts
```

Verified: 22 tests passed.

Coverage includes scenario values, simulation labels, observation times,
deterministic replay, changed inputs, invalid arguments and CLI output.

Broker ingestion, rule execution and case creation require separate
implementation and verification.

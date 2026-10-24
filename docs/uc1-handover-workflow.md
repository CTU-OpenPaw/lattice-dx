
# UC1 handover synchronization

## Scope

Synchronize procurement handover events through n8n into a local sample
system backed by PostgreSQL.

This implementation stores the original event and delivery attempts.
It does not yet map events to NGSI-LD Assets or update the broker.

## Files

- Workflow: `infra/config/n8n/uc1-handover-sample.json`
- Sample server: `apps/api/src/uc1-sample/server.ts`
- Database schema: `infra/config/uc1/sample-system.sql`
- Compose overlay: `infra/compose/uc1-sample.yml`
- Workflow tests: `tests/uc1-handover-sample-workflow.test.ts`

## Local setup

Run commands from the repository root with the core PostgreSQL service
running.

Set `UC1_SAMPLE_TOKEN` in `.env.integration` to a generated secret.
The default sample tenant is `org-a`; configure `UC1_SAMPLE_TENANT`
when necessary. Do not commit secrets.

Apply the schema before starting the sample server:

```powershell
Get-Content .\infra\config\uc1\sample-system.sql -Raw -Encoding UTF8 |
    docker exec -i lattice-dx-postgres-1 `
        psql -U lattice -d lattice `
        -v ON_ERROR_STOP=1 --single-transaction -f -
```

Start the sample service:

```powershell
docker compose --env-file .env.integration `
    -f infra/compose/core.yml `
    -f infra/compose/uc1-sample.yml `
    up -d --build uc1-sample
```

Check readiness:

```powershell
curl.exe --max-time 10 -i http://localhost:4100/healthz
```

Expected response: HTTP 200 with `{"status":"ready"}`.

n8n must share the Docker network with `uc1-sample`.
The workflow calls `http://uc1-sample:4100/sample/handovers`.

## n8n configuration

Import `infra/config/n8n/uc1-handover-sample.json`.

Configure two separate Header Auth credentials:


| Node                    | Credential                     | Header        | Value                                       |
| ------------------------- | -------------------------------- | --------------- | --------------------------------------------- |
| Webhook                 | LatticeDX UC1 Handover Webhook | Authorization | Bearer followed by the source webhook token |
| Send Handover to Sample | LatticeDX UC1 Sample API       | Authorization | Bearer followed by UC1_SAMPLE_TOKEN         |

Keep both secrets in n8n credentials.

The exported workflow is inactive and contains no credential IDs or
pinned execution data. Select local credentials after importing.

Use the test URL while the editor is listening:

`POST http://localhost:5678/webhook-test/latticedx/uc1/sample/handovers`

Re-arm the test listener before each request. For a published workflow,
use `/webhook/latticedx/uc1/sample/handovers`.

## Event contract

Send a JSON WorkflowEvent with:

- `eventId`, `organizationId`, `runId`, and `recordId`.
- `eventType`: `asset.handed_over`.
- `definitionId`: `procurement`.
- A positive integer `version`.
- A valid UTC ISO 8601 `occurredAt`.
- A `data` object containing string values, including nonblank
  `assetId`, `recipientId`, `departmentId`, `locationId`, and
  `attachmentId`.

The `Idempotency-Key` header must equal `eventId` and match
`[A-Za-z0-9._:-]{1,128}`.

The sample service checks the configured tenant. It does not verify
recipient, department, location, or attachment existence in the backend.

## Results and persistence


| Situation                                               | HTTP | Result              |
| --------------------------------------------------------- | ------ | --------------------- |
| First accepted delivery                                 | 201  | accepted            |
| Same organization, event ID, and JSON payload           | 200  | duplicate           |
| Same organization and event ID with a different payload | 409  | conflict            |
| Invalid event or key                                    | 400  | invalid_payload     |
| Authentication or tenant rejected                       | 403  | Rejected            |
| Transport failure or unusable upstream response         | 502  | sample_unavailable  |
| Sample storage unavailable                              | 503  | storage_unavailable |

`uc1_sample.handovers` stores the original payload, workflow identifiers,
event time, and receipt time. Its primary key is
`(organization_id, event_id)`.

`uc1_sample.delivery_attempts` records accepted, duplicate, and conflict
outcomes with HTTP status and receipt time.

Accepted data and its delivery attempt are committed before acknowledgement.
A conflicting payload does not overwrite the stored event.

Requests that cannot reach the sample service cannot create a delivery
attempt there. Database-backed attempt logs do not cover every failure.

## Retry procedure

The n8n HTTP node has a five-second timeout and does not automatically
retry POST requests.

For an uncertain delivery result:

1. Check the sample service readiness.
2. Restore connectivity or correct the configuration.
3. Re-arm the test listener when using the test URL.
4. Resend the exact original event, Authorization header, and
   Idempotency-Key.

If the original delivery committed, replay returns `200 duplicate`.
Otherwise, a successful first delivery returns `201 accepted`.

Do not generate a new event ID merely to retry delivery.
A `409 conflict` requires investigating the changed payload.

## Verification — 22 October 2026

Automated checks:

- Intake workflow: 29 tests passed.
- Handover workflow: 37 tests passed.
- API TypeScript check: passed.

Live fixture checks:

- Initial delivery: `201 accepted`.
- Exact replay: `200 duplicate`.
- PostgreSQL contained one handover record.
- Accepted and duplicate delivery attempts were recorded.
- Changed payload under the same event ID: `409 conflict`.
- Stored asset ID remained unchanged after the conflict.
- Replay after restarting the sample service: `200 duplicate`.

Fixture event ID:

`uc1-demo-a97fe9d1-bd31-4340-9814-a4dc18bd206a`

Fixture asset ID:

`demo-asset-1a645b41-d1b1-4ee8-bfc5-b380000130b7`

Run workflow checks:

```powershell
docker run --rm `
    --mount "type=bind,source=$($PWD.Path),target=/work" `
    --workdir /work `
    node:24.15.0-alpine `
    node node_modules/vitest/vitest.mjs run `
    tests/uc1-intake-workflow.test.ts `
    tests/uc1-handover-sample-workflow.test.ts
```

## Remaining verification and integration

- Confirm the live 502 response while the sample service is unavailable.
- Verify delivery from a real backend procurement handover through its
  outbox, including failure and retry behavior.
- Review routing for other backend event types before enabling a shared
  outbox destination.
- Implement stable Asset URN mapping and broker upsert.
- Extend source and trace reconciliation through the resulting Asset.

The current live evidence uses synthetic events sent through n8n.
It does not establish end-to-end delivery from the backend outbox.

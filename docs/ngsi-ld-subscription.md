# NGSI-LD Asset subscription — local v1

## Scope and evidence

Receiver: `POST /v1/integrations/ngsi-ld/notifications`.
Operational read-back: `GET /v1/integrations/ngsi-ld/context?entityId=<URN>`.

This implementation projects **Asset.status only** into `ngsi_ld_asset_context` in PostgreSQL.
It does not change orders, workflow state, accounting, Asset ownership, names or relationships.
The existing Asset connector and data contract are unchanged.

Receiver tests use Fastify injection and an in-memory repository. They verify authentication,
tenant/subscription binding, payload validation, ordering and failure responses.

### Target local verification — 16/10/2026

The operator supplied a complete passing output from `smoke-ngsi-ld-subscription.mjs` on the
target Docker environment at commit `a5ec081`. Checklist 5 is verified for the local Asset.status scope.

- Actual broker delivery: Asset create → gateway → receiver → PostgreSQL read-back passed.
- Actual broker delivery: status update with newer observedAt applied and read back successfully.
- Direct receiver checks: missing/wrong token and wrong tenant returned 403.
- Direct receiver checks: foreign subscription rejected; duplicate/stale observations ignored;
  conflicting values at the same observedAt returned 409.
- Direct receiver checks: missing/invalid fields and observedAt rejected; accepted context unchanged.
- Retained fixture: `urn:ngsi-ld:Asset:org-a:subscription-a1137a4a-c514-4515-bf86-65590b1b1cf1`.
- No business order or workflow transition changed.

The old subscription retained a duplicate tenant header after PATCH; scoped recreation cleared it.
The broker delivered an earlier fractional timestamp as a whole-second value. The successful smoke
therefore uses whole-second fixtures with exact equality. Millisecond fidelity and live concurrent
delivery remain outside this evidence.

## Source and tenant binding

- A dedicated `NGSI_LD_NOTIFICATION_TOKEN` is required: 32–256 URL-safe characters.
- The API checks `X-Lattice-Broker-Token` before parsing the request body.
- `NGSILD-Tenant` must equal the configured tenant, default `org-a`.
- `subscriptionId` must equal the explicitly configured subscription ID.
- Every Asset URN, businessId and organizationId must agree with that tenant.
- Subscription `receiverInfo` configures only the dedicated token header. Orion-LD forwards
  `NGSILD-Tenant` from the tenant-scoped broker operation automatically; do not add a second copy
  in receiverInfo. The API continues to require exactly the configured tenant value.
- The token authenticates possession of a shared secret, not the broker process itself.
  A claimed subscription ID, IP or JSON field alone is not source authentication.
- Missing receiver config/storage returns 503; missing/wrong token, header tenant or subscription returns 403.

The broker stores the outgoing credential in the subscription definition. Keep Orion-LD local/internal,
do not log/share full subscription responses, and do not reuse n8n or human sales credentials.
For non-local deployment use TLS and appropriate broker access control/network isolation.

## Payload and temporal policy

- Normalized NGSI-LD JSON or JSON-LD notification, 1–100 distinct Assets, maximum 64 KiB.
- Each entity requires id, type, businessId, organizationId and status.
- Compact terms and expanded project attribute IRIs are accepted; ambiguous duplicate aliases reject.
  No remote context is fetched and no general JSON-LD expansion is performed.
- status must be a single default Property with value ready/in_use/repair/retired.
  Multi-instance arrays and datasetId are outside v1.
- `status.observedAt` is mandatory: valid UTC ISO 8601 ending in Z, precision at most milliseconds.
  More than five minutes in the future rejects. `notifiedAt` and receipt time never replace observedAt.
- Newer observedAt applies; older observedAt is ignored with HTTP 200.
- Same observedAt + same value is ignored; same observedAt + different value returns 409.
- Missing/invalid status or identity fields return 400; nothing in that batch is written.
- Batches are transactional, with per-tenant/entity locks acquired in sorted order. A conflict rolls back the batch.
- Only status is projected, so an absent name or relationship never clears existing business data.
- Deduplication here is based on entity/status/observedAt, not a retained notification-id inbox.

## Run on Windows

Run from the repository root. Node 20.6+ supports the `--env-file` option used below;
the repository's full build/check continues to require Node 24.

### 1. Configure a separate broker credential

```powershell
node .\scripts\configure-ngsi-ld-local.mjs
```

This appends a random token to `.env.integration` only if absent, retaining other settings.
It never prints the token. `.env.integration` is ignored by Git.

Optional settings in that file:

```dotenv
NGSI_LD_TENANT=org-a
NGSI_LD_SUBSCRIPTION_ID=urn:ngsi-ld:Subscription:latticedx:org-a:asset-context-v1
NGSI_LD_URL=http://localhost:1026
NGSI_LD_NOTIFICATION_URL=http://gateway:9080/v1/integrations/ngsi-ld/notifications
DX_GATEWAY_URL=http://localhost:8080
```

The script calls the broker from Windows via localhost. The broker calls the receiver via
the gateway service name inside `lattice-dx_default`. Do not set the broker's destination to Windows localhost.

### 2. Rebuild the API and recreate the gateway

```powershell
docker compose --env-file .env.integration -f infra/compose/core.yml config --quiet
docker compose --env-file .env.integration -f infra/compose/core.yml up -d --build api
docker compose --env-file .env.integration -f infra/compose/core.yml up -d --force-recreate gateway
docker compose --env-file .env.integration -f infra/compose/core.yml ps
```

Wait for the API to become healthy. Never add `--remove-orphans` or delete volumes.
Recreating gateway reloads its mounted standalone routes. Keep using the same env-file on subsequent
core recreations; otherwise the receiver is disabled because no token is configured.
No secret defaults are committed. Unconfigured existing installations continue to run with receiver disabled.

### 3. Register the subscription

```powershell
node --env-file=.env.integration .\scripts\register-ngsi-ld-subscription.mjs
```

Expected: HTTP 201 for a new subscription, HTTP 204 when updating the explicitly configured existing subscription.
No other subscription is removed. Definition: Asset in the configured tenant; watches status;
notification contains businessId, organizationId and status, normalized format.

If API diagnostics show tokenMatches=true, tenantMatches=false and tenantValueCount=2,
the broker is delivering a duplicate tenant header. An earlier subscription definition may retain
NGSILD-Tenant in receiverInfo even after PATCH. Explicitly recreate this demo subscription once:

```powershell
node --env-file=.env.integration .\scripts\register-ngsi-ld-subscription.mjs --recreate
```

This deletes and creates only the configured subscription in its tenant; notification counters reset
and there is a short delivery gap. Existing entities, context rows, business data and other subscriptions
are retained. Run only during local testing. If recreation fails after DELETE, fix the reported error and
run registration again. Do not weaken backend tenant checks or rotate unrelated credentials.

### 4. Verify broker delivery and negative cases

```powershell
node --env-file=.env.integration .\scripts\smoke-ngsi-ld-subscription.mjs
```

Expected PASS lines:

- broker create → receiver → PostgreSQL read-back;
- broker update → receiver with newer observedAt applied;
- missing/wrong token and wrong header tenant → 403;
- wrong subscription → 403;
- duplicate/stale observation ignored; equal-time conflicting value → 409;
- missing fields and invalid/absent/future observedAt → 400;
- accepted context unchanged after negative tests.

The first two checks prove actual broker notification delivery. The later checks call the receiver
directly with controlled payloads; they must not be reported as notifications emitted by the broker.
The script creates and retains a unique demo Asset and updates only its own status.

The target local broker was observed delivering a status timestamp ending in `.000Z` when the
input had fractional milliseconds (`.428Z`). Smoke fixtures therefore use distinct whole-second
timestamps and still require exact read-back equality. This checks ordering at second resolution;
it does not establish end-to-end millisecond preservation. The receiver continues to validate and
store the observedAt actually delivered; subsecond fidelity needs separate broker investigation.

On failure, stop and inspect the HTTP status and API logs locally:

```powershell
docker compose --env-file .env.integration -f infra/compose/core.yml logs --tail 80 api
```

Do not publish env files or full subscription JSON containing receiverInfo.

## Remaining scope

Startup recovery and the Orion-LD 1.10.0 inline-context PATCH workaround are documented
in [broker recovery](broker-recovery.md). Use the updated registration helper; direct
inline-context subscription PATCH can reproduce the upstream crash after restart.

- End-to-end millisecond fidelity and live concurrent/batch delivery beyond the current smoke.
- Vehicle/Shipment/Warehouse schemas and mappings agreed with the backend owner.
- Projection of additional attributes with independent observedAt rules.
- Retention/inbox audit and delivery retry/reconciliation strategy.
- Broker credential rotation and non-local transport/access control.
- Mapping contextual observations to authorized business actions, if later required.

Protocol reference: [FIWARE NGSI-LD subscriptions](https://github.com/FIWARE/tutorials.NGSI-LD/blob/master/docs/subscriptions.md).

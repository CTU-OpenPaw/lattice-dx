# Runtime integration corrections — 18 October 2026

## Form permissions

Warehouse users could receive an order successfully while the sales form refreshed its
warehouse directory choices, received 403, and displayed a misleading global error.

`GET /v1/me/capabilities` now includes `logistics.create`. It requires `logistics:sales`
and `workflow:start`, and configured workflow/directory dependencies. The bridge exposes
this existing fixed read endpoint as `workflow/capabilities`, with the session's token;
caller-supplied IDs, queries, bodies, tokens and endpoints are rejected.

The trusted Logistics action contract references that capability. Shared Form loading checks
the capability (or existing action catalog) before requesting reference data. Unavailable
actions do not fetch protected choices, render upload controls or remain indefinitely in a
loading state. Missing/malformed capability responses fail closed. This is UI availability;
API writes still enforce their own identity, roles, references, tenant and current state.

Foundation is 0.14.1 and Action Bridge is 0.1.1. Reinstall the plugins and rebuild the API
together. An older backend without the capability leaves the form unavailable.

## n8n failures

The exported Logistics intake workflow now sets the HTTP node timeout to 10,000 ms and routes
connection/timeout/invalid-JSON failures to a fixed JSON HTTP 502 response. It does not include
raw upstream error details and does not automatically retry a POST. The message tells callers
to check the order and preserve the same Idempotency-Key if retrying an uncertain operation.
Received backend HTTP responses still pass through with their body/status, including 401.

The actual n8n runtime previously returned 500 for a dropped upstream connection. After the
change, an isolated upstream fixture verified DROP → 502, NONJSON → 502, TIMEOUT → 502 after
approximately 10 seconds, SUCCESS → 201 and HTTP401 → 401. These are transport tests with a
simulated upstream, not successful business-order evidence.

To reproduce on the configured local stack, reuse the installed demo credential references
and `.env.integration` (never export credential values):

```powershell
node scripts/prepare-n8n-failure-fixture.mjs
docker --context desktop-linux compose -f infra/compose/core.yml cp scripts/fixtures/n8n-failure-upstream.cjs api:/tmp/lattice-n8n-upstream.cjs
# Keep this command running in a separate terminal; it exposes no host port.
docker --context desktop-linux compose -f infra/compose/core.yml exec -T -e N8N_FAILURE_FIXTURE=true api node /tmp/lattice-n8n-upstream.cjs
```

In another terminal:

```powershell
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml cp output/n8n-failure-test/workflow.json n8n:/tmp/lattice-failure-test.json
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml exec -T n8n n8n import:workflow --input=/tmp/lattice-failure-test.json
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml exec -T n8n n8n publish:workflow --id=LatticeRuntimeFailureTest
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml restart n8n
node --env-file=.env.integration scripts/smoke-n8n-failures.mjs
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml exec -T n8n n8n unpublish:workflow --id=LatticeRuntimeFailureTest
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml restart n8n
```

Unpublish the fixture and stop the upstream process even if an assertion fails. The fixture
has its own ID/path and never points at the real order API. Import the updated business export
separately; its inactive state is intentional until token management is ready.

## Verification

`pnpm check` passed type checking, 609 tests across 112 files, and production builds.
The Foundation/Action Bridge Node suite passed all 67 tests. On the updated local
runtime, warehouse sign-in showed the unavailable sales form without a global 403;
the previously received order and its three audit events remained readable. Alice
sign-in showed the enabled sales form with warehouse/warehouse2 directory choices.
The updated business n8n export was imported in its intentionally inactive state.
The five live n8n transport fixture cases above passed before the fixture was unpublished.

## Remaining integration work

These corrections do not implement procurement handover delivery to the broker, token refresh,
the threshold executor or real-model incident analysis. Those are unfinished integration work,
not implied by successful transport tests. Existing outbox jobs remain pending; no global
worker is enabled to process unrelated backlog. No Notion task is automatically ticked.

When recreating the configured local core stack, use `--env-file .env.integration` so receiver
credentials and `NGSI_LD_CONTEXT_READ=true` remain supplied. The plain core Compose command
uses defaults and does not load that file automatically.

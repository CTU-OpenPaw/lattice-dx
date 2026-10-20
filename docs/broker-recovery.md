# Orion-LD startup recovery — 20 October 2026

## Failure and prevention

Orion-LD 1.10.0 exited with code 139 while loading persisted contexts. An inline
`@context` sent in a **subscription PATCH** produced a hosted context with `url:null`.
The same image started against an empty database, crashed against a cloned context
database, and started after the malformed URL was restored on that clone. Upstream
`src/lib/orionld/contextCache/orionldContextCacheInit.cpp` at tag 1.10.0 compares the
stored URL with `strcmp` without checking its type/null value.

Using an inline mapping object alone did not prevent the PATCH defect. Sending
expanded terms without a context avoided the crash but broke notification delivery;
neither approach is the final repair.

The registration helper now uses the broker's native `POST /ngsi-ld/v1/jsonldContexts`
API, then references its returned URL in subscription PATCH. Compact terms, tenant
checks and the receiver credential are preserved. It does not delete/recreate the
subscription or reset counters. Both local smoke entry points load the same mapping
object; the NGSI-LD core context is implicit.

Each administrative registration update creates one hosted context. Do not invoke
registration per telemetry event. No automatic context deletion is implemented,
because active subscriptions can reference those contexts. Third-party clients that
still PATCH inline contexts can reproduce this upstream defect; this change prevents
it in the repository's registration path, not in the upstream binary itself.

## Local recovery and data preservation

The original Mongo volume was not edited or deleted. A read-only archive of the Orion
namespaces was restored into a fresh named volume. Only the invalid hosted-context
URL was repaired on the copy, retaining its ID, value and all other documents.
The final copy comparison verified 3 entities (including a smoke fixture), 1
subscription and 4 contexts, allowing exactly one URL difference. Subsequent smoke
runs deliberately add separate demo assets and hosted contexts.

The existing Mongo service now mounts that verified volume. Its selection is stored
in ignored `.env.integration` as `ORION_MONGO_VOLUME`; use that file whenever bringing
up the local integration stack:

```powershell
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/integration.yml up -d
node --env-file=.env.integration scripts/smoke-ngsi-ld-subscription.mjs
```

The Compose default still uses the selected project name, so separate `-p` projects
remain isolated. The override is for an intentional recovery volume only. Do not
copy this machine's recovery volume name to a fresh installation or omit its local
override while recreating the recovered Mongo service.

Retained local artifacts (Git-ignored):

- `output/orion-full-recovery-source-20261020.archive`: full original dump.
- `output/orion-pre-final-recovery-20261020.archive`: final pre-cutover dump,
  including the additional smoke asset from the first recovery attempt.
- `output/oct20-orion-final-copy-verification.json`: inventory and normalized hash.
- `output/oct20-broker-final-smoke.log` and
  `output/oct20-broker-after-restart-smoke.log`: actual notification acceptance.

Archives can contain the receiver credential and must not be published. The original
volume `lattice-dx_orion-mongo-data` and the intermediate recovery volume are retained;
the active local volume is `lattice-dx_orion-recovery-20261020-v2`.

For rollback or another recovery: stop broker writers, preserve the active volume and
archive, restore into another fresh volume, validate complete data and context URLs,
then change only the local volume selector and recreate the Mongo service. Never
restore over the source volume or run `down -v`. The original volume still contains
the malformed URL: switching back to it is a forensic/data rollback, not a working
availability rollback. Do not restore it blindly and expect the broker to start.

## Verification

The hosted-context path passed create/update notifications through Gateway to
PostgreSQL, invalid credential/tenant checks and observation ordering. The production
local broker then restarted successfully, passed a second notification run after
restart and restarted again without creating another null-URL context. Service
versions, receiver authorization and application data policies were unchanged.

An independent review caught a project-isolation issue in the initial volume default;
the corrected fallback was checked with two different Compose project names and the
explicit local recovery override. Model/agent verification remains separate.


# UC1 handover-to-Asset mapping

## Scope

Module: `apps/api/src/uc1-integration/asset-mapping.ts`

The mapper converts a validated procurement handover event into an
NGSI-LD Asset projection. It performs no database or broker writes.

Example configuration:
`infra/config/uc1/asset-mapping.example.json`

The example contains synthetic source IDs. Replace them with verified
source identifiers before integrating real backend events.

## Identity resolution

Mappings are selected using:

- organizationId
- sourceSystem
- sourceEntityType
- sourceId

Each lookup must resolve to exactly one mapping.

The broker URN must match the configured organization, entity type,
and integration ID character rules.

Do not derive Asset identity from eventId, runId, recordId, a display
name, or the time of delivery.

Keep the configured broker URN stable across handovers and retries.
Configuration changes must not silently remap an existing source entity
to a different Asset.

## Projection


| Source                          | Asset projection                            |
| --------------------------------- | --------------------------------------------- |
| Resolved Asset mapping          | id and businessId                           |
| Trusted configured organization | organizationId                              |
| Asset mapping name              | name on creation                            |
| asset.handed_over               | status = in_use                             |
| Resolved Department mapping     | belongsToDepartment                         |
| Resolved Location mapping       | locatedAt                                   |
| occurredAt                      | observedAt on status and both relationships |
| eventId                         | sourceEventId                               |

The status mapping is a local integration policy pending backend review.

The mapper returns:

- entity: attributes required to create the Asset.
- attributes: handover attributes to update an existing Asset.

Handover updates do not rename an existing Asset.
The connector supplies the project JSON-LD context.

Recipient identifiers, attachment identifiers, and the complete
transactional payload are not copied into the broker projection.

## Validation and trust

The caller must authenticate the event source and supply trusted
organization and source-system configuration.

The mapper rejects:

- Organization mismatches and unsupported events.
- Missing required handover fields.
- Invalid source timestamps.
- Missing or ambiguous mappings.
- URNs with the wrong entity type or organization.
- Missing Asset display names.

Source timestamps are preserved rather than replaced by processing time.

Mapping configuration alone does not prove that Department and Location
entities exist. The broker integration must verify relationship targets
before writing an Asset.

## Verification — 22 October 2026

18 mapping tests passed, covering identity stability, explicit ID
resolution, replay determinism, source timestamps, data boundaries,
and invalid or missing mappings.

## Remaining integration

- Load and validate mapping configuration in the job processor.
- Verify real backend source IDs.
- Verify Department and Location existence on the broker.
- Implement ordered upsert and retry.
- Persist source-event and Asset reconciliation history.

Pure mapping determinism does not by itself provide database
deduplication, stale-event protection, or exactly-once delivery.

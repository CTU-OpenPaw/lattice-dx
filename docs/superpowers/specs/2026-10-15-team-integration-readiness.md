# Team integration readiness — approved scope, 15 October 2026

Duy's agreed work is to review the NGSI-LD identity/mapping contract, compare Hưng's UI with the merged backend, prepare shared data and an executable multi-actor acceptance path, then fix only demonstrated backend integration defects. This records the user's approval to plan and execute that scope; it is not a request for a new feature platform.

## Design

Use the merged engine unchanged where possible. Add one declarative asset-review module and signed-HTTP seed/test tooling. The owner creates an asset and starts a linked workflow; a separate warehouse actor sees an allowed approval, but must obtain an explicit asset grant to read its data. A foreign-organization actor stays denied. This exercises UI-compatible workflows without introducing a Logistics-only engine or pretending the UI supports entity blocks it has not implemented.

Each seed uses a new UUID-derived slug namespace and idempotency keys, preserves existing accounts/roles/directory and writes a metadata-only local artifact containing IDs and URLs. It must not overwrite existing fixtures or persist credentials/tokens. Smoke execution uses those exact IDs, verifies identity and tenant, replay and version conflicts, and retains its own data for team inspection.

Read teammate branches at recorded SHAs. Do not modify, merge, deploy, or message those branches/tasks. Their own test reports are attributed; independently executed tests are labeled separately. Broker notifications authenticate source and bind tenant; URNs/business IDs, entity UUIDs, workflow IDs and account subjects stay distinct. Backend shared data and broker context projections have distinct authority. No mapping auto-creates a grant or uses an external timestamp as a concurrency version.

## Constraints

- One branch `codex/team-integration-readiness` from merged `origin/main`; work in the existing checkout, no extra worktrees.
- Preserve CV.pdf, a.png, output, credentials, current accounts/roles/directory, all business data and persistent volumes.
- No UI/plugin/adapter source changes, no new dependencies, no automatic merge/release or Notion ticks.
- Existing signed JWT, publication, current resource policy, expectedVersion and Idempotency-Key contracts remain authoritative.
- No new production endpoint or service unless an integration failure demonstrates the need.
- Deliver a reviewable PR, concrete handoff and clear boundaries between backend, simulated adapter, UI tests and live broker/n8n tests.

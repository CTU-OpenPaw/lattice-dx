# Sensor, Rules and Evidence-Based Agent — Next Tasks

Created: 23 October 2026 (Asia/Ho_Chi_Minh).
Owner: Thạch Thanh Nhi — Integration, Data & AI.
Status: planned; all seven tasks are pending.

Suggested repository destination:
`docs/superpowers/plans/2026-10-23-sensor-rules-agent.md`

## Implementation checklist

- [ ] **1. Simulated sensor data generator:** implement normal, anomalous, missing, stale and malformed readings; explicitly label generated data as simulated.
- [ ] **2. Sensor adapter:** ingest readings against the same stable Asset URN; retain source, observation time and data-quality information.
- [ ] **3. Rule executor:** implement threshold rules, data freshness windows and a cooldown period to suppress repeated alerts.
- [ ] **4. Case integration:** connect broker notifications to rule evaluation and Duy's case-creation API; verify duplicate-notification handling.
- [ ] **5. History and reproducible scenarios:** retain measurement history and rule/agent execution results for dashboard reconciliation; support replaying fixtures for the same scenario.
- [ ] **6. Evidence-based agent:** read through authorized tools, reconcile measurements with reference documents and return recommendations with source records and evidence.
- [ ] **7. Failure and authorization checks:** test model failures, missing data and document content containing instructions that exceed the agent's authority; return explicit error outcomes.

## Acceptance and delivery notes

- These tasks extend the UC1 Asset integration; this checklist does not mark the remaining UC1 backend-outbox acceptance as complete.
- Confirm the current case API contract, permissions and notification routing with the backend before connecting case creation.
- Keep simulated data identifiable in stored records and dashboard evidence.
- Preserve stable Asset identity across readings, scenario replays and delivery retries.
- Record source observation time separately from ingestion and processing times.
- Specify replay and alert-deduplication behavior before enabling actions.
- Treat retrieved documents as data, not authority to change tool permissions or execute actions.
- Mark a task complete only after implementation, appropriate tests and recorded acceptance evidence.
- Keep documentation and code in English; commit meaningful completed changes with their verification evidence.

## Evidence log

| Task | Commit | Automated verification | Live verification | Status |
| --- | --- | --- | --- | --- |
| 1. Simulator | — | Not run | Not run | Pending |
| 2. Adapter | — | Not run | Not run | Pending |
| 3. Rule executor | — | Not run | Not run | Pending |
| 4. Case integration | — | Not run | Not run | Pending |
| 5. History and replay | — | Not run | Not run | Pending |
| 6. Agent and evidence | — | Not run | Not run | Pending |
| 7. Failure and authorization checks | — | Not run | Not run | Pending |

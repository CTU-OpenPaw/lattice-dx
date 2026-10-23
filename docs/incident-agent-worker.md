# Incident agent worker

The one-job executor handles the existing `incident-response@1` analysis wait. It does not discover jobs or replace n8n transport. The existing worker `/run` server remains a demo endpoint.

## Run one authorized job

Put these values in the ignored root `.env.agent`; never commit credentials:

```dotenv
AGENT_BASE_URL=http://localhost:20128/v1
AGENT_API_KEY=<local provider key>
AGENT_MODEL=combo
AGENT_ENGINE_URL=http://localhost:8080
AGENT_WORKER_TOKEN=<short-lived worker JWT>
```

```powershell
pnpm agent:incident <job-uuid>
```

The worker JWT needs both `connector:agent` and `agent:worker`, the correct organization, and an active directory entry. Use a dedicated worker identity; a user session token is insufficient. The requester must retain its current case, asset and attachment permissions. This change does not provision a production identity or token refresh service.

For Nhi's receiver, import `runIncidentJob(config, jobId)` from `apps/agent-worker/src/incident.ts` and pass server-side configuration and the backend dispatch job UUID. Never take provider URLs, tokens, models, or replacement context from an inbound event. Return/record a transport acknowledgement only according to the receiver's delivery contract; do not blindly rerun inference after errors. `job_conflict` requires inspecting the existing job rather than creating another one.

## Execution and limits

1. Claim the explicit job; obtain a lease of at most 60 seconds.
2. Fetch its bound context through `X-Agent-Lease`. Backend rechecks current authority.
3. Call only `combo` with a model timeout capped at 45 seconds and the remaining lease minus five seconds. No tools or external URLs are executed.
4. Accept only JSON with `summary`, `suggestedStatus`, and `evidence`. Evidence contains IDs of supplied case/asset/attachment sources, not arbitrary model citations. IDs validate references, not the truth of a diagnosis; humans must inspect the proposal.
5. Submit the proposal. Backend alone moves the workflow to `review_pending`; humans retain approval and close operations.

Context is limited to 24 KB including the prompt. Engine HTTP responses are capped at 128 KiB. Explicit clean attachments support `.txt`, `.md`, `.csv`, `.json`, and `.log`, with strict UTF-8, canonical base64 and an 8 KiB decoded limit. PDF, images, OCR and larger documents fail explicitly before inference.

The current backend context contains the bound case, asset and optional attachment. It does **not** supply a sensor history or rule snapshot. The worker is instructed to report missing observations; broker data must be explicitly and authoritatively bound before claiming sensor-based analysis.

Before submission, failure is reported using the backend's safe error codes when the lease permits it. After an ambiguous submission, the worker reads the job back and accepts only a matching persisted proposal. Otherwise it returns `result_uncertain`; it does not mark the job failed, regenerate, or reclaim automatically. Inspect the job with an authorized operator. A separate human retry policy already exists in the backend.

## Verification

```powershell
pnpm exec vitest run apps/agent-worker/src/incident.test.ts
pnpm test:agent-worker-live
pnpm check
```

The live fixture uses signed fixture identities, production API repositories, an isolated PostgreSQL schema, and a real model call through `combo`. Its test-only fetch adapter maps the confirmed host router `localhost:20128` to Docker's host address; production provider restrictions stay unchanged. The schema is removed afterwards. Credentials enter the container through stdin and are not written to files or logs.

Verified on 2026-10-19: resolved combo member `deepseek-v4.1-flash-free`, persisted proposal, `review_pending`, unchanged asset, and forbidden worker approval/close. This proves the executor, not n8n/Broker/UI delivery or the app-builder agent.

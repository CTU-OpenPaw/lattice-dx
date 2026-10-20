# UC1 intake workflow (direct API)

Import `infra/config/n8n/uc1-intake.json` into n8n. This workflow calls the existing UC1 procurement API directly; it does not require the integration service described in `uc1-n8n-integration.md`, which is not present in this checkout.

Select two separate Header Auth credentials before publishing:

- Webhook: `LatticeDX UC1 Intake Webhook`, header `Authorization`, value `Bearer <source webhook token>`.
- HTTP Request: `LatticeDX UC1 API`, header `Authorization`, value `Bearer <valid API JWT>`. The API identity needs `workflow:start` and the procurement start role (`employee`) in the intended organization. Refresh the credential when the JWT expires.

Keep tokens in n8n credentials. The exported workflow is inactive and has no credential IDs or secrets. The HTTP URL assumes n8n shares the Docker network with `gateway`; adjust that fixed URL for another deployment.

POST `/webhook/latticedx/uc1/orders` with `Content-Type: application/json`, the webhook Authorization header and `Idempotency-Key: order-001`:

```json
{"title":"Purchase laptops for IT","input":{}}
```

Only `title` (required, nonblank, at most 200 Unicode characters) and optional empty `input` are accepted. The node constructs `{definitionId:"procurement",title,input:{}}` for `POST /v1/workflows`. Procurement v1 does not accept order lines, quantities or source metadata at creation; these fields are rejected instead of silently dropped. This creates a draft, and does not submit or approve it.

Invalid schema/key returns 400 before calling the API. Webhook authentication is enforced by n8n. API status/body, including 201, 401, 403 and 409, are returned to the caller. Transport errors, timeouts and invalid upstream JSON return a sanitized 502. The HTTP node times out after 30 seconds and does not automatically retry POST.

Retry the exact same payload and key after an uncertain result. Idempotency is delegated to the backend and scoped to its authenticated actor; there is no source-record deduplication across different keys in this direct workflow. The response contains the backend workflow `id`. Use `/webhook-test/` while listening in the n8n editor, or publish for `/webhook/`.

Local contract checks: `pnpm exec vitest run tests/uc1-intake-workflow.test.ts`. These checks execute the exported validation code and inspect routing; import, credentials and live HTTP behavior still need verification in n8n.

## API Response Handling

Configure the Create UC1 Draft node as follows:

- Response Format: Text, with the response content stored in `data`.
- Include Response Headers and Status: enabled.
- Never Error: enabled to allow explicit handling of HTTP 4xx/5xx responses.
- Timeout: 30000 ms.
- Retry On Fail: disabled.
- On Error: Continue using error output.

Connect the success output to Normalize UC1 Response, then to
Return Order Result. Connect the error output to Return Integration Failure.

Normalize UC1 Response parses the response text as JSON and preserves
the upstream HTTP status and JSON body, including 201 and 409.

For non-JSON upstream responses:

- HTTP 401/403: preserve the HTTP status and return a sanitized
  `upstream_auth_error` JSON response.
- Other statuses: return HTTP 502 with `upstream_unavailable`.

Connection failures and timeouts also return a sanitized HTTP 502.
These failures do not confirm whether the backend created the workflow.
Retry with the same payload and Idempotency-Key after an uncertain result.

## Credentials and Local Setup

Configure two separate Header Auth credentials:


| Node             | Credential                   | Header                                |
| ------------------ | ------------------------------ | --------------------------------------- |
| Webhook          | LatticeDX UC1 Intake Webhook | Authorization: Bearer                 |
| Create UC1 Draft | LatticeDX UC1 API            | Authorization: Bearer <API JWT></api> |

Use different tokens for webhook authentication and API authentication.
Store token values in n8n credentials. Never include them in exported
workflow JSON, documentation, or Git.

The API identity requires `workflow:start` and the procurement start role
`employee` in the intended organization. Refresh the API JWT and update
the API credential when it expires.

The fixed API URL is `http://gateway:9080/v1/workflows`. This assumes
n8n and gateway share a Docker network. Adjust the URL for other deployments.

For editor testing, use:

`/webhook-test/latticedx/uc1/orders`

Click Execute workflow before each test request. The test webhook accepts
one request per listening session.

After publishing the workflow, use:

`/webhook/latticedx/uc1/orders`

## Verification Results — 2026-10-20


| Test case                         | Observed result             |
| ----------------------------------- | ----------------------------- |
| Valid payload                     | HTTP 201, procurement draft |
| Same key and payload              | HTTP 201, same workflow ID  |
| Same key with a different payload | HTTP 409                    |
| Blank title                       | HTTP 400                    |
| Unsupported top-level field       | HTTP 400                    |
| Non-empty input                   | HTTP 400                    |
| Missing webhook token             | HTTP 403                    |
| Invalid webhook token             | HTTP 403                    |
| Unit/contract tests               | 29/29 passed, exit code 0   |

Verified workflow ID:

`f621b8fd-ddad-4b5f-882e-2b68d10cc82c`

The normalization node has unit coverage for non-JSON HTTP 401/403
responses, malformed JSON, and invalid or missing upstream status codes.
These error scenarios have not yet been verified end to end after adding
the normalization node.

## Scope and Limitations

- The intake accepts `title` and an optional empty `input` object,
  following the procurement v1 creation contract.
- It creates a draft without submitting or approving it.
- Idempotency is delegated to the backend and scoped to the authenticated actor.
- Different keys do not provide source-record deduplication.
- The committed workflow is inactive and contains no pinned data or
  local credential IDs. Select credentials after importing it.
- Handover synchronization, Asset mapping, broker upsert/retry, and
  source-history tracing are outside this intake implementation.

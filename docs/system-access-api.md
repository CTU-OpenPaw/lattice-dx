# System access API and Studio transport

System grants belong to an organization, installed system ID and immutable system version. Grants do not create Keycloak accounts, add global platform roles, or bypass entity ownership/sharing. A user must already exist and be enabled in the organization directory.

## Administration

Administration requires both `workflow:design` and `data:design`. All commands require `Idempotency-Key`. The existing user/browser-bound Studio bridge forwards the authenticated actor; callers never supply an organization or global role override.

Let `base = /v1/systems/:id/versions/:version`:

| Method | Route | Studio operation | Payload |
|---|---|---|---|
| GET | `/v1/systems` | `adminSystems` | query: limit, offset, q |
| GET | `base` | `adminSystem` | no body |
| GET | `base/members` | `members` | query: limit, offset, q |
| POST | `base/members` | `grantMember` | body: principalType, principalId, roles |
| PUT | `base/members/:principalType/:principalId` | `updateMember` | body: expectedRevision, roles |
| DELETE | `base/members/:principalType/:principalId` | `revokeMember` | body: expectedRevision |
| GET | `base/members/history` | `memberHistory` | bridge query: limit, offset |
| GET | `base/policy` | `policy` | no body |
| POST | `base/policy/activate` | `activatePolicy` | body: expectedRevision |

For module administrators (`workflow:design` and `data:design`), `GET /v1/systems` (`adminSystems`) and `GET /v1/systems/:id/versions/:version` (`adminSystem`) provide installed system discovery and inspection from scratch. Unlike the employee runtime route (`/v1/system-apps`, which returns 404 for callers lacking business membership in managed systems), the admin endpoints list installed systems regardless of business membership, report readiness, and return `permittedBusinessRoles` derived strictly from published workflow definitions. Non-module-admin callers receive 403.

The backend additionally accepts principal filters on membership history/list according to route validation. The bridge exposes the narrower query set above. Page envelopes are `{items, page:{limit,offset,hasMore,nextOffset}}`; maximum limit is 100.

Examples with the existing browser client transport:

```js
await api.studio('grantMember', {
  id: 'company-ops', version: '1.0.0', key: 'grant-command-001',
  body: {principalType: 'person', principalId: 'verified-keycloak-subject', roles: ['employee']}
});
await api.studio('revokeMember', {
  id: 'company-ops', version: '1.0.0', key: 'revoke-command-001',
  principalType: 'person', principalId: 'verified-keycloak-subject',
  body: {expectedRevision: 1}
});
const policy = await api.studio('policy', {id: 'company-ops', version: '1.0.0'});
await api.studio('activatePolicy', {
  id: 'company-ops', version: '1.0.0', key: 'activate-command-001',
  body: {expectedRevision: policy.revision}
});
```

`principalType` is `person` or `department`. Business roles must occur in this version's persisted published workflow definitions; platform roles cannot be granted. Empty `roles: []` permits membership without a business workflow role. Grant/update responses include principal, roles, active/revoked status, revision, actor and timestamps. Revocation preserves a tombstone and increasing revision. Direct and department grants combine; removing a direct grant does not remove department-derived access.

## Effective access and activation

`GET /v1/system-apps/:id/versions/:version/access/me`, bridge `myAccess`, returns `{systemId,version,hasAccess,effectiveRoles,sources,enforcementStatus}`. `sources` distinguishes direct-person and department-derived roles.

Grants alone do not activate enforcement. An absent policy is legacy/revision 0. Explicit activation checks persisted publication and eligible directory membership, then records policy and audit. Reusing the same command with different input is a conflict. Reload state after a revision conflict. There is no public downgrade endpoint in this change.

For managed systems, active membership and business roles are scoped to the owning system, while existing global prerequisites and row-level checks remain. Workflow owners/assignees cannot bypass managed membership. Unmanaged resources retain legacy behavior. Shared schema ambiguity is rejected when managed ownership is relevant.

Errors use existing route envelopes: 400 invalid input, 401 invalid identity, 403 missing authority, 404 inaccessible/missing resource, 409 stale revision/state/idempotency conflict, 503 unavailable dependency. Do not interpret every 404 as physical deletion.

## Verification and limits

Run `node scripts/acceptance-system-access.mjs` for isolated real PostgreSQL and signed HTTP scenarios, including old-token revocation and owned workflow attachments. `node scripts/acceptance-system-studio.mjs` covers the existing configuration lifecycle. These are API acceptances, not browser walkthroughs.

This change does not implement identity provisioning, arbitrary custom blocks, a natural-language system builder, or new policy behavior for standalone non-workflow tasks, external brokers and autonomous agent workers. Their existing authorization remains separate. UI integration and full browser acceptance must be checked independently against these operation names and versioned payloads.

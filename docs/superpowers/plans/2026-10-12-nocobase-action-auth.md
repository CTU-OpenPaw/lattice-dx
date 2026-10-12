# NocoBase action authentication bridge

User authorization: write a detailed plan and execute it in this session. Branch `codex/nocobase-action-auth`, dependent on action runtime PR #2. No upstream source edits or commercial auth plugin.

## Design and acceptance

A team-owned server plugin `@latticedx/plugin-action-bridge` exposes `dxActions:connect`, `callback`, `status`, `catalog`, `run`, `disconnect`. NocoBase verifies its own bearer token/currentUser on every private route. Connect uses Authorization Code + S256 PKCE with Keycloak client `dx-nocobase`. Browser receives an authorization URL, not a Keycloak token/password. An HttpOnly SameSite=Lax cookie binds a random pending connection to the browser; state is random, one-use and expires in two minutes. Callback requires BOTH state and the matching browser cookie before exchanging code.

Linked access tokens live in process memory, at most five minutes, indexed by browser connection and bound to NocoBase user ID. No refresh token retention, token returned to client, database token storage or implicit email mapping. Same NocoBase account in another browser does not share the link. Plugin restart/expiry requires reconnection. Multiple replicas need shared secure session storage before deployment.

Callback exchanges code at Keycloak's internal endpoint with the PKCE verifier; checks the access token by fetching the authorized catalog through Gateway, and obtains subject from Keycloak userinfo. API remains authority for role/org. Never accept client-supplied bearer/owner/org for the outbound call. Catalog/run use fixed upstream paths, bounded timeouts and no automatic retries; run only accepts an action ID and version/input envelope. Disconnect clears cookie and local connection; does not claim global logout/revocation.

Credential keys/passwords in Compose are public local fixtures. Callback is fixed to `http://localhost:13000/api/dxActions:callback`, redirect on success fixed to `/admin`; no caller-defined redirects. HTTPS required outside localhost. Connecting and mutating private endpoints require explicit Authorization header and POST, limiting ambient-cookie CSRF. Callback alone is public.

This is account linking, not NocoBase SSO: user deliberately authenticates both systems. First plugin is server-only; Hưng adds client UI using this API. Group source is original Apache-2.0, upstream SDK/runtime licenses remain applicable and are documented without claiming complete compliance.

## Execution

- [x] 1. Inspect pinned NocoBase auth/resource/ACL SDK and package discovery in source/runtime. Preserve upstream. Add `plugins/nocobase/action-bridge` as a separate workspace package with CommonJS server entry (runtime-ready, no bundled upstream code). Include plugin tests in Vitest configuration.
- [x] 2. Write failing session tests: PKCE S256/verifier generation, state-cookie mismatch, expiry, one-use callback, local-user isolation, per-browser isolation, token nondisclosure, disconnection and bounded storage. Use injected time/HTTP dependencies; verify red before implementing.
- [x] 3. Implement session/HTTP bridge module and thin NocoBase plugin. Test private routes reject missing currentUser/bearer or wrong methods; callback handles denied authorization and token failure; upstream errors preserve status without leaking credentials and malformed upstream responses never expose tokens.
- [x] 4. Add Keycloak public client with standard flow enabled, direct grants disabled, PKCE S256 required, exact redirect URI and API audience/org mappers. Extend idempotent local realm sync to create/update this client without deleting users/volumes.
- [x] 5. Add plugin bind mount and local endpoint env configuration in NocoBase Compose. Provide repeatable install/enable script using NocoBase's CLI. Verify runtime resource routes, default ACL, package discovery and persistence after container recreation.
- [x] 6. Add real integration smoke: NocoBase login; anonymous/unsupported calls rejected; follow real Keycloak code flow as Alice; callback rejects wrong cookie, valid callback links; run action through NocoBase; caller scope matches Alice; second browser lacks access; disconnect blocks subsequent execution. Use fixture passwords only in server-side local script, never emit credentials/tokens/codes. Test creates data without deleting it.
- [x] 7. Document routes, Hưng's integration instructions, two-sign-in limitation, connection lifetime, errors, restart behavior, deployment/SSO/idempotency limitations and license provenance. Run full `pnpm check`, runtime smoke, prior action/foundation smoke, Compose and whitespace checks.
- [x] 8. Obtain independent security review, resolve important findings, commit/push and create dependent PR against `codex/action-runtime`. Attach PR, do not merge. Record exact tests and remaining integration work.

Success means an authenticated NocoBase request executes an action under the explicitly linked Keycloak identity without a fixed user credential or Keycloak token in the client. It does not prove reusable UI blocks or complete enterprise SSO.


Published PR: https://github.com/TrDuy-pan3000/LatticeDX/pull/3 (dependent on PR #2, open for review, not merged). Verification: 76 tests; real bridge/action/foundation smoke; package persists after container recreation. Independent review found no remaining concrete important issue after fixes.

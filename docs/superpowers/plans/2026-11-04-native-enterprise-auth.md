# Native Enterprise Authentication Implementation Plan

> **For agentic workers:** Use executing-plans to implement task-by-task, with verification checkpoints.

**Goal:** Add a selectable enterprise login plugin and native builder block; successful Keycloak login becomes a normal NocoBase session with existing native ACL.

**Architecture:** A separate SDK extension registers an authenticator type using BaseAuth, uses openid-client for authorization code + PKCE + state + nonce verification, and maps verified subject to the native usersAuthenticators table. Native users/roles/session remain authoritative. Builder only inserts a login button, never authentication or ACL logic.

**Tech Stack:** NocoBase 2.2.38 public auth/client SDK; openid-client 6.8.9; Keycloak; Node test runner; local Docker rehearsal.

## Global Constraints

- Preserve dirty teammate code, existing native lab data, password login and legacy bridge. No commit/merge without review; do not read secrets/.env or CV.pdf/a.png.
- No upstream source copying or commercial OIDC plugin reuse. Preserve dependency licenses in package.
- Use explicit root-managed subject mappings; no email linking, user creation or role provisioning at login.
- Provider endpoints and callback origin are server deployment configuration. Only loopback development may use HTTP; never disable TLS certificate verification.
- Fail closed on missing/disabled authenticator, unknown subject, inactive membership, bad state/nonce/code/issuer, expired/replayed callback or unsafe return URL.
- Use native cache and lock manager for one-time login flow; host BaseAuth issues sessions. Do not build another JWT/session engine.

### Task 1: Isolated plugin and OIDC protocol boundary

Files: `plugins/nocobase/plugin-enterprise-auth/package.json`, `src/server/policy.js`, `src/server/oidc.js`, `tests/policy.test.cjs`, `build.mjs`; `scripts/lib/nocobase-externals.mjs`.

- [x] Write failing policy tests for deployment URL validation, safe local return, binding mismatch/expiry/replay, explicit mapping and inactive membership.
- [x] Pin openid-client 6.8.9 with lockfile, bundle its dependencies and licenses, externalize host SDK.
- [x] Implement configuration validation and OIDC discovery/grant with PKCE/state/nonce and signed ID-token verification through the library.
- [x] Run `node --test plugins/nocobase/plugin-enterprise-auth/tests/*.test.cjs` and build.

### Task 2: Native authenticator and administrative mapping

Files: `src/server/index.js`, `src/server/auth.js`, `src/server/routes.js` in the new plugin.

- [x] Register `lattice-keycloak` via `app.authManager.registerTypes`; subclass BaseAuth and implement only verified subject lookup and active Employee membership check.
- [x] Add GET start/callback routes with one-time state protected by browser cookie, cache TTL, native lock, no token/error detail logging; exchange successful login through native SDK.
- [x] Add root-only explicit subject-to-user link action; reject ambiguity, invalid membership and different existing mapping. Provider settings come from deployment, no client secrets in public responses.
- [x] Verify direct auth:signIn cannot bypass verified callback; callback replay and missing browser binding fail.

### Task 3: Native client integration

Files: `src/client/index.js`, `client.js`, `client-v2.js`, `server.js` in the new plugin.

- [x] Register SignInButton/AdminSettingsForm with native plugin-auth; provide root mapping settings screen.
- [x] Register `EnterpriseLoginBlock` and Add Block initializer; component selects an enabled authenticator, uses same start endpoint, and displays errors without sensitive values.
- [x] Use a short-lived, single-use browser-bound handoff so native SDK stores host token without bearer tokens in URLs.
- [x] Check builder insertion, persisted schema and actual sign-in rendering in browser.

### Task 4: Rehearsal and integration

Files: `infra/compose/nocobase.yml`, `infra/compose/native-rehearsal.yml`, `scripts/install-workspace.mjs`, `tests/workspace-install.test.ts`, `scripts/setup-native-auth-lab.mjs`, `scripts/acceptance-native-auth.mjs`.

- [x] Add third local package to mount/build/install and installer tests; backup before runtime mutation.
- [x] Start existing Keycloak database/service; create a dedicated public PKCE client with exact callbacks, keeping existing clients untouched.
- [x] Create a dedicated native lab authenticator and explicit existing lab-user mapping; preserve credentials/roles/data.
- [x] Verify valid login, disabled/unmapped account, replay/state binding, native auth:check and organization-scoped access; verify password fallback.
- [x] Install on main local runtime only after rehearsal passes; test native lab still accessible.

### Task 5: Handoff

Files: `docs/native-enterprise-auth-guide.md`, `output/native-platform/native-auth-acceptance.json`.

- [x] Document plugin activation, native authentication settings, mapping, Add Block path, test URLs and limitations (native logout vs Keycloak SSO logout).
- [x] Report exact API/browser evidence; do not claim tests not run or tick unrelated Notion tasks.

## Verified checkpoint — 2026-11-04

- Main runtime plugin 0.1.0 installed after DB backup, native host 2.2.38. 101 listed plugins, no incompatible checker entries.
- New plugin unit tests: 9 pass; installer tests: 6 pass; live HTTP auth acceptance: 14 pass; native organization checks: 6 pass; native workflow regressions: 22 pass.
- Browser: real Keycloak login returned to native lab in rehearsal; main runtime Add block -> Enterprise login saved and survived reload; native mapping settings rendered issuer/client/callback; clicking inserted main block completed SSO and returned to native lab under employee UI.
- Fresh dependency restore tested with plugin node_modules moved aside; npm ci restored all 3 pinned dependencies, packed tar includes MIT LICENSE.md notices. Independent reviewer reports no remaining blockers in reviewed scope.
- UI evidence: output/native-platform/enterprise-login-block.jpg and enterprise-auth-settings.jpg. API evidence is separate from browser evidence.
- Supported/tested builder is classic native schema UI Lab; FlowModel V2 registration is not claimed. Single-process local cache only; global/back-channel Keycloak logout not implemented. Legacy bridge preserved. No commit/push/merge/release performed.

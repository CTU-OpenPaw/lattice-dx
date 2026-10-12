// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

const noco = 'http://localhost:13000';
const cookies = new Map();
async function request(url, options = {}, jar) {
  const headers = new Headers(options.headers);
  if (jar?.size) headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
  const response = await fetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (jar) for (const cookie of response.headers.getSetCookie()) {
    const [name, ...value] = cookie.split(';')[0].split('=');
    if (value.join('=')) jar.set(name, value.join('=')); else jar.delete(name);
  }
  return response;
}
const login = await request(noco + '/api/auth:signIn', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@nocobase.com', password: 'admin123' }),
});
assert.equal(login.status, 200, 'NocoBase fixture login');
const loginBody = await login.json();
const nocoToken = loginBody.data?.token;
assert.ok(typeof nocoToken === 'string', 'NocoBase login returns a bearer token');
const headers = { authorization: `Bearer ${nocoToken}`, 'content-type': 'application/json' };
async function bridge(action, method = 'GET', body, jar = cookies) {
  return request(`${noco}/api/dxActions:${action}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }, jar);
}
assert.equal((await request(noco + '/api/dxActions:status')).status, 401);
assert.equal((await bridge('connect')).status, 405);
assert.deepEqual(await (await bridge('status')).json(), { connected: false });
const start = await bridge('connect', 'POST');
assert.equal(start.status, 200);
const startBody = await start.json();
assert.deepEqual(Object.keys(startBody), ['authorizationUrl']);
const authorizationUrl = new URL(startBody.authorizationUrl);
assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
assert.ok(cookies.has('dx_action_connection'));
assert.match(start.headers.get('set-cookie') || '', /httponly/i);
assert.match(start.headers.get('set-cookie') || '', /samesite=lax/i);

// Exercise the actual Keycloak form/authorization-code flow as a local fixture.
// Credentials, tokens and authorization codes are never printed or written to disk.
const keycloakCookies = new Map();
const authorization = await request(authorizationUrl, {}, keycloakCookies);
assert.equal(authorization.status, 200, 'Keycloak authorization form');
const html = await authorization.text();
const formAction = html.match(/<form[^>]*action="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&');
assert.ok(formAction, 'Keycloak login form has an action');
const formUrl = new URL(formAction, authorizationUrl);
assert.equal(formUrl.origin, 'http://localhost:8081');
const signedIn = await request(formUrl, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'alice', password: 'local-alice-password', credentialId: '' }),
}, keycloakCookies);
assert.equal(signedIn.status, 302, 'Keycloak returns the authorization callback');
const callbackUrl = new URL(signedIn.headers.get('location'));
assert.equal(callbackUrl.origin, noco);
assert.equal(callbackUrl.pathname, '/api/dxActions:callback');
assert.ok(callbackUrl.searchParams.get('code'));
assert.equal((await request(callbackUrl)).status, 400, 'Callback without browser binding is denied');
const callback = await request(callbackUrl, {}, cookies);
assert.equal(callback.status, 302, 'Bound callback links the Keycloak account');
assert.equal(callback.headers.get('location'), '/admin');
assert.equal((await request(callbackUrl, {}, cookies)).status, 400, 'Callback cannot be replayed');
const status = await (await bridge('status')).json();
assert.equal(status.connected, true);
assert.equal(status.identity.username, 'alice');
assert.ok(!('token' in status) && !('access_token' in status));
const catalog = await bridge('catalog');
assert.equal(catalog.status, 200);
assert.deepEqual((await catalog.json()).items.map(item => item.id).sort(), ['records.create', 'tasks.create']);
assert.equal((await bridge('catalog', 'GET', undefined, new Map())).status, 401, 'Same NocoBase user in a different browser has no linked token');
const run = await bridge('run', 'POST', { actionId: 'records.create', version: 1, input: { title: 'NocoBase PKCE bridge smoke' } });
assert.equal(run.status, 200);
const result = await run.json();
assert.equal(result.status, 'succeeded');
assert.equal(result.result.ownerId, status.identity.subject);
assert.equal(result.result.organizationId, 'org-a');
assert.equal((await bridge('disconnect', 'POST')).status, 200);
assert.deepEqual(await (await bridge('status')).json(), { connected: false });
assert.equal((await bridge('catalog')).status, 401);
console.log('NocoBase bridge smoke passed: actual NocoBase authentication, Keycloak authorization code + PKCE, browser-bound one-use callback, scoped action through Gateway, session isolation and disconnect.');
console.log(`Created record ${result.result.id}; local demo data retained. No SSO or UI-block assertion.`);

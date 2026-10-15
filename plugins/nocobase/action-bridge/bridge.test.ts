// SPDX-License-Identifier: Apache-2.0
import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBridge } = require('./bridge.cjs');

const config = {
  authorizationUrl: 'http://localhost:8081/realms/lattice/protocol/openid-connect/auth',
  tokenUrl: 'http://keycloak:8080/realms/lattice/protocol/openid-connect/token',
  userinfoUrl: 'http://keycloak:8080/realms/lattice/protocol/openid-connect/userinfo',
  gatewayUrl: 'http://gateway:9080', clientId: 'dx-nocobase',
  callbackUrl: 'http://localhost:13000/api/dxActions:callback',
};
function setup() {
  let time = 1000;
  const calls: { url: string; options: RequestInit }[] = [];
  const bridge = createBridge(config, {
    now: () => time,
    fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (url === config.tokenUrl) return Response.json({ access_token: 'server-only-token', expires_in: 300 });
      if (url === config.userinfoUrl) return Response.json({ sub: 'alice', preferred_username: 'alice' });
      if (url.endsWith('/v1/actions')) return Response.json({ items: [] });
      return Response.json({ actionId: 'records.create', version: 1, status: 'succeeded', result: { id: 'record-1', ownerId: 'alice' } });
    },
  });
  return { bridge, calls, advance: (ms: number) => { time += ms; } };
}
async function linked() {
  const result = setup();
  const connection = result.bridge.connect('noco-1');
  const state = new URL(connection.authorizationUrl).searchParams.get('state');
  await result.bridge.callback({ state, code: 'one-time-code' }, connection.browserId);
  return { ...result, connection, state };
}
test('action key is forwarded only as a validated header; legacy calls still work',async()=>{
  const {bridge,calls,connection}=await linked();
  const payload={actionId:'records.create',version:1,input:{title:'Hello'},key:'ui-stable'};
  await bridge.run('noco-1',connection.browserId,payload);
  expect((calls.at(-1)!.options.headers as Record<string,string>)['idempotency-key']).toBe('ui-stable');
  expect(JSON.parse(String(calls.at(-1)!.options.body))).toEqual({version:1,input:{title:'Hello'}});
  const count=calls.length;
  for(const key of ['', 'bad key', ['a','b'], 'x'.repeat(129)])await expect(bridge.run('noco-1',connection.browserId,{...payload,key})).rejects.toMatchObject({status:400});
  expect(calls).toHaveLength(count);
});

test('authorization uses one-use random state and server-held S256 PKCE verifier', async () => {
  const { bridge, calls } = setup();
  const connection = bridge.connect('noco-1');
  const url = new URL(connection.authorizationUrl);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('redirect_uri')).toBe(config.callbackUrl);
  expect(url.searchParams.has('code_verifier')).toBe(false);
  await bridge.callback({ state: url.searchParams.get('state'), code: 'one-time-code' }, connection.browserId);
  const body = new URLSearchParams(String(calls[0].options.body));
  expect(body.get('grant_type')).toBe('authorization_code');
  expect(body.has('client_secret')).toBe(false);
  expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
});

test('wrong browser cookie cannot link or consume another browser pending state', async () => {
  const { bridge, calls } = setup();
  const connection = bridge.connect('noco-1');
  const query = { state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' };
  await expect(bridge.callback(query, 'other-browser')).rejects.toMatchObject({ status: 400 });
  expect(calls).toHaveLength(0);
  await bridge.callback(query, connection.browserId);
  expect(bridge.status('noco-1', connection.browserId).connected).toBe(true);
});

test('callback replay is rejected before another token exchange', async () => {
  const { bridge, calls, state, connection } = await linked();
  const count = calls.length;
  await expect(bridge.callback({ state, code: 'code' }, connection.browserId)).rejects.toMatchObject({ status: 400 });
  expect(calls).toHaveLength(count);
});

test('pending authorization expires without contacting Keycloak', async () => {
  const { bridge, advance, calls } = setup();
  const connection = bridge.connect('noco-1');
  advance(120001);
  await expect(bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId)).rejects.toMatchObject({ status: 400 });
  expect(calls).toHaveLength(0);
});

test('linked token is isolated by browser and NocoBase user and never returned in status', async () => {
  const { bridge, connection } = await linked();
  const status = bridge.status('noco-1', connection.browserId);
  expect(status).toMatchObject({ connected: true, identity: { subject: 'alice', username: 'alice' } });
  expect(JSON.stringify(status)).not.toContain('server-only-token');
  expect(bridge.status('noco-2', connection.browserId)).toEqual({ connected: false });
  expect(bridge.status('noco-1', 'other-browser')).toEqual({ connected: false });
  await expect(bridge.catalog('noco-2', connection.browserId)).rejects.toMatchObject({ status: 401 });
});

test('run forwards only server-held token to a fixed gateway path', async () => {
  const { bridge, calls, connection } = await linked();
  const result = await bridge.run('noco-1', connection.browserId, { actionId: 'records.create', version: 1, input: { title: 'Hello' } });
  expect(result.status).toBe('succeeded');
  const call = calls.at(-1)!;
  expect(call.url).toBe('http://gateway:9080/v1/actions/records.create/run');
  expect(call.options.headers).toMatchObject({ authorization: 'Bearer server-only-token' });
  expect(JSON.parse(String(call.options.body))).toEqual({ version: 1, input: { title: 'Hello' } });
  await expect(bridge.run('noco-1', connection.browserId, { actionId: '../health', version: 1, input: {} })).rejects.toMatchObject({ status: 400 });
  await expect(bridge.run('noco-1', connection.browserId, { actionId: 'records.create', version: 1, input: {}, token: 'override' })).rejects.toMatchObject({ status: 400 });
});

test('access expiry and disconnect remove local execution access', async () => {
  const { bridge, connection, advance } = await linked();
  bridge.disconnect('noco-2', connection.browserId);
  expect(bridge.status('noco-1', connection.browserId).connected).toBe(true);
  advance(300001);
  expect(bridge.status('noco-1', connection.browserId)).toEqual({ connected: false });
  const second = await linked();
  second.bridge.disconnect('noco-1', second.connection.browserId);
  await expect(second.bridge.catalog('noco-1', second.connection.browserId)).rejects.toMatchObject({ status: 401 });
});

test('denied authorization never establishes a connection', async () => {
  const { bridge, calls } = setup();
  const connection = bridge.connect('noco-1');
  await expect(bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), error: 'access_denied' }, connection.browserId)).rejects.toMatchObject({ status: 400 });
  expect(calls).toHaveLength(0);
  expect(bridge.status('noco-1', connection.browserId)).toEqual({ connected: false });
});

test('untrusted token exchange errors never disclose credentials', async () => {
  const bridge = createBridge(config, { fetch: async () => Response.json({ error: 'server-only-token' }, { status: 400 }) });
  const connection = bridge.connect('noco-1');
  await expect(bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId)).rejects.toMatchObject({ status: 502, message: 'Keycloak token exchange failed.' });
});

test('pending connection storage is bounded and recovers after expiry', () => {
  let time = 0;
  const bridge = createBridge(config, { now: () => time, maxConnections: 1 });
  bridge.connect('noco-1');
  expect(() => bridge.connect('noco-2')).toThrow('Connection capacity reached.');
  time = 120001;
  expect(() => bridge.connect('noco-2')).not.toThrow();
});

test('in-flight code exchange retains its connection capacity slot', async () => {
  let release: (response: Response) => void = () => {};
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const bridge = createBridge(config, { maxConnections: 1, fetch: async (url: string) => {
    if (url === config.tokenUrl) return gate;
    if (url === config.userinfoUrl) return Response.json({ sub: 'alice' });
    return Response.json({ items: [] });
  } });
  const connection = bridge.connect('noco-1');
  const exchange = bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId);
  expect(() => bridge.connect('noco-2')).toThrow('Connection capacity reached.');
  release(Response.json({ access_token: 'secret', expires_in: 300 }));
  await exchange;
});

test('disconnect during code exchange cannot resurrect a linked session', async () => {
  let release: (response: Response) => void = () => {};
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const bridge = createBridge(config, { fetch: async (url: string) => {
    if (url === config.tokenUrl) return gate;
    if (url === config.userinfoUrl) return Response.json({ sub: 'alice' });
    return Response.json({ items: [] });
  } });
  const connection = bridge.connect('noco-1');
  const exchange = bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId);
  bridge.disconnect('noco-1', connection.browserId);
  release(Response.json({ access_token: 'secret', expires_in: 300 }));
  await expect(exchange).rejects.toMatchObject({ status: 401 });
  expect(bridge.status('noco-1', connection.browserId)).toEqual({ connected: false });
});

test('invalid token response never creates an authenticated session', async () => {
  const bridge = createBridge(config, { fetch: async () => Response.json({ access_token: 'secret', expires_in: 0 }) });
  const connection = bridge.connect('noco-1');
  await expect(bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId)).rejects.toMatchObject({ status: 502 });
  expect(bridge.status('noco-1', connection.browserId)).toEqual({ connected: false });
});

test('failed gateway validation never links the token or exposes upstream errors', async () => {
  const bridge = createBridge(config, { fetch: async (url: string) => url === config.tokenUrl
    ? Response.json({ access_token: 'secret-token', expires_in: 300 })
    : Response.json({ error: 'secret-token' }, { status: 403 }) });
  const connection = bridge.connect('noco-1');
  await expect(bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId)).rejects.toMatchObject({ status: 403, message: 'Action catalog request failed.' });
  expect(bridge.status('noco-1', connection.browserId)).toEqual({ connected: false });
});

test('scheduled expiry purges the session without another request or lazy clock cleanup', async () => {
  const timers: { callback: () => void; delay: number }[] = [];
  const bridge = createBridge(config, { now: () => 1000, schedule: (callback: () => void, delay: number) => {
    timers.push({ callback, delay }); return { unref() {} };
  }, cancelTimer: () => {}, fetch: async (url: string) => {
    if (url === config.tokenUrl) return Response.json({ access_token: 'secret', expires_in: 300 });
    if (url === config.userinfoUrl) return Response.json({ sub: 'alice' });
    return Response.json({ items: [] });
  } });
  const connection = bridge.connect('noco-1');
  await bridge.callback({ state: new URL(connection.authorizationUrl).searchParams.get('state'), code: 'code' }, connection.browserId);
  expect(bridge.status('noco-1', connection.browserId).connected).toBe(true);
  expect(timers.map(timer => timer.delay)).toEqual([120000, 300000]);
  timers[1].callback();
  expect(bridge.status('noco-1', connection.browserId)).toEqual({ connected: false });
});

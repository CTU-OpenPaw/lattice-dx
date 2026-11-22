/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
type Context = {
  method: string; state: { currentUser?: { id: number } }; request: { body?: unknown }; query: object;
  cookies: { get: () => undefined; set: () => undefined }; get: () => string; set: () => undefined;
  redirect: () => undefined; status?: number; body?: unknown; withoutDataWrapping?: boolean;
};
async function setup() {
  let handlers: Record<string, (ctx: Context, next: () => Promise<void>) => Promise<void>> = {};
  const allowances: unknown[][] = [];
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL('./server.cjs', import.meta.url), 'utf8'), {
    module, URL,
    require: (name: string) => name === '@nocobase/server' ? { Plugin: class {} } : require('./bridge.cjs'),
    process: { env: { DX_BRIDGE_CALLBACK_URL: 'http://localhost:13000/api/dxActions:callback', DX_BRIDGE_ISSUER: 'http://localhost:8081/realms/lattice', DX_BRIDGE_INTERNAL_ISSUER: 'http://keycloak:8080/realms/lattice', DX_BRIDGE_GATEWAY_URL: 'http://gateway:9080' } },
  });
  const PluginClass = module.exports as unknown as new () => { app: object; load: () => Promise<void> };
  const plugin = new PluginClass();
  plugin.app = { resourceManager: { define: (resource: { actions: typeof handlers }) => { handlers = resource.actions; } }, acl: { allow: (...args: unknown[]) => allowances.push(args) } };
  await plugin.load();
  return { handlers, allowances };
}
function context(method: string, authenticated = true): Context {
  return { method, state: authenticated ? { currentUser: { id: 1 } } : {}, request: {}, query: {},
    cookies: { get: () => undefined, set: () => undefined }, get: () => authenticated ? 'Bearer noco-token' : '', set: () => undefined, redirect: () => undefined };
}
test('only callback is public and all private handlers demand NocoBase bearer identity', async () => {
  const { handlers, allowances } = await setup();
  expect(allowances.filter(item => item[2] === 'public')).toEqual([['dxActions', 'callback', 'public']]);
  for (const [name, method] of [['connect', 'POST'], ['status', 'GET'], ['catalog', 'GET'], ['run', 'POST'], ['disconnect', 'POST']]) {
    const ctx = context(method, false);
    await handlers[name](ctx, async () => {});
    expect(ctx.status).toBe(401);
  }
});
test('mutating endpoints reject GET even when authenticated', async () => {
  const { handlers } = await setup();
  for (const name of ['connect', 'run', 'disconnect']) {
    const ctx = context('GET');
    await handlers[name](ctx, async () => {});
    expect(ctx.status).toBe(405);
  }
});
test('a current user without explicit bearer header cannot mutate connection state', async () => {
  const { handlers } = await setup();
  const ctx = context('POST'); ctx.get = () => '';
  await handlers.connect(ctx, async () => {});
  expect(ctx.status).toBe(401);
});

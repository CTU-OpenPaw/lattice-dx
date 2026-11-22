/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge } = require('../bridge.cjs');

test('Agent bridge validates job operations, scopes session and forwards authorized requests', async () => {
  const calls = [];
  let deny = false;
  const bridge = createBridge(
    {
      gatewayUrl: 'http://gateway',
      tokenUrl: 'http://identity/token',
      userinfoUrl: 'http://identity/user',
      authorizationUrl: 'http://identity/auth',
      clientId: 'fixture',
      callbackUrl: 'http://localhost/callback'
    },
    {
      schedule: () => ({ unref() {} }),
      cancelTimer: () => {},
      fetch: async (url, options) => {
        calls.push({ url, options });
        return Response.json(
          url.endsWith('/token')
            ? { access_token: 'fixture-token', expires_in: 300 }
            : url.endsWith('/user')
            ? { sub: 'alice' }
            : url.endsWith('/actions')
            ? { items: [{ id: 'act-1', version: 1, title: 'Act', requiredRole: 'user', inputSchema: { type: 'object' } }] }
            : { items: [{ id: 'job-1', status: 'completed' }] },
          { status: deny ? 404 : 200 }
        );
      }
    }
  );

  const start = bridge.connect('noco');
  await bridge.callback({ state: new URL(start.authorizationUrl).searchParams.get('state'), code: 'fixture' }, start.browserId);
  const jobId = '11111111-1111-4111-8111-111111111111';

  // Bad inputs rejected
  await assert.rejects(bridge.agent('noco', start.browserId, { operation: 'invalid' }), { status: 400 });
  await assert.rejects(bridge.agent('noco', start.browserId, { operation: 'detail', id: 'not-a-uuid' }), { status: 400 });
  await assert.rejects(bridge.agent('noco', start.browserId, { operation: 'retry', id: jobId }), { status: 400 }); // missing key/body
  await assert.rejects(bridge.agent('other', start.browserId, { operation: 'detail', id: jobId }), { status: 401 });

  // List jobs
  await bridge.agent('noco', start.browserId, { operation: 'list', query: { runId: '22222222-2222-4222-8222-222222222222', limit: '10' } });
  assert.equal(calls.at(-1).url, 'http://gateway/v1/agent-jobs?runId=22222222-2222-4222-8222-222222222222&limit=10');
  assert.equal(calls.at(-1).options.method, 'GET');
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer fixture-token');

  // Job detail
  await bridge.agent('noco', start.browserId, { operation: 'detail', id: jobId });
  assert.equal(calls.at(-1).url, `http://gateway/v1/agent-jobs/${jobId}`);
  assert.equal(calls.at(-1).options.method, 'GET');

  // Retry job
  await bridge.agent('noco', start.browserId, { operation: 'retry', id: jobId, key: 'retry-key-01', body: { expectedVersion: 1 } });
  assert.equal(calls.at(-1).url, `http://gateway/v1/agent-jobs/${jobId}/retry`);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).options.headers['idempotency-key'], 'retry-key-01');

  // 404 propagation
  deny = true;
  await assert.rejects(bridge.agent('noco', start.browserId, { operation: 'detail', id: jobId }), { status: 404 });
  bridge.disconnect('noco', start.browserId);
});

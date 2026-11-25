#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseLiveLlmArgs,
  selectWorkingLlmModel,
  runLiveLlmToolLoop,
} from '../acceptance-live-llm-app-builder.mjs';

test('parseLiveLlmArgs validates origin and parses flags cleanly', () => {
  const opts = parseLiveLlmArgs([
    '--origin=http://127.0.0.1:13015',
    '--llm-base-url=http://127.0.0.1:20128/v1/',
    '--model=ag/gemini-3.8-flash',
    '--org=acme-clinic',
  ]);
  assert.equal(opts.origin, 'http://127.0.0.1:13015');
  assert.equal(opts.llmBaseUrl, 'http://127.0.0.1:20128/v1');
  assert.equal(opts.model, 'ag/gemini-3.8-flash');
  assert.equal(opts.organizationId, 'acme-clinic');
  assert.throws(() => parseLiveLlmArgs(['--origin=https://evil.example.com']));
  assert.throws(() => parseLiveLlmArgs(['--unknown-flag']));
});

test('selectWorkingLlmModel skips failing upstream models and returns non-secret diagnostics when all fail', async () => {
  const secretToken = 'sk-must-not-leak-in-probes';
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    if (url.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'ag/gemini-3.8-flash' }, { id: 'oc/union-alpha' }, { id: 'working/model-v1' }] }),
      };
    }
    const body = JSON.parse(init.body || '{}');
    if (body.model === 'ag/gemini-3.8-flash') {
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'HTTP 403' } }) };
    }
    if (body.model === 'oc/union-alpha') {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Model unavailable' } }) };
    }
    if (body.model === 'working/model-v1') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 't1' }] } }] }),
      };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };

  const hit = await selectWorkingLlmModel({
    llmBaseUrl: 'http://127.0.0.1:20128/v1',
    apiKey: secretToken,
    fetchImpl: fakeFetch,
  });
  assert.equal(hit.selectedModel, 'working/model-v1');
  assert.equal(hit.probes.length, 3);
  assert.equal(JSON.stringify(hit).includes(secretToken), false);

  const allFail = await selectWorkingLlmModel({
    llmBaseUrl: 'http://127.0.0.1:20128/v1',
    apiKey: secretToken,
    fetchImpl: async (url, init = {}) => (
      url.endsWith('/models')
        ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'broken/a' }] }) }
        : { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'DeepSeek invalid token' } }) }
    ),
  });
  assert.equal(allFail.selectedModel, null);
  assert.equal(allFail.probes[0].status, 503);
  assert.equal(JSON.stringify(allFail).includes(secretToken), false);
});

test('runLiveLlmToolLoop executes multi-turn tool calls and feeds tool errors back for self-correction', async () => {
  let turn = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      turn += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (turn === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'dxos_provision_role_workspace', arguments: JSON.stringify({ operation: 'build_enterprise_app', collectionName: 'users' }) },
              }],
            },
          }],
        }));
        return;
      }
      if (turn === 2) {
        const parsedReq = JSON.parse(body);
        assert.ok(parsedReq.messages.some((m) => m.role === 'tool' && m.content.includes('SYSTEM_COLLECTION_FORBIDDEN')));
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_2',
                type: 'function',
                function: { name: 'dxos_provision_role_workspace', arguments: JSON.stringify({ operation: 'build_enterprise_app', collectionName: 'latticeCustomClinicVisits' }) },
              }],
            },
          }],
        }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Đã dựng xong ứng dụng Phòng khám.' } }],
      }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const addr = server.address();
    const out = await runLiveLlmToolLoop({
      llmBaseUrl: `http://127.0.0.1:${addr.port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-gpt',
      systemPrompt: 'sys',
      toolDefinition: { name: 'dxos_provision_role_workspace', description: 'build', parameters: { type: 'object', properties: {} } },
      userPrompt: 'Build clinic app',
      maxTurns: 4,
      executeTool: async (_name, args) => (
        args.collectionName === 'users'
          ? { isError: true, error: 'SYSTEM_COLLECTION_FORBIDDEN' }
          : { built: true, ok: true, collections: [args.collectionName] }
      ),
    });
    assert.equal(out.turnCount, 2);
    assert.equal(out.toolExecutions[0].ok, false);
    assert.equal(out.toolExecutions[1].ok, true);
    assert.equal(out.finalReply, 'Đã dựng xong ứng dụng Phòng khám.');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

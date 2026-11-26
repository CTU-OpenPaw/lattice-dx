/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const INTEGRATIONS_PATH = path.join(PLUGIN_ROOT, 'src/server/flow/nodes/integrations.js');
const HEADER_SCRIPT = path.resolve(PLUGIN_ROOT, '../../../scripts/source-headers.mjs');

test('notify.send exposes omnichannel schema fields, enforces <= 350 line cap and SPDX header', async () => {
  const { integrationNodes } = require(INTEGRATIONS_PATH);
  const notifyNode = integrationNodes.find((n) => n.type === 'notify.send');
  assert.ok(notifyNode);

  assert.deepEqual(notifyNode.defaultConfig.notifyChannels, ['in_app']);
  assert.equal(notifyNode.defaultConfig.templateKey, '');
  assert.deepEqual(notifyNode.defaultConfig.channelConfig, {});

  const fields = notifyNode.inputSchema.fields;
  const channelsField = fields.find((f) => f.name === 'notifyChannels');
  const templateField = fields.find((f) => f.name === 'templateKey');
  const channelCfgField = fields.find((f) => f.name === 'channelConfig');

  assert.ok(channelsField, 'notifyChannels field must exist');
  assert.equal(channelsField.type, 'json');
  assert.deepEqual(channelsField.options, ['in_app', 'email_smtp', 'telegram', 'slack', 'webhook']);
  assert.ok(templateField && templateField.type === 'string');
  assert.ok(channelCfgField && channelCfgField.type === 'json');

  const raw = readFileSync(INTEGRATIONS_PATH, 'utf8');
  assert.ok(raw.split(/\r?\n/).length <= 350, 'integrations.js must stay <= 350 lines');
  const { addSourceHeader } = await import(pathToFileURL(HEADER_SCRIPT).href);
  assert.equal(addSourceHeader(raw, INTEGRATIONS_PATH).status, 'present');
  assert.equal(addSourceHeader(readFileSync(__filename, 'utf8'), __filename).status, 'present');
});

test('notify.send normalizes array/JSON/CSV notifyChannels, strips proto keys in channelConfig, and forwards lookupImpl + dryRun fields', async () => {
  const { integrationNodes } = require(INTEGRATIONS_PATH);
  const notifyNode = integrationNodes.find((n) => n.type === 'notify.send');
  const calls = [];
  const mockLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const mockFetch = async () => ({ ok: true });
  const notificationCenter = {
    async dispatchRoleNotifications(db, payload, opts) {
      calls.push({ db, payload, opts });
      return { dispatchedCount: 2 };
    },
  };

  // Array input + template interpolation + prototype key sanitization
  const dirtyChannelCfg = JSON.parse('{"connectorKey":"tg-ops","__proto__":{"polluted":true},"nested":{"constructor":"bad","ok":1}}');
  const res1 = await notifyNode.execute({
    config: {
      roleNames: ['ldx_operator'],
      title: 'Alert {{code}}',
      body: 'Check {{item}}',
      notifyChannels: ['telegram', 'SLACK', 'invalid_chan', 'telegram'],
      templateKey: 'tpl_{{tpl}}',
      channelConfig: dirtyChannelCfg,
    },
    input: { data: { code: 'A1', item: 'pump', tpl: 'ops_alert' } },
    context: { organizationId: 'org-a' },
    options: { notificationCenter, fetchImpl: mockFetch, lookupImpl: mockLookup, env: { NODE_ENV: 'test' } },
  });
  assert.equal(res1.nextPort, 'main');
  assert.equal(res1.output.dispatched, 2);
  assert.deepEqual(calls[0].payload.notifyChannels, ['telegram', 'slack']);
  assert.equal(calls[0].payload.templateKey, 'tpl_ops_alert');
  assert.deepEqual(calls[0].payload.channelConfig, { connectorKey: 'tg-ops', nested: { ok: 1 } });
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].payload.channelConfig, '__proto__'), false);
  assert.equal(calls[0].opts.lookupImpl, mockLookup);
  assert.equal(calls[0].opts.fetchImpl, mockFetch);

  // JSON string & CSV notifyChannels + dryRun
  const resDry = await notifyNode.execute({
    config: {
      roleNames: ['ldx_admin'],
      title: 'Dry',
      notifyChannels: '["email_smtp","webhook"]',
      templateKey: 'incident_alert',
    },
    context: { organizationId: 'org-a' },
    options: { dryRun: true, notificationCenter },
  });
  assert.equal(resDry.output.simulated, true);
  assert.deepEqual(resDry.output.notifyChannels, ['email_smtp', 'webhook']);
  assert.equal(resDry.output.templateKey, 'incident_alert');

  // CSV fallback & empty fallback to ['in_app']
  await notifyNode.execute({
    config: { roleNames: ['ldx_operator'], title: 'CSV', notifyChannels: 'in_app, slack , email_smtp' },
    context: { organizationId: 'org-a' },
    options: { notificationCenter },
  });
  assert.deepEqual(calls[1].payload.notifyChannels, ['in_app', 'slack', 'email_smtp']);

  await notifyNode.execute({
    config: { roleNames: ['ldx_operator'], title: 'Fallback', notifyChannels: ['unknown_only'] },
    context: { organizationId: 'org-a' },
    options: { notificationCenter },
  });
  assert.deepEqual(calls[2].payload.notifyChannels, ['in_app']);
});

test('integrations.js exports notify helpers and Flow blocklists include all 5 Wave 3 tables', async () => {
  const integrations = require(INTEGRATIONS_PATH);
  assert.deepEqual(integrations.NOTIFY_CHANNELS, ['in_app', 'email_smtp', 'telegram', 'slack', 'webhook']);
  assert.equal(typeof integrations.normalizeNotifyChannels, 'function');
  assert.equal(typeof integrations.parseChannelConfig, 'function');
  assert.deepEqual(integrations.normalizeNotifyChannels('telegram, invalid'), ['telegram']);
  assert.deepEqual(integrations.parseChannelConfig('{"connectorKey":"tg-1","__proto__":{"x":1}}'), { connectorKey: 'tg-1' });

  const { FORBIDDEN_SYSTEM_COLLECTIONS } = require(path.join(PLUGIN_ROOT, 'src/server/flow/schema.js'));
  const { dataNodes } = require(path.join(PLUGIN_ROOT, 'src/server/flow/nodes/data.js'));
  const { validateFlowGraph, validatePromptSecurity } = require(path.join(PLUGIN_ROOT, 'src/server/flow/validator.js'));
  const { isAllowlistedTargetCollection } = require(path.join(PLUGIN_ROOT, 'src/server/automation-engine.js'));
  const dataCreateNode = dataNodes.find((n) => n.type === 'data.create');
  assert.ok(dataCreateNode);

  const wave3Tables = [
    'latticeNotificationDeliveries',
    'latticeApprovalPolicies',
    'latticeApprovalRequests',
    'latticePublicForms',
    'latticePublicFormSubmissions',
  ];
  for (const col of wave3Tables) {
    assert.equal(FORBIDDEN_SYSTEM_COLLECTIONS.has(col), true, `FORBIDDEN_SYSTEM_COLLECTIONS must include ${col}`);
    assert.equal(isAllowlistedTargetCollection(col), false, `automation-engine isAllowlistedTargetCollection must reject ${col}`);
    const valRes = validateFlowGraph({
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'd1', type: 'data.create', config: { collection: col, values: { x: 1 } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'd1', targetHandle: 'in' }],
    });
    assert.equal(valRes.ok, false, `validateFlowGraph must reject ${col}`);
    assert.equal(validatePromptSecurity({ prompt: `query ${col}` }).refused, true, `validatePromptSecurity must refuse ${col}`);
    await assert.rejects(
      () => dataCreateNode.execute({ config: { collection: col, values: { x: 1 } }, context: { organizationId: 'org-a' } }),
      (err) => err?.code === 'TARGET_COLLECTION_FORBIDDEN' || /TARGET_COLLECTION_FORBIDDEN/.test(String(err?.message || '')),
    );
  }
});

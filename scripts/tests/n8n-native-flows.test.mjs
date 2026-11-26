/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const requireFromTest = createRequire(import.meta.url);

const COLDCHAIN_PATH = join(ROOT, 'infra/config/n8n/dxos-coldchain-alert-orchestrator.json');
const EPOD_PATH = join(ROOT, 'infra/config/n8n/dxos-epod-partner-sync.json');
const ENT_COMPLIANCE_PATH = join(ROOT, 'infra/config/n8n/dxos-enterprise-compliance-orchestrator.json');
const ENT_ERROR_HANDLER_PATH = join(ROOT, 'infra/config/n8n/dxos-enterprise-error-handler.json');
const EXTERNAL_CALLBACK_PATH = join(ROOT, 'infra/config/n8n/dxos-external-app-inbound-callback.json');
const ENT_BLUEPRINT_PATH = join(
  ROOT,
  'plugins/nocobase/plugin-dxos-studio/src/server/flow/blueprints/enterprise-n8n-compliance.json',
);

const SECRET_TOKEN_RE = /(?:ldx_pat_[0-9a-f]{8}_[0-9a-f]{32}|whsec_[A-Za-z0-9+/=]{12,}|sk-(?:proj-|live-|test-)?[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const FORBIDDEN_LEGACY_ASSISTANT_RE = new RegExp(`\\b${['co', 'pilot'].join('')}\\b`, 'i');

function loadWorkflow(path) {
  const raw = readFileSync(path, 'utf8');
  return { raw, workflow: JSON.parse(raw) };
}

function getNode(workflow, name) {
  const found = workflow.nodes.find((n) => n.name === name);
  assert.ok(found, `Missing node "${name}" in workflow "${workflow.name}"`);
  return found;
}

function compileCodeNode(workflow, nodeName) {
  const node = getNode(workflow, nodeName);
  assert.equal(node.type, 'n8n-nodes-base.code');
  assert.equal(typeof node.parameters?.jsCode, 'string');
  return new Function('$input', '$env', 'require', node.parameters.jsCode);
}

function evalN8nExpr(expr, { $json = {}, $env = {}, $ = () => ({ first: () => ({ json: {} }) }) } = {}) {
  assert.equal(typeof expr, 'string');
  assert.ok(expr.startsWith('={{') && expr.endsWith('}}'), `Expected n8n expression, got: ${expr}`);
  const inner = expr.slice(3, -2).trim();
  const fn = new Function('$json', '$env', '$', `return (${inner});`);
  return fn($json, $env, $);
}

function signStandardWebhook({ webhookId, timestampSec, rawBody, secret }) {
  const keyBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'utf8');
  const sig = createHmac('sha256', keyBytes)
    .update(`${webhookId}.${timestampSec}.${rawBody}`, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

function runCode(fn, { json = {}, binary = undefined, env = {} }) {
  const item = binary ? { json, binary } : { json };
  const result = fn({ first: () => item }, env, requireFromTest);
  assert.ok(Array.isArray(result) && result.length === 1 && result[0]?.json, 'Code node must return a single-item array');
  return result[0].json;
}

const WORKFLOW_SPECS = [
  {
    label: 'coldchain-alert-orchestrator',
    path: COLDCHAIN_PATH,
    expectedName: 'LatticeDX v1.0 Cold-Chain Alert & CMMS Orchestrator',
    webhookNodeName: 'Receive Cold-Chain Webhook',
    webhookPath: 'latticedx/v1/coldchain-alert',
    httpNodeName: 'Dispatch NocoBase Automation',
    expectedApiPath: '/api/dxosAutomations:runNow',
    successNodeName: 'Respond Success',
  },
  {
    label: 'epod-partner-sync',
    path: EPOD_PATH,
    expectedName: 'LatticeDX v1.0 ePOD & Voucher Partner Sync',
    webhookNodeName: 'Receive ePOD & Voucher Webhook',
    webhookPath: 'latticedx/v1/epod-partner-sync',
    httpNodeName: 'Sign Document in NocoBase Ledger',
    expectedApiPath: '/api/dxosLedger:signDocument',
    successNodeName: 'Respond Attested',
  },
];

for (const spec of WORKFLOW_SPECS) {
  test(`${spec.label}: valid n8n 2.48.1 structure, SPDX meta, zero hardcoded secrets, zero legacy /v1/ API paths, and $env PAT auth`, () => {
    const { raw, workflow } = loadWorkflow(spec.path);

    assert.equal(workflow.name, spec.expectedName);
    assert.equal(workflow.active, false);
    assert.deepEqual(workflow.pinData, {});
    assert.equal(workflow.settings?.executionOrder, 'v1');
    assert.equal(workflow.settings?.saveDataSuccessExecution, 'none');
    assert.equal(workflow.settings?.saveDataErrorExecution, 'all');
    assert.equal(workflow.settings?.errorWorkflow, 'dxos-enterprise-error-handler');
    assert.equal(workflow.settings?.saveManualExecutions, false);

    assert.equal(workflow.meta?.author, 'CTU-OpenPaw');
    assert.equal(workflow.meta?.license, 'Apache-2.0');
    assert.equal(workflow.meta?.spdx, 'SPDX-License-Identifier: Apache-2.0');

    assert.equal(SECRET_TOKEN_RE.test(raw), false, `${spec.label} must contain zero hardcoded secrets`);

    assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length >= 6);
    const nodeNames = new Set();
    const nodeIds = new Set();
    for (const node of workflow.nodes) {
      assert.ok(typeof node.id === 'string' && node.id.length > 0);
      assert.ok(!nodeIds.has(node.id), `Duplicate node id: ${node.id}`);
      nodeIds.add(node.id);
      assert.ok(typeof node.name === 'string' && node.name.length > 0);
      assert.ok(!nodeNames.has(node.name), `Duplicate node name: ${node.name}`);
      nodeNames.add(node.name);
      assert.match(node.type, /^n8n-nodes-base\./);
      assert.equal(typeof node.typeVersion, 'number');
      assert.ok(Array.isArray(node.position) && node.position.length === 2);
      for (const cred of Object.values(node.credentials ?? {})) {
        assert.equal(cred.id, undefined, 'Credential IDs must never be exported into Git');
      }
    }

    // Graph integrity: every connection source & target exists
    for (const [sourceName, outputMap] of Object.entries(workflow.connections ?? {})) {
      assert.ok(nodeNames.has(sourceName), `Connection source missing: ${sourceName}`);
      for (const branchList of outputMap.main ?? []) {
        for (const edge of branchList) {
          assert.ok(nodeNames.has(edge.node), `Connection target missing: ${edge.node}`);
        }
      }
    }

    // Webhook trigger validation
    const webhookNode = getNode(workflow, spec.webhookNodeName);
    assert.equal(webhookNode.type, 'n8n-nodes-base.webhook');
    assert.equal(webhookNode.parameters?.httpMethod, 'POST');
    assert.equal(webhookNode.parameters?.path, spec.webhookPath);
    assert.equal(webhookNode.parameters?.responseMode, 'responseNode');
    assert.equal(webhookNode.parameters?.authentication, 'none');
    assert.match(webhookNode.notes || '', /SPDX-License-Identifier:\s*Apache-2\.0/);

    // HTTP Request validation
    const httpNode = getNode(workflow, spec.httpNodeName);
    assert.equal(httpNode.type, 'n8n-nodes-base.httpRequest');
    assert.equal(httpNode.parameters?.method, 'POST');
    assert.equal(httpNode.onError, 'continueErrorOutput');
    assert.equal(httpNode.retryOnFail, true);
    assert.equal(httpNode.maxTries, 3);
    assert.equal(httpNode.parameters?.options?.redirect?.redirect?.followRedirects, false);

    const urlExpr = httpNode.parameters?.url;
    assert.ok(urlExpr.includes('$env.DX_NOCOBASE_BASE_URL'));
    assert.ok(urlExpr.includes('http://nocobase'));
    assert.ok(urlExpr.includes(spec.expectedApiPath));
    assert.doesNotMatch(urlExpr, /\/v1\//, 'HTTP callback URL must not use legacy /v1/ API path');
    assert.doesNotMatch(raw, /http:\/\/gateway|http:\/\/api:|\/v1\/workflows|\/v1\/chat\/completions|\/v1\/integrations/);

    assert.equal(
      evalN8nExpr(urlExpr, { $env: {} }),
      `http://nocobase${spec.expectedApiPath}`,
    );
    assert.equal(
      evalN8nExpr(urlExpr, { $env: { DX_NOCOBASE_BASE_URL: 'https://dx.example.org///' } }),
      `https://dx.example.org${spec.expectedApiPath}`,
    );

    const headers = httpNode.parameters?.headerParameters?.parameters ?? [];
    const authHeader = headers.find((h) => h.name === 'Authorization');
    const contentTypeHeader = headers.find((h) => h.name === 'Content-Type');
    assert.ok(authHeader, 'Missing Authorization header');
    assert.ok(authHeader.value.includes('$env.DX_NOCOBASE_PAT'));
    assert.equal(
      evalN8nExpr(authHeader.value, { $env: { DX_NOCOBASE_PAT: 'pat-runtime-token' } }),
      'Bearer pat-runtime-token',
    );
    assert.equal(contentTypeHeader?.value, 'application/json');

    // Auth If node routes false -> 401 Respond Unauthorized
    const authIfBranches = workflow.connections['Webhook Authenticated?'].main;
    assert.equal(authIfBranches[1][0].node, 'Respond Unauthorized');
    const unauthNode = getNode(workflow, 'Respond Unauthorized');
    assert.equal(unauthNode.type, 'n8n-nodes-base.respondToWebhook');
    const unauthBody = evalN8nExpr(unauthNode.parameters.responseBody, {
      $json: { code: 'WEBHOOK_SIGNATURE_INVALID', error: 'bad sig' },
    });
    assert.equal(unauthBody.ok, false);
    assert.equal(unauthBody.workflow, spec.label);
    assert.equal(unauthBody.error, 'WEBHOOK_SIGNATURE_INVALID');
  });

  test(`${spec.label}: extracted Standard Webhooks HMAC-SHA256 Code node passes valid signatures and rejects forged/expired/missing inputs`, () => {
    const { workflow } = loadWorkflow(spec.path);
    const verifyFn = compileCodeNode(workflow, 'Verify Standard Webhook');

    const plainSecret = 'test-standard-webhook-secret-2026';
    const whsecSecret = `whsec_${randomBytes(32).toString('base64')}`;
    const payload = {
      specversion: '1.0',
      id: 'evt-cc-1001',
      source: 'urn:latticedx:test',
      type: spec.label === 'coldchain-alert-orchestrator' ? 'alarm.triggered' : 'epod.captured',
      time: '2026-11-23T15:00:00.000Z',
      data: {
        organizationId: 'org-alpha',
        assetId: 42,
        deviceKey: 'sensor-cold-01',
        severity: 'critical',
        orderId: 77,
      },
    };
    const compactRaw = JSON.stringify(payload);
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Valid plain secret signature
    const sigPlain = signStandardWebhook({
      webhookId: 'msg_valid_001',
      timestampSec: nowSec,
      rawBody: compactRaw,
      secret: plainSecret,
    });
    const okPlain = runCode(verifyFn, {
      json: {
        headers: {
          'webhook-id': 'msg_valid_001',
          'webhook-timestamp': String(nowSec),
          'webhook-signature': sigPlain,
        },
        body: payload,
      },
      env: { DX_WEBHOOK_SECRET: plainSecret },
    });
    assert.equal(okPlain.authenticated, true);
    assert.equal(okPlain.webhookId, 'msg_valid_001');
    assert.deepEqual(okPlain.body, payload);

    // 2. Valid whsec_ base64 secret + rotated multi-signature header + mixed-case headers + binary rawBody
    const prettyRaw = JSON.stringify(payload, null, 2);
    const sigWhsec = signStandardWebhook({
      webhookId: 'msg_whsec_002',
      timestampSec: nowSec - 299,
      rawBody: prettyRaw,
      secret: whsecSecret,
    });
    const okWhsec = runCode(verifyFn, {
      json: {
        headers: {
          'Webhook-Id': 'msg_whsec_002',
          'Webhook-Timestamp': String(nowSec - 299),
          'Webhook-Signature': `v1,aW52YWxpZHNpZ25hdHVyZTEyMzQ1Njc4OTAxMjM0NTY= ${sigWhsec}`,
        },
        body: payload,
      },
      binary: {
        data: {
          data: Buffer.from(prettyRaw, 'utf8').toString('base64'),
          mimeType: 'application/json',
        },
      },
      env: { DX_WEBHOOK_SECRET: whsecSecret },
    });
    assert.equal(okWhsec.authenticated, true);
    assert.equal(okWhsec.webhookId, 'msg_whsec_002');
    assert.deepEqual(okWhsec.body, payload);

    // 3. Forged / wrong signature -> 401
    const forged = runCode(verifyFn, {
      json: {
        headers: {
          'webhook-id': 'msg_valid_001',
          'webhook-timestamp': String(nowSec),
          'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        },
        body: payload,
      },
      env: { DX_WEBHOOK_SECRET: plainSecret },
    });
    assert.equal(forged.authenticated, false);
    assert.equal(forged.statusCode, 401);
    assert.equal(forged.code, 'WEBHOOK_SIGNATURE_INVALID');

    // 4. Tampered body after signing -> 401
    const tampered = runCode(verifyFn, {
      json: {
        headers: {
          'webhook-id': 'msg_valid_001',
          'webhook-timestamp': String(nowSec),
          'webhook-signature': sigPlain,
        },
        body: { ...payload, data: { ...payload.data, organizationId: 'org-evil' } },
      },
      env: { DX_WEBHOOK_SECRET: plainSecret },
    });
    assert.equal(tampered.authenticated, false);
    assert.equal(tampered.statusCode, 401);

    // 5. Expired timestamp (> 300s past) and future timestamp (> 300s ahead) -> 401
    for (const staleTs of [nowSec - 301, nowSec + 301]) {
      const staleSig = signStandardWebhook({
        webhookId: 'msg_stale',
        timestampSec: staleTs,
        rawBody: compactRaw,
        secret: plainSecret,
      });
      const expired = runCode(verifyFn, {
        json: {
          headers: {
            'webhook-id': 'msg_stale',
            'webhook-timestamp': String(staleTs),
            'webhook-signature': staleSig,
          },
          body: payload,
        },
        env: { DX_WEBHOOK_SECRET: plainSecret },
      });
      assert.equal(expired.authenticated, false);
      assert.equal(expired.statusCode, 401);
      assert.equal(expired.code, 'WEBHOOK_TIMESTAMP_EXPIRED');
    }

    // 6. Malformed timestamp -> 401
    const badTs = runCode(verifyFn, {
      json: {
        headers: {
          'webhook-id': 'msg_bad_ts',
          'webhook-timestamp': 'not-a-number',
          'webhook-signature': sigPlain,
        },
        body: payload,
      },
      env: { DX_WEBHOOK_SECRET: plainSecret },
    });
    assert.equal(badTs.authenticated, false);
    assert.equal(badTs.statusCode, 401);

    // 7. Missing required headers -> 401
    const missingHdr = runCode(verifyFn, {
      json: {
        headers: { 'webhook-id': 'msg_only_id' },
        body: payload,
      },
      env: { DX_WEBHOOK_SECRET: plainSecret },
    });
    assert.equal(missingHdr.authenticated, false);
    assert.equal(missingHdr.statusCode, 401);
    assert.equal(missingHdr.code, 'WEBHOOK_HEADERS_MISSING');

    // 8. Missing DX_WEBHOOK_SECRET -> fails closed 401
    const noSecret = runCode(verifyFn, {
      json: {
        headers: {
          'webhook-id': 'msg_valid_001',
          'webhook-timestamp': String(nowSec),
          'webhook-signature': sigPlain,
        },
        body: payload,
      },
      env: {},
    });
    assert.equal(noSecret.authenticated, false);
    assert.equal(noSecret.statusCode, 401);
    assert.equal(noSecret.code, 'WEBHOOK_SECRET_NOT_CONFIGURED');
  });
}

test('coldchain-alert-orchestrator: branch logic classifies alarm.triggered, device.offline, lot.held_mkt and builds response', () => {
  const { workflow } = loadWorkflow(COLDCHAIN_PATH);
  const classifyFn = compileCodeNode(workflow, 'Classify & Route Cold-Chain Event');

  const alarmOut = runCode(classifyFn, {
    json: {
      webhookId: 'wh-alarm-1',
      body: {
        specversion: '1.0',
        id: 'evt-alarm-1',
        type: 'alarm.triggered',
        time: '2026-11-23T15:05:00.000Z',
        data: {
          organizationId: 'org-cold-1',
          assetId: '15',
          deviceKey: 'freezer-01',
          severity: 'critical',
          alarmCode: 'ALM-TEMP-HIGH',
          numericValue: 9.4,
        },
      },
    },
  });
  assert.equal(alarmOut.dispatchCallback, true);
  assert.equal(alarmOut.route, 'cmms_alarm_escalation');
  assert.equal(alarmOut.priority, 'urgent');
  assert.equal(alarmOut.organizationId, 'org-cold-1');
  assert.equal(alarmOut.assetId, 15);
  assert.equal(alarmOut.deviceKey, 'freezer-01');
  assert.equal(alarmOut.severity, 'critical');
  assert.equal(alarmOut.callbackPayload.automationCode, 'auto_cmms_on_coldchain_fault');
  assert.equal(alarmOut.callbackPayload.context.route, 'cmms_alarm_escalation');

  const offlineOut = runCode(classifyFn, {
    json: {
      webhookId: 'wh-off-1',
      body: {
        specversion: '1.0',
        id: 'evt-off-1',
        type: 'device.offline',
        data: {
          organizationId: 'org-cold-1',
          assetId: 16,
          deviceKey: 'gateway-node-02',
        },
      },
    },
  });
  assert.equal(offlineOut.dispatchCallback, true);
  assert.equal(offlineOut.route, 'cmms_device_offline_dispatch');
  assert.equal(offlineOut.severity, 'high');
  assert.equal(offlineOut.priority, 'high');

  const mktOut = runCode(classifyFn, {
    json: {
      webhookId: 'wh-mkt-1',
      body: {
        specversion: '1.0',
        id: 'evt-mkt-1',
        type: 'lot.held_mkt',
        data: {
          organizationId: 'org-cold-1',
          assetId: 18,
          deviceKey: 'chamber-03',
          lotCode: 'LOT-VAC-2026-09',
          mktCelsius: 11.2,
        },
      },
    },
  });
  assert.equal(mktOut.dispatchCallback, true);
  assert.equal(mktOut.route, 'coldchain_mkt_quarantine_escalation');
  assert.equal(mktOut.priority, 'urgent');
  assert.equal(mktOut.callbackPayload.context.lotCode, 'LOT-VAC-2026-09');

  const ignoredOut = runCode(classifyFn, {
    json: {
      webhookId: 'wh-other-1',
      body: {
        specversion: '1.0',
        id: 'evt-other-1',
        type: 'inventory.recounted',
        data: { organizationId: 'org-cold-1' },
      },
    },
  });
  assert.equal(ignoredOut.dispatchCallback, false);
  assert.equal(ignoredOut.ignored, true);
  assert.equal(ignoredOut.statusCode, 200);

  const missingOrgOut = runCode(classifyFn, {
    json: {
      webhookId: 'wh-noorg-1',
      body: { specversion: '1.0', id: 'evt-noorg-1', type: 'alarm.triggered', data: {} },
    },
  });
  assert.equal(missingOrgOut.dispatchCallback, false);
  assert.equal(missingOrgOut.invalidPayload, true);
  assert.equal(missingOrgOut.statusCode, 400);

  // Verify Respond Success expression matches required contract
  const respondSuccess = getNode(workflow, 'Respond Success');
  const responseBody = evalN8nExpr(respondSuccess.parameters.responseBody, {
    $: (name) => {
      assert.equal(name, 'Classify & Route Cold-Chain Event');
      return { first: () => ({ json: alarmOut }) };
    },
  });
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.workflow, 'coldchain-alert-orchestrator');
  assert.equal(responseBody.eventId, 'evt-alarm-1');
  assert.equal(responseBody.callbackDispatched, true);
});

test('epod-partner-sync: attestation builder maps ePOD & voucher targets to dxosLedger:signDocument and formats response', () => {
  const { workflow } = loadWorkflow(EPOD_PATH);
  const buildFn = compileCodeNode(workflow, 'Build Partner Attestation Payload');

  const epodOut = runCode(buildFn, {
    json: {
      webhookId: 'wh-epod-1',
      body: {
        specversion: '1.0',
        id: 'evt-epod-901',
        type: 'epod.captured',
        data: {
          organizationId: 'org-log-1',
          orderId: 501,
          epodUid: 'EPOD-2026-XYZ',
          trackingCode: 'LDX-TRK-99887',
          partnerCode: 'vnpost-cold',
        },
      },
    },
  });
  assert.equal(epodOut.valid, true);
  assert.equal(epodOut.targetCollection, 'latticeOrders');
  assert.equal(epodOut.targetRecordId, 501);
  assert.equal(epodOut.signDocumentPayload.organizationId, 'org-log-1');
  assert.equal(epodOut.signDocumentPayload.targetCollection, 'latticeOrders');
  assert.equal(epodOut.signDocumentPayload.targetRecordId, 501);
  assert.ok(epodOut.signDocumentPayload.reason.includes('LDX-TRK-99887'));
  assert.ok(epodOut.signDocumentPayload.reason.length <= 255);

  const voucherOut = runCode(buildFn, {
    json: {
      webhookId: 'wh-voucher-1',
      body: {
        specversion: '1.0',
        id: 'evt-voucher-22',
        type: 'voucher.submitted',
        data: {
          organizationId: 'org-log-1',
          targetCollection: 'latticeRequests',
          targetRecordId: '88',
          voucherCode: 'REQ-2026-0088',
        },
      },
    },
  });
  assert.equal(voucherOut.valid, true);
  assert.equal(voucherOut.targetCollection, 'latticeRequests');
  assert.equal(voucherOut.targetRecordId, 88);

  const invalidOut = runCode(buildFn, {
    json: {
      webhookId: 'wh-bad-1',
      body: {
        specversion: '1.0',
        id: 'evt-bad-1',
        type: 'epod.captured',
        data: {
          organizationId: 'org-log-1',
          targetCollection: 'latticeUsers',
          targetRecordId: 1,
        },
      },
    },
  });
  assert.equal(invalidOut.valid, false);
  assert.equal(invalidOut.statusCode, 400);

  // Verify Respond Attested expression matches required contract
  const respondAttested = getNode(workflow, 'Respond Attested');
  const responseBody = evalN8nExpr(respondAttested.parameters.responseBody, {
    $json: { body: { merkleRoot: 'abc123', keyId: 'pki-key-1' } },
    $: (name) => {
      assert.equal(name, 'Build Partner Attestation Payload');
      return { first: () => ({ json: epodOut }) };
    },
  });
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.workflow, 'epod-partner-sync');
  assert.equal(responseBody.eventId, 'evt-epod-901');
  assert.equal(responseBody.attested, true);
  assert.equal(responseBody.merkleRoot, 'abc123');
});

function assertStockN8nGraphIntegrity(raw, workflow, label) {
  assert.equal(workflow.active, false, `${label} must be inactive on export`);
  assert.deepEqual(workflow.pinData, {}, `${label} pinData must be empty`);
  assert.equal(workflow.settings?.executionOrder, 'v1', `${label} executionOrder must be v1`);
  assert.equal(workflow.meta?.author, 'CTU-OpenPaw', `${label} meta.author`);
  assert.equal(workflow.meta?.license, 'Apache-2.0', `${label} meta.license`);
  assert.equal(workflow.meta?.spdx, 'SPDX-License-Identifier: Apache-2.0', `${label} meta.spdx`);
  assert.equal(SECRET_TOKEN_RE.test(raw), false, `${label} must contain zero hardcoded secrets`);
  assert.equal(FORBIDDEN_LEGACY_ASSISTANT_RE.test(raw), false, `${label} must contain zero forbidden legacy assistant strings`);
  assert.doesNotMatch(
    raw,
    /http:\/\/gateway|http:\/\/api:|\/v1\/workflows|\/v1\/chat\/completions|\/v1\/integrations/,
    `${label} must not reference legacy /v1/ endpoints`,
  );

  assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length > 0);
  const nodeNames = new Set();
  const nodeIds = new Set();
  for (const node of workflow.nodes) {
    assert.ok(typeof node.id === 'string' && node.id.length > 0);
    assert.ok(!nodeIds.has(node.id), `${label}: duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    assert.ok(typeof node.name === 'string' && node.name.length > 0);
    assert.ok(!nodeNames.has(node.name), `${label}: duplicate node name ${node.name}`);
    nodeNames.add(node.name);
    assert.match(node.type, /^n8n-nodes-base\./, `${label}: node ${node.name} must use stock n8n-nodes-base.*`);
    assert.equal(typeof node.typeVersion, 'number', `${label}: node ${node.name} typeVersion must be numeric`);
    assert.ok(Array.isArray(node.position) && node.position.length === 2, `${label}: node ${node.name} position`);
    for (const cred of Object.values(node.credentials ?? {})) {
      assert.equal(cred.id, undefined, `${label}: credential IDs must never be exported into Git (${node.name})`);
    }
  }

  for (const [sourceName, outputMap] of Object.entries(workflow.connections ?? {})) {
    assert.ok(nodeNames.has(sourceName), `${label}: connection source missing: ${sourceName}`);
    for (const branchList of outputMap.main ?? []) {
      for (const edge of branchList) {
        assert.ok(nodeNames.has(edge.node), `${label}: connection target missing: ${edge.node}`);
      }
    }
  }
}

test('enterprise-compliance-orchestrator: flagship >=22-node 2-way Cold-Chain Settlement & External-App graph validates HMAC, DMN, PKI, Orion-LD, MQTT, Telegram/SMTP/Sheets/Slack/GitHub, retries, and errorWorkflow', () => {
  const { raw, workflow } = loadWorkflow(ENT_COMPLIANCE_PATH);
  assertStockN8nGraphIntegrity(raw, workflow, 'enterprise-compliance-orchestrator');

  assert.ok(workflow.nodes.length >= 22, `Expected >= 22 nodes, got ${workflow.nodes.length}`);
  assert.equal(workflow.settings?.saveDataErrorExecution, 'all');
  assert.equal(workflow.settings?.errorWorkflow, 'dxos-enterprise-error-handler');

  const nodeTypes = new Set(workflow.nodes.map((n) => n.type));
  for (const requiredType of [
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.code',
    'n8n-nodes-base.if',
    'n8n-nodes-base.switch',
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.merge',
    'n8n-nodes-base.respondToWebhook',
    'n8n-nodes-base.telegram',
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.googleSheets',
    'n8n-nodes-base.slack',
    'n8n-nodes-base.github',
  ]) {
    assert.ok(nodeTypes.has(requiredType), `Missing required Stock n8n node type: ${requiredType}`);
  }

  const externalNodes = [
    'Evaluate Settlement DMN Policy',
    'Sign Document in NocoBase Ledger',
    'Upsert Digital Twin in Orion-LD',
    'Dispatch Edge Interlock (Node-RED MQTT)',
    'Trigger NocoBase Escalation',
    'Notify Ops via Telegram',
    'Send Partner Settlement Email',
    'Append Partner Ledger (Google Sheets)',
    'Post Incident Alert to Slack',
    'Create Audit Issue in GitHub',
  ];
  for (const nodeName of externalNodes) {
    const node = getNode(workflow, nodeName);
    assert.equal(node.onError, 'continueErrorOutput', `${nodeName} must continueErrorOutput`);
    assert.equal(node.retryOnFail, true, `${nodeName} must enable retryOnFail`);
    assert.ok(Number(node.maxTries) >= 2, `${nodeName} must configure maxTries >= 2`);
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.equal(node.parameters?.options?.redirect?.redirect?.followRedirects, false);
      assert.ok(String(node.parameters?.url || '').includes('$env.'));
    }
  }

  const dmnHttp = getNode(workflow, 'Evaluate Settlement DMN Policy');
  assert.equal(
    evalN8nExpr(dmnHttp.parameters.url, { $env: {} }),
    'http://nocobase/api/dxosDmn:evaluate',
  );
  const orionHttp = getNode(workflow, 'Upsert Digital Twin in Orion-LD');
  assert.equal(
    evalN8nExpr(orionHttp.parameters.url, { $env: {} }),
    'http://orion-ld:1026/ngsi-ld/v1/entityOperations/upsert?options=update',
  );
  const edgeHttp = getNode(workflow, 'Dispatch Edge Interlock (Node-RED MQTT)');
  assert.equal(
    evalN8nExpr(edgeHttp.parameters.url, { $env: {} }),
    'http://nodered:1880/twin/command',
  );
  assert.equal(getNode(workflow, 'Merge Critical Branches').parameters?.numberInputs, 5);
  assert.equal(getNode(workflow, 'Merge External App Dispatches').parameters?.numberInputs, 5);

  const verifyFn = compileCodeNode(workflow, 'Verify Standard Webhook');
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const rawBody = JSON.stringify({ organizationId: 'org-ent', amount: 125000000, severity: 'critical' });
  const ts = String(Math.floor(Date.now() / 1000));
  const whId = 'msg_ent_1';
  const sig = signStandardWebhook({ webhookId: whId, timestampSec: ts, rawBody, secret });
  const verified = runCode(verifyFn, {
    json: { headers: { 'webhook-id': whId, 'webhook-timestamp': ts, 'webhook-signature': sig }, rawBody },
    env: { DX_WEBHOOK_SECRET: secret },
  });
  assert.equal(verified.authenticated, true);

  const scoreFn = compileCodeNode(workflow, 'Score Risk & Batch Compliance');
  const crit = runCode(scoreFn, {
    json: {
      body: {
        organizationId: 'org-ent',
        type: 'record.latticeRequests.create',
        data: {
          id: 7,
          assetId: 4,
          code: 'REQ-ENT-7',
          amount: 125000000,
          severity: 'critical',
          temperatureC: -8,
          slaOverdueMinutes: 45,
          partnerCode: 'vnpost-cold',
          partnerEmail: 'claims@vnpost-cold.example.com',
          lotCode: 'LOT-VAC-2026-09',
          items: [{ sku: 'A', value: 60000000 }, { sku: 'B', value: 65000000 }],
        },
      },
    },
  });
  assert.equal(crit.tier, 'critical');
  assert.equal(crit.riskScore, 100);
  assert.equal(crit.partnerClaimRequired, true);
  assert.ok(crit.settlementEstimateVnd > 0);
  assert.equal(crit.signDocumentPayload.targetRecordId, 7);
  assert.equal(crit.orionEntityId, 'urn:ngsi-ld:ComplianceAlert:org-ent:REQ-ENT-7');
  assert.equal(crit.edgeInterlockPayload.assetId, 4);
  assert.equal(crit.dmnEvaluatePayload.tableKey, 'coldchain_settlement_policy_v1');

  const mergeDmnNode = getNode(workflow, 'Merge Risk & DMN Decision');
  const mergeDmnFn = new Function('$input', '$', 'require', mergeDmnNode.parameters.jsCode);
  const mergedDecision = mergeDmnFn(
    { first: () => ({ json: { body: { data: { matched: true, decision: { settlementTier: 'critical', settlementRatePct: 80, approveClaim: true } } } } }) },
    (name) => {
      assert.equal(name, 'Score Risk & Batch Compliance');
      return { first: () => ({ json: crit }) };
    },
    requireFromTest,
  )[0].json;
  assert.equal(mergedDecision.dmnMatched, true);
  assert.equal(mergedDecision.settlementRatePct, 80);
  assert.equal(mergedDecision.settlementEstimateVnd, 100000000);
  assert.ok(mergedDecision.telegramMessage.includes('REQ-ENT-7'));
  assert.ok(mergedDecision.emailSubject.includes('REQ-ENT-7'));
  assert.ok(mergedDecision.slackMessage.includes('REQ-ENT-7'));
  assert.ok(mergedDecision.githubIssueTitle.includes('REQ-ENT-7'));
  assert.equal(mergedDecision.googleSheetRow.code, 'REQ-ENT-7');

  const normPkiFn = compileCodeNode(workflow, 'Normalize PKI Attestation');
  const pkiItem = runCode(normPkiFn, { json: { body: { data: { signed: true, keyId: 'ed25519-k1', merkleRoot: 'mrk-999' } } } });
  assert.equal(pkiItem.signed, true);
  assert.equal(pkiItem.merkleRoot, 'mrk-999');

  const normOrionNode = getNode(workflow, 'Normalize Orion-LD Sync');
  const normOrionFn = new Function('$input', '$', 'require', normOrionNode.parameters.jsCode);
  const orionItem = normOrionFn(
    { first: () => ({ json: { statusCode: 201 } }) },
    () => ({ first: () => ({ json: mergedDecision }) }),
    requireFromTest,
  )[0].json;
  assert.equal(orionItem.synced, true);
  assert.equal(orionItem.entityId, 'urn:ngsi-ld:ComplianceAlert:org-ent:REQ-ENT-7');

  const normEdgeNode = getNode(workflow, 'Normalize Edge Interlock');
  const normEdgeFn = new Function('$input', '$', 'require', normEdgeNode.parameters.jsCode);
  const edgeItem = normEdgeFn(
    { first: () => ({ json: { statusCode: 202, body: { commandId: mergedDecision.edgeInterlockPayload.commandId } } }) },
    () => ({ first: () => ({ json: mergedDecision }) }),
    requireFromTest,
  )[0].json;
  assert.equal(edgeItem.dispatched, true);
  assert.equal(edgeItem.mqttTopic, 'latticedx/org-ent/4/command');

  const dossierFn = compileCodeNode(workflow, 'Build Partner & Regulatory Dossier');
  const dossierItem = runCode(dossierFn, { json: mergedDecision });
  assert.equal(dossierItem.kind, 'partner_dossier');
  assert.equal(dossierItem.itemCount, 2);

  const normExtNode = getNode(workflow, 'Normalize External App Dispatches');
  const normExtFn = new Function('$input', '$', 'require', normExtNode.parameters.jsCode);
  const extItem = normExtFn(
    {
      all: () => [
        { json: { ok: true, result: { message_id: 701 } } },
        { json: { accepted: ['claims@vnpost-cold.example.com'], messageId: '<smtp-1@latticedx>' } },
        { json: { updates: { updatedRows: 1 } } },
        { json: { ok: true, ts: '1732460000.0001' } },
        { json: { error: { message: 'GITHUB_TOKEN_NOT_CONFIGURED' } } },
      ],
    },
    () => ({ first: () => ({ json: mergedDecision }) }),
    requireFromTest,
  )[0].json;
  assert.equal(extItem.kind, 'external_apps');
  assert.equal(extItem.totalChannels, 5);
  assert.equal(extItem.succeededCount, 4);
  assert.equal(extItem.degradedCount, 1);

  const aggNode = getNode(workflow, 'Aggregate Orchestration Receipt');
  const aggFn = new Function('$input', '$', '$execution', aggNode.parameters.jsCode);
  const aggOut = aggFn(
    { all: () => [{ json: pkiItem }, { json: orionItem }, { json: edgeItem }, { json: dossierItem }, { json: extItem }] },
    (name) => {
      assert.equal(name, 'Merge Risk & DMN Decision');
      return { first: () => ({ json: mergedDecision }) };
    },
    { id: 'exec-live-26' },
  );
  assert.equal(aggOut[0].json.ok, true);
  assert.equal(aggOut[0].json.n8nExecutionId, 'exec-live-26');
  assert.deepEqual(aggOut[0].json.systemsOrchestrated, [
    'nocobase-pki-ledger',
    'fiware-orion-ld',
    'nodered-mqtt-edge',
    'partner-regulatory-dossier',
    'external-apps-fanout',
  ]);
  assert.equal(aggOut[0].json.pkiAttestation.merkleRoot, 'mrk-999');
  assert.equal(aggOut[0].json.digitalTwinSync.synced, true);
  assert.equal(aggOut[0].json.edgeInterlock.dispatched, true);
  assert.equal(aggOut[0].json.partnerDispatch.itemCount, 2);
  assert.equal(aggOut[0].json.externalAppsDispatched.succeededCount, 4);
  assert.equal(aggOut[0].json.settlementSummary.settlementEstimateVnd, 100000000);
});

test('enterprise-error-handler: starts with errorTrigger, scrubs secrets, notifies ops, and logs incident event back to NocoBase', () => {
  const { raw, workflow } = loadWorkflow(ENT_ERROR_HANDLER_PATH);
  assertStockN8nGraphIntegrity(raw, workflow, 'enterprise-error-handler');
  assert.equal(workflow.settings?.saveDataErrorExecution, 'all');

  const triggerNode = workflow.nodes[0];
  assert.equal(triggerNode.type, 'n8n-nodes-base.errorTrigger');

  const httpNode = getNode(workflow, 'Log Error Event to NocoBase');
  assert.equal(httpNode.type, 'n8n-nodes-base.httpRequest');
  assert.equal(httpNode.parameters?.method, 'POST');
  assert.equal(httpNode.retryOnFail, true);
  assert.ok(Number(httpNode.maxTries) >= 2);
  assert.equal(httpNode.onError, 'continueErrorOutput');
  assert.equal(
    evalN8nExpr(httpNode.parameters.url, { $env: {} }),
    'http://nocobase/api/dxosEvents:publish',
  );
  const headers = httpNode.parameters?.headerParameters?.parameters ?? [];
  const authHeader = headers.find((h) => h.name === 'Authorization');
  assert.ok(authHeader?.value?.includes('$env.DX_NOCOBASE_PAT'));
  assert.equal(
    evalN8nExpr(authHeader.value, { $env: { DX_NOCOBASE_PAT: 'ldx_pat_12345678_abcdef' } }),
    'Bearer ldx_pat_12345678_abcdef',
  );

  const tgNode = getNode(workflow, 'Notify Ops on Error (Telegram)');
  assert.equal(tgNode.type, 'n8n-nodes-base.telegram');
  assert.equal(tgNode.retryOnFail, true);
  const mailNode = getNode(workflow, 'Send Error Alert Email');
  assert.equal(mailNode.type, 'n8n-nodes-base.emailSend');
  assert.equal(mailNode.retryOnFail, true);

  const formatFn = compileCodeNode(workflow, 'Format Error Incident Payload');
  const formatted = runCode(formatFn, {
    json: {
      execution: {
        id: 'exec-err-99',
        url: 'http://n8n:5678/execution/exec-err-99',
        lastNodeExecuted: 'Append Partner Ledger (Google Sheets)',
        error: {
          message: 'Request failed with Bearer ldx_pat_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
      workflow: {
        id: 'wf-ent-1',
        name: 'LatticeDX v1.0 Enterprise Multi-System Compliance & Partner Settlement Orchestrator',
      },
    },
    env: { DX_DEFAULT_ORG_ID: 'org-ent' },
  });
  assert.equal(formatted.organizationId, 'org-ent');
  assert.equal(formatted.nocobaseEventPayload.type, 'automation.n8n_failed');
  assert.equal(formatted.nocobaseEventPayload.organizationId, 'org-ent');
  assert.equal(
    formatted.nocobaseEventPayload.data.errorMessage.includes('ldx_pat_'),
    false,
    'Sensitive PAT tokens must be redacted from error payloads',
  );
  assert.ok(formatted.telegramMessage.includes('exec-err-99'));
  assert.ok(formatted.emailSubject.includes('exec-err-99'));
});

test('external-app-inbound-callback: verifies multi-provider signatures fail-closed and updates NocoBase status via ldx_pat_* bearer auth', () => {
  const { raw, workflow } = loadWorkflow(EXTERNAL_CALLBACK_PATH);
  assertStockN8nGraphIntegrity(raw, workflow, 'external-app-inbound-callback');
  assert.equal(workflow.settings?.saveDataErrorExecution, 'all');
  assert.equal(workflow.settings?.errorWorkflow, 'dxos-enterprise-error-handler');

  const webhookNode = getNode(workflow, 'Receive External App Callback');
  assert.equal(webhookNode.type, 'n8n-nodes-base.webhook');
  assert.equal(webhookNode.parameters?.httpMethod, 'POST');
  assert.equal(webhookNode.parameters?.path, 'latticedx/v1/external-app-callback');
  assert.equal(webhookNode.parameters?.responseMode, 'responseNode');

  const updateHttp = getNode(workflow, 'Update Record Status in NocoBase');
  assert.equal(updateHttp.type, 'n8n-nodes-base.httpRequest');
  assert.equal(updateHttp.parameters?.method, 'POST');
  assert.equal(updateHttp.retryOnFail, true);
  assert.ok(Number(updateHttp.maxTries) >= 2);
  assert.equal(updateHttp.onError, 'continueErrorOutput');
  assert.equal(
    evalN8nExpr(updateHttp.parameters.url, {
      $env: {},
      $json: { targetCollection: 'latticeCustomPartnerClaims', targetRecordId: 42 },
    }),
    'http://nocobase/api/latticeCustomPartnerClaims:update?filterByTk=42',
  );
  const authHdr = (updateHttp.parameters?.headerParameters?.parameters ?? []).find((h) => h.name === 'Authorization');
  assert.ok(authHdr?.value?.includes('$env.DX_NOCOBASE_PAT'));
  assert.equal(
    evalN8nExpr(authHdr.value, { $env: { DX_NOCOBASE_PAT: 'ldx_pat_deadbeef_0123456789abcdef0123456789abcdef' } }),
    'Bearer ldx_pat_deadbeef_0123456789abcdef0123456789abcdef',
  );

  const eventHttp = getNode(workflow, 'Publish Callback Event to NocoBase');
  assert.equal(eventHttp.type, 'n8n-nodes-base.httpRequest');
  assert.equal(eventHttp.retryOnFail, true);
  assert.equal(
    evalN8nExpr(eventHttp.parameters.url, { $env: {} }),
    'http://nocobase/api/dxosEvents:publish',
  );

  const verifyFn = compileCodeNode(workflow, 'Verify Inbound Callback Signature');
  const nowSec = Math.floor(Date.now() / 1000);
  const partnerBody = {
    organizationId: 'org-ent',
    sourceApp: 'partner_webhook',
    targetCollection: 'latticeCustomPartnerClaims',
    targetRecordId: 42,
    decision: 'settled',
    settlementAmountVnd: 100000000,
    partnerReference: 'PARTNER-ACK-77',
  };
  const partnerRaw = JSON.stringify(partnerBody);
  const whSecret = 'inbound-wh-secret-2026';
  const whSig = signStandardWebhook({ webhookId: 'cb_1', timestampSec: nowSec, rawBody: partnerRaw, secret: whSecret });
  const okPartner = runCode(verifyFn, {
    json: {
      headers: {
        'webhook-id': 'cb_1',
        'webhook-timestamp': String(nowSec),
        'webhook-signature': whSig,
      },
      rawBody: partnerRaw,
      body: partnerBody,
    },
    env: { DX_WEBHOOK_SECRET: whSecret },
  });
  assert.equal(okPartner.authenticated, true);
  assert.equal(okPartner.authScheme, 'standard_webhooks');

  const tgBody = {
    callback_query: {
      id: 'tg_cb_1',
      from: { username: 'ops_director' },
      data: 'approve_claim:org-ent:latticeCustomPartnerClaims:42',
    },
  };
  const okTg = runCode(verifyFn, {
    json: {
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret-token-2026' },
      body: tgBody,
    },
    env: { DX_TELEGRAM_WEBHOOK_SECRET: 'tg-secret-token-2026' },
  });
  assert.equal(okTg.authenticated, true);
  assert.equal(okTg.authScheme, 'telegram_secret_token');

  const slackSecret = 'slack-signing-secret-2026';
  const slackRaw = JSON.stringify({
    organizationId: 'org-ent',
    targetCollection: 'latticeIncidentCases',
    targetRecordId: 9,
    decision: 'acknowledged',
    sourceApp: 'slack',
  });
  const slackSig = `v0=${createHmac('sha256', slackSecret).update(`v0:${nowSec}:${slackRaw}`, 'utf8').digest('hex')}`;
  const okSlack = runCode(verifyFn, {
    json: {
      headers: { 'x-slack-request-timestamp': String(nowSec), 'x-slack-signature': slackSig },
      rawBody: slackRaw,
    },
    env: { DX_SLACK_SIGNING_SECRET: slackSecret },
  });
  assert.equal(okSlack.authenticated, true);
  assert.equal(okSlack.authScheme, 'slack_v0');

  const rejected = runCode(verifyFn, {
    json: {
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-token' },
      body: tgBody,
    },
    env: { DX_TELEGRAM_WEBHOOK_SECRET: 'tg-secret-token-2026' },
  });
  assert.equal(rejected.authenticated, false);
  assert.equal(rejected.statusCode, 401);

  const normalizeFn = compileCodeNode(workflow, 'Normalize Inbound Action & Target');
  const normPartner = runCode(normalizeFn, {
    json: { authenticated: true, authScheme: 'standard_webhooks', body: partnerBody },
  });
  assert.equal(normPartner.valid, true);
  assert.equal(normPartner.targetCollection, 'latticeCustomPartnerClaims');
  assert.equal(normPartner.targetRecordId, 42);
  assert.equal(normPartner.updatePayload.status, 'settled');
  assert.equal(normPartner.updatePayload.settlementStatus, 'settled');
  assert.equal(normPartner.eventPublishPayload.type, 'partner.settlement_callback');

  const normTg = runCode(normalizeFn, {
    json: { authenticated: true, authScheme: 'telegram_secret_token', body: tgBody },
  });
  assert.equal(normTg.valid, true);
  assert.equal(normTg.sourceApp, 'telegram');
  assert.equal(normTg.organizationId, 'org-ent');
  assert.equal(normTg.targetCollection, 'latticeCustomPartnerClaims');
  assert.equal(normTg.targetRecordId, 42);
  assert.equal(normTg.updatePayload.status, 'approved');

  const badTarget = runCode(normalizeFn, {
    json: {
      authenticated: true,
      authScheme: 'standard_webhooks',
      body: { organizationId: 'org-ent', targetCollection: 'users', targetRecordId: 1, decision: 'approved' },
    },
  });
  assert.equal(badTarget.valid, false);
  assert.equal(badTarget.statusCode, 400);
});

test('enterprise-n8n-compliance blueprint in plugin-dxos-studio aligns with the >=22-node Cold-Chain Settlement orchestrator and passes validateFlowGraph', () => {
  const raw = readFileSync(ENT_BLUEPRINT_PATH, 'utf8');
  assert.equal(FORBIDDEN_LEGACY_ASSISTANT_RE.test(raw), false);
  assert.equal(/17[- ]node/i.test(raw), false, 'Blueprint must no longer reference stale 17-node count');
  const bp = JSON.parse(raw);
  assert.equal(bp.blueprintKey, 'auto_enterprise_n8n_compliance');
  assert.equal(bp.ruleKey, 'auto_enterprise_n8n_compliance');

  const n8nNode = bp.graphJson.nodes.find((n) => n.id === 'call_n8n_orchestrator');
  assert.ok(n8nNode);
  assert.equal(n8nNode.type, 'integration.http');
  assert.equal(n8nNode.config.connectorKey, 'n8n-enterprise-orchestrator');
  assert.equal(n8nNode.config.path, '/webhook/latticedx/v1/enterprise-compliance-orchestrator');

  const { validateFlowGraph } = requireFromTest(
    join(ROOT, 'plugins/nocobase/plugin-dxos-studio/src/server/flow/validator.js'),
  );
  const flowRegistry = requireFromTest(
    join(ROOT, 'plugins/nocobase/plugin-dxos-studio/src/server/flow/registry.js'),
  );
  const validation = validateFlowGraph(bp.graphJson, { nodeRegistry: flowRegistry });
  assert.equal(validation.ok, true, `Blueprint graphJson invalid: ${JSON.stringify(validation.errors)}`);
});

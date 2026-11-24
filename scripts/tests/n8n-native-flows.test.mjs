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

const SECRET_TOKEN_RE = /(?:ldx_pat_[0-9a-f]{8}_[0-9a-f]{32}|whsec_[A-Za-z0-9+/=]{12,}|sk-(?:proj-|live-|test-)?[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

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
    assert.equal(workflow.settings?.saveDataErrorExecution, 'none');
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
    assert.equal(httpNode.retryOnFail, false);
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

test('enterprise-compliance-orchestrator: 13-node graph validates HMAC, risk tiers, PKI normalization, partner dossier, and fan-in aggregation', () => {
  const { raw, workflow } = loadWorkflow(ENT_COMPLIANCE_PATH);
  assert.equal(workflow.nodes.length, 13);
  assert.equal(workflow.active, false);
  assert.equal(SECRET_TOKEN_RE.test(raw), false);
  assert.equal(workflow.meta?.spdx, 'SPDX-License-Identifier: Apache-2.0');

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
        data: { id: 7, code: 'REQ-ENT-7', amount: 125000000, severity: 'critical', temperatureC: -8, slaOverdueMinutes: 45, items: [{ sku: 'A', value: 60 }, { sku: 'B', value: 40 }] },
      },
    },
  });
  assert.equal(crit.tier, 'critical');
  assert.equal(crit.riskScore, 100);
  assert.equal(crit.signDocumentPayload.targetRecordId, 7);

  const normPkiFn = compileCodeNode(workflow, 'Normalize PKI Attestation');
  const pkiItem = runCode(normPkiFn, { json: { body: { data: { signed: true, keyId: 'ed25519-k1', merkleRoot: 'mrk-999' } } } });
  assert.equal(pkiItem.signed, true);
  assert.equal(pkiItem.merkleRoot, 'mrk-999');

  const dossierFn = compileCodeNode(workflow, 'Build Partner & Regulatory Dossier');
  const dossierItem = runCode(dossierFn, { json: crit });
  assert.equal(dossierItem.kind, 'partner_dossier');
  assert.equal(dossierItem.itemCount, 2);

  const aggNode = getNode(workflow, 'Aggregate Orchestration Receipt');
  const aggFn = new Function('$input', '$', '$execution', aggNode.parameters.jsCode);
  const aggOut = aggFn(
    { all: () => [{ json: pkiItem }, { json: dossierItem }] },
    (name) => {
      assert.equal(name, 'Score Risk & Batch Compliance');
      return { first: () => ({ json: crit }) };
    },
    { id: 'exec-live-13' },
  );
  assert.equal(aggOut[0].json.ok, true);
  assert.equal(aggOut[0].json.n8nExecutionId, 'exec-live-13');
  assert.equal(aggOut[0].json.pkiAttestation.merkleRoot, 'mrk-999');
  assert.equal(aggOut[0].json.partnerDispatch.itemCount, 2);
});

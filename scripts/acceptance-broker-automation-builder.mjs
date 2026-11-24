#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeLabOrigin } from './setup-native-multi-portal-demo.mjs';

const DEFAULT_ORG = 'native-ui-lab';
const DEMO_PASS = process.env.NATIVE_DEMO_PASSWORD ?? 'NativeLab-2026!';

export function parseBrokerAcceptanceArgs(argv) {
  let origin = null;
  let reportPath = null;
  let organizationId = DEFAULT_ORG;

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length);
    else if (arg.startsWith('--org=')) organizationId = arg.slice('--org='.length).trim() || DEFAULT_ORG;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (reportPath === null) reportPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!origin && !reportPath) {
    throw new Error(
      'Usage: node scripts/acceptance-broker-automation-builder.mjs <clean-install report.json> | --origin=http://localhost:13014 [--org=native-ui-lab]',
    );
  }
  if (origin !== null) {
    origin = assertSafeLabOrigin(origin);
  }
  return { origin, reportPath, organizationId };
}

export async function createBrokerAcceptanceCallers(origin) {
  const safeOrigin = assertSafeLabOrigin(origin);
  const tokens = {};

  async function signIn(email, password) {
    const res = await fetch(new URL('/api/auth:signIn', safeOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    assert.ok(res.ok && json?.data?.token, `Sign-in failed for ${email}: HTTP ${res.status}`);
    return json.data.token;
  }

  tokens.root = await signIn(
    process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com',
    process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123',
  );
  tokens.employee = await signIn(
    process.env.NATIVE_DEMO_EMPLOYEE_EMAIL || 'native.lab.employee@example.invalid',
    DEMO_PASS,
  );

  return async function callActor(actorRole, path, { method = 'GET', values, bearerToken, headers: extraHeaders = {} } = {}) {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    const urlPath = cleanPath.startsWith('api/') ? `/${cleanPath}` : `/api/${cleanPath}`;
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    } else if (actorRole !== 'anon') {
      const tok = tokens[actorRole];
      if (!tok) throw new Error(`Unknown actor role: ${actorRole}`);
      headers.authorization = `Bearer ${tok}`;
      if (actorRole === 'root') headers['X-Role'] = 'root';
    }

    const response = await fetch(new URL(urlPath, safeOrigin), {
      method,
      redirect: 'error',
      headers,
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      rawText: text,
      data: payload.data !== undefined ? payload.data : payload,
    };
  };
}

function unwrapList(resData) {
  if (Array.isArray(resData)) return resData;
  if (Array.isArray(resData?.items)) return resData.items;
  if (Array.isArray(resData?.rows)) return resData.rows;
  if (Array.isArray(resData?.data)) return resData.data;
  return [];
}

function makeOkActor(callActor) {
  return async function okActor(actorRole, path, opts) {
    const res = await callActor(actorRole, path, opts);
    assert.ok(
      res.ok && res.status < 300,
      `${actorRole} ${path.split('?')[0]} failed (${res.status}): ${JSON.stringify(res.data)}`,
    );
    return res;
  };
}

async function verifyRbacNegativeChecks(callActor, organizationId, suffix) {
  const lower = suffix.toLowerCase();
  const protectedCalls = [
    ['dxosVault:save', {
      organizationId,
      connectorKey: `blocked-conn-${lower}`,
      name: 'Blocked Vault Save',
      connectorType: 'http_api',
      baseUrl: 'http://127.0.0.1/api/dxos:health',
      authType: 'none',
    }],
    ['dxosBroker:provisionDevice', {
      organizationId,
      deviceKey: `blocked-dev-${lower}`,
      name: 'Blocked Device',
    }],
    ['dxosAutomations:saveRule', {
      organizationId,
      ruleKey: `blocked_rule_${lower}`,
      name: 'Blocked Automation',
      triggerEventType: 'alarm.*',
      actionsJson: [],
    }],
    ['dxosBuilder:createDomain', {
      organizationId,
      collectionName: `latticeCustomBlocked${suffix}`,
      fields: [{ name: 'code', type: 'string', required: true }],
    }],
    ['dxosBuilder:provisionTenant', {
      organizationId,
      name: `Blocked Tenant ${suffix}`,
    }],
  ];

  for (const [endpoint, values] of protectedCalls) {
    const unauthRes = await callActor('anon', endpoint, { method: 'POST', values });
    assert.equal(unauthRes.status, 401, `Expected 401 for unauthenticated ${endpoint}, got ${unauthRes.status}`);

    const empRes = await callActor('employee', endpoint, { method: 'POST', values });
    assert.equal(empRes.status, 403, `Expected 403 for employee ${endpoint}, got ${empRes.status}`);
  }
}

async function verifyConnectorVaultLifecycle(callActor, okActor, organizationId, suffix, cleanup) {
  const connectorKey = `acc-conn-${suffix.toLowerCase()}`;
  const initialSecret = `acc-vault-v1-${suffix}`;
  const rotatedSecret = `acc-vault-v2-${suffix}`;

  const saveRes = await okActor('root', 'dxosVault:save', {
    method: 'POST',
    values: {
      organizationId,
      connectorKey,
      name: `Acceptance Connector ${suffix}`,
      connectorType: 'http_api',
      baseUrl: 'http://127.0.0.1/api/dxos:health',
      authType: 'bearer',
      secrets: { token: initialSecret },
    },
  });
  cleanup.connectorKey = connectorKey;
  assert.equal(saveRes.data?.connectorKey, connectorKey);
  assert.equal(saveRes.data?.hasSecrets, true);
  assert.equal(saveRes.data?.secretVersion, 1);
  assert.equal(saveRes.data?.encryptedSecretsJson, undefined);
  assert.equal((saveRes.rawText || JSON.stringify(saveRes.data)).includes(initialSecret), false, 'dxosVault:save leaked secret');

  const listRes = await okActor('root', `dxosVault:list?organizationId=${encodeURIComponent(organizationId)}&limit=200`);
  const listed = unwrapList(listRes.data).find((c) => c?.connectorKey === connectorKey);
  assert.ok(listed, 'Saved connector missing from dxosVault:list');
  assert.equal(listed.hasSecrets, true);
  assert.ok(Array.isArray(listed.secretKeys) && listed.secretKeys.includes('token'));
  assert.equal(listed.encryptedSecretsJson, undefined);
  assert.equal((listRes.rawText || JSON.stringify(listRes.data)).includes(initialSecret), false, 'dxosVault:list leaked secret');

  const rawListBlocked = await callActor('employee', 'latticeConnectors:list');
  assert.equal(rawListBlocked.status, 403, `Expected 403 on raw latticeConnectors:list, got ${rawListBlocked.status}`);

  const rawCreateBlocked = await callActor('employee', 'latticeConnectors:create', {
    method: 'POST',
    values: { organizationId, connectorKey: `raw-${suffix.toLowerCase()}`, name: 'Blocked Raw' },
  });
  assert.equal(rawCreateBlocked.status, 403, `Expected 403 on raw latticeConnectors:create, got ${rawCreateBlocked.status}`);

  const rotateRes = await okActor('root', 'dxosVault:rotateSecret', {
    method: 'POST',
    values: { organizationId, connectorKey, secrets: { token: rotatedSecret } },
  });
  assert.equal(rotateRes.data?.secretVersion, 2);
  assert.equal(rotateRes.data?.hasSecrets, true);
  assert.equal((rotateRes.rawText || JSON.stringify(rotateRes.data)).includes(rotatedSecret), false, 'dxosVault:rotateSecret leaked secret');

  const testRes = await okActor('root', 'dxosVault:testConnection', {
    method: 'POST',
    values: { organizationId, connectorKey },
  });
  assert.equal(typeof testRes.data?.ok, 'boolean');
  assert.ok(testRes.data?.lastTestedAt, 'dxosVault:testConnection missing lastTestedAt');
  assert.ok(testRes.data?.lastTestStatus, 'dxosVault:testConnection missing lastTestStatus');
  if (testRes.data.ok) {
    assert.equal(testRes.data.statusCode, 200);
    assert.equal(testRes.data.lastTestStatus, 'ok');
  }

  const delRes = await okActor('root', 'dxosVault:delete', {
    method: 'POST',
    values: { organizationId, connectorKey },
  });
  assert.equal(delRes.data?.deleted, true);
  cleanup.connectorKey = null;

  const afterDel = await okActor('root', `dxosVault:list?organizationId=${encodeURIComponent(organizationId)}&limit=200`);
  assert.equal(
    unwrapList(afterDel.data).some((c) => c?.connectorKey === connectorKey),
    false,
    'Deleted connector still present in dxosVault:list',
  );

  return { connectorKey, rotatedVersion: rotateRes.data.secretVersion, testStatus: testRes.data.lastTestStatus };
}

async function verifyMqttLwtAutomationCmms(callActor, okActor, organizationId, suffix, cleanup) {
  const packRes = await okActor('root', 'dxosBuilder:installBusinessPack', {
    method: 'POST',
    values: { organizationId, packKey: 'cmms-maintenance' },
  });
  assert.equal(packRes.data?.installed, true);
  assert.equal(packRes.data?.domain?.collectionName, 'latticeCustomWorkOrders');
  assert.equal(packRes.data?.dmnTable?.tableKey, 'cmms_priority_routing_v1');
  assert.equal(packRes.data?.automationRule?.ruleKey, 'auto_cmms_on_coldchain_fault');
  assert.equal(packRes.data?.domain?.portalPage?.path, '/p/cmms');

  const assetRes = await okActor('root', 'latticeAssets:create', {
    method: 'POST',
    values: {
      code: `ACC-IOT-${suffix}`,
      name: `Acceptance Cold Chiller ${suffix}`,
      kind: 'cold-chiller',
      status: 'active',
      organizationId,
      active: true,
    },
  });
  const tempAsset = assetRes.data || {};
  assert.ok(tempAsset.id, 'Failed to create temporary IoT asset');
  cleanup.assetId = tempAsset.id;

  const deviceKey = `acc-dev-${suffix.toLowerCase()}`;
  const provDevRes = await okActor('root', 'dxosBroker:provisionDevice', {
    method: 'POST',
    values: {
      organizationId,
      deviceKey,
      name: `Acceptance Sensor ${suffix}`,
      assetId: tempAsset.id,
    },
  });
  const provisionedDevice = provDevRes.data?.device || {};
  const oneTimeMqttPassword = provDevRes.data?.mqttPassword;
  assert.ok(provisionedDevice.id, 'provisionDevice missing device.id');
  assert.equal(provisionedDevice.deviceKey, deviceKey);
  assert.ok(typeof oneTimeMqttPassword === 'string' && oneTimeMqttPassword.length >= 12, 'provisionDevice missing one-time mqttPassword');
  cleanup.deviceId = provisionedDevice.id;
  cleanup.deviceKey = deviceKey;

  const listDevRes = await okActor('root', `dxosBroker:listDevices?organizationId=${encodeURIComponent(organizationId)}&limit=200`);
  const listedDev = unwrapList(listDevRes.data).find((d) => d?.deviceKey === deviceKey);
  assert.ok(listedDev, 'Provisioned device missing from dxosBroker:listDevices');
  assert.equal(listedDev.mqttPassword, undefined, 'dxosBroker:listDevices must never expose mqttPassword');
  assert.equal(
    (listDevRes.rawText || JSON.stringify(listDevRes.data)).includes(oneTimeMqttPassword),
    false,
    'dxosBroker:listDevices leaked mqttPassword',
  );

  const lwtRuleKey = `acc_lwt_wo_${suffix.toLowerCase()}`;
  await okActor('root', 'dxosAutomations:saveRule', {
    method: 'POST',
    values: {
      organizationId,
      ruleKey: lwtRuleKey,
      name: `Acceptance LWT Work Order ${suffix}`,
      triggerEventType: 'device.offline',
      filterJson: { deviceKey },
      dmnTableKey: 'cmms_priority_routing_v1',
      actionsJson: [
        {
          type: 'create_record',
          collection: 'latticeCustomWorkOrders',
          values: {
            workOrderCode: `WO-LWT-${suffix}`,
            title: 'LWT Disconnect: {{data.deviceKey}}',
            assetId: '{{data.assetId}}',
            deviceKey: '{{data.deviceKey}}',
            priority: '{{dmn.workOrderPriority}}',
            status: 'open',
            faultSummary: '{{data.reason}}',
            assignedRole: '{{dmn.assignedRole}}',
          },
        },
      ],
      active: true,
    },
  });
  cleanup.lwtRuleKey = lwtRuleKey;

  const badEdgeRes = await callActor('anon', 'dxosBroker:deviceStatusIngest', {
    method: 'POST',
    headers: { 'X-Lattice-Edge-Token': 'invalid-edge-token-0000' },
    values: { organizationId, deviceKey, status: 'DEATH' },
  });
  assert.equal(badEdgeRes.status, 401, `Expected 401 for invalid edge token, got ${badEdgeRes.status}`);

  const deathRes = await okActor('root', 'dxosBroker:deviceStatusIngest', {
    method: 'POST',
    values: {
      organizationId,
      deviceKey,
      status: 'DEATH',
      reason: `acc_lwt_disconnect_${suffix}`,
    },
  });
  assert.equal(deathRes.data?.device?.status, 'offline');
  assert.equal(deathRes.data?.transitionedToOffline, true);
  if (deathRes.data?.incident?.id) {
    cleanup.incidentIds.push(deathRes.data.incident.id);
  }

  const eventsRes = await okActor(
    'root',
    `dxosEvents:listEvents?organizationId=${encodeURIComponent(organizationId)}&eventType=device.offline&pageSize=20`,
  );
  const offlineEvt = unwrapList(eventsRes.data).find(
    (ev) => ev?.eventType === 'device.offline'
      && (ev?.subject === deviceKey || ev?.payloadJson?.data?.deviceKey === deviceKey),
  );
  assert.ok(offlineEvt, 'device.offline CloudEvent missing from dxosEvents:listEvents');

  const lwtRunsRes = await okActor(
    'root',
    `dxosAutomations:listRuns?organizationId=${encodeURIComponent(organizationId)}&ruleKey=${encodeURIComponent(lwtRuleKey)}&limit=20`,
  );
  const lwtRun = unwrapList(lwtRunsRes.data).find((r) => r?.status === 'completed');
  assert.ok(lwtRun, 'LWT device.offline automation run did not complete');
  for (const step of lwtRun.stepTracesJson || []) {
    if (step?.type === 'create_record' && step?.output?.collection === 'latticeCustomWorkOrders' && step?.output?.id != null) {
      cleanup.workOrderIds.push(step.output.id);
    }
  }

  const runNowRes = await okActor('root', 'dxosAutomations:runNow', {
    method: 'POST',
    values: {
      organizationId,
      ruleKey: 'auto_cmms_on_coldchain_fault',
      eventType: 'alarm.triggered',
      subject: deviceKey,
      data: {
        severity: 'critical',
        deviceKey,
        assetId: tempAsset.id,
        message: `Acceptance cold-chain fault ${suffix}`,
      },
    },
  });
  const cmmsRun = runNowRes.data?.run;
  assert.equal(cmmsRun?.status, 'completed');
  assert.equal(cmmsRun?.dmnResultJson?.outputs?.workOrderPriority, 'critical');
  const createdStep = (cmmsRun?.stepTracesJson || []).find(
    (s) => s?.type === 'create_record' && s?.output?.collection === 'latticeCustomWorkOrders',
  );
  const workOrderId = createdStep?.output?.id;
  assert.ok(workOrderId, 'auto_cmms_on_coldchain_fault runNow did not create latticeCustomWorkOrders record');
  cleanup.workOrderIds.push(workOrderId);

  const cmmsRunsRes = await okActor(
    'root',
    `dxosAutomations:listRuns?organizationId=${encodeURIComponent(organizationId)}&ruleKey=auto_cmms_on_coldchain_fault&limit=20`,
  );
  assert.ok(
    unwrapList(cmmsRunsRes.data).some((r) => r?.runUid === cmmsRun.runUid),
    'runNow execution missing from dxosAutomations:listRuns',
  );

  const woRes = await okActor('root', `latticeCustomWorkOrders:get?filterByTk=${encodeURIComponent(workOrderId)}`);
  assert.equal(woRes.data?.organizationId, organizationId);
  assert.equal(woRes.data?.deviceKey, deviceKey);
  assert.equal(woRes.data?.priority, 'critical');

  return { deviceKey, offlineEventId: offlineEvt.eventId, workOrderId, runUid: cmmsRun.runUid };
}

async function verifyWebhooksHmacCircuitDlq(callActor, okActor, organizationId, suffix, cleanup) {
  const subscriptionKey = `acc-hook-${suffix.toLowerCase()}`;
  const eventType = `acc.wh.${suffix.toLowerCase()}.ping`;
  const signingSecret = `acc-whsec-${suffix}`;

  const subRes = await okActor('root', 'dxosEvents:saveSubscription', {
    method: 'POST',
    values: {
      organizationId,
      subscriptionKey,
      name: `Acceptance Webhook ${suffix}`,
      targetUrl: 'http://127.0.0.1:59999/acc-webhook-sink',
      eventPattern: `acc.wh.${suffix.toLowerCase()}.*`,
      signingSecret,
      active: true,
    },
  });
  const sub = subRes.data || {};
  assert.ok(sub.id, 'saveSubscription missing id');
  assert.equal(sub.hasSigningSecret, true);
  assert.equal(sub.circuitState, 'closed');
  assert.equal((subRes.rawText || JSON.stringify(subRes.data)).includes(signingSecret), false, 'saveSubscription leaked signingSecret');
  cleanup.subscriptionKey = subscriptionKey;
  cleanup.subscriptionId = sub.id;

  const publishedEventIds = [];
  for (let i = 1; i <= 6; i += 1) {
    const pubRes = await okActor('root', 'dxosEvents:publish', {
      method: 'POST',
      values: {
        organizationId,
        type: eventType,
        subject: `probe-${suffix}-${i}`,
        data: { seq: i, suffix },
      },
    });
    assert.equal(pubRes.data?.event?.specversion, '1.0');
    assert.ok(Number(pubRes.data?.deliveriesQueued || 0) >= 1, 'publish did not queue webhook delivery');
    if (pubRes.data?.event?.id) publishedEventIds.push(pubRes.data.event.id);
  }

  const dispatchRes = await okActor('root', 'dxosEvents:dispatchNow', {
    method: 'POST',
    values: { organizationId, batchSize: 20 },
  });
  assert.equal(typeof dispatchRes.data?.processedCount, 'number');

  const delivRes = await okActor(
    'root',
    `dxosEvents:listDeliveries?organizationId=${encodeURIComponent(organizationId)}&subscriptionId=${encodeURIComponent(sub.id)}&pageSize=20`,
  );
  const deliveries = unwrapList(delivRes.data);
  assert.ok(deliveries.length >= 6, `Expected >= 6 queued deliveries, got ${deliveries.length}`);
  assert.ok(
    deliveries.some((d) => ['retry_wait', 'dlq', 'delivered'].includes(d?.status) || Number(d?.attempt || 0) >= 1),
    'Expected delivery trace attempt/retry status after dispatchNow',
  );

  const listSubRes = await okActor('root', `dxosEvents:listSubscriptions?organizationId=${encodeURIComponent(organizationId)}&limit=200`);
  const listedSub = unwrapList(listSubRes.data).find((s) => s?.subscriptionKey === subscriptionKey);
  assert.ok(listedSub, 'Subscription missing from listSubscriptions');
  assert.equal(listedSub.hasSigningSecret, true);
  assert.equal(
    (listSubRes.rawText || JSON.stringify(listSubRes.data)).includes(signingSecret),
    false,
    'listSubscriptions leaked signingSecret',
  );
  assert.equal(listedSub.circuitState, 'open', `Expected circuit breaker to open after failures, got ${listedSub.circuitState}`);
  assert.ok(Number(listedSub.failureCount || 0) >= 5, 'Expected failureCount >= 5 when circuit opened');

  const resetRes = await okActor('root', 'dxosEvents:resetCircuit', {
    method: 'POST',
    values: { organizationId, subscriptionKey },
  });
  assert.equal(resetRes.data?.circuitState, 'closed');
  assert.equal(resetRes.data?.failureCount, 0);

  const replayRes = await okActor('root', 'dxosEvents:replayDlq', {
    method: 'POST',
    values: { organizationId, subscriptionId: sub.id },
  });
  assert.equal(typeof replayRes.data?.replayedCount, 'number');

  const delSubRes = await okActor('root', 'dxosEvents:deleteSubscription', {
    method: 'POST',
    values: { organizationId, subscriptionKey },
  });
  assert.equal(delSubRes.data?.deleted, true);
  cleanup.subscriptionKey = null;

  return {
    subscriptionKey,
    publishedCount: publishedEventIds.length,
    circuitOpenedAndReset: true,
    replayedDlqCount: replayRes.data.replayedCount,
  };
}

async function verifyDomainBuilderOpenApiRls(callActor, okActor, organizationId, suffix, cleanup) {
  const customCollection = `latticeCustomAcc${suffix}`;
  const portalSlug = `acc-${suffix.toLowerCase()}`;
  const otherOrgId = `acc-iso-${suffix.toLowerCase()}`;

  const domRes = await okActor('root', 'dxosBuilder:createDomain', {
    method: 'POST',
    values: {
      organizationId,
      collectionName: customCollection,
      title: `Acceptance Custom Domain ${suffix}`,
      description: 'Temporary custom domain for OpenAPI & RLS acceptance',
      fields: [
        { name: 'itemCode', type: 'string', title: 'Item Code', required: true, indexed: true },
        { name: 'status', type: 'string', title: 'Status', enumValues: ['open', 'closed'] },
        { name: 'reading', type: 'float', title: 'Reading' },
      ],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_employee'],
      portalSlug,
      portalTitle: `Acceptance Portal ${suffix}`,
    },
  });
  const domain = domRes.data?.domain || {};
  cleanup.customCollection = customCollection;
  cleanup.customPortalPage = domain.portalPage || null;
  assert.equal(domain.collectionName, customCollection);
  assert.equal(domain.rls?.attached, true);
  assert.equal(domain.rls?.verified, true);
  assert.equal(domain.portalPage?.path, `/p/${portalSlug}`);

  const listDomRes = await okActor('root', 'dxosBuilder:listDomains');
  assert.ok(
    unwrapList(listDomRes.data).some((d) => d?.collectionName === customCollection && d?.rlsProtected === true),
    'Created custom domain missing from dxosBuilder:listDomains',
  );

  const openapiRes = await okActor('anon', 'dxos:openapi');
  assert.equal(openapiRes.data?.openapi, '3.1.0');
  assert.ok(
    openapiRes.data?.paths?.[`/api/${customCollection}:list`]?.get,
    `/api/dxos:openapi missing GET /api/${customCollection}:list`,
  );
  assert.ok(
    openapiRes.data?.paths?.[`/api/${customCollection}:create`]?.post,
    `/api/dxos:openapi missing POST /api/${customCollection}:create`,
  );
  assert.ok(
    openapiRes.data?.components?.schemas?.[customCollection],
    `/api/dxos:openapi missing schema ${customCollection}`,
  );

  const recARes = await okActor('root', `${customCollection}:create`, {
    method: 'POST',
    values: { organizationId, itemCode: `ORG-A-${suffix}`, status: 'open', reading: 4.2 },
  });
  const recA = recARes.data || {};
  assert.ok(recA.id, `Failed to create record in ${customCollection} for ${organizationId}`);
  cleanup.customRecordIds.push(recA.id);

  const recBRes = await okActor('root', `${customCollection}:create`, {
    method: 'POST',
    values: { organizationId: otherOrgId, itemCode: `ORG-B-${suffix}`, status: 'open', reading: 9.1 },
  });
  const recB = recBRes.data || {};
  assert.ok(recB.id, `Failed to create record in ${customCollection} for ${otherOrgId}`);
  cleanup.customRecordIds.push(recB.id);

  const empListRes = await callActor('employee', `${customCollection}:list?pageSize=200`);
  if (empListRes.ok) {
    const empItems = unwrapList(empListRes.data);
    assert.ok(empItems.some((r) => Number(r?.id) === Number(recA.id)), 'Employee could not see own-org custom record');
    assert.equal(empItems.some((r) => Number(r?.id) === Number(recB.id)), false, 'Tenant isolation breach: employee saw cross-org record');
  } else {
    assert.equal(empListRes.status, 403, `Unexpected status on employee ${customCollection}:list (${empListRes.status})`);
  }

  const empGetOther = await callActor('employee', `${customCollection}:get?filterByTk=${encodeURIComponent(recB.id)}`);
  assert.equal(
    empGetOther.ok && Number(empGetOther.data?.id) === Number(recB.id),
    false,
    'Tenant isolation breach: employee fetched cross-org custom record by ID',
  );

  const empCrossCreate = await callActor('employee', `${customCollection}:create`, {
    method: 'POST',
    values: { organizationId: otherOrgId, itemCode: `CROSS-${suffix}`, status: 'open', reading: 1.0 },
  });
  assert.equal(empCrossCreate.status, 403, `Expected 403 on cross-org ${customCollection}:create, got ${empCrossCreate.status}`);

  for (const crossPath of [
    `dxosVault:list?organizationId=${encodeURIComponent(otherOrgId)}`,
    `dxosEvents:listEvents?organizationId=${encodeURIComponent(otherOrgId)}`,
    `dxosAutomations:listRules?organizationId=${encodeURIComponent(otherOrgId)}`,
  ]) {
    const crossRes = await callActor('employee', crossPath);
    assert.equal(crossRes.status, 403, `Expected 403 for cross-org ${crossPath}, got ${crossRes.status}`);
  }

  return { customCollection, portalPath: domain.portalPage.path, openApiPathsVerified: true };
}

async function verifyTenantProvisioning(callActor, okActor, suffix, cleanup) {
  const subOrgId = `acc-sub-${suffix.toLowerCase()}`;
  const adminUsername = `acc_admin_${suffix.toLowerCase()}`;
  const adminEmail = `acc.admin.${suffix.toLowerCase()}@example.invalid`;
  const payload = {
    organizationId: subOrgId,
    name: `Acceptance Subsidiary ${suffix}`,
    region: 'VN',
    adminUsername,
    adminEmail,
    adminPassword: `AccSub-${suffix}-2026!`,
  };

  const prov1 = await okActor('root', 'dxosBuilder:provisionTenant', {
    method: 'POST',
    values: payload,
  });
  cleanup.tenantOrgId = subOrgId;
  cleanup.tenantAdminUserId = prov1.data?.adminAccount?.userId ?? null;
  cleanup.tenantAdminEmployeeId = prov1.data?.adminAccount?.employeeId ?? null;

  assert.equal(prov1.data?.provisioned, true);
  assert.equal(prov1.data?.organization?.organizationId, subOrgId);
  assert.equal(prov1.data?.pkiKey?.algorithm, 'Ed25519');
  assert.equal(prov1.data?.pkiKey?.active, true);
  assert.ok(Number(prov1.data?.slaCount || 0) >= 4, 'provisionTenant missing VN SLA policies');
  assert.equal(prov1.data?.adminAccount?.role, 'ldx_admin');
  assert.equal(prov1.data?.adminAccount?.username, adminUsername);

  const list1 = await okActor('root', 'dxosBuilder:listTenants?limit=200');
  const found1 = unwrapList(list1.data).filter((t) => t?.organizationId === subOrgId);
  assert.equal(found1.length, 1, 'Provisioned tenant missing or duplicated in dxosBuilder:listTenants');
  assert.equal(found1[0]?.activePkiKey?.algorithm, 'Ed25519');
  assert.ok(Number(found1[0]?.slaCount || 0) >= 4);

  const prov2 = await okActor('root', 'dxosBuilder:provisionTenant', {
    method: 'POST',
    values: {
      ...payload,
      adminPassword: `DifferentIgnored-${suffix}!`,
    },
  });
  assert.equal(prov2.data?.provisioned, true);
  assert.equal(prov2.data?.organization?.organizationId, subOrgId);
  assert.equal(prov2.data?.pkiKey?.keyId, prov1.data?.pkiKey?.keyId, 'Idempotent provisionTenant must reuse active PKI key');
  assert.equal(prov2.data?.adminAccount?.userId, prov1.data?.adminAccount?.userId, 'Idempotent provisionTenant must reuse admin user');

  const list2 = await okActor('root', 'dxosBuilder:listTenants?limit=200');
  const found2 = unwrapList(list2.data).filter((t) => t?.organizationId === subOrgId);
  assert.equal(found2.length, 1, 'Idempotent provisionTenant created duplicate tenant entries');

  return { subOrgId, keyId: prov1.data.pkiKey.keyId, adminUsername };
}

async function destroyMatchingIds(callActor, collection, filter) {
  const qs = encodeURIComponent(JSON.stringify(filter));
  const res = await callActor('root', `${collection}:list?filter=${qs}&pageSize=200`).catch(() => null);
  for (const row of unwrapList(res?.data)) {
    if (row?.id != null) {
      await callActor('root', `${collection}:destroy?filterByTk=${encodeURIComponent(row.id)}`, { method: 'POST' }).catch(() => {});
    }
  }
}

async function cleanupAcceptanceResources(callActor, organizationId, cleanup) {
  if (cleanup.connectorKey) {
    await callActor('root', 'dxosVault:delete', {
      method: 'POST',
      values: { organizationId, connectorKey: cleanup.connectorKey },
    }).catch(() => {});
  }
  if (cleanup.subscriptionKey) {
    await callActor('root', 'dxosEvents:deleteSubscription', {
      method: 'POST',
      values: { organizationId, subscriptionKey: cleanup.subscriptionKey },
    }).catch(() => {});
  }
  if (cleanup.subscriptionId) {
    await destroyMatchingIds(callActor, 'latticeWebhookDeliveries', {
      organizationId,
      subscriptionId: cleanup.subscriptionId,
    });
  }
  if (cleanup.lwtRuleKey) {
    await callActor('root', 'dxosAutomations:deleteRule', {
      method: 'POST',
      values: { organizationId, ruleKey: cleanup.lwtRuleKey },
    }).catch(() => {});
  }

  const woIdSet = new Set(cleanup.workOrderIds.filter((id) => id != null));
  if (cleanup.assetId) {
    const woRes = await callActor(
      'root',
      `latticeCustomWorkOrders:list?filter=${encodeURIComponent(JSON.stringify({ organizationId, assetId: cleanup.assetId }))}&pageSize=100`,
    ).catch(() => null);
    for (const row of unwrapList(woRes?.data)) {
      if (row?.id != null) woIdSet.add(row.id);
    }
  }
  for (const woId of woIdSet) {
    await callActor('root', `latticeCustomWorkOrders:destroy?filterByTk=${encodeURIComponent(woId)}`, { method: 'POST' }).catch(() => {});
  }

  for (const incId of cleanup.incidentIds) {
    await callActor('root', `latticeIncidentCases:destroy?filterByTk=${encodeURIComponent(incId)}`, { method: 'POST' }).catch(() => {});
  }

  if (cleanup.deviceKey) {
    await callActor('root', 'dxosBroker:revokeDevice', {
      method: 'POST',
      values: { organizationId, deviceKey: cleanup.deviceKey, reason: 'acceptance_cleanup' },
    }).catch(() => {});
  }
  if (cleanup.deviceId) {
    await callActor('root', `latticeIotDevices:destroy?filterByTk=${encodeURIComponent(cleanup.deviceId)}`, { method: 'POST' }).catch(() => {});
  }
  if (cleanup.assetId) {
    await callActor('root', `latticeAssets:destroy?filterByTk=${encodeURIComponent(cleanup.assetId)}`, { method: 'POST' }).catch(() => {});
  }

  if (cleanup.customCollection) {
    for (const recId of cleanup.customRecordIds) {
      await callActor('root', `${cleanup.customCollection}:destroy?filterByTk=${encodeURIComponent(recId)}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanup.customPortalPage?.tabSchemaUid) {
      await destroyMatchingIds(callActor, 'flowModels', { parentId: cleanup.customPortalPage.tabSchemaUid });
      await callActor('root', `flowModels:destroy?filterByTk=${encodeURIComponent(cleanup.customPortalPage.tabSchemaUid)}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanup.customPortalPage?.routeId != null) {
      await destroyMatchingIds(callActor, 'desktopRoutes', { parentId: cleanup.customPortalPage.routeId });
      await callActor('root', `desktopRoutes:destroy?filterByTk=${encodeURIComponent(cleanup.customPortalPage.routeId)}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanup.customPortalPage?.layoutUid) {
      await destroyMatchingIds(callActor, 'desktopRoutesUiLayouts', { uiLayoutUid: cleanup.customPortalPage.layoutUid });
      await callActor('root', `uiLayouts:destroy?filterByTk=${encodeURIComponent(cleanup.customPortalPage.layoutUid)}`, { method: 'POST' }).catch(() => {});
    }
    await callActor('root', `collections:destroy?filterByTk=${encodeURIComponent(cleanup.customCollection)}`, { method: 'POST' }).catch(() => {});
  }

  if (cleanup.tenantOrgId) {
    if (cleanup.tenantAdminEmployeeId != null) {
      await callActor('root', `latticeEmployees:destroy?filterByTk=${encodeURIComponent(cleanup.tenantAdminEmployeeId)}`, { method: 'POST' }).catch(() => {});
    } else {
      await destroyMatchingIds(callActor, 'latticeEmployees', { organizationId: cleanup.tenantOrgId });
    }
    if (cleanup.tenantAdminUserId != null) {
      await callActor('root', `users:destroy?filterByTk=${encodeURIComponent(cleanup.tenantAdminUserId)}`, { method: 'POST' }).catch(() => {});
    }
    for (const col of ['latticeSlaPolicies', 'latticePkiKeys', 'latticeLocations', 'latticeDepartments', 'latticeOrganizations']) {
      await destroyMatchingIds(callActor, col, { organizationId: cleanup.tenantOrgId });
    }
  }
}

export async function runBrokerAutomationBuilderAcceptance(callActor, { organizationId = DEFAULT_ORG } = {}) {
  const okActor = makeOkActor(callActor);
  const suffix = Date.now().toString(36).slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  const cleanup = {
    connectorKey: null,
    subscriptionKey: null,
    subscriptionId: null,
    lwtRuleKey: null,
    assetId: null,
    deviceId: null,
    deviceKey: null,
    incidentIds: [],
    workOrderIds: [],
    customCollection: null,
    customPortalPage: null,
    customRecordIds: [],
    tenantOrgId: null,
    tenantAdminUserId: null,
    tenantAdminEmployeeId: null,
  };

  const checks = {
    rbacNegativeChecksOk: false,
    connectorVaultLifecycleOk: false,
    mqttDynSecLwtAutomationCmmsOk: false,
    webhooksHmacCircuitDlqOk: false,
    domainBuilderOpenApiRlsOk: false,
    tenantProvisioningIdempotentOk: false,
  };

  try {
    await verifyRbacNegativeChecks(callActor, organizationId, suffix);
    checks.rbacNegativeChecksOk = true;

    const vaultSummary = await verifyConnectorVaultLifecycle(callActor, okActor, organizationId, suffix, cleanup);
    checks.connectorVaultLifecycleOk = true;

    const brokerAutomationSummary = await verifyMqttLwtAutomationCmms(callActor, okActor, organizationId, suffix, cleanup);
    checks.mqttDynSecLwtAutomationCmmsOk = true;

    const webhooksSummary = await verifyWebhooksHmacCircuitDlq(callActor, okActor, organizationId, suffix, cleanup);
    checks.webhooksHmacCircuitDlqOk = true;

    const domainBuilderSummary = await verifyDomainBuilderOpenApiRls(callActor, okActor, organizationId, suffix, cleanup);
    checks.domainBuilderOpenApiRlsOk = true;

    const tenantSummary = await verifyTenantProvisioning(callActor, okActor, suffix, cleanup);
    checks.tenantProvisioningIdempotentOk = true;

    return {
      status: 'PASS',
      result: 'PASS',
      organizationId,
      checks,
      vault: vaultSummary,
      brokerAutomation: brokerAutomationSummary,
      webhooks: webhooksSummary,
      domainBuilder: domainBuilderSummary,
      tenant: tenantSummary,
    };
  } finally {
    await cleanupAcceptanceResources(callActor, organizationId, cleanup);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const opts = parseBrokerAcceptanceArgs(process.argv.slice(2));
    let origin = opts.origin;
    if (opts.reportPath) {
      const report = JSON.parse(await readFile(resolve(opts.reportPath), 'utf8'));
      origin = assertSafeLabOrigin(report.origin);
    }
    const callActor = await createBrokerAcceptanceCallers(origin);
    const summary = await runBrokerAutomationBuilderAcceptance(callActor, { organizationId: opts.organizationId });
    console.log(JSON.stringify(summary, null, 2));
  })().catch((err) => {
    console.error(JSON.stringify({ status: 'FAIL', result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  });
}

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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBrokerAcceptanceCallers,
  parseBrokerAcceptanceArgs,
  runBrokerAutomationBuilderAcceptance,
} from '../acceptance-broker-automation-builder.mjs';
import { addSourceHeader } from '../source-headers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function createMockAcceptanceCaller({
  leakMqttPasswordInList = false,
  omitCustomCollectionInOpenApi = false,
  failStep = null,
} = {}) {
  const state = {
    nextId: 100,
    connectors: [],
    assets: [],
    devices: [],
    incidents: [],
    events: [],
    subscriptions: [],
    deliveries: [],
    dmnTables: [],
    automationRules: [],
    automationRuns: [],
    workOrders: [],
    domains: new Map(),
    customRecords: new Map(),
    tenants: [],
    users: [],
    employees: [],
    pkiKeys: [],
    slas: [],
    departments: [],
    locations: [],
    routes: [],
    flowModels: [],
    destroyedPaths: [],
    calls: [],
    provisionedPasswords: [],
  };

  const errResp = (status, code, message = code) => ({
    ok: false,
    status,
    rawText: JSON.stringify({ errors: [{ code, message }] }),
    data: { code, message },
  });
  const okResp = (data) => ({
    ok: true,
    status: 200,
    rawText: JSON.stringify({ data }),
    data,
  });

  const callActor = async (actorRole, path, opts = {}) => {
    state.calls.push({ actorRole, path, opts });
    const [resourceAction, queryStr = ''] = String(path).split('?');
    const query = new URLSearchParams(queryStr);
    const values = opts.values || {};

    if (failStep && resourceAction === failStep) {
      return errResp(500, 'INJECTED_FAILURE', `Forced failure at ${failStep}`);
    }

    // RBAC negative check endpoints
    const adminMutations = new Set([
      'dxosVault:save',
      'dxosBroker:provisionDevice',
      'dxosAutomations:saveRule',
      'dxosBuilder:createDomain',
      'dxosBuilder:provisionTenant',
    ]);
    if (adminMutations.has(resourceAction)) {
      if (actorRole === 'anon') return errResp(401, 'NATIVE_LOGIN_REQUIRED');
      if (actorRole === 'employee') return errResp(403, 'FORBIDDEN');
    }

    // Direct CRUD guard for latticeConnectors
    if (resourceAction.startsWith('latticeConnectors:')) {
      if (actorRole !== 'root') return errResp(403, 'VAULT_DIRECT_CRUD_FORBIDDEN');
    }

    // Cross-org check for employee on scoped endpoints
    if (actorRole === 'employee' && query.get('organizationId') && query.get('organizationId') !== 'native-ui-lab') {
      return errResp(403, 'NATIVE_ORGANIZATION_MISMATCH');
    }

    // 2. Connector Vault
    if (resourceAction === 'dxosVault:save') {
      const idx = state.connectors.findIndex(
        (c) => c.organizationId === values.organizationId && c.connectorKey === values.connectorKey,
      );
      const row = {
        id: idx >= 0 ? state.connectors[idx].id : ++state.nextId,
        organizationId: values.organizationId,
        connectorKey: values.connectorKey,
        name: values.name,
        connectorType: values.connectorType,
        baseUrl: values.baseUrl,
        authType: values.authType,
        secrets: values.secrets || {},
        secretVersion: idx >= 0 ? state.connectors[idx].secretVersion + 1 : 1,
        lastTestedAt: null,
        lastTestStatus: null,
        active: true,
      };
      if (idx >= 0) state.connectors[idx] = row;
      else state.connectors.push(row);
      const { secrets, ...safe } = row;
      return okResp({ ...safe, hasSecrets: Object.keys(secrets).length > 0, secretKeys: Object.keys(secrets) });
    }
    if (resourceAction === 'dxosVault:list') {
      const org = query.get('organizationId');
      return okResp({
        organizationId: org,
        items: state.connectors
          .filter((c) => !org || c.organizationId === org)
          .map(({ secrets, ...safe }) => ({
            ...safe,
            hasSecrets: Object.keys(secrets || {}).length > 0,
            secretKeys: Object.keys(secrets || {}),
          })),
      });
    }
    if (resourceAction === 'dxosVault:rotateSecret') {
      const row = state.connectors.find(
        (c) => c.organizationId === values.organizationId && c.connectorKey === values.connectorKey,
      );
      if (!row) return errResp(404, 'CONNECTOR_NOT_FOUND');
      row.secrets = values.secrets || {};
      row.secretVersion += 1;
      const { secrets, ...safe } = row;
      return okResp({ ...safe, hasSecrets: true, secretKeys: Object.keys(secrets) });
    }
    if (resourceAction === 'dxosVault:testConnection') {
      const row = state.connectors.find(
        (c) => c.organizationId === values.organizationId && c.connectorKey === values.connectorKey,
      );
      if (!row) return errResp(404, 'CONNECTOR_NOT_FOUND');
      row.lastTestedAt = new Date().toISOString();
      row.lastTestStatus = 'ok';
      return okResp({
        ok: true,
        statusCode: 200,
        latencyMs: 4,
        connectorKey: row.connectorKey,
        connectorType: row.connectorType,
        lastTestedAt: row.lastTestedAt,
        lastTestStatus: 'ok',
      });
    }
    if (resourceAction === 'dxosVault:delete') {
      const idx = state.connectors.findIndex(
        (c) => c.organizationId === values.organizationId && c.connectorKey === values.connectorKey,
      );
      if (idx < 0) return errResp(404, 'CONNECTOR_NOT_FOUND');
      const [removed] = state.connectors.splice(idx, 1);
      return okResp({ deleted: true, id: removed.id, connectorKey: removed.connectorKey });
    }

    // 3. CMMS Pack, Assets, Broker DynSec, LWT, Automations
    if (resourceAction === 'dxosBuilder:installBusinessPack') {
      assert.equal(values.packKey, 'cmms-maintenance');
      state.domains.set('latticeCustomWorkOrders', {
        collectionName: 'latticeCustomWorkOrders',
        title: 'CMMS Work Orders',
        rlsProtected: true,
        fields: [{ name: 'workOrderCode', type: 'string' }, { name: 'deviceKey', type: 'string' }],
        portalPages: [{ path: '/p/cmms', title: 'CMMS Maintenance' }],
      });
      if (!state.customRecords.has('latticeCustomWorkOrders')) {
        state.customRecords.set('latticeCustomWorkOrders', []);
      }
      if (!state.dmnTables.some((t) => t.tableKey === 'cmms_priority_routing_v1')) {
        state.dmnTables.push({ id: ++state.nextId, organizationId: values.organizationId, tableKey: 'cmms_priority_routing_v1' });
      }
      if (!state.automationRules.some((r) => r.ruleKey === 'auto_cmms_on_coldchain_fault')) {
        state.automationRules.push({
          id: ++state.nextId,
          organizationId: values.organizationId,
          ruleKey: 'auto_cmms_on_coldchain_fault',
          triggerEventType: 'alarm.triggered',
          dmnTableKey: 'cmms_priority_routing_v1',
        });
      }
      return okResp({
        installed: true,
        packKey: 'cmms-maintenance',
        organizationId: values.organizationId,
        domain: {
          collectionName: 'latticeCustomWorkOrders',
          rls: { attached: true, verified: true },
          portalPage: { path: '/p/cmms' },
        },
        dmnTable: { tableKey: 'cmms_priority_routing_v1' },
        automationRule: { ruleKey: 'auto_cmms_on_coldchain_fault' },
      });
    }
    if (resourceAction === 'latticeAssets:create') {
      const asset = { id: ++state.nextId, ...values };
      state.assets.push(asset);
      return okResp(asset);
    }
    if (resourceAction === 'dxosBroker:provisionDevice') {
      const pwd = `mock-mqtt-${++state.nextId}`;
      state.provisionedPasswords.push(pwd);
      const dev = {
        id: ++state.nextId,
        organizationId: values.organizationId,
        deviceKey: values.deviceKey,
        name: values.name,
        assetId: values.assetId ?? null,
        assetEntityId: values.assetId ? `urn:ngsi-ld:Asset:${values.organizationId}:native:${values.assetId}` : null,
        mqttUsername: `ldx_${values.organizationId}_${values.deviceKey}`,
        mqttClientId: `ldx-${values.organizationId}-${values.deviceKey}`,
        topicPrefix: `latticedx/${values.organizationId}/${values.deviceKey}`,
        status: 'provisioned',
      };
      state.devices.push({ ...dev, mqttPassword: pwd });
      return okResp({ device: dev, mqttPassword: pwd, brokerSynced: false });
    }
    if (resourceAction === 'dxosBroker:listDevices') {
      const org = query.get('organizationId');
      return okResp({
        organizationId: org,
        items: state.devices
          .filter((d) => !org || d.organizationId === org)
          .map(({ mqttPassword, ...safe }) => (leakMqttPasswordInList ? { ...safe, mqttPassword } : safe)),
      });
    }
    if (resourceAction === 'dxosBroker:revokeDevice') {
      const dev = state.devices.find((d) => d.deviceKey === values.deviceKey);
      if (dev) dev.status = 'revoked';
      return okResp({ device: dev || null, brokerSynced: false });
    }
    if (resourceAction === 'dxosAutomations:saveRule') {
      const rule = { id: ++state.nextId, ...values };
      state.automationRules.push(rule);
      return okResp({ rule });
    }
    if (resourceAction === 'dxosAutomations:deleteRule') {
      state.automationRules = state.automationRules.filter(
        (r) => !(r.organizationId === values.organizationId && r.ruleKey === values.ruleKey),
      );
      return okResp({ deleted: true, ruleKey: values.ruleKey });
    }
    if (resourceAction === 'dxosAutomations:listRules') {
      return okResp({ items: state.automationRules.filter((r) => r.organizationId === query.get('organizationId')) });
    }
    if (resourceAction === 'dxosBroker:deviceStatusIngest') {
      const hdrs = opts.headers || {};
      if (hdrs['X-Lattice-Edge-Token'] || actorRole === 'anon') {
        return errResp(401, 'TELEMETRY_EDGE_AUTH_INVALID');
      }
      const dev = state.devices.find((d) => d.organizationId === values.organizationId && d.deviceKey === values.deviceKey);
      if (!dev) return errResp(404, 'BROKER_DEVICE_NOT_FOUND');
      dev.status = 'offline';
      const incident = { id: ++state.nextId, code: `ALM-${state.nextId}`, organizationId: values.organizationId };
      state.incidents.push(incident);

      const evt = {
        id: ++state.nextId,
        eventId: `evt-${state.nextId}`,
        organizationId: values.organizationId,
        eventType: 'device.offline',
        subject: dev.deviceKey,
        payloadJson: {
          specversion: '1.0',
          type: 'device.offline',
          subject: dev.deviceKey,
          data: {
            organizationId: values.organizationId,
            deviceKey: dev.deviceKey,
            assetId: dev.assetId,
            reason: values.reason,
          },
        },
      };
      state.events.push(evt);

      for (const rule of state.automationRules.filter((r) => r.organizationId === values.organizationId && r.triggerEventType === 'device.offline')) {
        const wo = {
          id: ++state.nextId,
          organizationId: values.organizationId,
          workOrderCode: `WO-LWT-${state.nextId}`,
          deviceKey: dev.deviceKey,
          assetId: dev.assetId,
          priority: 'medium',
          status: 'open',
        };
        state.workOrders.push(wo);
        state.automationRuns.push({
          id: ++state.nextId,
          organizationId: values.organizationId,
          ruleKey: rule.ruleKey,
          runUid: `run_${state.nextId}`,
          status: 'completed',
          stepTracesJson: [{ stepIndex: 0, type: 'create_record', status: 'completed', output: { collection: 'latticeCustomWorkOrders', id: wo.id } }],
        });
      }
      const { mqttPassword, ...safeDev } = dev;
      return okResp({ device: safeDev, previousStatus: 'provisioned', transitionedToOffline: true, incident });
    }
    if (resourceAction === 'dxosAutomations:runNow') {
      const wo = {
        id: ++state.nextId,
        organizationId: values.organizationId,
        workOrderCode: `WO-${state.nextId}`,
        assetId: values.data?.assetId ?? null,
        deviceKey: values.data?.deviceKey ?? '',
        priority: values.data?.severity === 'critical' ? 'critical' : 'medium',
        status: 'open',
      };
      state.workOrders.push(wo);
      const run = {
        id: ++state.nextId,
        organizationId: values.organizationId,
        ruleKey: values.ruleKey,
        runUid: `run_${state.nextId}`,
        status: 'completed',
        dmnResultJson: { tableKey: 'cmms_priority_routing_v1', outputs: { workOrderPriority: wo.priority, assignedRole: 'ldx_manager' } },
        stepTracesJson: [{ stepIndex: 0, type: 'create_record', status: 'completed', output: { collection: 'latticeCustomWorkOrders', id: wo.id } }],
      };
      state.automationRuns.push(run);
      return okResp({ run });
    }
    if (resourceAction === 'dxosAutomations:listRuns') {
      const org = query.get('organizationId');
      const rKey = query.get('ruleKey');
      return okResp({
        items: state.automationRuns.filter((r) => (!org || r.organizationId === org) && (!rKey || r.ruleKey === rKey)),
      });
    }
    if (resourceAction === 'latticeCustomWorkOrders:get') {
      const id = Number(query.get('filterByTk'));
      const wo = state.workOrders.find((w) => w.id === id);
      return wo ? okResp(wo) : errResp(404, 'NOT_FOUND');
    }
    if (resourceAction === 'latticeCustomWorkOrders:list') {
      const f = JSON.parse(query.get('filter') || '{}');
      return okResp(state.workOrders.filter((w) => (!f.assetId || w.assetId === f.assetId)));
    }

    // 4. Webhooks & Circuit Breaker / DLQ
    if (resourceAction === 'dxosEvents:listEvents') {
      const org = query.get('organizationId');
      const eType = query.get('eventType');
      return okResp({
        items: state.events.filter((e) => (!org || e.organizationId === org) && (!eType || e.eventType === eType)),
      });
    }
    if (resourceAction === 'dxosEvents:saveSubscription') {
      const sub = {
        id: ++state.nextId,
        organizationId: values.organizationId,
        subscriptionKey: values.subscriptionKey,
        name: values.name,
        targetUrl: values.targetUrl,
        eventPattern: values.eventPattern,
        signingSecret: values.signingSecret,
        active: values.active !== false,
        failureCount: 0,
        circuitState: 'closed',
        circuitOpenUntil: null,
      };
      state.subscriptions.push(sub);
      const { signingSecret, ...safe } = sub;
      return okResp({ ...safe, hasSigningSecret: Boolean(signingSecret) });
    }
    if (resourceAction === 'dxosEvents:listSubscriptions') {
      const org = query.get('organizationId');
      return okResp({
        items: state.subscriptions
          .filter((s) => !org || s.organizationId === org)
          .map(({ signingSecret, ...safe }) => ({ ...safe, hasSigningSecret: Boolean(signingSecret) })),
      });
    }
    if (resourceAction === 'dxosEvents:publish') {
      const evtId = `evt-${++state.nextId}`;
      const evt = {
        id: state.nextId,
        eventId: evtId,
        organizationId: values.organizationId,
        eventType: values.type,
        subject: values.subject,
        specversion: '1.0',
      };
      state.events.push(evt);
      const matchingSubs = state.subscriptions.filter(
        (s) => s.organizationId === values.organizationId && s.active,
      );
      for (const s of matchingSubs) {
        state.deliveries.push({
          id: ++state.nextId,
          organizationId: values.organizationId,
          eventId: evtId,
          subscriptionId: s.id,
          eventType: values.type,
          attempt: 0,
          status: 'pending',
          lastError: null,
        });
      }
      return okResp({ event: { specversion: '1.0', id: evtId, type: values.type }, deliveriesQueued: matchingSubs.length });
    }
    if (resourceAction === 'dxosEvents:dispatchNow') {
      let processedCount = 0;
      for (const d of state.deliveries.filter((x) => x.organizationId === values.organizationId && x.status === 'pending')) {
        const sub = state.subscriptions.find((s) => s.id === d.subscriptionId);
        if (!sub || sub.circuitState === 'open') continue;
        processedCount += 1;
        d.attempt += 1;
        d.status = d.attempt >= 5 ? 'dlq' : 'retry_wait';
        d.lastError = 'TCP ECONNREFUSED';
        sub.failureCount += 1;
        if (sub.failureCount >= 5) {
          sub.circuitState = 'open';
          sub.circuitOpenUntil = new Date(Date.now() + 120000).toISOString();
        }
      }
      return okResp({ processedCount });
    }
    if (resourceAction === 'dxosEvents:listDeliveries') {
      const subId = Number(query.get('subscriptionId'));
      return okResp({ items: state.deliveries.filter((d) => !subId || d.subscriptionId === subId) });
    }
    if (resourceAction === 'dxosEvents:resetCircuit') {
      const sub = state.subscriptions.find(
        (s) => s.organizationId === values.organizationId && s.subscriptionKey === values.subscriptionKey,
      );
      if (!sub) return errResp(404, 'SUBSCRIPTION_NOT_FOUND');
      sub.circuitState = 'closed';
      sub.failureCount = 0;
      sub.circuitOpenUntil = null;
      const { signingSecret, ...safe } = sub;
      return okResp({ ...safe, hasSigningSecret: Boolean(signingSecret) });
    }
    if (resourceAction === 'dxosEvents:replayDlq') {
      return okResp({ organizationId: values.organizationId, replayedCount: 0, deliveryIds: [] });
    }
    if (resourceAction === 'dxosEvents:deleteSubscription') {
      const idx = state.subscriptions.findIndex(
        (s) => s.organizationId === values.organizationId && s.subscriptionKey === values.subscriptionKey,
      );
      if (idx < 0) return errResp(404, 'SUBSCRIPTION_NOT_FOUND');
      const [removed] = state.subscriptions.splice(idx, 1);
      return okResp({ deleted: true, id: removed.id, subscriptionKey: removed.subscriptionKey });
    }

    // 5. Visual Domain Builder + OpenAPI + PG RLS isolation
    if (resourceAction === 'dxosBuilder:createDomain') {
      const routeId = ++state.nextId;
      const tabSchemaUid = `dxos-tab-${values.portalSlug}`;
      state.routes.push({ id: routeId, type: 'page', options: { path: `/p/${values.portalSlug}`, collectionName: values.collectionName } });
      state.flowModels.push({ uid: tabSchemaUid, parentId: `dxos-page-${values.portalSlug}` });
      const dom = {
        collectionName: values.collectionName,
        title: values.title,
        fields: values.fields,
        rls: { attached: true, verified: true },
        rlsProtected: true,
        portalPage: { path: `/p/${values.portalSlug}`, routeId, tabSchemaUid },
        portalPages: [{ id: routeId, path: `/p/${values.portalSlug}` }],
      };
      state.domains.set(values.collectionName, dom);
      state.customRecords.set(values.collectionName, []);
      return okResp({ domain: dom });
    }
    if (resourceAction === 'dxosBuilder:listDomains') {
      return okResp({ items: [...state.domains.values()] });
    }
    if (resourceAction === 'dxos:openapi') {
      const paths = { '/api/dxos:health': { get: {} } };
      const schemas = { GenericResponse: { type: 'object' } };
      for (const [name, dom] of state.domains.entries()) {
        if (omitCustomCollectionInOpenApi && name.startsWith('latticeCustomAcc')) continue;
        paths[`/api/${name}:list`] = { get: {} };
        paths[`/api/${name}:create`] = { post: {} };
        schemas[name] = { type: 'object', title: dom.title, properties: { organizationId: { type: 'string' } } };
      }
      return okResp({ openapi: '3.1.0', info: { version: '1.0.0' }, paths, components: { schemas } });
    }

    const customMatch = resourceAction.match(/^(latticeCustomAcc[A-Za-z0-9]+):(create|list|get|destroy)$/);
    if (customMatch) {
      const [, colName, act] = customMatch;
      const rows = state.customRecords.get(colName) || [];
      if (act === 'create') {
        if (actorRole === 'employee' && values.organizationId !== 'native-ui-lab') {
          return errResp(403, 'NATIVE_ORGANIZATION_MISMATCH');
        }
        const rec = { id: ++state.nextId, ...values };
        rows.push(rec);
        return okResp(rec);
      }
      if (act === 'list') {
        const scoped = actorRole === 'employee' ? rows.filter((r) => r.organizationId === 'native-ui-lab') : rows;
        return okResp(scoped);
      }
      if (act === 'get') {
        const id = Number(query.get('filterByTk'));
        const row = rows.find((r) => r.id === id);
        if (!row) return errResp(404, 'NOT_FOUND');
        if (actorRole === 'employee' && row.organizationId !== 'native-ui-lab') {
          return errResp(404, 'NOT_FOUND');
        }
        return okResp(row);
      }
      if (act === 'destroy') {
        state.destroyedPaths.push(path);
        const id = Number(query.get('filterByTk'));
        state.customRecords.set(colName, rows.filter((r) => r.id !== id));
        return okResp({ ok: true });
      }
    }

    // 6. 1-Click Tenant Provisioning
    if (resourceAction === 'dxosBuilder:provisionTenant') {
      const existingOrg = state.tenants.find((t) => t.organizationId === values.organizationId);
      if (!existingOrg) {
        state.tenants.push({ organizationId: values.organizationId, name: values.name, region: values.region || 'VN' });
        state.departments.push(
          { id: ++state.nextId, organizationId: values.organizationId, code: 'ops' },
          { id: ++state.nextId, organizationId: values.organizationId, code: 'maint' },
        );
        state.locations.push({ id: ++state.nextId, organizationId: values.organizationId, code: 'hq' });
        state.pkiKeys.push({
          id: ++state.nextId,
          organizationId: values.organizationId,
          keyId: `ed25519-${values.organizationId}`,
          algorithm: 'Ed25519',
          active: true,
        });
        for (let i = 0; i < 4; i += 1) {
          state.slas.push({ id: ++state.nextId, organizationId: values.organizationId, priority: `p${i}` });
        }
        const uId = ++state.nextId;
        state.users.push({ id: uId, username: values.adminUsername, email: values.adminEmail, organizationId: values.organizationId });
        state.employees.push({ id: ++state.nextId, organizationId: values.organizationId, userId: uId, code: `emp_admin_${values.organizationId}` });
      }
      const pki = state.pkiKeys.find((k) => k.organizationId === values.organizationId);
      const usr = state.users.find((u) => u.organizationId === values.organizationId);
      const emp = state.employees.find((e) => e.organizationId === values.organizationId);
      return okResp({
        provisioned: true,
        organization: state.tenants.find((t) => t.organizationId === values.organizationId),
        departmentsCount: 2,
        locationsCount: 1,
        pkiKey: { keyId: pki.keyId, algorithm: 'Ed25519', active: true, status: 'active' },
        slaCount: 4,
        adminAccount: { userId: usr.id, username: usr.username, email: usr.email, role: 'ldx_admin', employeeId: emp.id },
      });
    }
    if (resourceAction === 'dxosBuilder:listTenants') {
      return okResp({
        items: state.tenants.map((t) => ({
          ...t,
          departmentCount: state.departments.filter((d) => d.organizationId === t.organizationId).length,
          employeeCount: state.employees.filter((e) => e.organizationId === t.organizationId).length,
          activePkiKey: state.pkiKeys.find((k) => k.organizationId === t.organizationId) || null,
          slaCount: state.slas.filter((s) => s.organizationId === t.organizationId).length,
        })),
      });
    }

    // Cleanup list & destroy endpoints
    if (resourceAction === 'collections:destroy') {
      state.destroyedPaths.push(path);
      state.domains.delete(query.get('filterByTk'));
      return okResp({ ok: true });
    }
    if (resourceAction.endsWith(':list')) {
      return okResp([]);
    }
    if (resourceAction.endsWith(':destroy')) {
      state.destroyedPaths.push(path);
      return okResp({ ok: true });
    }

    throw new Error(`Unexpected mock API call: ${resourceAction}`);
  };

  return { callActor, state };
}

test('parseBrokerAcceptanceArgs validates origins and parses report/origin/org flags', () => {
  assert.equal(typeof createBrokerAcceptanceCallers, 'function');
  assert.throws(() => parseBrokerAcceptanceArgs([]), /Usage:/);
  assert.throws(() => parseBrokerAcceptanceArgs(['--origin=http://localhost:13000']), /Unsafe/i);
  assert.throws(() => parseBrokerAcceptanceArgs(['--origin=https://evil.example.com']), /Unsafe/i);
  assert.throws(() => parseBrokerAcceptanceArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseBrokerAcceptanceArgs(['a.json', 'b.json']), /Unexpected argument/);

  const byOrigin = parseBrokerAcceptanceArgs(['--origin=http://127.0.0.1:13014', '--org=mekong-ops']);
  assert.equal(byOrigin.origin, 'http://127.0.0.1:13014');
  assert.equal(byOrigin.organizationId, 'mekong-ops');
  assert.equal(byOrigin.reportPath, null);

  const byReport = parseBrokerAcceptanceArgs(['output/native-clean/1234/report.json']);
  assert.equal(byReport.reportPath, 'output/native-clean/1234/report.json');
  assert.equal(byReport.origin, null);
  assert.equal(byReport.organizationId, 'native-ui-lab');
});

test('runBrokerAutomationBuilderAcceptance verifies all 6 closed-loop checks, masks secrets, and cleans up', async () => {
  const { callActor, state } = createMockAcceptanceCaller();
  const res = await runBrokerAutomationBuilderAcceptance(callActor, { organizationId: 'native-ui-lab' });

  assert.equal(res.status, 'PASS');
  assert.equal(res.result, 'PASS');
  for (const [name, passed] of Object.entries(res.checks)) {
    assert.equal(passed, true, `Acceptance check ${name} did not pass`);
  }

  // Zero secret leaks in summary
  const summaryText = JSON.stringify(res);
  assert.equal(summaryText.includes('acc-vault-v1-'), false);
  assert.equal(summaryText.includes('acc-vault-v2-'), false);
  assert.equal(summaryText.includes('acc-whsec-'), false);
  for (const pwd of state.provisionedPasswords) {
    assert.equal(summaryText.includes(pwd), false, 'Acceptance summary leaked mqttPassword');
  }

  // Temporary entities cleaned up
  assert.equal(state.connectors.length, 0);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.automationRules.some((r) => r.ruleKey.startsWith('acc_lwt_wo_')), false);
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('collections:destroy?filterByTk=latticeCustomAcc')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeAssets:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeIotDevices:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeCustomWorkOrders:destroy?')));
});

test('runBrokerAutomationBuilderAcceptance fails closed on leaked mqttPassword or missing OpenAPI custom paths and still cleans up', async () => {
  const leakyMock = createMockAcceptanceCaller({ leakMqttPasswordInList: true });
  await assert.rejects(
    () => runBrokerAutomationBuilderAcceptance(leakyMock.callActor, { organizationId: 'native-ui-lab' }),
    /listDevices/,
  );
  assert.ok(leakyMock.state.destroyedPaths.some((p) => p.startsWith('latticeAssets:destroy?')));
  assert.ok(leakyMock.state.destroyedPaths.some((p) => p.startsWith('latticeIotDevices:destroy?')));

  const missingOpenApiMock = createMockAcceptanceCaller({ omitCustomCollectionInOpenApi: true });
  await assert.rejects(
    () => runBrokerAutomationBuilderAcceptance(missingOpenApiMock.callActor, { organizationId: 'native-ui-lab' }),
    /dxos:openapi missing/,
  );
  assert.ok(missingOpenApiMock.state.destroyedPaths.some((p) => p.startsWith('collections:destroy?')));
});

test('acceptance script and test carry compliant CTU-OpenPaw SPDX headers', () => {
  for (const rel of [
    'scripts/acceptance-broker-automation-builder.mjs',
    'scripts/tests/acceptance-broker-automation-builder.test.mjs',
    'scripts/seed-v100-championship-showcase.mjs',
    'scripts/tests/seed-v100-championship-showcase.test.mjs',
  ]) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const res = addSourceHeader(src, rel);
    assert.equal(res.status, 'present', `SPDX header check failed for ${rel}: ${res.status}`);
  }
});

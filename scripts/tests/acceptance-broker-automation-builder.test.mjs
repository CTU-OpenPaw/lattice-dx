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
import { createHash, createHmac } from 'node:crypto';
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
const BLUEPRINTS_DIR = join(REPO_ROOT, 'plugins/nocobase/plugin-dxos-studio/src/server/flow/blueprints');
const MOCK_BLUEPRINTS = [
  'coldchain-emergency.json',
  'mkt-quarantine.json',
  'sla-escalation.json',
  'procurement-hitl-approval.json',
  'scheduled-ai-digest.json',
  'partner-webhook-sync.json',
].map((file) => JSON.parse(readFileSync(join(BLUEPRINTS_DIR, file), 'utf8')));

const MOCK_NODE_TYPES = [
  ['trigger.event', 'trigger'],
  ['trigger.record', 'trigger'],
  ['trigger.schedule', 'trigger'],
  ['trigger.webhook', 'trigger'],
  ['trigger.manual', 'trigger'],
  ['control.if', 'control'],
  ['control.switch', 'control'],
  ['control.parallel', 'control'],
  ['control.merge', 'control'],
  ['control.loop', 'control'],
  ['control.delay', 'control'],
  ['control.approval', 'control'],
  ['control.subflow', 'control'],
  ['data.query', 'data'],
  ['data.create', 'data'],
  ['data.update', 'data'],
  ['logic.dmn', 'logic'],
  ['logic.transform', 'logic'],
  ['ai.llm', 'ai'],
  ['ai.agent', 'ai'],
  ['integration.http', 'integration'],
  ['iot.twin_command', 'integration'],
  ['notify.send', 'integration'],
  ['event.emit', 'integration'],
].map(([type, category]) => ({
  type,
  category,
  label: type,
  inputs: category === 'trigger' ? [] : ['in'],
  outputs: type === 'control.if'
    ? ['true', 'false', 'error']
    : type === 'control.approval'
      ? ['approved', 'rejected', 'error']
      : type === 'control.loop'
        ? ['item', 'done', 'error']
        : category === 'trigger'
          ? ['main']
          : ['main', 'error'],
}));

const sha256Hex = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');

function createMockAcceptanceCaller({
  leakMqttPasswordInList = false,
  omitCustomCollectionInOpenApi = false,
  failStep = null,
  skipCmmsCoreStep = false,
  missingConnectorOnStep4 = false,
  shrinkNodeRegistry = false,
  forceReplayResumeOk = false,
  forceBadWebhookAccept = false,
  initialAutomationRuns = [],
  initialAutomationRules = [],
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
    automationRules: [...initialAutomationRules],
    automationRuns: [...initialAutomationRuns],
    workOrders: [],
    serviceTickets: [],
    approvalQueue: [],
    twinShadows: [],
    proposals: [],
    partnerClaims: [],
    oauthStates: new Map(),
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
      'dxosVault:delete',
      'dxosBroker:provisionDevice',
      'dxosAutomations:saveRule',
      'dxosAutomations:deleteRule',
      'dxosAutomations:aiAssist',
      'dxosAutomations:resumeRun',
      'dxosBuilder:createDomain',
      'dxosBuilder:provisionTenant',
      'dxosVault:oauthStart',
    ]);
    if (
      adminMutations.has(resourceAction)
      || resourceAction === 'dxosAutomations:builderCatalog'
      || resourceAction === 'dxosAutomations:nodeRegistry'
      || resourceAction === 'dxosAutomations:testNode'
      || resourceAction === 'dxosN8n:status'
      || resourceAction === 'dxosN8n:appCatalog'
    ) {
      if (actorRole === 'anon') return errResp(401, 'NATIVE_LOGIN_REQUIRED');
      if (actorRole === 'employee' && resourceAction !== 'dxosAutomations:nodeRegistry') {
        return errResp(403, 'FORBIDDEN');
      }
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

    // 3. CMMS Pack, Partner Settlement Pack, Assets, Broker DynSec, LWT, Automations
    if (resourceAction === 'dxosBuilder:installBusinessPack') {
      if (values.packKey === 'coldchain-partner-settlement') {
        const rule = {
          id: ++state.nextId,
          organizationId: values.organizationId,
          ruleKey: 'auto_coldchain_partner_settlement',
          schemaVersion: 2,
          active: true,
        };
        if (!state.automationRules.some((r) => r.ruleKey === rule.ruleKey)) {
          state.automationRules.push(rule);
        }
        return okResp({
          installed: true,
          packKey: values.packKey,
          organizationId: values.organizationId,
          domain: {
            collectionName: 'latticeCustomPartnerClaims',
            portalPage: { path: '/p/partner-claims' },
          },
          dmnTable: { tableKey: 'coldchain_settlement_policy_v1' },
          automationRule: rule,
        });
      }
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
          name: 'Auto CMMS Cold-Chain Fault',
          triggerEventType: 'alarm.triggered,device.offline',
          dmnTableKey: 'cmms_priority_routing_v1',
          cooldownSec: 60,
          actionsJson: [
            { type: 'create_record', collection: 'latticeCustomWorkOrders' },
            { type: 'notify_role', role: '{{dmn.assignedRole}}' },
            { type: 'twin_set_desired', when: { 'dmn.workOrderPriority': 'critical' }, desiredPatch: { targetTempC: 4.0, fanMode: 'high' } },
            { type: 'trigger_ai_triage', when: { 'dmn.workOrderPriority': 'critical' } },
            { type: 'call_connector', when: { 'dmn.workOrderPriority': 'critical' }, connectorKey: 'n8n-coldchain-orchestrator' },
          ],
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
      const idx = state.automationRules.findIndex(
        (r) => r.organizationId === values.organizationId && r.ruleKey === values.ruleKey,
      );
      const rule = { id: idx >= 0 ? state.automationRules[idx].id : ++state.nextId, ...values };
      if (idx >= 0) state.automationRules[idx] = rule;
      else state.automationRules.push(rule);
      return okResp({ rule });
    }
    if (resourceAction === 'dxosAutomations:deleteRule') {
      const idx = state.automationRules.findIndex(
        (r) => r.organizationId === values.organizationId && r.ruleKey === values.ruleKey,
      );
      if (idx < 0) return errResp(404, 'RULE_NOT_FOUND', `Automation rule ${values.ruleKey} not found`);
      state.automationRules.splice(idx, 1);
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
          triggerEventId: evt.eventId,
          subject: dev.deviceKey,
          status: 'completed',
          stepTracesJson: [{ stepIndex: 0, type: 'create_record', status: 'completed', output: { collection: 'latticeCustomWorkOrders', id: wo.id, record: wo } }],
        });
      }
      const { mqttPassword, ...safeDev } = dev;
      return okResp({ device: safeDev, previousStatus: 'provisioned', transitionedToOffline: true, incident });
    }
    if (resourceAction === 'dxosAutomations:nodeRegistry') {
      const nodeTypes = shrinkNodeRegistry ? MOCK_NODE_TYPES.slice(0, 12) : MOCK_NODE_TYPES;
      return okResp({ nodeTypes });
    }
    if (resourceAction === 'dxosAutomations:testNode') {
      let graph = values.graph || values.graphJson || values.rule?.graphJson || null;
      if (!graph && values.ruleKey) {
        const found = state.automationRules.find(
          (r) => r.organizationId === values.organizationId && r.ruleKey === values.ruleKey,
        );
        if (!found) return errResp(404, 'RULE_NOT_FOUND');
        graph = found.graphJson;
      }
      const target = graph?.nodes?.find((n) => n.id === values.nodeId);
      if (!target) return errResp(404, 'FLOW_NODE_NOT_FOUND');
      const pinData = values.pinnedInputs?.data || values.pinnedInputs || {};
      if (target.type === 'control.if') {
        const cond = target.config?.condition || {};
        const fieldName = String(cond.field || '').replace(/^data\./, '');
        const actual = pinData[fieldName];
        const matched = cond.op === 'gt' ? Number(actual) > Number(cond.value) : actual === cond.value;
        return okResp({
          result: {
            ok: true,
            nodeId: target.id,
            status: 'completed',
            input: pinData,
            output: { matched, condition: cond },
            nextPort: matched ? 'true' : 'false',
            durationMs: 1,
            error: null,
          },
        });
      }
      if (target.type === 'data.create') {
        return okResp({
          result: {
            ok: true,
            nodeId: target.id,
            status: 'completed',
            input: pinData,
            output: { collection: target.config?.collection, id: null, record: target.config?.values || {}, simulated: true },
            nextPort: 'main',
            durationMs: 1,
            error: null,
          },
        });
      }
      return okResp({
        result: {
          ok: true,
          nodeId: target.id,
          status: 'completed',
          input: pinData,
          output: { simulated: true },
          nextPort: 'main',
          durationMs: 1,
          error: null,
        },
      });
    }
    if (resourceAction === 'dxosAutomations:runNow') {
      const savedRule = state.automationRules.find(
        (r) => r.organizationId === values.organizationId && r.ruleKey === values.ruleKey,
      );
      const approvalNode = savedRule?.graphJson?.nodes?.find((n) => n.type === 'control.approval');
      if (approvalNode) {
        const approvalId = ++state.nextId;
        const resumeToken = `mock-resume-token-${++state.nextId}`;
        const runUid = `run_${++state.nextId}`;
        state.approvalQueue.push({
          id: approvalId,
          organizationId: values.organizationId,
          status: 'pending',
          toolName: 'latticeflow.approval',
          proposedArgs: { organizationId: values.organizationId, runUid },
          title: approvalNode.config?.title || 'Approval Required',
        });
        const trigNode = savedRule.graphJson.nodes.find((n) => String(n.type || '').startsWith('trigger.'));
        const nodeStatesJson = {
          ...(trigNode ? { [trigNode.id]: { status: 'completed', output: { data: values.event?.data || values.data || {} } } } : {}),
          [approvalNode.id]: { status: 'suspended', output: { approvalId, status: 'pending' }, suspend: { kind: 'approval', approvalId } },
        };
        const stepTracesJson = [
          ...(trigNode ? [{ nodeId: trigNode.id, type: trigNode.type, label: trigNode.label, status: 'completed', output: { data: values.event?.data || values.data || {} } }] : []),
          { nodeId: approvalNode.id, type: approvalNode.type, label: approvalNode.label, status: 'suspended', output: { approvalId, status: 'pending' } },
        ];
        const runRecord = {
          id: ++state.nextId,
          organizationId: values.organizationId,
          ruleKey: values.ruleKey,
          runUid,
          status: 'suspended',
          graphVersion: 2,
          suspendedNodeId: approvalNode.id,
          approvalId,
          resumeTokenHash: sha256Hex(resumeToken),
          triggerPayloadJson: { event: values.event || { type: 'manual.trigger', data: values.data || {} }, data: values.event?.data || values.data || {} },
          nodeStatesJson,
          stepTracesJson,
        };
        state.automationRuns.push(runRecord);
        const { resumeTokenHash: _hiddenHash, ...publicRun } = runRecord;
        return okResp({ run: { ...publicRun, resumeToken } });
      }

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
      const isCmmsV2 = savedRule?.graphJson?.nodes?.length > 0;
      const stepTraces = isCmmsV2
        ? [
            { nodeId: 'trig_coldchain', type: 'trigger.event', status: 'completed', output: { data: values.data || {} } },
            { nodeId: 'dmn_priority', type: 'logic.dmn', status: 'completed', output: { outputs: { workOrderPriority: wo.priority } } },
            { nodeId: 'create_work_order', type: 'data.create', status: 'completed', output: { collection: 'latticeCustomWorkOrders', id: wo.id, record: wo } },
            { nodeId: 'notify_assigned', type: 'notify.send', status: 'completed', output: { dispatched: 1 } },
            { nodeId: 'if_critical', type: 'control.if', status: 'completed', output: { matched: true } },
            { nodeId: 'parallel_critical', type: 'control.parallel', status: 'completed', output: { fannedOut: true } },
            { nodeId: 'twin_cool_down', type: 'iot.twin_command', status: 'completed', output: { shadow: { id: 901, assetId: wo.assetId }, approvalId: 902 } },
            { nodeId: 'ai_triage_wo', type: 'ai.agent', status: 'completed', output: { id: 903, target: 'latticeAgentProposals' } },
            {
              nodeId: 'http_n8n_dispatch',
              type: 'integration.http',
              status: missingConnectorOnStep4 ? 'failed' : 'completed',
              ...(missingConnectorOnStep4
                ? { output: null, error: 'CONNECTOR_NOT_FOUND: n8n-coldchain-orchestrator' }
                : { output: { connectorKey: 'n8n-coldchain-orchestrator', status: 200, ok: true } }),
            },
          ]
        : [
            { stepIndex: 0, type: 'create_record', status: 'completed', output: { collection: 'latticeCustomWorkOrders', id: wo.id, record: wo } },
            { stepIndex: 1, type: 'notify_role', status: 'completed', output: { dispatched: 1 } },
            {
              stepIndex: 2,
              type: 'twin_set_desired',
              status: skipCmmsCoreStep ? 'skipped' : 'completed',
              ...(skipCmmsCoreStep ? { skipReason: 'BRANCH_CONDITION_NOT_MATCHED', output: null } : { output: { shadow: { id: 901, assetId: wo.assetId }, approvalId: 902 } }),
            },
            { stepIndex: 3, type: 'trigger_ai_triage', status: 'completed', output: { id: 903, target: 'latticeAgentProposals' } },
            {
              stepIndex: 4,
              type: 'call_connector',
              status: missingConnectorOnStep4 ? 'failed' : 'completed',
              ...(missingConnectorOnStep4
                ? { output: null, error: 'CONNECTOR_NOT_FOUND: n8n-coldchain-orchestrator' }
                : { output: { connectorKey: 'n8n-coldchain-orchestrator', status: 200, ok: true } }),
            },
          ];
      const run = {
        id: ++state.nextId,
        organizationId: values.organizationId,
        ruleKey: values.ruleKey,
        runUid: `run_${state.nextId}`,
        subject: values.subject ?? values.data?.deviceKey ?? '',
        ...(isCmmsV2 ? { graphVersion: 2 } : {}),
        status: missingConnectorOnStep4 ? 'partial' : 'completed',
        dmnResultJson: { tableKey: 'cmms_priority_routing_v1', outputs: { workOrderPriority: wo.priority, assignedRole: 'ldx_manager' } },
        stepTracesJson: stepTraces,
      };
      state.automationRuns.push(run);
      return okResp({ run });
    }
    if (resourceAction === 'dxosAutomations:resumeRun') {
      const existing = state.automationRuns.find((r) => r.runUid === values.runUid);
      if (!existing) return errResp(404, 'RUN_NOT_FOUND', `Automation run ${values.runUid} not found`);
      if (existing.organizationId !== values.organizationId) {
        return errResp(403, 'NATIVE_ORGANIZATION_MISMATCH', 'Run belongs to another organization');
      }
      if (existing.status !== 'suspended' && !forceReplayResumeOk) {
        return errResp(409, 'RUN_ALREADY_RESUMED', `Run status is "${existing.status}", expected "suspended"`);
      }
      if (values.resumeToken !== undefined && sha256Hex(values.resumeToken) !== existing.resumeTokenHash) {
        return errResp(403, 'INVALID_RESUME_TOKEN', 'Invalid or missing resume token');
      }
      const decision = String(values.decision || 'approved').toLowerCase() === 'rejected' ? 'rejected' : 'approved';
      const qItem = state.approvalQueue.find((q) => q.id === existing.approvalId);
      if (qItem) qItem.status = decision;

      const rule = state.automationRules.find(
        (r) => r.organizationId === existing.organizationId && r.ruleKey === existing.ruleKey,
      );
      const nextNodeStates = { ...(existing.nodeStatesJson || {}) };
      const nextTraces = [...(existing.stepTracesJson || [])];
      nextNodeStates[existing.suspendedNodeId] = { status: 'completed', nextPort: decision, output: { status: decision, decision } };
      const apTrace = nextTraces.find((t) => t.nodeId === existing.suspendedNodeId);
      if (apTrace) apTrace.status = 'completed';

      if (decision === 'approved') {
        const createNode = rule?.graphJson?.nodes?.find((n) => n.type === 'data.create');
        if (createNode && createNode.config?.collection === 'latticeServiceTickets') {
          const ticket = {
            id: ++state.nextId,
            organizationId: existing.organizationId,
            code: `HITL-${existing.triggerPayloadJson?.data?.code || existing.runUid}`,
            name: `Approved ${existing.triggerPayloadJson?.data?.code || existing.runUid}`,
            serviceType: 'facilities',
            priority: 'high',
            status: 'draft',
          };
          state.serviceTickets.push(ticket);
          nextNodeStates[createNode.id] = {
            status: 'completed',
            output: { collection: 'latticeServiceTickets', id: ticket.id, record: ticket },
          };
          nextTraces.push({
            nodeId: createNode.id,
            type: 'data.create',
            label: createNode.label,
            status: 'completed',
            output: { collection: 'latticeServiceTickets', id: ticket.id, record: ticket },
          });
        }
        const okNotify = rule?.graphJson?.nodes?.find((n) => n.id === 'notify_ok');
        if (okNotify) {
          nextNodeStates[okNotify.id] = { status: 'completed', output: { dispatched: 1 } };
          nextTraces.push({ nodeId: okNotify.id, type: 'notify.send', status: 'completed', output: { dispatched: 1 } });
        }
        const rejNotify = rule?.graphJson?.nodes?.find((n) => n.id === 'notify_rej');
        if (rejNotify) {
          nextNodeStates[rejNotify.id] = { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' };
        }
      }

      existing.status = 'completed';
      existing.suspendedNodeId = null;
      existing.resumeTokenHash = null;
      existing.nodeStatesJson = nextNodeStates;
      existing.stepTracesJson = nextTraces;
      return okResp({ run: existing });
    }
    if (resourceAction === 'dxosAutomations:getRunTrace') {
      const runUid = query.get('runUid');
      const org = query.get('organizationId');
      const found = state.automationRuns.find((r) => r.runUid === runUid && (!org || r.organizationId === org));
      return found ? okResp({ run: found }) : errResp(404, 'RUN_NOT_FOUND');
    }
    if (resourceAction === 'dxosAutomations:webhookIngress') {
      const org = query.get('organizationId') || values.organizationId;
      const rKey = query.get('ruleKey') || values.ruleKey;
      const rule = state.automationRules.find((r) => r.organizationId === org && r.ruleKey === rKey && r.active !== false);
      if (!rule) return errResp(404, 'RULE_NOT_FOUND');
      const trig = rule.graphJson?.nodes?.find((n) => n.type === 'trigger.webhook');
      if (!trig) return errResp(400, 'WEBHOOK_TRIGGER_NOT_CONFIGURED');
      const conn = state.connectors.find(
        (c) => c.organizationId === org && (c.connectorKey === trig.config?.secretConnectorKey || c.connectorKey === `webhook-${rKey}`),
      );
      const secret = conn?.secrets?.webhookSecret || conn?.secrets?.secret || trig.config?.secret || '';
      if (!secret) return errResp(401, 'WEBHOOK_SIGNATURE_INVALID');
      const hdrs = opts.headers || {};
      const sigKey = Object.keys(hdrs).find((k) => k.toLowerCase() === 'x-lattice-signature-256');
      const sigVal = sigKey ? String(hdrs[sigKey]) : '';
      const providedHex = sigVal.startsWith('sha256=') ? sigVal.slice(7).trim() : sigVal.trim();
      const expectedHex = createHmac('sha256', secret).update(JSON.stringify(values), 'utf8').digest('hex');
      if (!forceBadWebhookAccept && providedHex !== expectedHex) {
        return errResp(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook HMAC signature');
      }
      const runUid = `run_${++state.nextId}`;
      state.automationRuns.push({
        id: state.nextId,
        organizationId: org,
        ruleKey: rKey,
        runUid,
        status: 'completed',
        graphVersion: 2,
        stepTracesJson: [{ nodeId: trig.id, type: 'trigger.webhook', status: 'completed' }],
      });
      return okResp({ ok: true, run: { runUid, status: 'completed' } });
    }
    if (resourceAction === 'dxosAutomations:builderCatalog') {
      const org = query.get('organizationId');
      return okResp({
        organizationId: org,
        nodeTypes: MOCK_NODE_TYPES,
        eventTypes: [{ type: 'alarm.triggered' }, { type: 'sla.warning' }, { type: 'sla.breached' }],
        actionTypes: [{ type: 'create_record' }, { type: 'notify_role' }],
        dmnTables: [{ key: 'cmms_priority_routing_v1', name: 'CMMS Priority Routing' }],
        collections: [{ name: 'latticeCustomWorkOrders', fields: [{ name: 'workOrderCode', type: 'string' }, { name: 'priority', type: 'string' }] }],
        connectors: state.connectors.map(({ secrets, ...safe }) => safe),
        roles: ['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_dispatcher'],
        blueprints: MOCK_BLUEPRINTS,
      });
    }
    if (resourceAction === 'dxosAutomations:testRule') {
      const targetRuleKey = values.rule?.ruleKey || values.ruleKey;
      const savedRule = state.automationRules.find(
        (r) => r.organizationId === values.organizationId && r.ruleKey === targetRuleKey,
      );
      if (targetRuleKey === 'auto_coldchain_partner_settlement') {
        return okResp({
          ok: true,
          simulation: {
            graphVersion: 2,
            status: 'completed',
            dmnResultJson: { tableKey: 'coldchain_settlement_policy_v1', outputs: { settlementTier: 'critical', settlementRatePct: 85 } },
            nodeStatesJson: { trig_claim: { status: 'completed' }, dmn_policy: { status: 'completed' } },
            stepTracesJson: [{ nodeId: 'trig_claim', type: 'trigger.event', status: 'completed', simulated: true }],
          },
        });
      }
      if (targetRuleKey === 'auto_sla_breach_escalation') {
        const useV1 = savedRule && !savedRule.graphJson;
        const evType = String(values.event?.type || 'sla.breached');
        const isWarn = evType === 'sla.warning';
        const isBreach = evType === 'sla.breached';
        if (useV1) {
          return okResp({
            simulation: {
              dmnResultJson: null,
              stepTracesJson: [
                { stepIndex: 0, type: 'notify_role', status: isWarn ? 'simulated' : 'skipped', ...(isWarn ? {} : { skipReason: 'BRANCH_CONDITION_NOT_MATCHED' }) },
                { stepIndex: 1, type: 'create_record', status: isBreach ? 'simulated' : 'skipped', ...(isBreach ? {} : { skipReason: 'BRANCH_CONDITION_NOT_MATCHED' }) },
                { stepIndex: 2, type: 'notify_role', status: isBreach ? 'simulated' : 'skipped', ...(isBreach ? {} : { skipReason: 'BRANCH_CONDITION_NOT_MATCHED' }) },
              ],
            },
          });
        }
        return okResp({
          simulation: {
            graphVersion: 2,
            dmnResultJson: null,
            nodeStatesJson: isWarn
              ? {
                  trig_sla: { status: 'completed' },
                  switch_sla_event: { status: 'completed', nextPort: 'case_0' },
                  notify_dispatcher_warn: { status: 'completed' },
                  create_sla_ticket: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                  notify_manager_breach: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                }
              : {
                  trig_sla: { status: 'completed' },
                  switch_sla_event: { status: 'completed', nextPort: 'case_1' },
                  notify_dispatcher_warn: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                  create_sla_ticket: { status: 'completed' },
                  notify_manager_breach: { status: 'completed' },
                },
            stepTracesJson: isWarn
              ? [
                  { nodeId: 'trig_sla', type: 'trigger.event', status: 'completed', simulated: true },
                  { nodeId: 'switch_sla_event', type: 'control.switch', status: 'completed', simulated: true },
                  { nodeId: 'notify_dispatcher_warn', type: 'notify.send', status: 'completed', simulated: true },
                ]
              : [
                  { nodeId: 'trig_sla', type: 'trigger.event', status: 'completed', simulated: true },
                  { nodeId: 'switch_sla_event', type: 'control.switch', status: 'completed', simulated: true },
                  { nodeId: 'create_sla_ticket', type: 'data.create', status: 'completed', simulated: true },
                  { nodeId: 'notify_manager_breach', type: 'notify.send', status: 'completed', simulated: true },
                ],
          },
        });
      }
      if (!values.rule && targetRuleKey !== 'auto_cmms_on_coldchain_fault') {
        if (!savedRule) return errResp(404, 'RULE_NOT_FOUND', `Automation rule ${targetRuleKey} not found`);
        const loopNode = savedRule.graphJson?.nodes?.find((n) => n.type === 'control.loop');
        const ifNode = savedRule.graphJson?.nodes?.find((n) => n.type === 'control.if');
        if (loopNode && ifNode) {
          const exceeded = values.event?.data?.thresholdExceeded === true;
          const items = Array.isArray(values.event?.data?.items) ? values.event.data.items : [];
          if (exceeded) {
            return okResp({
              simulation: {
                graphVersion: 2,
                status: 'completed',
                nodeStatesJson: {
                  trig_1: { status: 'completed' },
                  if_check: { status: 'completed', nextPort: 'true' },
                  loop_items: { status: 'completed', output: { count: items.length, results: items } },
                  xform_item: { status: 'completed' },
                  notify_done: { status: 'completed' },
                  notify_skip: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                },
                stepTracesJson: [
                  { nodeId: 'trig_1', type: 'trigger.event', status: 'completed', simulated: true },
                  { nodeId: 'if_check', type: 'control.if', status: 'completed', simulated: true, output: { matched: true } },
                  { nodeId: 'loop_items', type: 'control.loop', status: 'completed', simulated: true, output: { count: items.length, results: items } },
                  ...items.map((item, idx) => ({ nodeId: 'xform_item', type: 'logic.transform', status: 'completed', simulated: true, loopNodeId: 'loop_items', loopIteration: idx, output: item })),
                  { nodeId: 'notify_done', type: 'notify.send', status: 'completed', simulated: true },
                ],
              },
            });
          }
          return okResp({
            simulation: {
              graphVersion: 2,
              status: 'completed',
              nodeStatesJson: {
                trig_1: { status: 'completed' },
                if_check: { status: 'completed', nextPort: 'false' },
                loop_items: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                xform_item: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                notify_done: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                notify_skip: { status: 'completed' },
              },
              stepTracesJson: [
                { nodeId: 'trig_1', type: 'trigger.event', status: 'completed', simulated: true },
                { nodeId: 'if_check', type: 'control.if', status: 'completed', simulated: true, output: { matched: false } },
                { nodeId: 'notify_skip', type: 'notify.send', status: 'completed', simulated: true },
              ],
            },
          });
        }
        return okResp({
          simulation: {
            graphVersion: 2,
            status: 'completed',
            nodeStatesJson: Object.fromEntries((savedRule.graphJson?.nodes || []).map((n) => [n.id, { status: 'completed' }])),
            stepTracesJson: (savedRule.graphJson?.nodes || []).map((n) => ({ nodeId: n.id, type: n.type, status: 'completed', simulated: true })),
          },
        });
      }
      const sev = String(values.event?.data?.severity || 'high');
      const isCrit = sev === 'critical';
      if (savedRule?.graphJson?.nodes?.length > 0) {
        return okResp({
          simulation: {
            graphVersion: 2,
            dmnResultJson: { tableKey: 'cmms_priority_routing_v1', outputs: { workOrderPriority: isCrit ? 'critical' : 'high', assignedRole: isCrit ? 'ldx_manager' : 'ldx_operator' } },
            nodeStatesJson: isCrit
              ? Object.fromEntries(savedRule.graphJson.nodes.map((n) => [n.id, { status: 'completed' }]))
              : {
                  trig_coldchain: { status: 'completed' },
                  dmn_priority: { status: 'completed' },
                  create_work_order: { status: 'completed' },
                  notify_assigned: { status: 'completed' },
                  if_critical: { status: 'completed', nextPort: 'false' },
                  parallel_critical: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                  twin_cool_down: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                  ai_triage_wo: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                  http_n8n_dispatch: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
                },
            stepTracesJson: (isCrit
              ? savedRule.graphJson.nodes
              : savedRule.graphJson.nodes.slice(0, 5)
            ).map((n) => ({ nodeId: n.id, type: n.type, status: 'completed', simulated: true })),
          },
        });
      }
      return okResp({
        simulation: {
          dmnResultJson: { tableKey: 'cmms_priority_routing_v1', outputs: { workOrderPriority: isCrit ? 'critical' : 'high', assignedRole: isCrit ? 'ldx_manager' : 'ldx_operator' } },
          stepTracesJson: [
            { stepIndex: 0, type: 'create_record', status: 'simulated' },
            { stepIndex: 1, type: 'notify_role', status: 'simulated' },
            { stepIndex: 2, type: 'twin_set_desired', status: isCrit ? 'simulated' : 'skipped', ...(isCrit ? {} : { skipReason: 'BRANCH_CONDITION_NOT_MATCHED' }) },
            { stepIndex: 3, type: 'trigger_ai_triage', status: isCrit ? 'simulated' : 'skipped', ...(isCrit ? {} : { skipReason: 'BRANCH_CONDITION_NOT_MATCHED' }) },
            { stepIndex: 4, type: 'call_connector', status: isCrit ? 'simulated' : 'skipped', ...(isCrit ? {} : { skipReason: 'BRANCH_CONDITION_NOT_MATCHED' }) },
          ],
        },
      });
    }
    if (resourceAction === 'dxosAutomations:aiAssist') {
      if (/ignore previous|users table/i.test(String(values.prompt || ''))) {
        return errResp(400, 'AI_ASSIST_REFUSED', 'Unsafe prompt rejected');
      }
      if (values.mode === 'suggest') {
        return okResp({
          ok: true,
          refused: false,
          mode: 'suggest',
          modeUsed: 'offline-fallback',
          applied: false,
          suggestions: [{ id: 'add_cooldown_guard', title: 'Add cooldown' }, { id: 'add_error_branch', title: 'Add error branch' }],
        });
      }
      const upsertMockRule = (draftRule) => {
        const idx = state.automationRules.findIndex(
          (r) => r.organizationId === values.organizationId && r.ruleKey === draftRule.ruleKey,
        );
        const saved = {
          id: idx >= 0 ? state.automationRules[idx].id : ++state.nextId,
          organizationId: values.organizationId,
          ...draftRule,
        };
        if (idx >= 0) state.automationRules[idx] = saved;
        else state.automationRules.push(saved);
        return saved;
      };
      if (values.mode === 'fix_error') {
        const g = JSON.parse(JSON.stringify(values.graph || values.rule?.graphJson || {}));
        const failedId = Object.entries(values.runTrace?.nodeStatesJson || {}).find(([, s]) => s?.status === 'failed')?.[0];
        const target = (g.nodes || []).find((n) => n.id === failedId) || (g.nodes || [])[1];
        if (!target) return errResp(400, 'AI_ASSIST_REFUSED', 'No repairable node');
        target.continueOnFail = true;
        target.config = { ...(target.config || {}), recordId: '{{data.id}}', filter: { id: '{{data.id}}' } };
        g.nodes.push({ id: `err_notify_${target.id}`, type: 'notify.send', label: 'Error Alert', config: { roleNames: ['ldx_operator'], severity: 'critical', title: 'Recovered' } });
        g.edges = g.edges || [];
        g.edges.push({ id: `e_err_${target.id}`, source: target.id, sourceHandle: 'error', target: `err_notify_${target.id}`, targetHandle: 'in' });
        return okResp({ ok: true, refused: false, mode: 'fix_error', modeUsed: 'offline-fallback', applied: false, draftGraph: g });
      }
      if (values.mode === 'node') {
        let baseRule = values.rule || null;
        if (!baseRule && values.ruleKey) {
          baseRule = state.automationRules.find(
            (r) => r.organizationId === values.organizationId && r.ruleKey === values.ruleKey,
          );
          if (!baseRule) return errResp(404, 'RULE_NOT_FOUND', `Automation rule ${values.ruleKey} not found`);
        }
        const cloned = JSON.parse(JSON.stringify(baseRule));
        const targetId = String(values.targetNodeId || values.targetNode || '').trim();
        const node = cloned.graphJson?.nodes?.find((n) => n.id === targetId || (targetId === 'trigger' && String(n.type || '').startsWith('trigger.')));
        if (!node) return errResp(400, 'AI_ASSIST_REFUSED', `Target node "${targetId}" not found.`);
        const numMatch = String(values.prompt || '').match(/(-?\d+(?:\.\d+)?)/);
        const roleMatch = String(values.prompt || '').match(/\bldx_[a-z0-9_]+\b/i);
        if (node.type === 'control.if' && numMatch) {
          node.config.condition = { ...(node.config.condition || { field: 'data.value', op: 'gt' }), value: Number(numMatch[1]) };
        } else if (node.type === 'notify.send' && roleMatch) {
          node.config.roleNames = [roleMatch[0].toLowerCase()];
        }
        if (values.apply === true) {
          const savedRule = upsertMockRule(cloned);
          return okResp({ ok: true, refused: false, mode: 'node', modeUsed: 'offline-fallback', applied: true, draftGraph: cloned.graphJson, draftRule: cloned, savedRule });
        }
        return okResp({ ok: true, refused: false, mode: 'node', modeUsed: 'offline-fallback', applied: false, draftGraph: cloned.graphJson, draftRule: cloned });
      }
      const numMatch = String(values.prompt || '').match(/(-?\d+(?:\.\d+)?)/);
      const thresholdVal = numMatch ? Number(numMatch[1]) : 8;
      const graphJson = {
        version: 2,
        nodes: [
          { id: 'trig_1', type: 'trigger.event', label: 'Event Trigger', config: { eventType: 'alarm.triggered' } },
          { id: 'if_1', type: 'control.if', label: 'Evaluate Condition', config: { condition: { field: 'data.temperature', op: 'gt', value: thresholdVal } } },
          { id: 'crt_1', type: 'data.create', label: 'Create Ticket', config: { collection: 'latticeServiceTickets', values: { code: 'FLOW-{{id}}' } } },
          { id: 'notify_1', type: 'notify.send', label: 'Notify Manager', config: { roleNames: ['ldx_manager'], severity: 'info', title: 'Alert' } },
        ],
        edges: [
          { id: 'e1', source: 'trig_1', sourceHandle: 'main', target: 'if_1', targetHandle: 'in' },
          { id: 'e2', source: 'if_1', sourceHandle: 'true', target: 'crt_1', targetHandle: 'in' },
          { id: 'e3', source: 'crt_1', sourceHandle: 'main', target: 'notify_1', targetHandle: 'in' },
        ],
        settings: { errorPolicy: 'stop', cooldownSec: 0, maxDepth: 8, timeoutMs: 30000 },
      };
      const draftRule = {
        schemaVersion: 2,
        ruleKey: values.rule?.ruleKey || 'auto_architect_draft',
        name: 'DX-OS Flow Architect Draft',
        triggerEventType: 'alarm.triggered',
        cooldownSec: 0,
        maxDepth: 8,
        active: true,
        graphJson,
        actionsJson: [
          { type: 'create_record', collection: 'latticeServiceTickets' },
          { type: 'notify_role', role: 'ldx_manager' },
        ],
      };
      if (values.apply === true) {
        const savedRule = upsertMockRule(draftRule);
        return okResp({ ok: true, refused: false, mode: 'full', modeUsed: 'offline-fallback', applied: true, draftGraph: graphJson, draftRule, savedRule });
      }
      return okResp({ ok: true, refused: false, mode: 'full', modeUsed: 'offline-fallback', applied: false, draftGraph: graphJson, draftRule });
    }
    if (resourceAction === 'dxosAutomations:listRules') {
      const org = query.get('organizationId');
      return okResp({
        items: state.automationRules.filter((r) => !org || r.organizationId === org),
      });
    }
    if (resourceAction === 'dxosAi:listApprovals') {
      const org = query.get('organizationId');
      const status = query.get('status');
      return okResp({
        items: state.approvalQueue.filter(
          (q) => (!org || q.organizationId === org) && (!status || q.status === status),
        ),
      });
    }
    if (resourceAction === 'dxosAi:approveAction') {
      const approval = state.approvalQueue.find(
        (q) => Number(q.id) === Number(values.approvalId) && q.organizationId === values.organizationId,
      );
      if (!approval) return errResp(404, 'APPROVAL_NOT_FOUND');
      approval.status = 'approved';
      const existing = state.automationRuns.find(
        (r) => Number(r.approvalId) === Number(approval.id) && r.organizationId === values.organizationId,
      );
      if (existing) {
        const ticket = {
          id: ++state.nextId,
          organizationId: values.organizationId,
          code: `HITL-Q-${existing.runUid}`,
          name: `Queue Approved ${existing.runUid}`,
          serviceType: 'facilities',
          priority: 'high',
          status: 'draft',
        };
        state.serviceTickets.push(ticket);
        existing.status = 'completed';
        existing.suspendedNodeId = null;
        existing.resumeTokenHash = null;
        existing.nodeStatesJson = {
          ...(existing.nodeStatesJson || {}),
          create_ticket: { status: 'completed', output: { collection: 'latticeServiceTickets', id: ticket.id, record: ticket } },
        };
        existing.stepTracesJson = [
          ...(existing.stepTracesJson || []),
          { nodeId: 'create_ticket', type: 'data.create', status: 'completed', output: { collection: 'latticeServiceTickets', id: ticket.id, record: ticket } },
        ];
      }
      return okResp({
        approval,
        status: 'approved',
        result: existing ? { run: existing } : null,
      });
    }
    if (resourceAction === 'dxosN8n:appCatalog' || resourceAction === 'dxosVault:appCatalog') {
      const items = [
        'n8n_api', 'gmail_oauth2', 'google_sheets', 'google_drive', 'slack',
        'telegram', 'github', 'jira', 'discord', 'hubspot', 'webhook_generic',
      ].map((appType) => ({ appType, name: appType }));
      return okResp({ organizationId: query.get('organizationId'), items });
    }
    if (resourceAction === 'dxosVault:oauthStart') {
      const oauthState = `state-${++state.nextId}`;
      const codeChallenge = sha256Hex(`verifier-${oauthState}`);
      state.oauthStates.set(values.connectorKey, oauthState);
      state.connectors = state.connectors.filter(
        (c) => !(c.organizationId === values.organizationId && c.connectorKey === values.connectorKey),
      );
      state.connectors.push({
        id: ++state.nextId,
        organizationId: values.organizationId,
        connectorKey: values.connectorKey,
        name: values.connectorKey,
        connectorType: 'oauth2',
        authType: 'oauth2_pkce',
        secrets: { clientSecret: values.clientSecret },
      });
      return okResp({
        ok: true,
        connectorKey: values.connectorKey,
        state: oauthState,
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: values.redirectUri,
        authorizeUrl: `https://accounts.example.test/o/oauth2/v2/auth?state=${oauthState}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      });
    }
    if (resourceAction === 'dxosVault:oauthCallback') {
      const expected = state.oauthStates.get(values.connectorKey);
      if (!expected || values.state !== expected) {
        return errResp(400, 'OAUTH_STATE_MISMATCH', 'Invalid OAuth2 state');
      }
      return okResp({ ok: true, connected: true });
    }
    if (resourceAction === 'dxosN8n:status') {
      return okResp({
        organizationId: query.get('organizationId'),
        ok: true,
        healthzOk: true,
        apiOk: true,
        hasApiKey: true,
      });
    }
    if (resourceAction === 'dxosN8n:workflows') {
      return okResp({
        data: [{ id: 'n8n_orch_26', name: 'dxos-enterprise-compliance-orchestrator', active: true }],
      });
    }
    if (resourceAction === 'dxosN8n:executions') {
      return okResp({
        data: [{ id: 'exec_v100_1', status: 'success' }],
      });
    }
    if (resourceAction === 'latticeCustomPartnerClaims:list') {
      return okResp(state.partnerClaims);
    }
    if (resourceAction === 'latticeCustomPartnerClaims:create') {
      const row = { id: ++state.nextId, ...values };
      state.partnerClaims.push(row);
      return okResp(row);
    }
    if (resourceAction === 'latticeCustomPartnerClaims:destroy') {
      state.destroyedPaths.push(path);
      const id = Number(query.get('filterByTk'));
      state.partnerClaims = state.partnerClaims.filter((c) => Number(c.id) !== id);
      return okResp({ ok: true });
    }
    if (resourceAction === 'dxosAutomations:listRuns') {
      const org = query.get('organizationId');
      const rKey = query.get('ruleKey');
      return okResp({
        items: state.automationRuns.filter((r) => (!org || r.organizationId === org) && (!rKey || r.ruleKey === rKey)),
      });
    }
    if (resourceAction === 'latticeAutomationRuns:list') {
      const f = JSON.parse(query.get('filter') || '{}');
      return okResp(
        state.automationRuns.filter((r) =>
          Object.entries(f).every(([k, v]) => (v === undefined ? true : r?.[k] === v)),
        ),
      );
    }
    if (resourceAction === 'latticeAutomationRuns:destroy') {
      state.destroyedPaths.push(path);
      const id = Number(query.get('filterByTk'));
      state.automationRuns = state.automationRuns.filter((r) => Number(r.id) !== id);
      return okResp({ ok: true });
    }
    if (resourceAction === 'latticeServiceTickets:get') {
      const id = Number(query.get('filterByTk'));
      const t = state.serviceTickets.find((x) => x.id === id);
      return t ? okResp(t) : errResp(404, 'NOT_FOUND');
    }
    if (resourceAction === 'latticeServiceTickets:list') {
      const f = JSON.parse(query.get('filter') || '{}');
      return okResp(state.serviceTickets.filter((t) => (!f.organizationId || t.organizationId === f.organizationId)));
    }
    if (resourceAction === 'latticeServiceTickets:destroy') {
      state.destroyedPaths.push(path);
      const id = Number(query.get('filterByTk'));
      state.serviceTickets = state.serviceTickets.filter((t) => Number(t.id) !== id);
      return okResp({ ok: true });
    }
    if (resourceAction === 'latticeAiApprovalQueue:list') {
      const f = JSON.parse(query.get('filter') || '{}');
      return okResp(state.approvalQueue.filter((q) => (!f.organizationId || q.organizationId === f.organizationId)));
    }
    if (resourceAction === 'latticeAiApprovalQueue:destroy') {
      state.destroyedPaths.push(path);
      const id = Number(query.get('filterByTk'));
      state.approvalQueue = state.approvalQueue.filter((q) => Number(q.id) !== id);
      return okResp({ ok: true });
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
    if (resourceAction === 'latticeCustomWorkOrders:destroy') {
      state.destroyedPaths.push(path);
      const id = Number(query.get('filterByTk'));
      state.workOrders = state.workOrders.filter((w) => Number(w.id) !== id);
      return okResp({ ok: true });
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
  const showcaseRun = {
    id: 50,
    organizationId: 'native-ui-lab',
    ruleKey: 'auto_cmms_on_coldchain_fault',
    runUid: 'run_showcase_coldchain_1',
    triggerEventId: 'evt_showcase_1',
    status: 'completed',
    stepTracesJson: [
      {
        stepIndex: 0,
        type: 'create_record',
        status: 'completed',
        output: { collection: 'latticeCustomWorkOrders', id: 51, record: { deviceKey: 'cold-truck-ct-01', assetId: 11 } },
      },
    ],
  };
  const { callActor, state } = createMockAcceptanceCaller({ initialAutomationRuns: [showcaseRun] });
  const res = await runBrokerAutomationBuilderAcceptance(callActor, { organizationId: 'native-ui-lab' });

  assert.equal(res.status, 'PASS');
  assert.equal(res.result, 'PASS');
  for (const [name, passed] of Object.entries(res.checks)) {
    assert.equal(passed, true, `Acceptance check ${name} did not pass`);
  }

  // Zero secret leaks in summary (including HITL resumeToken and inbound webhook secret)
  const summaryText = JSON.stringify(res);
  assert.equal(summaryText.includes('acc-vault-v1-'), false);
  assert.equal(summaryText.includes('acc-vault-v2-'), false);
  assert.equal(summaryText.includes('acc-oauth-sec-'), false);
  assert.equal(summaryText.includes('acc-whsec-'), false);
  assert.equal(summaryText.includes('acc-inwh-'), false);
  assert.equal(summaryText.includes('mock-resume-token-'), false);
  for (const pwd of state.provisionedPasswords) {
    assert.equal(summaryText.includes(pwd), false, 'Acceptance summary leaked mqttPassword');
  }

  // Temporary entities cleaned up (showcase run preserved)
  assert.equal(state.connectors.length, 0);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.serviceTickets.length, 0);
  assert.equal(state.approvalQueue.length, 0);
  assert.equal(state.partnerClaims.length, 0);
  assert.equal(state.automationRules.some((r) => r.ruleKey.startsWith('acc_')), false);
  assert.deepEqual(state.automationRuns.map((r) => r.id), [50]);
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeAutomationRuns:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('collections:destroy?filterByTk=latticeCustomAcc')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeAssets:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeIotDevices:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeServiceTickets:destroy?')));
  assert.equal(res.checks.automationStudioAndArchitectOk, true);
  assert.equal(Object.hasOwn(res.checks, `automationStudioAnd${['Co', 'pilot'].join('')}Ok`), false);
  assert.ok(res.automationStudio.nodeRegistryCount >= 24);
  assert.deepEqual(
    res.automationStudio.nodeRegistryCategories.sort(),
    ['ai', 'control', 'data', 'integration', 'logic', 'trigger'],
  );
  assert.ok(res.automationStudio.blueprintCount >= 6);
  assert.equal(res.automationStudio.criticalSimulatedSteps, 5);
  assert.equal(res.automationStudio.highSkippedSteps, 3);
  assert.equal(res.automationStudio.slaWarningSimulatedSteps, 3);
  assert.equal(res.automationStudio.slaBreachedSimulatedSteps, 4);
  assert.equal(res.automationStudio.dagLoopIterations, 2);
  assert.equal(res.automationStudio.dagLoopFalseBranchSkipped, true);
  assert.equal(res.automationStudio.testNodeOk, true);
  assert.equal(res.automationStudio.testNodeNextPort, 'true');
  assert.equal(res.automationStudio.hitlPausedStatus, 'suspended');
  assert.ok([403, 404].includes(res.automationStudio.hitlCrossOrgRejectedStatus));
  assert.equal(res.automationStudio.hitlBadTokenRejectedStatus, 403);
  assert.equal(res.automationStudio.hitlResumedStatus, 'completed');
  assert.equal(res.automationStudio.hitlReplayRejectedStatus, 409);
  assert.equal(res.automationStudio.hitlQueueApprovalStatus, 'approved');
  assert.equal(res.automationStudio.hitlQueueResumedStatus, 'completed');
  assert.equal(res.checks.n8nRestV1AndOauthPkceOk, true);
  assert.equal(res.n8nAndOauthPkce.appCatalogCount, 11);
  assert.equal(res.n8nAndOauthPkce.oauthPkceChallengeMethod, 'S256');
  assert.equal(res.n8nAndOauthPkce.oauthBadStateStatus, 400);
  assert.equal(res.n8nAndOauthPkce.liveN8nConfigured, true);
  assert.equal(res.checks.enterpriseComplianceAndPartnerSettlementOk, true);
  assert.ok(res.enterpriseCompliance.orchestratorNodeCount >= 26);
  assert.equal(res.enterpriseCompliance.partnerClaimsCollection, 'latticeCustomPartnerClaims');
  assert.equal(res.enterpriseCompliance.partnerSettlementDmnKey, 'coldchain_settlement_policy_v1');
  assert.equal(res.automationStudio.webhookInvalidSigStatus, 401);
  assert.equal(res.automationStudio.webhookValidSigStatus, 200);
  assert.equal(res.automationStudio.aiFixErrorRepaired, true);
  assert.ok(res.automationStudio.aiSuggestCount >= 1);
  assert.match(res.automationStudio.aiAppliedTempRuleKey, /^acc_ai_temp_/);
  assert.equal(res.automationStudio.aiAppliedThresholdValue, 12);
  assert.equal(res.automationStudio.aiInjectionRejectedStatus, 400);
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeCustomWorkOrders:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeTwinShadows:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeAgentProposals:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeAiApprovalQueue:destroy?')));
});

test('runBrokerAutomationBuilderAcceptance tolerates partial step 4 call_connector failure on clean-install but fails closed if core steps 0..3 skip or fail', async () => {
  const partialOkMock = createMockAcceptanceCaller({ missingConnectorOnStep4: true });
  const partialRes = await runBrokerAutomationBuilderAcceptance(partialOkMock.callActor, { organizationId: 'native-ui-lab' });
  assert.equal(partialRes.status, 'PASS');
  assert.equal(partialOkMock.state.automationRuns.length, 0);

  const skippedCoreMock = createMockAcceptanceCaller({ skipCmmsCoreStep: true });
  await assert.rejects(
    () => runBrokerAutomationBuilderAcceptance(skippedCoreMock.callActor, { organizationId: 'native-ui-lab' }),
    /twin_set_desired.*status === 'completed'/,
  );
  assert.equal(skippedCoreMock.state.automationRuns.length, 0);
  assert.equal(skippedCoreMock.state.automationRules.some((r) => r.ruleKey.startsWith('acc_')), false);
});

test('runBrokerAutomationBuilderAcceptance uses saved auto_sla_breach_escalation ruleKey when present and cleans up aiTempRuleKey runs', async () => {
  const { callActor, state } = createMockAcceptanceCaller({
    initialAutomationRules: [
      {
        id: 40,
        organizationId: 'native-ui-lab',
        ruleKey: 'auto_sla_breach_escalation',
        name: 'Saved SLA Escalation',
        triggerEventType: 'sla.warning,sla.breached',
        actionsJson: [
          { type: 'notify_role', when: { 'event.type': 'sla.warning' }, role: 'ldx_dispatcher' },
          { type: 'create_record', when: { 'event.type': 'sla.breached' }, collection: 'latticeServiceTickets' },
          { type: 'notify_role', when: { 'event.type': 'sla.breached' }, role: 'ldx_manager' },
        ],
      },
    ],
  });
  const wrappedCallActor = async (actorRole, path, opts = {}) => {
    const res = await callActor(actorRole, path, opts);
    if (path === 'dxosAutomations:aiAssist' && opts?.values?.apply === true && opts?.values?.mode === 'full') {
      state.automationRuns.push({
        id: ++state.nextId,
        organizationId: opts.values.organizationId,
        ruleKey: opts.values.ruleKey,
        runUid: `run_ai_temp_${state.nextId}`,
        status: 'completed',
        stepTracesJson: [],
      });
    }
    return res;
  };
  const res = await runBrokerAutomationBuilderAcceptance(wrappedCallActor, { organizationId: 'native-ui-lab' });
  assert.equal(res.status, 'PASS');
  assert.equal(state.automationRuns.length, 0);
  assert.equal(state.automationRules.some((r) => r.ruleKey.startsWith('acc_')), false);
  const slaTestCall = state.calls.find(
    (c) => c.path === 'dxosAutomations:testRule' && c.opts?.values?.ruleKey === 'auto_sla_breach_escalation',
  );
  assert.ok(slaTestCall, 'Expected testRule to use ruleKey=auto_sla_breach_escalation when rule is already saved');
});

test('runBrokerAutomationBuilderAcceptance fails closed on shrunk nodeRegistry, replay resume acceptance, bad webhook HMAC acceptance, leaked mqttPassword, or missing OpenAPI custom paths and still cleans up', async () => {
  const shrunkRegMock = createMockAcceptanceCaller({ shrinkNodeRegistry: true });
  await assert.rejects(
    () => runBrokerAutomationBuilderAcceptance(shrunkRegMock.callActor, { organizationId: 'native-ui-lab' }),
    /nodeRegistry/i,
  );
  assert.equal(shrunkRegMock.state.automationRuns.length, 0);
  assert.equal(shrunkRegMock.state.automationRules.some((r) => r.ruleKey.startsWith('acc_')), false);

  const replayMock = createMockAcceptanceCaller({ forceReplayResumeOk: true });
  await assert.rejects(
    () => runBrokerAutomationBuilderAcceptance(replayMock.callActor, { organizationId: 'native-ui-lab' }),
    /409/,
  );
  assert.equal(replayMock.state.automationRuns.length, 0);
  assert.equal(replayMock.state.serviceTickets.length, 0);
  assert.equal(replayMock.state.approvalQueue.length, 0);
  assert.equal(replayMock.state.automationRules.some((r) => r.ruleKey.startsWith('acc_')), false);

  const badWebhookMock = createMockAcceptanceCaller({ forceBadWebhookAccept: true });
  await assert.rejects(
    () => runBrokerAutomationBuilderAcceptance(badWebhookMock.callActor, { organizationId: 'native-ui-lab' }),
    /401/,
  );
  assert.equal(badWebhookMock.state.connectors.length, 0);
  assert.equal(badWebhookMock.state.automationRules.some((r) => r.ruleKey.startsWith('acc_')), false);

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

test('runBrokerAutomationBuilderAcceptance succeeds and cleans up when auto_cmms_on_coldchain_fault is pre-seeded as Graph v2', async () => {
  const coldBp = MOCK_BLUEPRINTS.find((b) => b.ruleKey === 'auto_cmms_on_coldchain_fault');
  const { callActor, state } = createMockAcceptanceCaller({
    initialAutomationRules: [
      {
        id: 41,
        organizationId: 'native-ui-lab',
        ...coldBp,
        schemaVersion: 2,
      },
    ],
  });
  const res = await runBrokerAutomationBuilderAcceptance(callActor, { organizationId: 'native-ui-lab' });
  assert.equal(res.status, 'PASS');
  assert.equal(res.checks.automationStudioAndArchitectOk, true);
  assert.equal(res.automationStudio.criticalSimulatedSteps, 9);
  assert.equal(res.automationStudio.highSkippedSteps, 4);
  assert.equal(state.automationRuns.length, 0);
  assert.equal(state.workOrders.length, 0);
  assert.equal(state.serviceTickets.length, 0);
  assert.equal(state.approvalQueue.length, 0);
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeTwinShadows:destroy?')));
  assert.ok(state.destroyedPaths.some((p) => p.startsWith('latticeAgentProposals:destroy?')));
});

test('acceptance script and test carry compliant CTU-OpenPaw SPDX headers and zero legacy Wave 9 branding', () => {
  const bannedBrandRe = new RegExp(['co', 'pilot'].join(''), 'i');
  for (const rel of [
    'scripts/acceptance-broker-automation-builder.mjs',
    'scripts/tests/acceptance-broker-automation-builder.test.mjs',
    'scripts/seed-v100-championship-showcase.mjs',
    'scripts/tests/seed-v100-championship-showcase.test.mjs',
  ]) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const res = addSourceHeader(src, rel);
    assert.equal(res.status, 'present', `SPDX header check failed for ${rel}: ${res.status}`);
    if (rel.includes('acceptance-broker-automation-builder')) {
      assert.equal(bannedBrandRe.test(src), false, `Legacy branding must not appear in ${rel}`);
    }
  }
});

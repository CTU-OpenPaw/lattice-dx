/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function normalizeServerUrl(serverUrl) {
  const fallback = 'http://localhost:13014';
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) return fallback;
  try {
    const parsed = new URL(serverUrl.trim());
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return fallback;
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

function resolveVersionFallback() {
  try {
    const pkg = require('../../package.json');
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // Fallback below
  }
  return '1.0.0';
}

const API_OPERATIONS = Object.freeze([
  ['/api/dxos:health', 'get', 'Observability', 'Health check', true],
  ['/api/dxos:metrics', 'get', 'Observability', 'Prometheus metrics exposition', false],
  ['/api/dxos:openapi', 'get', 'Observability', 'Live OpenAPI 3.1.0 specification', true],
  ['/api/dxos:asyncapi', 'get', 'Observability', 'Live AsyncAPI 3.0.0 specification', true],

  ['/api/dxosApiKeys:issue', 'post', 'PaaS API Keys', 'Issue scoped PaaS Personal Access Token', false],
  ['/api/dxosApiKeys:list', 'get', 'PaaS API Keys', 'List organization or own PaaS API keys', false],
  ['/api/dxosApiKeys:revoke', 'post', 'PaaS API Keys', 'Revoke a PaaS API key', false],

  ['/api/dxosLedger:publicKey', 'get', 'PKI & Crypto Ledger', 'Get organization active Ed25519 public key', false],
  ['/api/dxosLedger:entries', 'get', 'PKI & Crypto Ledger', 'List paginated crypto ledger entries', false],
  ['/api/dxosLedger:status', 'get', 'PKI & Crypto Ledger', 'Get latest sequence, head hash, and Merkle root', false],
  ['/api/dxosLedger:verify', 'get', 'PKI & Crypto Ledger', 'Verify full organization hash-chain, signatures, and Merkle roots', false],
  ['/api/dxosLedger:verify', 'post', 'PKI & Crypto Ledger', 'Verify full organization hash-chain, signatures, and Merkle roots (POST)', false],
  ['/api/dxosLedger:signDocument', 'post', 'PKI & Crypto Ledger', 'Sign an organization record snapshot and append to crypto ledger', false],
  ['/api/dxosLedger:verifySignature', 'post', 'PKI & Crypto Ledger', 'Verify an Ed25519 signature for a canonical JSON payload', false],

  ['/api/latticeVoucher:submit', 'post', 'Vouchers', 'Submit draft voucher into immutable workflow', false],
  ['/api/latticeVoucher:cancel', 'post', 'Vouchers', 'Cancel submitted/approved voucher with reason', false],
  ['/api/latticeVoucher:amend', 'post', 'Vouchers', 'Create amended draft revision from cancelled voucher', false],
  ['/api/latticeVoucher:lineage', 'get', 'Vouchers', 'Read full voucher amendment lineage', false],

  ['/api/latticeNotifications:listMine', 'get', 'Notifications', 'List caller inbox notifications', false],
  ['/api/latticeNotifications:unreadCount', 'get', 'Notifications', 'Get unread notification count', false],
  ['/api/latticeNotifications:markRead', 'post', 'Notifications', 'Mark single notification read', false],
  ['/api/latticeNotifications:markAllRead', 'post', 'Notifications', 'Mark all matching notifications read', false],

  ['/api/latticeSla:summary', 'get', 'SLA Engine', 'Compute current SLA warning and breach summary', false],
  ['/api/latticeSla:policies', 'get', 'SLA Engine', 'List organization SLA escalation policies', false],
  ['/api/latticeSla:savePolicy', 'post', 'SLA Engine', 'Create or update an SLA escalation policy', false],
  ['/api/latticeSla:evaluateNow', 'post', 'SLA Engine', 'Run SLA evaluation and dispatch breach escalations', false],

  ['/api/latticePara:summary', 'get', 'PARA Knowledge Vault', 'Summarize PARA documents by space', false],
  ['/api/latticePara:hybridSearch', 'post', 'PARA Knowledge Vault', 'Run scoped hybrid vector + FTS search', false],
  ['/api/latticePara:extractAttachment', 'post', 'PARA Knowledge Vault', 'Extract searchable text from attachment', false],
  ['/api/latticePara:reindex', 'post', 'PARA Knowledge Vault', 'Rebuild PARA document search chunks', false],

  ['/api/dxosWms:stockSummary', 'get', 'WMS & Cold Logistics', 'Read warehouse stock lot summary', false],
  ['/api/dxosWms:receiveStock', 'post', 'WMS & Cold Logistics', 'Receive FEFO/lot stock into warehouse', false],
  ['/api/dxosWms:issueStock', 'post', 'WMS & Cold Logistics', 'Issue stock lots against order lines', false],
  ['/api/dxosWms:epodCapture', 'post', 'WMS & Cold Logistics', 'Record signed GPS/photo ePOD delivery event', false],
  ['/api/dxosWms:publicTrack', 'get', 'WMS & Cold Logistics', 'Public shipment tracking status lookup', true],

  ['/api/dxosDmn:listTables', 'get', 'DMN Decision Engine', 'List organization DMN decision tables', false],
  ['/api/dxosDmn:saveTable', 'post', 'DMN Decision Engine', 'Create or update a DMN decision table', false],
  ['/api/dxosDmn:evaluate', 'post', 'DMN Decision Engine', 'Evaluate a DMN decision table against context facts', false],
  ['/api/dxosDmn:delegations', 'get', 'DMN Decision Engine', 'List approval delegations', false],
  ['/api/dxosDmn:saveDelegation', 'post', 'DMN Decision Engine', 'Create or update an approval delegation rule', false],

  ['/api/dxosDataGov:freezeSnapshot', 'post', 'Data Governance', 'Freeze and cryptographically sign a dataset snapshot', false],
  ['/api/dxosDataGov:listSnapshots', 'get', 'Data Governance', 'List frozen dataset snapshots', false],
  ['/api/dxosDataGov:lineage', 'get', 'Data Governance', 'Query data lineage graph', false],
  ['/api/dxosDataGov:listQuarantine', 'get', 'Data Governance', 'List quarantined records', false],
  ['/api/dxosDataGov:resolveQuarantine', 'post', 'Data Governance', 'Approve or reject a quarantined record', false],

  ['/api/dxosBlocks:proposals', 'get', 'Blocks & IoT Telemetry', 'List agent evidence proposals', false],
  ['/api/dxosBlocks:contextTelemetry', 'get', 'Blocks & IoT Telemetry', 'Read latest NGSI-LD entity context and telemetry', false],
  ['/api/dxosBlocks:telemetrySeries', 'get', 'Blocks & IoT Telemetry', 'Query historical IoT telemetry time-series points', false],
  ['/api/dxosBlocks:telemetryIngest', 'post', 'Blocks & IoT Telemetry', 'Ingest IoT telemetry point (edge token or JWT/PAT)', false],
  ['/api/dxosBlocks:alarmIngest', 'post', 'Blocks & IoT Telemetry', 'Ingest or deduplicate threshold alarm', false],
  ['/api/dxosBlocks:alarmAck', 'post', 'Blocks & IoT Telemetry', 'Acknowledge an active alarm', false],
  ['/api/dxosBlocks:alarmClear', 'post', 'Blocks & IoT Telemetry', 'Clear a resolved alarm', false],
  ['/api/dxosBlocks:exportReport', 'post', 'Blocks & IoT Telemetry', 'Execute governed PDF/CSV/XLSX export', false],
  ['/api/dxosBlocks:globalSearch', 'get', 'Blocks & IoT Telemetry', 'Tenant-scoped global search across entities and knowledge', false],

  ['/api/dxosStudio:listTemplates', 'get', 'DX-OS Studio', 'List Poka-yoke workflow templates', false],
  ['/api/dxosStudio:listEmployees', 'get', 'DX-OS Studio', 'List organization employees for Studio setup', false],
  ['/api/dxosStudio:installWorkflow', 'post', 'DX-OS Studio', 'Install a Poka-yoke workflow template', false],
  ['/api/dxosStudio:composePortals', 'post', 'DX-OS Studio', 'Compose multi-portal pages and attach DX-OS blocks', false],
  ['/api/dxosStudio:pluginStatus', 'get', 'DX-OS Studio', 'Inspect DX-OS plugin activation status', false],
  ['/api/dxosStudio:readiness', 'get', 'DX-OS Studio', 'Read platform runtime readiness checklist', false],
  ['/api/dxosStudio:outboxDlqList', 'get', 'DX-OS Studio', 'List failed/dead-lettered context outbox events', false],
  ['/api/dxosStudio:outboxDlqReplay', 'post', 'DX-OS Studio', 'Replay dead-lettered context outbox events', false],
  ['/api/dxosStudio:solutionBundleExport', 'get', 'DX-OS Studio', 'Export portable JSON solution bundle', false],
  ['/api/dxosStudio:solutionBundleDiff', 'post', 'DX-OS Studio', 'Diff an incoming solution bundle against current state', false],
  ['/api/dxosStudio:solutionBundleImport', 'post', 'DX-OS Studio', 'Import a validated solution bundle', false],
  ['/api/dxosStudio:solutionBundleRollback', 'post', 'DX-OS Studio', 'Rollback last imported solution bundle', false],

  ['/api/dxosAi:listProfiles', 'get', 'AI Workforce & MCP', 'List organization AI employee profiles', false],
  ['/api/dxosAi:saveProfile', 'post', 'AI Workforce & MCP', 'Create or update an AI employee profile', false],
  ['/api/dxosAi:deleteProfile', 'post', 'AI Workforce & MCP', 'Delete an AI employee profile', false],
  ['/api/dxosAi:bootstrapDefaults', 'post', 'AI Workforce & MCP', 'Bootstrap default AI workforce and LLM providers', false],
  ['/api/dxosAi:portalCopilot', 'post', 'AI Workforce & MCP', 'Invoke scoped portal AI copilot', false],
  ['/api/dxosAi:auditLogs', 'get', 'AI Workforce & MCP', 'Read AI tool execution audit logs', false],
  ['/api/dxosAi:quotaSummary', 'get', 'AI Workforce & MCP', 'Read organization AI token/budget quota summary', false],
  ['/api/dxosAi:enterpriseTopology', 'get', 'AI Workforce & MCP', 'Read 6-plane enterprise topology metadata', false],
  ['/api/dxosAi:pageSurfaceState', 'get', 'AI Workforce & MCP', 'Inspect current portal page surface state', false],
  ['/api/dxosAi:inspectPageBlocks', 'get', 'AI Workforce & MCP', 'Inspect configurable blocks on a portal page', false],
  ['/api/dxosAi:rollbackPageSnapshot', 'post', 'AI Workforce & MCP', 'Rollback UI surface snapshot to previous revision', false],
  ['/api/dxosAi:surfaceEvents', 'get', 'AI Workforce & MCP', 'Subscribe to real-time SSE portal surface updates', false],
  ['/api/dxosAi:listApprovals', 'get', 'AI Workforce & MCP', 'List pending HITL AI action approvals', false],
  ['/api/dxosAi:approveAction', 'post', 'AI Workforce & MCP', 'Approve a pending HITL AI action', false],
  ['/api/dxosAi:rejectAction', 'post', 'AI Workforce & MCP', 'Reject a pending HITL AI action', false],

  ['/api/dxos-mcp', 'post', 'AI Workforce & MCP', 'Inbound 2-way Enterprise MCP JSON-RPC gateway', false],
  ['/api/dxos-mcp/it-ot', 'post', 'AI Workforce & MCP', 'IT/OT MCP JSON-RPC endpoint for telemetry and workflows', false],

  ['/api/dxosVault:list', 'get', 'Connector & Secrets Vault', 'List organization connectors with masked secrets', false],
  ['/api/dxosVault:save', 'post', 'Connector & Secrets Vault', 'Create or update an encrypted connector in vault', false],
  ['/api/dxosVault:rotateSecret', 'post', 'Connector & Secrets Vault', 'Rotate encrypted connector secrets', false],
  ['/api/dxosVault:delete', 'post', 'Connector & Secrets Vault', 'Delete a connector from vault', false],
  ['/api/dxosVault:testConnection', 'post', 'Connector & Secrets Vault', 'Test connector endpoint reachability with SSRF guard', false],

  ['/api/dxosEvents:listEvents', 'get', 'Event Bus & Webhooks', 'List CloudEvents 1.0 domain events', false],
  ['/api/dxosEvents:publish', 'post', 'Event Bus & Webhooks', 'Publish a CloudEvents 1.0 domain event', false],
  ['/api/dxosEvents:listSubscriptions', 'get', 'Event Bus & Webhooks', 'List webhook subscriptions with masked secrets', false],
  ['/api/dxosEvents:saveSubscription', 'post', 'Event Bus & Webhooks', 'Create or update a Standard Webhooks subscription', false],
  ['/api/dxosEvents:toggleSubscription', 'post', 'Event Bus & Webhooks', 'Enable or disable a webhook subscription', false],
  ['/api/dxosEvents:deleteSubscription', 'post', 'Event Bus & Webhooks', 'Delete a webhook subscription', false],
  ['/api/dxosEvents:listDeliveries', 'get', 'Event Bus & Webhooks', 'List outbound webhook delivery attempts and DLQ', false],
  ['/api/dxosEvents:dispatchNow', 'post', 'Event Bus & Webhooks', 'Immediately drain due outbound webhook deliveries', false],
  ['/api/dxosEvents:replayDlq', 'post', 'Event Bus & Webhooks', 'Replay dead-lettered webhook deliveries', false],
  ['/api/dxosEvents:resetCircuit', 'post', 'Event Bus & Webhooks', 'Reset an open webhook subscription circuit breaker', false],

  ['/api/dxosBroker:listDevices', 'get', 'IoT Broker Control Plane', 'List registered IoT broker devices', false],
  ['/api/dxosBroker:provisionDevice', 'post', 'IoT Broker Control Plane', 'Provision Mosquitto DynSec device credentials and topic ACL', false],
  ['/api/dxosBroker:revokeDevice', 'post', 'IoT Broker Control Plane', 'Revoke IoT device MQTT credentials', false],
  ['/api/dxosBroker:deviceStatusIngest', 'post', 'IoT Broker Control Plane', 'Ingest device BIRTH/DEATH LWT status event', true],
  ['/api/dxosBroker:orionEntities', 'get', 'IoT Broker Control Plane', 'Inspect live FIWARE Orion-LD entities', false],
  ['/api/dxosBroker:orionListSubscriptions', 'get', 'IoT Broker Control Plane', 'List NGSI-LD broker subscriptions', false],
  ['/api/dxosBroker:orionCreateSubscription', 'post', 'IoT Broker Control Plane', 'Create NGSI-LD subscription in Orion-LD', false],
  ['/api/dxosBroker:orionToggleSubscription', 'post', 'IoT Broker Control Plane', 'Toggle NGSI-LD broker subscription', false],
  ['/api/dxosBroker:orionDeleteSubscription', 'post', 'IoT Broker Control Plane', 'Delete NGSI-LD broker subscription', false],
  ['/api/dxosBroker:orionNotify', 'post', 'IoT Broker Control Plane', 'Receive inbound Orion-LD subscription notification webhook', true],

  ['/api/dxosAutomations:listRules', 'get', 'Native Automation Engine', 'List organization automation rules', false],
  ['/api/dxosAutomations:saveRule', 'post', 'Native Automation Engine', 'Create or update an automation rule (Trigger -> DMN -> Actions)', false],
  ['/api/dxosAutomations:toggleRule', 'post', 'Native Automation Engine', 'Enable or disable an automation rule', false],
  ['/api/dxosAutomations:deleteRule', 'post', 'Native Automation Engine', 'Delete an automation rule', false],
  ['/api/dxosAutomations:listRuns', 'get', 'Native Automation Engine', 'List automation execution runs and step traces', false],
  ['/api/dxosAutomations:runNow', 'post', 'Native Automation Engine', 'Execute an automation rule manually', false],
  ['/api/dxosAutomations:replayRun', 'post', 'Native Automation Engine', 'Replay an automation execution run', false],

  ['/api/dxosBuilder:listDomains', 'get', 'Visual Domain Builder', 'List dynamic latticeCustom* domains', false],
  ['/api/dxosBuilder:createDomain', 'post', 'Visual Domain Builder', 'Create a dynamic latticeCustom* domain with RLS and portal page', false],
  ['/api/dxosBuilder:listBusinessPacks', 'get', 'Visual Domain Builder', 'List installable enterprise business packs', false],
  ['/api/dxosBuilder:installBusinessPack', 'post', 'Visual Domain Builder', 'Install a business pack into organization scope', false],
  ['/api/dxosBuilder:listTenants', 'get', 'Visual Domain Builder', 'List provisioned tenant organizations', false],
  ['/api/dxosBuilder:provisionTenant', 'post', 'Visual Domain Builder', 'Provision a new multi-tenant organization workspace', false],
]);

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Za-z0-9_]+$/;
const AUTO_MANAGED_FIELDS = new Set(['id', 'createdAt', 'updatedAt']);

function mapFieldTypeToJsonSchema(field) {
  const type = String(field?.type || field?.options?.type || 'string').trim().toLowerCase();
  const schema = {};
  if (['integer', 'bigint', 'bigInt'.toLowerCase()].includes(type)) {
    schema.type = 'integer';
  } else if (['float', 'double', 'decimal', 'number'].includes(type)) {
    schema.type = 'number';
  } else if (type === 'boolean') {
    schema.type = 'boolean';
  } else if (['json', 'jsonb'].includes(type)) {
    schema.type = 'object';
    schema.additionalProperties = true;
  } else if (['date', 'datetime', 'time'].includes(type)) {
    schema.type = 'string';
    schema.format = 'date-time';
  } else {
    schema.type = 'string';
  }
  const enumSource = field?.options?.uiSchema?.enum || field?.uiSchema?.enum;
  if (Array.isArray(enumSource) && enumSource.length > 0) {
    const vals = enumSource
      .map((item) => (item && typeof item === 'object' ? (item.value ?? item.label) : item))
      .filter((v) => typeof v === 'string' || typeof v === 'number');
    if (vals.length > 0) schema.enum = vals;
  }
  const title = field?.options?.uiSchema?.title || field?.uiSchema?.title;
  if (typeof title === 'string' && title.trim()) {
    schema.description = title.trim();
  }
  return schema;
}

function collectCustomCollections(db) {
  if (!db) return [];
  let rawEntries = [];
  if (db.collections instanceof Map) {
    rawEntries = [...db.collections.entries()];
  } else if (Array.isArray(db.collections)) {
    rawEntries = db.collections.map((c, i) => [c?.name || c?.options?.name || String(i), c]);
  } else if (db.collections && typeof db.collections === 'object') {
    rawEntries = Object.entries(db.collections);
  } else if (typeof db.getCollections === 'function') {
    const list = db.getCollections() || [];
    rawEntries = (Array.isArray(list) ? list : [...list]).map((c) => [c?.name || c?.options?.name, c]);
  }

  const out = [];
  const seen = new Set();
  for (const [key, col] of rawEntries) {
    const name = String(col?.name || col?.options?.name || key || '').trim();
    if (!CUSTOM_COLLECTION_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const title = String(col?.options?.title || col?.title || name).trim();
    const rawFields = col?.fields instanceof Map
      ? [...col.fields.values()]
      : (Array.isArray(col?.fields) ? col.fields : (col?.fields && typeof col.fields === 'object' ? Object.values(col.fields) : []));
    out.push({ name, title, fields: rawFields });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function makeOperationId(pathStr, method) {
  const cleaned = pathStr
    .replace(/^\/api\//, '')
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch) => ch.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
  return `${method}_${cleaned}`;
}

function buildOpenApiSpec({ serverUrl, version, db } = {}) {
  const resolvedUrl = normalizeServerUrl(serverUrl);
  const resolvedVersion = version || resolveVersionFallback();
  const paths = {};
  const schemas = {
    GenericResponse: {
      type: 'object',
      additionalProperties: true,
    },
  };

  for (const [pathStr, method, tag, summary, isPublic] of API_OPERATIONS) {
    if (!paths[pathStr]) paths[pathStr] = {};
    const op = {
      operationId: makeOperationId(pathStr, method),
      summary,
      tags: [tag],
      security: isPublic ? [] : [{ bearerAuth: [] }, { latticeApiKey: [] }],
      responses: {
        200: {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GenericResponse' },
            },
          },
        },
        400: { description: 'Validation error' },
        401: { description: 'Authentication required or invalid credential' },
        403: { description: 'Insufficient role or scope permissions' },
      },
    };
    if (method === 'post') {
      op.requestBody = {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true },
          },
        },
      };
    }
    paths[pathStr][method] = op;
  }

  for (const col of collectCustomCollections(db)) {
    const properties = {
      id: { type: 'integer' },
      organizationId: { type: 'string' },
    };
    const required = [];
    for (const field of col.fields) {
      const fName = String(field?.name || field?.options?.name || '').trim();
      if (!fName) continue;
      properties[fName] = mapFieldTypeToJsonSchema(field);
      const allowNull = field?.options?.allowNull ?? field?.allowNull;
      if (allowNull === false && !AUTO_MANAGED_FIELDS.has(fName) && !required.includes(fName)) {
        required.push(fName);
      }
    }
    schemas[col.name] = {
      type: 'object',
      title: col.title,
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: true,
    };

    const schemaRef = { $ref: `#/components/schemas/${col.name}` };
    const customOps = [
      ['list', 'get', `List ${col.title} (${col.name}) records`, {
        type: 'object',
        properties: {
          data: { type: 'array', items: schemaRef },
          meta: { type: 'object', additionalProperties: true },
        },
      }, false],
      ['get', 'get', `Get single ${col.title} (${col.name}) record`, schemaRef, false],
      ['create', 'post', `Create ${col.title} (${col.name}) record`, schemaRef, true],
      ['update', 'post', `Update ${col.title} (${col.name}) record`, schemaRef, true],
      ['destroy', 'post', `Delete ${col.title} (${col.name}) record`, { $ref: '#/components/schemas/GenericResponse' }, false],
    ];

    for (const [actionName, method, summary, resSchema, hasBodySchema] of customOps) {
      const pathStr = `/api/${col.name}:${actionName}`;
      if (!paths[pathStr]) paths[pathStr] = {};
      const op = {
        operationId: makeOperationId(pathStr, method),
        summary,
        tags: ['Dynamic Custom Domains'],
        security: [{ bearerAuth: [] }, { latticeApiKey: [] }],
        responses: {
          200: {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: resSchema,
              },
            },
          },
          400: { description: 'Validation error' },
          401: { description: 'Authentication required or invalid credential' },
          403: { description: 'Insufficient role or scope permissions' },
        },
      };
      if (method === 'post') {
        op.requestBody = {
          required: false,
          content: {
            'application/json': {
              schema: hasBodySchema ? schemaRef : { type: 'object', additionalProperties: true },
            },
          },
        };
      }
      paths[pathStr][method] = op;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'LatticeDX Enterprise Digital OS API',
      version: resolvedVersion,
      summary: 'Multi-tenant Open-Core PaaS, PKI Ledger, ERP, WMS, DMN, IoT, Event Bus, and AI MCP API',
      license: {
        name: 'Apache-2.0',
        identifier: 'Apache-2.0',
      },
    },
    servers: [
      {
        url: resolvedUrl,
        description: 'LatticeDX API Gateway',
      },
    ],
    security: [{ bearerAuth: [] }, { latticeApiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT / ldx_pat_*',
          description: 'OIDC/NocoBase Bearer JWT or scoped PaaS Personal Access Token (ldx_pat_...)',
        },
        latticeApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Lattice-API-Key',
          description: 'Scoped PaaS API key header (ldx_pat_<8hex>_<32hex>)',
        },
      },
      schemas,
    },
  };
}

function buildAsyncApiSpec({ serverUrl, version } = {}) {
  const resolvedUrl = normalizeServerUrl(serverUrl);
  const parsed = new URL(resolvedUrl);
  const resolvedVersion = version || resolveVersionFallback();

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'LatticeDX Event-Driven & IoT AsyncAPI',
      version: resolvedVersion,
      description: 'MQTT telemetry & downlink commands, SSE UI surface stream, Redis Pub/Sub bus, and NGSI-LD Context Outbox webhooks.',
      license: {
        name: 'Apache-2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
    },
    servers: {
      mqttBroker: {
        host: `${parsed.hostname}:1883`,
        protocol: 'mqtt',
        description: 'Eclipse Mosquitto MQTT broker for IoT telemetry and actuator downlink commands',
      },
      httpGateway: {
        host: parsed.host,
        protocol: parsed.protocol === 'https:' ? 'https' : 'http',
        description: 'HTTP/SSE gateway and Outbox webhook delivery endpoints',
      },
      redisPubSub: {
        host: 'redis:6379',
        protocol: 'redis',
        description: 'Internal Redis Pub/Sub event bus for portal surface updates',
      },
    },
    channels: {
      iotTelemetry: {
        address: 'latticedx/{org}/{entity}/telemetry',
        servers: [{ $ref: '#/servers/mqttBroker' }],
        description: 'Inbound IoT sensor telemetry stream normalized into latticeTelemetryPoints and NGSI-LD context',
        parameters: {
          org: { description: 'Tenant organization identifier' },
          entity: { description: 'Asset or device entity identifier' },
        },
        messages: {
          telemetryPoint: {
            $ref: '#/components/messages/TelemetryPointMessage',
          },
        },
      },
      iotDownlinkCommand: {
        address: 'latticedx/{org}/{entity}/command',
        servers: [{ $ref: '#/servers/mqttBroker' }],
        description: 'Signed downlink command topic dispatched to edge gateways/devices',
        parameters: {
          org: { description: 'Tenant organization identifier' },
          entity: { description: 'Target asset or device entity identifier' },
        },
        messages: {
          downlinkCommand: {
            $ref: '#/components/messages/DownlinkCommandMessage',
          },
        },
      },
      surfaceEventsSse: {
        address: '/api/dxosAi:surfaceEvents',
        servers: [{ $ref: '#/servers/httpGateway' }],
        description: 'Server-Sent Events (SSE) stream pushing portal UI surface updates and chatter events',
        messages: {
          surfaceUpdateEvent: {
            $ref: '#/components/messages/SurfaceUpdateMessage',
          },
        },
      },
      redisSurfaceUpdates: {
        address: 'latticedx:surface-updates',
        servers: [{ $ref: '#/servers/redisPubSub' }],
        description: 'Redis Pub/Sub channel synchronizing portal surface mutations across workers',
        messages: {
          redisSurfaceMessage: {
            $ref: '#/components/messages/SurfaceUpdateMessage',
          },
        },
      },
      contextOutboxWebhooks: {
        address: 'latticeContextOutbox',
        servers: [{ $ref: '#/servers/httpGateway' }],
        description: 'Transactional outbox webhook delivery for NGSI-LD context changes to Orion-LD and n8n',
        messages: {
          contextOutboxEvent: {
            $ref: '#/components/messages/ContextOutboxWebhookMessage',
          },
        },
      },
    },
    operations: {
      ingestIotTelemetry: {
        action: 'receive',
        channel: { $ref: '#/channels/iotTelemetry' },
        summary: 'Receive device telemetry payload via MQTT',
      },
      dispatchIotCommand: {
        action: 'send',
        channel: { $ref: '#/channels/iotDownlinkCommand' },
        summary: 'Publish downlink command payload to edge device',
      },
      subscribeSurfaceEvents: {
        action: 'send',
        channel: { $ref: '#/channels/surfaceEventsSse' },
        summary: 'Stream real-time surface updates over SSE',
      },
      publishSurfaceUpdates: {
        action: 'send',
        channel: { $ref: '#/channels/redisSurfaceUpdates' },
        summary: 'Broadcast surface update event on Redis Pub/Sub',
      },
      deliverContextOutboxWebhook: {
        action: 'send',
        channel: { $ref: '#/channels/contextOutboxWebhooks' },
        summary: 'Deliver transactional latticeContextOutbox event via webhook',
      },
    },
    components: {
      messages: {
        TelemetryPointMessage: {
          name: 'TelemetryPoint',
          contentType: 'application/json',
          payload: {
            type: 'object',
            required: ['organizationId', 'entityId', 'metric', 'value', 'observedAt'],
            properties: {
              organizationId: { type: 'string' },
              entityId: { type: 'string' },
              metric: { type: 'string' },
              value: { type: 'number' },
              unit: { type: 'string' },
              observedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        DownlinkCommandMessage: {
          name: 'DownlinkCommand',
          contentType: 'application/json',
          payload: {
            type: 'object',
            required: ['organizationId', 'entityId', 'command', 'issuedAt'],
            properties: {
              organizationId: { type: 'string' },
              entityId: { type: 'string' },
              command: { type: 'string' },
              args: { type: 'object', additionalProperties: true },
              signatureBase64: { type: 'string' },
              issuedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        SurfaceUpdateMessage: {
          name: 'SurfaceUpdate',
          contentType: 'application/json',
          payload: {
            type: 'object',
            required: ['portalSlug'],
            properties: {
              portalSlug: { type: 'string' },
              kind: { type: 'string' },
              organizationId: { type: 'string' },
              revision: { type: 'integer' },
            },
          },
        },
        ContextOutboxWebhookMessage: {
          name: 'ContextOutboxWebhook',
          contentType: 'application/json',
          payload: {
            type: 'object',
            required: ['eventId', 'entityId', 'organizationId', 'collectionName', 'recordId', 'payload'],
            properties: {
              eventId: { type: 'string' },
              entityId: { type: 'string' },
              organizationId: { type: 'string' },
              collectionName: { type: 'string' },
              recordId: { type: 'integer' },
              payload: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  };
}

module.exports = {
  normalizeServerUrl,
  buildOpenApiSpec,
  buildAsyncApiSpec,
};

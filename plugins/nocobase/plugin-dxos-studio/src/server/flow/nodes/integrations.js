/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { fail, loadFoundationModule } = require('../../wms-dmn-shared');
const { sanitizeOutgoingHeaders, scrubAndCapHttpBody } = require('../security-helpers');
const { flowHelpers } = require('./triggers');

const { isPlainObject, sanitizePlainObject, interpolateTemplate, buildEvalContext, resolveOrgId, pickHelper } = flowHelpers;
const MAX_HARD_DEPTH = 8;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const NOTIFY_CHANNELS = ['in_app', 'email_smtp', 'telegram', 'slack', 'webhook'];
const VALID_NOTIFY_CHANNEL_SET = new Set([...NOTIFY_CHANNELS, 'smtp', 'apprise', 'all', 'external']);
function normalizeNotifyChannels(raw) {
  let list = raw;
  if (typeof list === 'string') {
    const t = list.trim();
    if (t.startsWith('[')) { try { list = JSON.parse(t); } catch { list = [t]; } } else list = t ? t.split(',') : [];
  }
  const out = (Array.isArray(list) ? list : []).map((c) => String(c || '').trim().toLowerCase()).filter((c) => VALID_NOTIFY_CHANNEL_SET.has(c));
  return out.length ? [...new Set(out)] : ['in_app'];
}
function parseChannelConfig(raw) {
  let val = raw;
  if (typeof val === 'string' && val.trim().startsWith('{')) { try { val = JSON.parse(val); } catch { return undefined; } }
  return isPlainObject(val) ? sanitizePlainObject(val) : undefined;
}

function loadSiblingBlocksModule(relName) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const sub = inDist ? `dist/server/${relName}` : `src/server/${relName}`;
  const alt = inDist ? `src/server/${relName}` : `dist/server/${relName}`;
  const candidates = [
    path.resolve(__dirname, `../../../../../plugin-dxos-blocks/${sub}`),
    `@latticedx/plugin-dxos-blocks/${sub}`,
    path.resolve(__dirname, `../../../../../plugin-dxos-blocks/${alt}`),
    `@latticedx/plugin-dxos-blocks/${alt}`,
  ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirect = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || !err.requireStack.length || err.requireStack[0] === __filename);
      if (!isDirect) throw err;
    }
  }
  return null;
}

function loadIntegrations(app, options = {}) {
  return {
    eventBusMod: options.eventBus || app?.latticeEvents || loadFoundationModule('event-bus'),
    vaultMod: options.connectorVault || app?.latticeVault || loadFoundationModule('connector-vault'),
    notificationMod: options.notificationCenter || app?.latticeNotifications || loadFoundationModule('notification-center'),
    digitalTwinMod: options.digitalTwin || app?.latticeDigitalTwin || loadSiblingBlocksModule('digital-twin'),
  };
}

function buildConnectorUrl(baseUrl, pathOrUrl) {
  const baseRaw = String(baseUrl || '').trim();
  let baseParsed;
  try { baseParsed = new URL(baseRaw); } catch {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, 'CONNECTOR_URL_OVERRIDE_FORBIDDEN: Invalid connector baseUrl');
  }
  const p = String(pathOrUrl || '').trim();
  if (!p) return baseRaw;
  if (/^\/\//.test(p) || /\\/.test(p) || /[\u0000-\u001f\u007f]/.test(p)) {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Unsafe connector path "${p}"`);
  }
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) ? p : `${baseRaw.replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`;
  let targetParsed;
  try { targetParsed = new URL(candidate); } catch {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Invalid connector URL "${p}"`);
  }
  if (targetParsed.origin !== baseParsed.origin || targetParsed.protocol !== baseParsed.protocol
    || targetParsed.host !== baseParsed.host || targetParsed.username !== baseParsed.username || targetParsed.password !== baseParsed.password) {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Path "${p}" cannot switch origin from "${baseParsed.origin}"`);
  }
  return targetParsed.toString();
}

function scrubSecrets(text, secrets) {
  let out = String(text || '');
  if (!secrets || typeof secrets !== 'object') return out;
  for (const sVal of Object.values(secrets)) {
    if (typeof sVal === 'string' && sVal.length >= 4) out = out.split(sVal).join('[REDACTED]');
  }
  return out;
}

function buildHmacHeaders(bodyString, secrets) {
  const raw = String(secrets?.secret || secrets?.signingSecret || secrets?.hmacSecret || secrets?.webhookSecret || secrets?.apiKey || '').trim();
  if (!raw) return {};
  const key = raw.startsWith('whsec_') ? Buffer.from(raw.slice(6), 'base64') : raw;
  const webhookId = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const hexSig = crypto.createHmac('sha256', key).update(bodyString || '').digest('hex');
  const b64Sig = crypto.createHmac('sha256', key).update(`${webhookId}.${ts}.${bodyString || ''}`).digest('base64');
  return { 'X-Lattice-Signature-256': `sha256=${hexSig}`, 'webhook-id': webhookId, 'webhook-timestamp': ts, 'webhook-signature': `v1,${b64Sig}` };
}

function buildFallbackAuthHeaders(authType, secrets) {
  const kind = String(authType || 'none').toLowerCase();
  if (!secrets || typeof secrets !== 'object' || kind === 'none') return {};
  if (kind === 'bearer' && (secrets.token || secrets.bearerToken || secrets.accessToken || secrets.apiKey)) {
    return { Authorization: `Bearer ${secrets.token || secrets.bearerToken || secrets.accessToken || secrets.apiKey}` };
  }
  if (kind === 'api_key' && secrets.apiKey) return { [String(secrets.headerName || 'X-API-Key')]: String(secrets.apiKey) };
  if (kind === 'basic' && secrets.username) return { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ''}`).toString('base64')}` };
  return {};
}

const integrationNodes = [
  {
    type: 'integration.http',
    category: 'integration',
    label: 'Kết nối HTTP qua Vault',
    description: 'Gọi HTTP connector quản trị trong Vault với khóa origin, kiểm tra SSRF và ký HMAC.',
    icon: 'GlobalOutlined',
    color: '#eb2f96',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { connectorKey: '', method: 'POST', path: '', headers: {}, body: null, timeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
    inputSchema: {
      fields: [
        { name: 'connectorKey', label: 'Mã Kết nối (Connector Key)', type: 'string', required: true },
        { name: 'method', label: 'Phương thức HTTP', type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        { name: 'path', label: 'Đường dẫn Tương đối', type: 'string', placeholder: '/webhooks/sync' },
        { name: 'headers', label: 'Header Tùy chỉnh (JSON)', type: 'json' },
        { name: 'body', label: 'Nội dung Yêu cầu (JSON)', type: 'json' },
        { name: 'timeoutMs', label: 'Thời gian chờ (ms)', type: 'number' },
      ],
    },
    async execute({ node, config, input, context, db, app, options = {}, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const { vaultMod } = loadIntegrations(app, options);
      const connectorKey = String(interp(cfg.connectorKey || cfg.connector || '', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      if (!connectorKey) throw fail('CONNECTOR_KEY_REQUIRED', 400, 'integration.http requires connectorKey');
      if (!orgId) throw fail('CONNECTOR_ORG_REQUIRED', 400, 'Valid organizationId is required for integration.http');
      if (typeof vaultMod?.resolveConnectorSecrets !== 'function') throw fail('VAULT_UNAVAILABLE', 503, 'Connector Vault module unavailable');

      const { connector, secrets } = await vaultMod.resolveConnectorSecrets(db, orgId, connectorKey, { env: options.env });
      const resolvedUrl = pickHelper(helpers, 'buildConnectorUrl', buildConnectorUrl)(connector.baseUrl, interp(cfg.path ?? cfg.url ?? '', evalCtx));
      const fetchFn = options.fetchImpl || globalThis.fetch;
      const isMockFetch = typeof options.fetchImpl === 'function' && options.fetchImpl !== globalThis.fetch;
      const ssrfOpts = { connectorType: connector.connectorType || 'http_api', env: options.env, ...(typeof options.lookupImpl === 'function' ? { lookupImpl: options.lookupImpl } : {}), skipDnsCheck: isMockFetch && typeof options.lookupImpl !== 'function' };
      if (typeof vaultMod.assertSafeConnectorUrl === 'function') vaultMod.assertSafeConnectorUrl(resolvedUrl, ssrfOpts);
      if (typeof vaultMod.assertSafeConnectorUrlAsync === 'function') await vaultMod.assertSafeConnectorUrlAsync(resolvedUrl, ssrfOpts);

      const method = String(cfg.method || 'POST').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw fail('HTTP_METHOD_INVALID', 400, `Unsupported HTTP method: ${method}`);
      const safePathUrl = (() => { try { const u = new URL(resolvedUrl); return `${u.origin}${u.pathname}`; } catch { return resolvedUrl; } })();
      if (options.dryRun) return { output: { connectorKey, authType: connector.authType, method, url: safePathUrl, simulated: true, ok: true }, nextPort: 'main' };
      if (typeof fetchFn !== 'function') throw fail('FETCH_UNAVAILABLE', 503, 'fetch implementation unavailable');

      const customHeaders = isPlainObject(cfg.headers) ? interp(cfg.headers, evalCtx) : {};
      const authHeaders = typeof vaultMod.buildConnectorAuthHeaders === 'function' ? vaultMod.buildConnectorAuthHeaders(connector.authType, secrets) : buildFallbackAuthHeaders(connector.authType, secrets);
      const bodyPayload = method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(interp(cfg.body ?? cfg.payload ?? evalCtx.data ?? {}, evalCtx));
      const hmacHeaders = connector.authType === 'hmac' ? pickHelper(helpers, 'buildHmacHeaders', buildHmacHeaders)(bodyPayload || '', secrets) : {};
      const cleanCustom = sanitizeOutgoingHeaders(customHeaders, authHeaders, hmacHeaders);
      const headers = { Accept: 'application/json', ...(bodyPayload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...cleanCustom, ...authHeaders, ...hmacHeaders };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(60000, Number(cfg.timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS)));
      let response;
      try {
        response = await fetchFn(resolvedUrl, { method, headers, body: bodyPayload, redirect: 'error', signal: controller.signal });
      } catch (err) {
        throw fail('CONNECTOR_HTTP_FAILED', 502, pickHelper(helpers, 'scrubSecrets', scrubSecrets)(err?.message || 'Connector HTTP request failed', secrets));
      } finally { clearTimeout(timer); }
      if (!response?.ok) {
        try { await response?.body?.cancel?.(); } catch {}
        throw fail('CONNECTOR_HTTP_ERROR', 502, `Connector ${connectorKey} responded with HTTP ${response?.status}`);
      }
      let rawRespBody = null;
      if (typeof response.text === 'function') {
        const txt = await response.text().catch(() => '');
        if (txt.length > 65536) rawRespBody = txt.slice(0, 16384);
        else if (txt.trim()) { try { rawRespBody = JSON.parse(txt); } catch { rawRespBody = txt; } }
      } else if (typeof response.json === 'function') {
        rawRespBody = await response.json().catch(() => null);
      }
      const responseBody = scrubAndCapHttpBody(rawRespBody, secrets);
      return { output: { connectorKey, authType: connector.authType, method, url: safePathUrl, status: response.status, ok: true, response: responseBody }, nextPort: 'main' };
    },
  },
  {
    type: 'iot.twin_command',
    category: 'integration',
    label: 'Lệnh Digital Twin',
    description: 'Áp dụng hoặc đưa vào cổng duyệt HITL bản vá trạng thái mong muốn cho thực thể Digital Twin.',
    icon: 'ControlOutlined',
    color: '#eb2f96',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { assetId: '', assetEntityId: '', desiredPatch: {}, downlinkUrl: '' },
    inputSchema: {
      fields: [
        { name: 'assetId', label: 'ID Tài sản', type: 'string' },
        { name: 'assetEntityId', label: 'Entity ID / URN Twin', type: 'string', required: true },
        { name: 'desiredPatch', label: 'Trạng thái Mong muốn (JSON)', type: 'json', required: true },
        { name: 'downlinkUrl', label: 'URL Downlink (tùy chọn)', type: 'string' },
      ],
    },
    async execute({ node, config, input, context, db, app, options = {}, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const orgId = resolveOrgId(context, input, options, cfg);
      if (!orgId) throw fail('TWIN_ORG_REQUIRED', 400, 'Valid organizationId is required for iot.twin_command');
      const rawDesired = interp(cfg.desiredPatch ?? cfg.desired ?? {}, evalCtx);
      const desiredPatch = isPlainObject(rawDesired) ? sanitizePlainObject(rawDesired) : {};
      const assetEntityId = String(interp(cfg.assetEntityId || cfg.deviceKey || evalCtx.event?.subject || '', evalCtx)).trim();
      const assetId = cfg.assetId ? interp(cfg.assetId, evalCtx) : undefined;
      const downlinkUrl = cfg.downlinkUrl ? String(interp(cfg.downlinkUrl, evalCtx)) : undefined;
      if (options.dryRun) return { output: { organizationId: orgId, assetId: assetId ?? null, assetEntityId, desiredPatch, simulated: true }, nextPort: 'main' };
      const { digitalTwinMod } = loadIntegrations(app, options);
      if (typeof digitalTwinMod?.requestDesiredSetpoint !== 'function') throw fail('DIGITAL_TWIN_UNAVAILABLE', 503, 'Digital Twin module unavailable');
      const twinRes = await digitalTwinMod.requestDesiredSetpoint(db, {
        organizationId: orgId, assetId, assetEntityId, desiredPatch,
        actor: context?.actor || { username: 'flow:twin', role: 'automation' }, downlinkUrl, env: options.env, fetchImpl: options.fetchImpl,
      });
      return { output: twinRes, nextPort: 'main' };
    },
  },
  {
    type: 'notify.send',
    category: 'integration',
    label: 'Gửi Thông báo theo Vai trò',
    description: 'Gửi thông báo theo phạm vi tổ chức tới các vai trò mục tiêu qua các kênh đã cấu hình.',
    icon: 'BellOutlined',
    color: '#eb2f96',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { roleNames: ['ldx_operator'], title: '', body: '', severity: 'warning', category: 'system', targetCollection: '', targetRecordId: '', targetPath: '', notifyChannels: ['in_app'], templateKey: '', channelConfig: {} },
    inputSchema: {
      fields: [
        { name: 'roleNames', label: 'Danh sách Vai trò (JSON)', type: 'json', required: true },
        { name: 'title', label: 'Tiêu đề', type: 'string', required: true },
        { name: 'body', label: 'Nội dung', type: 'textarea' },
        { name: 'severity', label: 'Mức độ nghiêm trọng', type: 'select', options: ['info', 'warning', 'high', 'critical'] },
        { name: 'category', label: 'Phân loại', type: 'select', options: ['system', 'mention', 'voucher', 'sla', 'alarm', 'approval'] },
        { name: 'targetCollection', label: 'Bảng dữ liệu Đích', type: 'collection' },
        { name: 'targetRecordId', label: 'ID Bản ghi Đích', type: 'string' },
        { name: 'targetPath', label: 'Đường dẫn Portal Đích', type: 'string' },
        { name: 'notifyChannels', label: 'Kênh Thông báo (JSON)', type: 'json', options: NOTIFY_CHANNELS, placeholder: '["in_app","email_smtp","telegram","slack","webhook"]' },
        { name: 'templateKey', label: 'Mã Mẫu thông báo', type: 'string', placeholder: 'incident_alert' },
        { name: 'channelConfig', label: 'Cấu hình Kênh (JSON)', type: 'json', placeholder: '{"connectorKey":"tg-ops"}' },
      ],
    },
    async execute({ node, config, input, context, db, app, options = {}, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const orgId = resolveOrgId(context, input, options, cfg);
      if (!orgId) throw fail('NOTIFY_ORG_REQUIRED', 400, 'Valid organizationId is required for notify.send');
      const rawRoles = interp(cfg.roleNames || cfg.roles || cfg.role || 'ldx_operator', evalCtx);
      const roleNames = (Array.isArray(rawRoles) ? rawRoles : [rawRoles]).map((r) => String(r || '').trim()).filter(Boolean);
      const title = String(interp(cfg.title || 'Workflow Notification', evalCtx));
      const body = String(interp(cfg.body || cfg.message || '', evalCtx));
      const severity = String(interp(cfg.severity || 'warning', evalCtx));
      const category = String(interp(cfg.category || 'system', evalCtx));
      const targetCollection = cfg.targetCollection ? String(interp(cfg.targetCollection, evalCtx)) : undefined;
      const targetRecordId = cfg.targetRecordId ? interp(cfg.targetRecordId, evalCtx) : undefined;
      const targetPath = cfg.targetPath ? String(interp(cfg.targetPath, evalCtx)) : undefined;
      const notifyChannels = normalizeNotifyChannels(interp(cfg.notifyChannels, evalCtx));
      const templateKey = cfg.templateKey ? String(interp(cfg.templateKey, evalCtx)).trim().slice(0, 120) : undefined;
      const channelConfig = cfg.channelConfig !== undefined ? parseChannelConfig(interp(cfg.channelConfig, evalCtx)) : undefined;
      if (options.dryRun) return { output: { roleNames, title, body, severity, category, notifyChannels, ...(templateKey ? { templateKey } : {}), dispatched: roleNames.length, simulated: true }, nextPort: 'main' };

      const { notificationMod } = loadIntegrations(app, options);
      if (typeof notificationMod?.dispatchRoleNotifications === 'function') {
        const res = await notificationMod.dispatchRoleNotifications(db, {
          organizationId: orgId, roleNames, category, severity, title, body, targetCollection, targetRecordId, targetPath, notifyChannels,
          ...(templateKey ? { templateKey } : {}), ...(channelConfig ? { channelConfig } : {}),
        }, { env: options.env, fetchImpl: options.fetchImpl, ...(typeof options.lookupImpl === 'function' ? { lookupImpl: options.lookupImpl } : {}) });
        return { output: { roleNames, notifyChannels, ...(templateKey ? { templateKey } : {}), dispatched: res?.dispatchedCount ?? res?.createdCount ?? res?.count ?? roleNames.length, title }, nextPort: 'main' };
      }
      const notifRepo = db?.getRepository?.('latticeNotifications');
      if (typeof notifRepo?.create === 'function') {
        await notifRepo.create({ values: { organizationId: orgId, targetRole: roleNames[0] || 'ldx_operator', category, severity, title, body, targetCollection: targetCollection || null, targetRecordId: targetRecordId || null, targetPath: targetPath || null, read: false } });
        return { output: { roleNames, dispatched: roleNames.length, title }, nextPort: 'main' };
      }
      throw fail('NOTIFICATION_UNAVAILABLE', 503, 'Notification Center module unavailable');
    },
  },
  {
    type: 'event.emit',
    category: 'integration',
    label: 'Phát Sự kiện Miền',
    description: 'Phát một CloudEvent theo phạm vi tổ chức lên Lattice Event Bus với độ sâu đệ quy tăng dần.',
    icon: 'SendOutlined',
    color: '#eb2f96',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { eventType: '', subject: '', data: {} },
    inputSchema: {
      fields: [
        { name: 'eventType', label: 'Loại Sự kiện', type: 'string', required: true },
        { name: 'subject', label: 'Chủ thể (Subject)', type: 'string' },
        { name: 'data', label: 'Dữ liệu Payload (JSON)', type: 'json' },
      ],
    },
    async execute({ node, config, input, context, db, app, options = {}, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const orgId = resolveOrgId(context, input, options, cfg);
      const eventType = String(interp(cfg.eventType || cfg.type || '', evalCtx)).trim();
      if (!orgId) throw fail('EVENT_ORG_REQUIRED', 400, 'Valid organizationId is required for event.emit');
      if (!eventType) throw fail('EVENT_TYPE_REQUIRED', 400, 'event.emit requires eventType');
      const nextDepth = Number(context?.depth ?? evalCtx.event?.depth ?? 0) + 1;
      if (nextDepth > MAX_HARD_DEPTH) throw fail('RECURSION_DEPTH_LIMIT_EXCEEDED', 400, `RECURSION_DEPTH_LIMIT_EXCEEDED (depth=${nextDepth} > ${MAX_HARD_DEPTH})`);
      const subject = cfg.subject ? String(interp(cfg.subject, evalCtx)) : '';
      const rawData = interp(cfg.data ?? {}, evalCtx);
      const data = isPlainObject(rawData) ? sanitizePlainObject(rawData) : {};
      if (options.dryRun) return { output: { published: true, simulated: true, eventType, subject, data, depth: nextDepth }, nextPort: 'main' };

      const { eventBusMod } = loadIntegrations(app, options);
      const body = { organizationId: orgId, type: eventType, source: 'dxos-studio:flow', subject, data, depth: nextDepth, app };
      if (typeof app?.latticeEvents?.publishDomainEvent === 'function') {
        if (typeof db?.getRepository === 'function') await app.latticeEvents.publishDomainEvent(db, body);
        else await app.latticeEvents.publishDomainEvent(body);
        return { output: { published: true, eventType, subject, depth: nextDepth }, nextPort: 'main' };
      }
      if (typeof eventBusMod?.publishDomainEvent === 'function') {
        await eventBusMod.publishDomainEvent(db, body);
        return { output: { published: true, eventType, subject, depth: nextDepth }, nextPort: 'main' };
      }
      throw fail('EVENT_BUS_UNAVAILABLE', 503, 'Event Bus module unavailable');
    },
  },
];

module.exports = { integrationNodes, buildConnectorUrl, buildHmacHeaders, scrubSecrets, NOTIFY_CHANNELS, normalizeNotifyChannels, parseChannelConfig };

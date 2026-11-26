/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { ORG_ID_RE } = require('../../wms-dmn-shared');

const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function sanitizePlainObject(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePlainObject(item, seen));
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const key of Object.keys(value)) {
    if (!BLOCKED_PROTO_KEYS.has(key)) out[key] = sanitizePlainObject(value[key], seen);
  }
  return out;
}

function getSafePath(root, rawPath) {
  if (root === null || root === undefined) return undefined;
  const pathStr = String(rawPath || '').trim();
  if (!pathStr || !/^[a-zA-Z0-9_.\-$]+$/.test(pathStr)) return undefined;
  let current = root;
  for (const seg of pathStr.split('.').filter(Boolean)) {
    if (BLOCKED_PROTO_KEYS.has(seg) || current == null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (!Object.prototype.hasOwnProperty.call(current, seg)) {
      return undefined;
    } else {
      current = current[seg];
    }
  }
  return current;
}

function resolveExpr(expr, ctx) {
  const trimmed = String(expr || '').trim();
  if (!trimmed || !/^[a-zA-Z0-9_.\-$]+$/.test(trimmed)) return undefined;
  if (trimmed.split('.').some((s) => BLOCKED_PROTO_KEYS.has(s))) return undefined;
  const direct = getSafePath(ctx, trimmed);
  if (direct !== undefined) return direct;
  return isPlainObject(ctx?.data) ? getSafePath(ctx.data, trimmed) : undefined;
}

function interpolateTemplate(value, context) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{([^{}]+)\}\}$/);
    if (exact) {
      const resolved = resolveExpr(exact[1], context);
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(/\{\{([^{}]*)\}\}/g, (_m, expr) => {
      const resolved = resolveExpr(expr, context);
      if (resolved === undefined || resolved === null) return '';
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateTemplate(item, context));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!BLOCKED_PROTO_KEYS.has(k)) out[k] = interpolateTemplate(v, context);
    }
    return out;
  }
  return value;
}

function buildEvalContext(context, input) {
  const ctx = isPlainObject(context) ? context : {};
  const data = isPlainObject(ctx.data) ? ctx.data : (isPlainObject(input?.data) ? input.data : (isPlainObject(input) ? input : {}));
  return { ...ctx, input: input ?? null, data };
}

function resolveOrgId(context, _input, options, _config) {
  const raw = String(
    options?.organizationId || context?.organizationId || context?.event?.organizationId || context?.event?.organizationid || '',
  ).trim();
  return ORG_ID_RE.test(raw) ? raw : '';
}

const pickHelper = (helpers, name, fallback) => (typeof helpers?.[name] === 'function' ? helpers[name] : fallback);

function executeTrigger(node, config, input, context) {
  const cfg = config || node?.config || {};
  const nodeType = String(node?.type || cfg?.type || input?.type || context?.event?.type || 'trigger.event');
  const data = sanitizePlainObject(
    isPlainObject(input?.data) ? input.data
      : isPlainObject(context?.data) ? context.data
        : isPlainObject(context?.event?.data) ? context.event.data
          : isPlainObject(input) ? input : {},
  );
  const record = sanitizePlainObject(input?.record ?? context?.record ?? context?.event?.record ?? (nodeType === 'trigger.record' ? data : null));
  const timestamp = String(input?.timestamp || context?.event?.time || new Date().toISOString());
  const webhook = sanitizePlainObject(
    input?.webhook ?? context?.webhook ?? (nodeType === 'trigger.webhook'
      ? { webhookPath: cfg.webhookPath || '', authMode: cfg.authMode || 'hmac', secretHeader: cfg.secretHeader || 'X-Lattice-Signature-256' }
      : null),
  );
  const schedule = sanitizePlainObject(
    input?.schedule ?? context?.schedule ?? (nodeType === 'trigger.schedule'
      ? { cron: cfg.cron || '0 * * * *', timezone: cfg.timezone || 'UTC' }
      : null),
  );
  return {
    output: { type: String(input?.type || context?.event?.type || cfg.eventType || nodeType), data, record, timestamp, webhook, schedule },
    nextPort: 'main',
  };
}

function makeTriggerNode({ type, label, description, icon, defaultConfig, fields }) {
  return {
    type,
    category: 'trigger',
    label,
    description,
    icon,
    color: '#1677ff',
    inputs: [],
    outputs: ['main'],
    defaultConfig,
    inputSchema: { fields },
    async execute({ node, config, input, context }) {
      return executeTrigger({ ...(node || {}), type: node?.type || type }, config, input, context);
    },
  };
}

const triggerNodes = [
  makeTriggerNode({
    type: 'trigger.event',
    label: 'Kích hoạt Sự kiện Miền',
    description: 'Bắt đầu quy trình khi có sự kiện miền CloudEvents khớp mẫu.',
    icon: 'BoltOutlined',
    defaultConfig: { eventType: '*', filterJson: null },
    fields: [
      { name: 'eventType', label: 'Mẫu Sự kiện', type: 'string', required: true, placeholder: 'entity.created, ticket.*' },
      { name: 'filterJson', label: 'Bộ lọc Sự kiện (JSON)', type: 'json' },
    ],
  }),
  makeTriggerNode({
    type: 'trigger.record',
    label: 'Kích hoạt Vòng đời Bản ghi',
    description: 'Bắt đầu quy trình khi tạo, cập nhật hoặc xóa bản ghi nghiệp vụ.',
    icon: 'DatabaseOutlined',
    defaultConfig: { collection: '', operation: 'create', filterJson: null },
    fields: [
      { name: 'collection', label: 'Bảng dữ liệu', type: 'collection', required: true, placeholder: 'latticeRequests' },
      { name: 'operation', label: 'Thao tác', type: 'select', required: true, options: ['create', 'update', 'delete'] },
      { name: 'filterJson', label: 'Bộ lọc Bản ghi (JSON)', type: 'json' },
    ],
  }),
  makeTriggerNode({
    type: 'trigger.schedule',
    label: 'Kích hoạt Theo lịch',
    description: 'Bắt đầu quy trình định kỳ theo biểu thức cron 5 trường.',
    icon: 'ClockCircleOutlined',
    defaultConfig: { cron: '0 * * * *', timezone: 'UTC' },
    fields: [
      { name: 'cron', label: 'Biểu thức Cron', type: 'string', required: true, placeholder: '*/15 * * * *' },
      { name: 'timezone', label: 'Múi giờ', type: 'string', placeholder: 'Asia/Ho_Chi_Minh' },
    ],
  }),
  makeTriggerNode({
    type: 'trigger.webhook',
    label: 'Kích hoạt Webhook Đến',
    description: 'Bắt đầu quy trình từ yêu cầu webhook xác thực HMAC-SHA256 hoặc Bearer.',
    icon: 'ApiOutlined',
    defaultConfig: { webhookPath: '', authMode: 'hmac', secretHeader: 'X-Lattice-Signature-256' },
    fields: [
      { name: 'webhookPath', label: 'Đường dẫn Webhook', type: 'string', required: true, placeholder: '/hooks/inbound' },
      { name: 'authMode', label: 'Chế độ Xác thực', type: 'select', required: true, options: ['hmac', 'bearer'] },
      { name: 'secretHeader', label: 'Header Chữ ký', type: 'string', placeholder: 'X-Lattice-Signature-256' },
    ],
  }),
  makeTriggerNode({
    type: 'trigger.manual',
    label: 'Kích hoạt Thủ công / API',
    description: 'Bắt đầu quy trình thủ công hoặc qua gọi API xác thực.',
    icon: 'PlayCircleOutlined',
    defaultConfig: { inputSchemaJson: {} },
    fields: [
      { name: 'inputSchemaJson', label: 'Schema Đầu vào (JSON)', type: 'json' },
    ],
  }),
];

module.exports = {
  triggerNodes,
  flowHelpers: {
    BLOCKED_PROTO_KEYS,
    isPlainObject,
    sanitizePlainObject,
    getSafePath,
    interpolateTemplate,
    buildEvalContext,
    resolveOrgId,
    pickHelper,
  },
};

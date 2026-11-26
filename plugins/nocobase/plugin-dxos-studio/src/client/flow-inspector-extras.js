/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const DEFAULT_AGENT_TOOLS = [
  'memory_recall',
  'memory_store',
  'dxos_search_enterprise_context',
  'dxos_my_workflow_tasks',
  'dxos_graph_impact_analysis',
  'dxos_execute_record_action',
  'dxos_alarm_action',
];

const shSingleQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function buildWebhookCurlCommand({ origin, organizationId, ruleKey, authMode, secretHeader, samplePayloadText }) {
  const safeOrigin = String(origin || 'http://localhost:13014').replace(/[\r\n\t\0]/g, '').replace(/\/+$/, '');
  const url = `${safeOrigin}/api/dxosAutomations:webhookIngress?organizationId=${encodeURIComponent(String(organizationId || 'default'))}&ruleKey=${encodeURIComponent(String(ruleKey || 'flow_rule'))}`;
  const mode = String(authMode || 'hmac').toLowerCase();
  const hdrName = String(secretHeader || 'X-Lattice-Signature-256').replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, '').trim() || 'X-Lattice-Signature-256';
  const authHeaderVal = mode === 'bearer'
    ? 'Authorization: Bearer <WEBHOOK_BEARER_TOKEN>'
    : `${hdrName}: sha256=<WEBHOOK_HMAC_SHA256_HEX>`;
  const body = String(samplePayloadText || '{"code":"WH-01"}');
  return `curl -X POST ${shSingleQuote(url)} \\\n  -H 'Content-Type: application/json' \\\n  -H ${shSingleQuote(authHeaderVal)} \\\n  -d ${shSingleQuote(body)}`;
}

function renderTraceIoView(h, { displayOut, activeTrace, formatJson, statusTone, S }) {
  const resolvedOut = displayOut || null;
  if (!resolvedOut) {
    return h('div', { 'data-testid': 'dxos-flow-output-view', style: S.card },
      h('span', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa có kết quả thử nghiệm hoặc trace. Hãy chạy "Thử nút này" hoặc Chạy thử.'),
    );
  }
  const traceInput = resolvedOut.input !== undefined ? resolvedOut.input : (activeTrace?.input !== undefined ? activeTrace.input : null);
  return h('div', { 'data-testid': 'dxos-flow-output-view', style: S.card },
    h('div', { style: S.rowBetween },
      h('span', { 'data-testid': 'dxos-flow-output-status', style: S.badge(statusTone(resolvedOut.status)) }, resolvedOut.status || 'completed'),
      h('span', { style: { fontSize: 11, color: '#475569' } }, `${resolvedOut.durationMs ?? 0} ms · nhánh: ${resolvedOut.nextPort || resolvedOut.nextPorts?.[0] || '-'}`),
    ),
    (resolvedOut.error || resolvedOut.reason)
      ? h('div', { style: { padding: 8, borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 11 } }, String(resolvedOut.error || resolvedOut.reason))
      : null,
    h('div', { style: S.grid(3) },
      h('span', { style: { ...S.label, marginBottom: 0 } }, 'Dữ liệu đầu vào (Input JSON)'),
      h('pre', { 'data-testid': 'dxos-flow-trace-input-json', style: { margin: 0, padding: 8, borderRadius: 6, background: '#1e293b', color: '#cbd5e1', fontSize: 11, overflowX: 'auto', maxHeight: 160 } }, formatJson(traceInput, null)),
    ),
    h('div', { style: S.grid(3) },
      h('span', { style: { ...S.label, marginBottom: 0 } }, 'Kết quả đầu ra (Output JSON)'),
      h('pre', { 'data-testid': 'dxos-flow-output-json', style: { margin: 0, padding: 8, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontSize: 11, overflowX: 'auto', maxHeight: 240 } }, formatJson(resolvedOut.output !== undefined ? resolvedOut.output : resolvedOut, null)),
    ),
  );
}

function createWebhookHelperComponent(React, S) {
  const h = React.createElement;
  return function WebhookHelper({ nodeId, nodeCfg, ruleKey, orgKey, onTestNode, onDryRunWebhook, onSwitchToOutput, testBusy }) {
    const [sampleText, setSampleText] = React.useState('{"code":"WH-01","source":"webhook"}');
    const [copied, setCopied] = React.useState(false);
    const origin = (typeof window !== 'undefined' && window?.location?.origin) ? window.location.origin : 'http://localhost:13014';
    const ingressPath = `/api/dxosAutomations:webhookIngress?organizationId=${encodeURIComponent(String(orgKey || 'default'))}&ruleKey=${encodeURIComponent(String(ruleKey || 'flow_rule'))}`;
    const configuredWebhookPath = String(nodeCfg?.webhookPath || '').trim();
    const curlCmd = buildWebhookCurlCommand({
      origin,
      organizationId: orgKey,
      ruleKey,
      authMode: nodeCfg?.authMode,
      secretHeader: nodeCfg?.secretHeader,
      samplePayloadText: sampleText,
    });
    const parseSample = () => {
      try { const p = JSON.parse(sampleText || '{}'); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : { payload: p }; }
      catch { return { raw: sampleText }; }
    };
    return h('div', { 'data-testid': 'dxos-flow-webhook-helper', style: { ...S.card, background: '#f0f9ff', border: '1px solid #bae6fd' } },
      h('div', { style: S.rowBetween },
        h('strong', { style: { fontSize: 12, color: '#0369a1' } }, 'Kiểm thử Webhook & Lệnh cURL'),
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-webhook-copy-btn',
          onClick: () => {
            try { if (typeof navigator !== 'undefined') navigator?.clipboard?.writeText?.(curlCmd); } catch {}
            setCopied(true);
          },
          style: S.btn(false, false, false),
        }, copied ? '✓ Đã chép' : 'Sao chép cURL'),
      ),
      h('div', { 'data-testid': 'dxos-flow-webhook-endpoints', style: { display: 'grid', gap: 3, padding: '6px 8px', borderRadius: 6, background: '#e0f2fe', fontSize: 11, color: '#0c4a6e' } },
        h('div', null, h('strong', null, 'URL nhận Webhook Ingress: '), h('code', null, `POST ${ingressPath}`)),
        h('div', null, h('strong', null, 'Đường dẫn cấu hình (webhookPath): '), h('code', null, configuredWebhookPath || '(chưa cấu hình)')),
      ),
      h('pre', { 'data-testid': 'dxos-flow-webhook-curl', style: { margin: 0, padding: 8, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontSize: 10, overflowX: 'auto', whiteSpace: 'pre-wrap' } }, curlCmd),
      h('textarea', {
        'data-testid': 'dxos-flow-webhook-sample-input',
        rows: 2,
        value: sampleText,
        onChange: (e) => setSampleText(e?.target?.value ?? ''),
        style: S.textarea,
      }),
      h('div', { style: S.rowWrap },
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-webhook-test-btn',
          disabled: Boolean(testBusy),
          onClick: () => {
            const sampleObj = parseSample();
            onSwitchToOutput?.();
            onTestNode?.(nodeId, {
              event: { type: 'webhook.inbound', data: sampleObj },
              data: sampleObj,
              webhook: { webhookPath: nodeCfg?.webhookPath || '', authMode: nodeCfg?.authMode || 'hmac' },
            });
          },
          style: S.btn(true, false, Boolean(testBusy)),
        }, testBusy ? 'Đang thử…' : 'Thử Trigger'),
        onDryRunWebhook ? h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-webhook-dryrun-btn',
          onClick: () => onDryRunWebhook(parseSample()),
          style: S.btn(false, false, false),
        }, 'Chạy thử luồng') : null,
      ),
    );
  };
}

function renderToolsPicker(h, { val, catalog, updateConfigField, inputStyle }) {
  const options = Array.isArray(catalog?.agentTools) && catalog.agentTools.length ? catalog.agentTools : DEFAULT_AGENT_TOOLS;
  const cur = Array.isArray(val) ? val : [];
  return h('select', {
    'data-testid': 'dxos-flow-field-tools-picker',
    value: '',
    style: inputStyle,
    onChange: (e) => {
      const picked = e?.target?.value;
      if (picked) updateConfigField('tools', cur.includes(picked) ? cur : [...cur, picked]);
    },
  },
    h('option', { value: '' }, '+ Thêm công cụ được phép...'),
    options.map((t) => h('option', { key: t, value: t }, t)),
  );
}

const VISUAL_FILTER_OPS = Object.freeze([
  ['eq', 'bằng (=)'],
  ['ne', 'khác (!=)'],
  ['gt', 'lớn hơn (>)'],
  ['gte', 'lớn hơn hoặc bằng (>=)'],
  ['lt', 'nhỏ hơn (<)'],
  ['lte', 'nhỏ hơn hoặc bằng (<=)'],
  ['contains', 'chứa (contains)'],
  ['in', 'trong danh sách (in)'],
  ['nin', 'ngoài danh sách (nin)'],
  ['exists', 'tồn tại (exists)'],
]);
const VISUAL_OP_SET = new Set(VISUAL_FILTER_OPS.map(([k]) => k));
const TRANSFORM_OPS = Object.freeze([
  ['set', 'Gán giá trị (set)'],
  ['template', 'Chuỗi mẫu (template)'],
  ['coerceNumber', 'Ép kiểu số (coerceNumber)'],
  ['coerceBoolean', 'Ép kiểu logic (coerceBoolean)'],
  ['math', 'Phép toán (math)'],
  ['concat', 'Nối chuỗi (concat)'],
  ['rename', 'Đổi tên trường (rename)'],
  ['pick', 'Chỉ giữ trường (pick)'],
  ['omit', 'Loại bỏ trường (omit)'],
]);
const CRON_FIELD_RE = /^[0-9*,\/-]+$/;

const FLOW_MUTATING_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_manager']);
const FLOW_ADMIN_ROLES = new Set(['root', 'admin', 'ldx_admin']);

function resolveFlowUiAccess({ uiPerms, userCtx, api, app } = {}) {
  const roleCandidates = [];
  const pushRole = (r) => {
    const clean = String(r || '').trim();
    if (clean) roleCandidates.push(clean);
  };
  pushRole(userCtx?.data?.currentRole);
  pushRole(userCtx?.currentRole);
  pushRole(api?.auth?.role);
  pushRole(app?.apiClient?.auth?.role);
  if (roleCandidates.length === 0 && Array.isArray(userCtx?.data?.roles)) {
    for (const r of userCtx.data.roles) {
      pushRole(typeof r === 'string' ? r : r?.name);
    }
  }
  if (roleCandidates.length > 0) {
    return {
      uiDenied: !roleCandidates.some((r) => FLOW_MUTATING_ROLES.has(r)),
      isAdminRole: roleCandidates.some((r) => FLOW_ADMIN_ROLES.has(r)),
    };
  }
  const uiDenied = Boolean(uiPerms && uiPerms.allowConfigUI === false && uiPerms.allowAll !== true);
  return { uiDenied, isAdminRole: !uiDenied };
}

function renderFlowForbiddenCard(h, { testId, title, description, onBack }) {
  return h('div', {
    'data-testid': testId || 'dxos-flow-forbidden',
    style: {
      padding: 24, maxWidth: 720, margin: '24px auto', borderRadius: 12,
      border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b',
    },
  },
    h('h2', { style: { margin: '0 0 8px', fontSize: 18 } }, title || '403 — Chỉ Quản trị viên mới được truy cập'),
    h('p', { style: { margin: '0 0 12px', fontSize: 13 } }, description || 'Tài khoản hiện tại không có quyền quản trị cấu hình workflow.'),
    h('button', {
      type: 'button',
      'data-testid': `${testId || 'dxos-flow-forbidden'}-back-btn`,
      onClick: onBack,
      style: {
        padding: '7px 14px', borderRadius: 8, border: '1px solid #2563eb',
        background: '#2563eb', color: '#ffffff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
      },
    }, 'Về Không gian việc của tôi'),
  );
}

function parseBuilderScalar(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('{{')) return raw;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return raw;
}

function formatBuilderValue(v, op) {
  if (op === 'exists') return v === false || v === 'false' ? 'false' : 'true';
  if (Array.isArray(v)) return v.map((x) => (x === null ? 'null' : String(x))).join(', ');
  if (v === undefined || v === null) return '';
  return String(v);
}

function compileFilterValue(op, raw) {
  if (op === 'exists') return raw === true || raw === 'true';
  if (op === 'in' || op === 'nin') {
    if (Array.isArray(raw)) return raw;
    const text = String(raw ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try { const p = JSON.parse(text); if (Array.isArray(p)) return p; } catch { /* fallback to split */ }
    }
    return text.split(',').map((s) => parseBuilderScalar(s.trim())).filter((x) => x !== '');
  }
  return parseBuilderScalar(raw);
}

function parseFlatFilterClause(clause) {
  if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return null;
  const keys = Object.keys(clause);
  if (keys.some((k) => ['$and', 'and', 'all', '$or', 'or', 'any', '$not', 'rules'].includes(k))) return null;
  if (typeof clause.field === 'string') {
    if ('op' in clause) {
      const op = String(clause.op || 'eq').trim().replace(/^\$/, '');
      if (!VISUAL_OP_SET.has(op)) return null;
      return [{ field: clause.field, op, value: clause.value ?? '' }];
    }
    const opKeys = keys.filter((k) => k !== 'field' && k !== 'value');
    if (opKeys.length) {
      const rows = [];
      for (const k of opKeys) {
        const norm = k.replace(/^\$/, '');
        if (!VISUAL_OP_SET.has(norm)) return null;
        rows.push({ field: clause.field, op: norm, value: clause[k] ?? '' });
      }
      return rows;
    }
    return [{ field: clause.field, op: 'eq', value: clause.value ?? '' }];
  }
  const rows = [];
  for (const [k, v] of Object.entries(clause)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const subKeys = Object.keys(v);
      if (!subKeys.length) return null;
      for (const sk of subKeys) {
        const norm = sk.replace(/^\$/, '');
        if (!VISUAL_OP_SET.has(norm)) return null;
        rows.push({ field: k, op: norm, value: v[sk] ?? '' });
      }
    } else {
      rows.push({ field: k, op: 'eq', value: v ?? '' });
    }
  }
  return rows;
}

function parseIfConditionToModel(cond) {
  if (cond === null || cond === undefined || cond === '') {
    return { supported: true, combinator: 'and', rows: [{ field: '', op: 'eq', value: '' }] };
  }
  if (typeof cond !== 'object' || Array.isArray(cond)) return { supported: false };
  if ('$not' in cond) return { supported: false };
  const andKey = ['$and', 'and', 'all', 'rules'].find((k) => Array.isArray(cond[k]));
  const orKey = ['$or', 'or', 'any'].find((k) => Array.isArray(cond[k]));
  const extraKeys = Object.keys(cond).filter((k) => k !== andKey && k !== orKey);
  if ((andKey || orKey) && (!extraKeys.length && !(andKey && orKey))) {
    const arr = cond[andKey || orKey];
    const rows = [];
    for (const item of arr) {
      const parsed = parseFlatFilterClause(item);
      if (!parsed) return { supported: false };
      rows.push(...parsed);
    }
    return { supported: true, combinator: orKey ? 'or' : 'and', rows: rows.length ? rows : [{ field: '', op: 'eq', value: '' }] };
  }
  const flat = parseFlatFilterClause(cond);
  if (!flat) return { supported: false };
  return { supported: true, combinator: 'and', rows: flat.length ? flat : [{ field: '', op: 'eq', value: '' }] };
}

function compileIfModelToCondition(combinator, rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({
    field: String(r?.field || ''),
    op: VISUAL_OP_SET.has(String(r?.op || 'eq')) ? String(r.op || 'eq') : 'eq',
    value: compileFilterValue(r?.op || 'eq', r?.value),
  }));
  if (!list.length) return { field: '', op: 'eq', value: '' };
  if (list.length === 1) return list[0];
  return { [combinator === 'or' ? '$or' : '$and']: list };
}

const FALLBACK_CSV_BUF = new Map();
function resolveCsvBuf(csvBuf, scopeKey) {
  const buf = csvBuf instanceof Map ? csvBuf : FALLBACK_CSV_BUF;
  const tag = String(scopeKey || '');
  if (buf.get('__scope__') !== tag) {
    buf.clear();
    buf.set('__scope__', tag);
  }
  return buf;
}
function getCsvDraftValue(buf, key, rawArr, formatFn) {
  const sig = JSON.stringify(Array.isArray(rawArr) ? rawArr : []);
  const entry = buf.get(key);
  if (entry && entry.sig === sig) return entry.text;
  if (entry) buf.delete(key);
  return formatFn();
}
function setCsvDraftValue(buf, key, text, parsedArr) {
  buf.set(key, { text, sig: JSON.stringify(Array.isArray(parsedArr) ? parsedArr : []) });
}
function clearCsvDraftPrefix(buf, prefix) {
  for (const k of [...buf.keys()]) if (String(k).startsWith(prefix)) buf.delete(k);
}

function renderIfBuilder(h, { node, val, updateConfigField, textareaEl, err, S, scopeKey, csvBuf }) {
  const model = parseIfConditionToModel(val);
  const rows = model.supported ? model.rows : [];
  const scope = scopeKey || node?.id || '';
  const buf = resolveCsvBuf(csvBuf, scope);
  const keyPrefix = `${scope}:if:`;
  const commit = (nextComb, nextRows) => updateConfigField('condition', compileIfModelToCondition(nextComb, nextRows));
  const renderVal = (r, i) => {
    if (r.op === 'exists') {
      return h('select', { 'data-testid': `dxos-flow-if-value-${i}`, value: formatBuilderValue(r.value, 'exists'), style: S.input, onChange: (e) => commit(model.combinator, rows.map((x, j) => (j === i ? { ...x, value: e?.target?.value === 'true' } : x))) },
        h('option', { value: 'true' }, 'Có tồn tại (true)'),
        h('option', { value: 'false' }, 'Không tồn tại (false)'));
    }
    const isCsv = r.op === 'in' || r.op === 'nin';
    const csvKey = `${keyPrefix}${i}:val`;
    const normArr = isCsv ? (Array.isArray(r.value) ? r.value : compileFilterValue(r.op, r.value)) : null;
    const inputVal = isCsv ? getCsvDraftValue(buf, csvKey, normArr, () => formatBuilderValue(r.value, r.op)) : formatBuilderValue(r.value, r.op);
    return h('input', {
      'data-testid': `dxos-flow-if-value-${i}`,
      type: 'text',
      placeholder: isCsv ? 'a, b, c' : 'Giá trị hoặc {{biểu_thức}}',
      value: inputVal,
      style: S.input,
      onChange: (e) => {
        const txt = e?.target?.value ?? '';
        if (isCsv) setCsvDraftValue(buf, csvKey, txt, compileFilterValue(r.op, txt));
        commit(model.combinator, rows.map((x, j) => (j === i ? { ...x, value: txt } : x)));
      },
    });
  };

  return h('div', { 'data-testid': 'dxos-flow-if-builder', style: S.grid(6) },
    model.supported ? h('div', { style: S.grid(6) },
      h('select', { 'data-testid': 'dxos-flow-if-combinator', value: model.combinator, style: S.input, onChange: (e) => commit(e?.target?.value === 'or' ? 'or' : 'and', rows) },
        h('option', { value: 'and' }, 'Khớp TẤT CẢ điều kiện (AND)'),
        h('option', { value: 'or' }, 'Khớp BẤT KỲ điều kiện nào (OR)')),
      rows.map((r, i) => h('div', { key: i, 'data-testid': `dxos-flow-if-row-${i}`, style: { ...S.card, padding: 8, gap: 6 } },
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
          h('input', { 'data-testid': `dxos-flow-if-field-${i}`, type: 'text', placeholder: 'Trường (vd: data.amount)', value: String(r.field || ''), style: { ...S.input, flex: 1 }, onChange: (e) => commit(model.combinator, rows.map((x, j) => (j === i ? { ...x, field: e?.target?.value ?? '' } : x))) }),
          h('button', { type: 'button', 'data-testid': `dxos-flow-if-del-${i}`, title: 'Xóa dòng', onClick: () => { clearCsvDraftPrefix(buf, keyPrefix); commit(model.combinator, rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ field: '', op: 'eq', value: '' }]); }, style: S.btn(false, true, false) }, '✕'),
        ),
        h('div', { style: S.grid2 },
          h('select', { 'data-testid': `dxos-flow-if-op-${i}`, value: r.op, style: S.input, onChange: (e) => { clearCsvDraftPrefix(buf, `${keyPrefix}${i}:`); const op = e?.target?.value || 'eq'; commit(model.combinator, rows.map((x, j) => (j === i ? { ...x, op, value: op === 'exists' ? true : x.value } : x))); } },
            VISUAL_FILTER_OPS.map(([k, lbl]) => h('option', { key: k, value: k }, lbl))),
          renderVal(r, i),
        ),
      )),
      h('button', { type: 'button', 'data-testid': 'dxos-flow-if-add', onClick: () => commit(model.combinator, [...rows, { field: '', op: 'eq', value: '' }]), style: S.btn(false, false, false) }, '+ Thêm điều kiện'),
    ) : h('div', { style: { padding: 8, borderRadius: 6, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 11 } }, 'Điều kiện lồng nhau nâng cao — vui lòng chỉnh sửa trực tiếp trong JSON thô bên dưới.'),
    h('details', { 'data-testid': 'dxos-flow-if-json-details', open: !model.supported || Boolean(err) || undefined },
      h('summary', { style: { fontSize: 11, fontWeight: 600, color: '#475569', cursor: 'pointer', marginBottom: 4 } }, '▸ Xem / Sửa JSON thô'),
      textareaEl,
      err ? h('span', { style: S.err(10) }, err) : null,
    ),
  );
}

function renderSwitchBuilder(h, { node, val, updateConfigField, textareaEl, err, S, scopeKey, csvBuf }) {
  const cases = Array.isArray(val) ? val : [];
  const scope = scopeKey || node?.id || '';
  const buf = resolveCsvBuf(csvBuf, scope);
  const keyPrefix = `${scope}:switch:`;
  const commit = (next) => updateConfigField('cases', next);
  const nextPortName = () => {
    const used = new Set(cases.map((c, idx) => String(c?.port || `case_${idx}`)));
    let n = cases.length;
    while (used.has(`case_${n}`)) n += 1;
    return `case_${n}`;
  };
  return h('div', { 'data-testid': 'dxos-flow-switch-builder', style: S.grid(6) },
    cases.map((c, i) => {
      const curOp = String(c?.operator || c?.op || 'eq').replace(/^\$/, '');
      const op = VISUAL_OP_SET.has(curOp) ? curOp : 'eq';
      const curVal = 'equals' in (c || {}) ? c.equals : c?.value;
      const isCsv = op === 'in' || op === 'nin';
      const csvKey = `${keyPrefix}${i}:val`;
      const normArr = isCsv ? (Array.isArray(curVal) ? curVal : compileFilterValue(op, curVal)) : null;
      const inputVal = isCsv ? getCsvDraftValue(buf, csvKey, normArr, () => formatBuilderValue(curVal, op)) : formatBuilderValue(curVal, op);
      return h('div', { key: i, 'data-testid': `dxos-flow-switch-row-${i}`, style: { ...S.card, padding: 8, gap: 6 } },
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
          h('input', { 'data-testid': `dxos-flow-switch-port-${i}`, type: 'text', placeholder: `case_${i}`, value: String(c?.port ?? `case_${i}`), style: { ...S.input, flex: 1 }, onChange: (e) => { const p = String(e?.target?.value ?? '').replace(/[^a-zA-Z0-9_-]/g, ''); commit(cases.map((x, j) => (j === i ? { ...x, port: p || `case_${i}` } : x))); } }),
          h('button', { type: 'button', 'data-testid': `dxos-flow-switch-del-${i}`, onClick: () => { clearCsvDraftPrefix(buf, keyPrefix); commit(cases.filter((_, j) => j !== i)); }, style: S.btn(false, true, false) }, '✕'),
        ),
        c?.condition
          ? h('span', { style: { fontSize: 11, color: '#92400e' } }, 'Nhánh đang dùng condition JSON tùy biến (chỉnh ở JSON thô).')
          : h('div', { style: S.grid2 },
            h('select', { 'data-testid': `dxos-flow-switch-op-${i}`, value: op, style: S.input, onChange: (e) => { clearCsvDraftPrefix(buf, `${keyPrefix}${i}:`); const nOp = e?.target?.value || 'eq'; commit(cases.map((x, j) => (j === i ? { ...x, operator: nOp, equals: nOp === 'exists' ? true : ('equals' in (x || {}) ? x.equals : (x?.value ?? '')) } : x))); } },
              VISUAL_FILTER_OPS.map(([k, lbl]) => h('option', { key: k, value: k }, lbl))),
            op === 'exists'
              ? h('select', { 'data-testid': `dxos-flow-switch-value-${i}`, value: formatBuilderValue(curVal, 'exists'), style: S.input, onChange: (e) => commit(cases.map((x, j) => (j === i ? { ...x, operator: op, equals: e?.target?.value === 'true' } : x))) }, h('option', { value: 'true' }, 'Có tồn tại (true)'), h('option', { value: 'false' }, 'Không tồn tại (false)'))
              : h('input', { 'data-testid': `dxos-flow-switch-value-${i}`, type: 'text', placeholder: isCsv ? 'a, b, c' : 'Giá trị so khớp', value: inputVal, style: S.input, onChange: (e) => { const txt = e?.target?.value ?? ''; const compiled = compileFilterValue(op, txt); if (isCsv) setCsvDraftValue(buf, csvKey, txt, compiled); commit(cases.map((x, j) => (j === i ? { ...x, operator: op, equals: compiled } : x))); } }),
          ),
      );
    }),
    h('button', { type: 'button', 'data-testid': 'dxos-flow-switch-add', onClick: () => commit([...cases, { port: nextPortName(), operator: 'eq', equals: '' }]), style: S.btn(false, false, false) }, '+ Thêm nhánh'),
    h('details', { 'data-testid': 'dxos-flow-switch-json-details', open: Boolean(err) || undefined },
      h('summary', { style: { fontSize: 11, fontWeight: 600, color: '#475569', cursor: 'pointer', marginBottom: 4 } }, '▸ Xem / Sửa JSON thô'),
      textareaEl,
      err ? h('span', { style: S.err(10) }, err) : null,
    ),
  );
}

function defaultTransformRow(opKind, prevTarget = '') {
  const tgt = String(prevTarget || '');
  if (opKind === 'template') return { op: 'template', target: tgt, expr: '' };
  if (opKind === 'math') return { op: 'math', target: tgt, operator: 'add', left: '', right: '' };
  if (opKind === 'concat') return { op: 'concat', target: tgt, parts: [], separator: '' };
  if (opKind === 'rename') return { op: 'rename', from: '', to: tgt };
  if (opKind === 'pick') return { op: 'pick', keys: [], ...(tgt ? { target: tgt } : {}) };
  if (opKind === 'omit') return { op: 'omit', keys: [] };
  return { op: opKind || 'set', target: tgt, value: '' };
}

function renderTransformBuilder(h, { node, val, updateConfigField, textareaEl, err, S, scopeKey, csvBuf }) {
  const ops = Array.isArray(val) ? val : [];
  const scope = scopeKey || node?.id || '';
  const buf = resolveCsvBuf(csvBuf, scope);
  const keyPrefix = `${scope}:tr:`;
  const commit = (next) => updateConfigField('operations', next);
  const patchOp = (i, patch) => commit(ops.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const splitCsv = (txt) => String(txt || '').split(',').map((s) => s.trim()).filter(Boolean);

  return h('div', { 'data-testid': 'dxos-flow-transform-builder', style: S.grid(6) },
    ops.map((row, i) => {
      const kind = String(row?.op || 'set');
      const isSrcMode = row?.source !== undefined && row?.source !== null && row?.value === undefined;
      const partsArr = Array.isArray(row?.parts) ? row.parts : [];
      const keysArr = Array.isArray(row?.keys) ? row.keys : [];
      return h('div', { key: i, 'data-testid': `dxos-flow-transform-row-${i}`, style: { ...S.card, padding: 8, gap: 6 } },
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
          h('select', { 'data-testid': `dxos-flow-transform-op-${i}`, value: kind, style: { ...S.input, flex: 1 }, onChange: (e) => { clearCsvDraftPrefix(buf, `${keyPrefix}${i}:`); commit(ops.map((x, j) => (j === i ? defaultTransformRow(e?.target?.value || 'set', x?.target) : x))); } },
            TRANSFORM_OPS.map(([k, lbl]) => h('option', { key: k, value: k }, lbl))),
          h('button', { type: 'button', 'data-testid': `dxos-flow-transform-del-${i}`, onClick: () => { clearCsvDraftPrefix(buf, keyPrefix); commit(ops.filter((_, j) => j !== i)); }, style: S.btn(false, true, false) }, '✕'),
        ),
        (kind === 'set' || kind === 'coerceNumber' || kind === 'coerceBoolean') ? h('div', { style: S.grid(4) },
          h('input', { 'data-testid': `dxos-flow-transform-target-${i}`, type: 'text', placeholder: 'Trường đích (target)', value: String(row?.target || ''), style: S.input, onChange: (e) => patchOp(i, { target: e?.target?.value ?? '' }) }),
          h('div', { style: S.grid2 },
            h('select', { 'data-testid': `dxos-flow-transform-srcmode-${i}`, value: isSrcMode ? 'source' : 'value', style: S.input, onChange: (e) => { const m = e?.target?.value; commit(ops.map((x, j) => (j === i ? (m === 'source' ? { op: kind, target: x.target || '', source: String(x.value ?? x.source ?? '') } : { op: kind, target: x.target || '', value: x.source ?? x.value ?? '' }) : x))); } },
              h('option', { value: 'value' }, 'Giá trị / {{biểu thức}}'),
              h('option', { value: 'source' }, 'Từ đường dẫn (source)')),
            h('input', { 'data-testid': `dxos-flow-transform-val-${i}`, type: 'text', placeholder: isSrcMode ? 'data.amount' : 'Giá trị hoặc {{...}}', value: String(isSrcMode ? (row?.source ?? '') : (row?.value ?? '')), style: S.input, onChange: (e) => { const raw = e?.target?.value ?? ''; patchOp(i, isSrcMode ? { source: raw, value: undefined } : { value: kind === 'set' ? parseBuilderScalar(raw) : raw, source: undefined }); } }),
          ),
        ) : null,
        kind === 'template' ? h('div', { style: S.grid2 },
          h('input', { 'data-testid': `dxos-flow-transform-target-${i}`, type: 'text', placeholder: 'Trường đích', value: String(row?.target || ''), style: S.input, onChange: (e) => patchOp(i, { target: e?.target?.value ?? '' }) }),
          h('input', { 'data-testid': `dxos-flow-transform-val-${i}`, type: 'text', placeholder: '{{data.code}}-{{data.status}}', value: String(row?.expr ?? row?.template ?? ''), style: S.input, onChange: (e) => patchOp(i, { expr: e?.target?.value ?? '' }) }),
        ) : null,
        kind === 'math' ? h('div', { style: S.grid(4) },
          h('input', { 'data-testid': `dxos-flow-transform-target-${i}`, type: 'text', placeholder: 'Trường đích', value: String(row?.target || ''), style: S.input, onChange: (e) => patchOp(i, { target: e?.target?.value ?? '' }) }),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 78px 1fr', gap: 4 } },
            h('input', { 'data-testid': `dxos-flow-transform-left-${i}`, type: 'text', placeholder: 'Trái (a)', value: String(row?.left ?? ''), style: S.input, onChange: (e) => patchOp(i, { left: parseBuilderScalar(e?.target?.value ?? '') }) }),
            h('select', { 'data-testid': `dxos-flow-transform-mathop-${i}`, value: String(row?.operator || 'add'), style: S.input, onChange: (e) => patchOp(i, { operator: e?.target?.value || 'add' }) },
              [['add', '+'], ['sub', '−'], ['mul', '×'], ['div', '÷']].map(([k, sym]) => h('option', { key: k, value: k }, `${sym} (${k})`))),
            h('input', { 'data-testid': `dxos-flow-transform-right-${i}`, type: 'text', placeholder: 'Phải (b)', value: String(row?.right ?? ''), style: S.input, onChange: (e) => patchOp(i, { right: parseBuilderScalar(e?.target?.value ?? '') }) }),
          ),
        ) : null,
        kind === 'concat' ? h('div', { style: S.grid(4) },
          h('input', { 'data-testid': `dxos-flow-transform-target-${i}`, type: 'text', placeholder: 'Trường đích', value: String(row?.target || ''), style: S.input, onChange: (e) => patchOp(i, { target: e?.target?.value ?? '' }) }),
          h('div', { style: S.grid2 },
            h('input', { 'data-testid': `dxos-flow-transform-parts-${i}`, type: 'text', placeholder: 'part1, part2', value: getCsvDraftValue(buf, `${keyPrefix}${i}:parts`, partsArr, () => partsArr.join(', ')), style: S.input, onChange: (e) => { const txt = e?.target?.value ?? ''; const parsed = splitCsv(txt); setCsvDraftValue(buf, `${keyPrefix}${i}:parts`, txt, parsed); patchOp(i, { parts: parsed }); } }),
            h('input', { 'data-testid': `dxos-flow-transform-sep-${i}`, type: 'text', placeholder: 'Ký tự nối (vd: -)', value: String(row?.separator ?? ''), style: S.input, onChange: (e) => patchOp(i, { separator: e?.target?.value ?? '' }) }),
          ),
        ) : null,
        kind === 'rename' ? h('div', { style: S.grid2 },
          h('input', { 'data-testid': `dxos-flow-transform-from-${i}`, type: 'text', placeholder: 'Từ (from)', value: String(row?.from ?? ''), style: S.input, onChange: (e) => patchOp(i, { from: e?.target?.value ?? '' }) }),
          h('input', { 'data-testid': `dxos-flow-transform-to-${i}`, type: 'text', placeholder: 'Thành (to)', value: String(row?.to ?? ''), style: S.input, onChange: (e) => patchOp(i, { to: e?.target?.value ?? '' }) }),
        ) : null,
        (kind === 'pick' || kind === 'omit') ? h('div', { style: S.grid(4) },
          h('input', { 'data-testid': `dxos-flow-transform-keys-${i}`, type: 'text', placeholder: 'key1, key2', value: getCsvDraftValue(buf, `${keyPrefix}${i}:${kind}:keys`, keysArr, () => keysArr.join(', ')), style: S.input, onChange: (e) => { const txt = e?.target?.value ?? ''; const parsed = splitCsv(txt); setCsvDraftValue(buf, `${keyPrefix}${i}:${kind}:keys`, txt, parsed); patchOp(i, { keys: parsed }); } }),
          kind === 'pick' ? h('input', { 'data-testid': `dxos-flow-transform-target-${i}`, type: 'text', placeholder: 'Đích tùy chọn (để trống = root)', value: String(row?.target || ''), style: S.input, onChange: (e) => patchOp(i, { target: (e?.target?.value || '').trim() || undefined }) }) : null,
        ) : null,
      );
    }),
    h('button', { type: 'button', 'data-testid': 'dxos-flow-transform-add', onClick: () => commit([...ops, { op: 'set', target: '', value: '' }]), style: S.btn(false, false, false) }, '+ Thêm ánh xạ'),
    h('details', { 'data-testid': 'dxos-flow-transform-json-details', open: Boolean(err) || undefined },
      h('summary', { style: { fontSize: 11, fontWeight: 600, color: '#475569', cursor: 'pointer', marginBottom: 4 } }, '▸ Xem / Sửa JSON thô'),
      textareaEl,
      err ? h('span', { style: S.err(10) }, err) : null,
    ),
  );
}

function renderVisualJsonField(h, ctx) {
  const t = ctx?.node?.type;
  const fname = ctx?.field?.name;
  if (t === 'control.if' && fname === 'condition') return renderIfBuilder(h, ctx);
  if (t === 'control.switch' && fname === 'cases') return renderSwitchBuilder(h, ctx);
  if (t === 'logic.transform' && fname === 'operations') return renderTransformBuilder(h, ctx);
  return null;
}

function validateFlowClientExtra(nodes, edges, schemaMap, errors) {
  if (nodes.length > 50) errors.push({ nodeId: nodes[0]?.id || null, severity: 'error', message: 'Quy trình vượt quá giới hạn tối đa 50 nút.' });
  const seen = new Set();
  const nodeMap = new Map();
  const triggers = [];
  for (const n of nodes) {
    if (!n || !n.id) continue;
    if (seen.has(n.id)) errors.push({ nodeId: n.id, severity: 'error', message: `Trùng mã nút "${n.id}".` });
    else { seen.add(n.id); nodeMap.set(n.id, n); }
    if (String(n.type || '').startsWith('trigger.')) triggers.push(n);
    if (schemaMap.size && !schemaMap.has(n.type)) errors.push({ nodeId: n.id, severity: 'error', message: `Loại nút không hợp lệ "${n.type}".` });
    const cfg = n.config && typeof n.config === 'object' ? n.config : {};
    if (n.type === 'control.loop' && cfg.maxIterations !== undefined && cfg.maxIterations !== null) {
      const m = Number(cfg.maxIterations);
      if (!Number.isInteger(m) || m < 1 || m > 100) errors.push({ nodeId: n.id, severity: 'error', message: 'Số lần lặp tối đa của control.loop phải trong khoảng 1..100.' });
    }
    if (n.type === 'control.subflow' && cfg.maxDepth !== undefined && cfg.maxDepth !== null) {
      const d = Number(cfg.maxDepth);
      if (!Number.isInteger(d) || d < 1 || d > 8) errors.push({ nodeId: n.id, severity: 'error', message: 'Độ sâu đệ quy (maxDepth) phải từ 1..8.' });
    }
    if (n.type === 'trigger.schedule' && cfg.cron !== undefined && cfg.cron !== null && String(cfg.cron).trim() !== '') {
      const fields = typeof cfg.cron === 'string' ? cfg.cron.trim().split(/\s+/) : [];
      if (fields.length !== 5 || !fields.every((f) => CRON_FIELD_RE.test(f))) errors.push({ nodeId: n.id, severity: 'error', message: 'Biểu thức cron của trigger.schedule phải gồm 5 trường hợp lệ.' });
    }
  }
  if (triggers.length > 1) {
    triggers.slice(1).forEach((tn) => errors.push({ nodeId: tn.id, severity: 'error', message: 'Chỉ được phép tối đa 1 Trigger node trong một quy trình.' }));
  }
  for (const e of edges) {
    const src = nodeMap.get(e?.source);
    const tgt = nodeMap.get(e?.target);
    if (tgt && String(tgt.type || '').startsWith('trigger.')) {
      errors.push({ nodeId: tgt.id, severity: 'error', message: `Trigger node "${tgt.label || tgt.id}" không thể nhận nhánh đầu vào.` });
    }
    const schema = src ? schemaMap.get(src.type) : null;
    if (src && Array.isArray(schema?.outputs) && e?.sourceHandle) {
      const allowed = src.type === 'control.switch' && Array.isArray(src.config?.cases)
        ? new Set([...src.config.cases.map((c, idx) => String(c?.port || `case_${idx}`).trim()).filter(Boolean), 'default', 'error'])
        : new Set(schema.outputs);
      if (!allowed.has(e.sourceHandle)) errors.push({ nodeId: src.id, severity: 'error', message: `Cổng ra "${e.sourceHandle}" không hợp lệ trên "${src.label || src.id}".` });
    }
  }
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  FLOW_MUTATING_ROLES,
  FLOW_ADMIN_ROLES,
  resolveFlowUiAccess,
  VISUAL_FILTER_OPS,
  TRANSFORM_OPS,
  buildWebhookCurlCommand,
  renderTraceIoView,
  createWebhookHelperComponent,
  renderToolsPicker,
  renderFlowForbiddenCard,
  parseBuilderScalar,
  parseIfConditionToModel,
  compileIfModelToCondition,
  renderVisualJsonField,
  validateFlowClientExtra,
};

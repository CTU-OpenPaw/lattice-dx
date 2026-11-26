/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createDmnVisualEditor, buildInitialSimContext } = require('./dmn-visual-editor');

const GOVERNANCE_SECTIONS = Object.freeze([
  { id: 'api-keys', key: 'api-keys', label: 'PaaS API Keys', title: '1. Khóa API Phạm vi (PaaS PAT)' },
  { id: 'ledger', key: 'ledger', label: 'PKI & Merkle Ledger', title: '2. Sổ cái Mật mã Ed25519 & Merkle' },
  { id: 'data-gov', key: 'data-gov', label: 'Dữ liệu Ấm/Lạnh & MKT', title: '3. Phân tầng Dữ liệu, Reading Room, Cách ly & MKT' },
  { id: 'wms-epod', key: 'wms-epod', label: 'Kho FEFO & ePOD', title: '4. Kho lạnh FEFO, Tạm giữ MKT & Chứng từ ePOD' },
  { id: 'dmn', key: 'dmn', label: 'Bảng Quyết định DMN', title: '5. Bảng Quyết định DMN (FIRST / COLLECT)' },
  { id: 'delegations', key: 'delegations', label: 'Ủy quyền Vai trò', title: '6. Ủy quyền Vai trò Có Phạm vi & Thời hạn' },
]);

const PAT_SCOPES = ['read', 'write', 'wms', 'dmn', 'iot', 'ai', 'ledger'];

const FREEZABLE_COLLECTIONS = [
  'latticeOrders',
  'latticeRequests',
  'latticeAssets',
  'latticeIncidentCases',
  'latticeTelemetryPoints',
  'latticeServiceTickets',
  'latticeParaDocuments',
];

const DEFAULT_DMN_INPUTS = '[{"name":"temperature","type":"number"}]';
const DEFAULT_DMN_OUTPUTS = '[{"name":"action","type":"string"}]';
const DEFAULT_DMN_RULES = '[{"when":{"temperature":{"op":"gt","value":8}},"then":{"action":"hold_mkt"}}]';

function defaultEndsAtIso(nowMs = Date.now()) {
  const dt = new Date(nowMs + 7 * 86_400_000);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function unwrapData(res) {
  return res?.data?.data ?? res?.data ?? {};
}

function extractError(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || fallback;
}

function maskKeyPrefix(prefix) {
  const clean = String(prefix || '').replace(/\.+$/, '').trim();
  return clean ? `${clean}...` : 'ldx_pat_...';
}

function shortHash(hash) {
  const s = String(hash || '');
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : (s || '-');
}

function formatTs(value) {
  if (!value) return '-';
  const s = String(value);
  return s.length > 19 ? s.slice(0, 19).replace('T', ' ') : s;
}

function parseSamplesInput(text) {
  const tokens = String(text || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalidTokens = [];
  const samples = [];
  for (const token of tokens) {
    const num = Number(token);
    if (!Number.isFinite(num)) invalidTokens.push(token);
    else samples.push(num);
  }
  return {
    ok: invalidTokens.length === 0,
    samples,
    invalidTokens,
    error: invalidTokens.length
      ? `Chuỗi mẫu nhiệt độ chứa giá trị không hợp lệ: ${invalidTokens.join(', ')}.`
      : null,
  };
}

function safeJsonParse(rawText, label) {
  try {
    return { ok: true, value: JSON.parse(String(rawText || '')) };
  } catch {
    return { ok: false, error: `${label} không phải JSON hợp lệ.` };
  }
}

function makeStyles() {
  return {
    card: { padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gap: 12 },
    subCard: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 10 },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
    kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 },
    kpiBox: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' },
    label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 },
    input: { width: '100%', padding: '7px 9px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box' },
    textarea: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box' },
    tableWrap: { width: '100%', overflowX: 'auto' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { textAlign: 'left', padding: '7px 8px', borderBottom: '2px solid #e2e8f0', color: '#475569', background: '#f8fafc', whiteSpace: 'nowrap' },
    td: { padding: '7px 8px', borderBottom: '1px solid #f1f5f9', color: '#0f172a', verticalAlign: 'top' },
    badge: (tone = 'neutral') => {
      const palette = {
        ok: { bg: '#dcfce7', color: '#166534', border: '#bbf7d0' },
        warn: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
        danger: { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
        info: { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe' },
        neutral: { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' },
      }[tone] || { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
      return {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: palette.bg,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
      };
    },
    btn: (primary = false, danger = false, disabled = false) => ({
      padding: '7px 12px',
      borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 12,
      fontWeight: 600,
      border: disabled ? '1px solid #cbd5e1' : danger ? '1px solid #dc2626' : primary ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: disabled ? '#e2e8f0' : danger ? '#dc2626' : primary ? '#1677ff' : '#ffffff',
      color: disabled ? '#94a3b8' : (primary || danger) ? '#ffffff' : '#1e293b',
      whiteSpace: 'nowrap',
    }),
  };
}

function renderStatusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['active', 'available', 'sealed', 'approved_release', 'valid'].includes(s)) return 'ok';
  if (['hold_mkt', 'quarantined', 'pending'].includes(s)) return 'warn';
  if (['revoked', 'rejected', 'expired', 'failed'].includes(s)) return 'danger';
  return 'neutral';
}

function renderApiKeysConsole(h, S, state, patchState, actions, employees, busy) {
  const { items, issuedToken, form, loading } = state;
  const setForm = (patch) => patchState((prev) => ({ ...prev, form: { ...prev.form, ...patch } }));
  const toggleScope = (scope, checked) => {
    const cur = new Set(form.scopes || []);
    if (checked) cur.add(scope);
    else cur.delete(scope);
    setForm({ scopes: PAT_SCOPES.filter((s) => cur.has(s)) });
  };

  return h('div', { 'data-testid': 'dxos-governance-console-api-keys', style: S.card },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 16 } }, 'PaaS Scoped API Keys (PAT)'),
      h('button', { type: 'button', onClick: actions.loadApiKeys, disabled: loading, style: S.btn(false, false, loading) }, loading ? 'Đang tải…' : 'Làm mới danh sách'),
    ),

    issuedToken ? h('div', {
      'data-testid': 'dxos-pat-token-once',
      role: 'alert',
      style: { padding: 12, borderRadius: 8, border: '1px solid #f59e0b', background: '#fffbeb', color: '#78350f', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    },
      h('div', { style: { fontSize: 12 } },
        h('strong', null, 'Token PAT chỉ hiển thị một lần duy nhất (không lưu vào bộ nhớ trình duyệt): '),
        h('code', { style: { background: '#fef3c7', padding: '2px 6px', borderRadius: 4, fontWeight: 700 } }, issuedToken),
      ),
      h('button', { type: 'button', onClick: () => patchState((p) => ({ ...p, issuedToken: null })), style: S.btn(false) }, 'Đóng & Xóa khỏi màn hình'),
    ) : null,

    h('form', { 'data-testid': 'dxos-apikey-issue-form', onSubmit: actions.issueApiKey, style: S.subCard },
      h('div', { style: { fontSize: 13, fontWeight: 700, color: '#0f172a' } }, 'Cấp phát Khóa API mới'),
      h('div', { style: S.grid2 },
        h('div', null,
          h('label', { style: S.label }, 'Tên khóa (Name)'),
          h('input', { 'data-testid': 'dxos-apikey-name-input', type: 'text', required: true, value: form.name, placeholder: 'VD: MES Gateway / CI Bot', onChange: (e) => setForm({ name: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Vai trò ràng buộc (roleName)'),
          h('input', { 'data-testid': 'dxos-apikey-role-input', type: 'text', required: true, value: form.roleName, placeholder: 'ldx_operator', onChange: (e) => setForm({ roleName: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Thời hạn (ngày, 1–365)'),
          h('input', { 'data-testid': 'dxos-apikey-days-input', type: 'number', min: 1, max: 365, value: form.expiresInDays, onChange: (e) => setForm({ expiresInDays: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Nhân sự sở hữu (tùy chọn userId)'),
          h('input', {
            'data-testid': 'dxos-apikey-userid-input',
            type: 'text',
            list: 'dxos-gov-emp-users',
            value: form.userId,
            placeholder: 'Để trống = chính bạn',
            onChange: (e) => setForm({ userId: e.target.value }),
            style: S.input,
          }),
          employees.length ? h('datalist', { id: 'dxos-gov-emp-users' },
            employees.filter((emp) => emp.userId).map((emp) => h('option', { key: emp.id, value: String(emp.userId) }, `${emp.name} (${emp.code})`)),
          ) : null,
        ),
      ),
      h('div', null,
        h('span', { style: S.label }, 'Phạm vi quyền (Scopes)'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
          PAT_SCOPES.map((sc) => h('label', { key: sc, style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 } },
            h('input', {
              'data-testid': `dxos-apikey-scope-${sc}`,
              type: 'checkbox',
              checked: (form.scopes || []).includes(sc),
              onChange: (e) => toggleScope(sc, Boolean(e?.target?.checked)),
            }),
            sc,
          )),
        ),
      ),
      h('div', null,
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, busy ? 'Đang cấp phát…' : 'Cấp phát API Key'),
      ),
    ),

    h('div', { style: S.tableWrap },
      h('table', { style: S.table },
        h('thead', null,
          h('tr', null,
            ['Tên khóa', 'Tiền tố (Masked)', 'Vai trò', 'Scopes', 'Hết hạn', 'Dùng lần cuối', 'Trạng thái', 'Thao tác'].map((col) => h('th', { key: col, style: S.th }, col)),
          ),
        ),
        h('tbody', null,
          !items.length
            ? h('tr', null, h('td', { colSpan: 8, style: { ...S.td, color: '#64748b' } }, 'Chưa có PaaS API Key nào trong tổ chức.'))
            : items.map((item) => {
              const scopes = Array.isArray(item.scopes) ? item.scopes : (Array.isArray(item.scopesJson) ? item.scopesJson : []);
              const isActive = item.active !== false && !item.revokedAt;
              return h('tr', { key: item.id || item.keyPrefix },
                h('td', { style: S.td }, item.name),
                h('td', { style: S.td }, h('code', null, maskKeyPrefix(item.keyPrefix))),
                h('td', { style: S.td }, item.roleName || '-'),
                h('td', { style: S.td }, scopes.join(', ') || '-'),
                h('td', { style: S.td }, formatTs(item.expiresAt)),
                h('td', { style: S.td }, formatTs(item.lastUsedAt)),
                h('td', { style: S.td }, h('span', { style: S.badge(isActive ? 'ok' : 'danger') }, isActive ? 'active' : 'revoked')),
                h('td', { style: S.td },
                  isActive
                    ? h('button', { 'data-testid': `dxos-apikey-revoke-${item.id}`, type: 'button', disabled: busy, onClick: () => actions.revokeApiKey(item.id), style: S.btn(false, true, busy) }, 'Thu hồi')
                    : h('span', { style: { fontSize: 11, color: '#94a3b8' } }, 'Đã thu hồi'),
                ),
              );
            }),
        ),
      ),
    ),
  );
}

function renderLedgerConsole(h, S, state, patchState, actions, busy) {
  const { publicKey, status, entries, total, page, eventType, targetCollection, verifyResult, loading } = state;

  return h('div', { 'data-testid': 'dxos-governance-console-ledger', style: S.card },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 16 } }, 'Ed25519 PKI & Merkle Crypto Ledger'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('button', { type: 'button', onClick: () => actions.loadLedger(), disabled: loading, style: S.btn(false, false, loading) }, 'Làm mới Ledger'),
        h('button', { 'data-testid': 'dxos-ledger-verify-btn', type: 'button', onClick: actions.verifyLedger, disabled: busy, style: S.btn(true, false, busy) }, 'Kiểm toán Chuỗi Merkle (Verify Chain)'),
      ),
    ),

    verifyResult ? h('div', {
      'data-testid': 'dxos-ledger-verify-result',
      role: 'status',
      style: {
        padding: 12,
        borderRadius: 8,
        border: `1px solid ${verifyResult.valid ? '#bbf7d0' : '#fecaca'}`,
        background: verifyResult.valid ? '#f0fdf4' : '#fef2f2',
        color: verifyResult.valid ? '#166534' : '#991b1b',
        fontSize: 12,
        wordBreak: 'break-all',
      },
    },
      verifyResult.valid
        ? `TOÀN VẸN HỢP LỆ — Đã kiểm toán ${verifyResult.checkedCount ?? 0} bản ghi · Merkle Root: ${verifyResult.merkleRoot || '-'}`
        : `CẢNH BÁO GIẢ MẠO (TAMPER DETECTED) tại seq #${verifyResult.brokenAtSeq}: ${verifyResult.reason || 'CHAIN_BROKEN'} (đã kiểm ${verifyResult.checkedCount ?? 0} mục).`,
    ) : null,

    h('div', { style: S.kpiGrid },
      [
        ['Key ID (Ed25519)', publicKey?.keyId || status?.keyId || '-'],
        ['Fingerprint SHA-256', publicKey?.fingerprintSha256 || '-'],
        ['Số bản ghi Ledger', status?.entryCount ?? 0],
        ['Seq mới nhất', status?.latestSeq ?? 0],
        ['Merkle Root', status?.merkleRoot || '-'],
        ['Head Hash', status?.headHash || '-'],
      ].map(([k, v]) => h('div', { key: k, style: S.kpiBox },
        h('div', { style: { fontSize: 11, color: '#64748b' } }, k),
        h('div', { style: { fontSize: 12, fontWeight: 700, color: '#0f172a', marginTop: 2, wordBreak: 'break-all', fontFamily: 'monospace' } }, v),
      )),
    ),

    publicKey?.publicKeyPem ? h('details', { style: S.subCard },
      h('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#334155' } }, 'Xem Public Key PEM (Ed25519 SPKI)'),
      h('pre', { style: { margin: '8px 0 0', fontSize: 11, overflowX: 'auto', color: '#0f172a' } }, publicKey.publicKeyPem),
    ) : null,

    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
      h('div', { style: { minWidth: 180 } },
        h('label', { style: S.label }, 'Lọc eventType'),
        h('input', { 'data-testid': 'dxos-ledger-filter-eventtype', type: 'text', value: eventType, placeholder: 'VD: wms.epod_captured', onChange: (e) => patchState((p) => ({ ...p, eventType: e.target.value })), style: S.input }),
      ),
      h('div', { style: { minWidth: 180 } },
        h('label', { style: S.label }, 'Lọc targetCollection'),
        h('input', { 'data-testid': 'dxos-ledger-filter-collection', type: 'text', value: targetCollection, placeholder: 'VD: latticeOrders', onChange: (e) => patchState((p) => ({ ...p, targetCollection: e.target.value })), style: S.input }),
      ),
      h('button', { 'data-testid': 'dxos-ledger-apply-filter-btn', type: 'button', onClick: actions.applyLedgerFilters, style: S.btn(false) }, 'Áp dụng lọc'),
      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' } },
        h('button', { 'data-testid': 'dxos-ledger-prev-page-btn', type: 'button', disabled: loading || page <= 1, onClick: () => actions.changeLedgerPage(Math.max(1, page - 1)), style: S.btn(false, false, loading || page <= 1) }, 'Trang trước'),
        h('span', { style: { fontSize: 12, color: '#64748b' } }, `Tổng ${total} mục · Trang ${page}`),
        h('button', { 'data-testid': 'dxos-ledger-next-page-btn', type: 'button', disabled: loading || page * 20 >= total, onClick: () => actions.changeLedgerPage(page + 1), style: S.btn(false, false, loading || page * 20 >= total) }, 'Trang sau'),
      ),
    ),

    h('div', { style: S.tableWrap },
      h('table', { 'data-testid': 'dxos-ledger-entries-table', style: S.table },
        h('thead', null,
          h('tr', null,
            ['Seq', 'Event Type', 'Collection', 'Record ID', 'Entry Hash', 'Merkle Root', 'Recorded At'].map((c) => h('th', { key: c, style: S.th }, c)),
          ),
        ),
        h('tbody', null,
          !entries.length
            ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có nhật ký mật mã nào.'))
            : entries.map((e) => h('tr', { key: `${e.seq}-${e.entryHash}` },
              h('td', { style: S.td }, `#${e.seq}`),
              h('td', { style: S.td }, e.eventType),
              h('td', { style: S.td }, e.targetCollection),
              h('td', { style: S.td }, e.targetRecordId),
              h('td', { style: S.td }, h('code', null, shortHash(e.entryHash))),
              h('td', { style: S.td }, h('code', null, shortHash(e.merkleRoot))),
              h('td', { style: S.td }, formatTs(e.recordedAt)),
            )),
        ),
      ),
    ),
  );
}

function renderDataGovConsole(h, S, state, patchState, actions, busy) {
  const { tierSummary, snapshots, selectedSnapshot, quarantine, freezeForm, mktForm, mktResult, resolveNote, releaseToTelemetry, loading } = state;
  const setFreeze = (patch) => patchState((p) => ({ ...p, freezeForm: { ...p.freezeForm, ...patch } }));
  const setMkt = (patch) => patchState((p) => ({ ...p, mktForm: { ...p.mktForm, ...patch } }));

  return h('div', { 'data-testid': 'dxos-governance-console-data-gov', style: S.card },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 16 } }, 'Hot–Warm–Cold Tiering, Reading Room, Quarantine & Arrhenius MKT'),
      h('button', { type: 'button', onClick: actions.loadDataGov, disabled: loading, style: S.btn(false, false, loading) }, 'Làm mới dữ liệu'),
    ),

    h('div', { style: S.kpiGrid },
      [
        ['Hot (Orders + Tickets)', (tierSummary?.hotOrders ?? 0) + (tierSummary?.hotTickets ?? 0)],
        ['Warm Orders', tierSummary?.warmOrders ?? 0],
        ['Cold Snapshots', `${tierSummary?.coldSnapshots ?? 0} (${tierSummary?.coldTotalRecords ?? 0} bản ghi)`],
        ['Lineage Edges', tierSummary?.lineageEdges ?? 0],
        ['Quarantine Mở / Xử lý', `${tierSummary?.quarantineOpen ?? 0} / ${tierSummary?.quarantineResolved ?? 0}`],
      ].map(([k, v]) => h('div', { key: k, style: S.kpiBox },
        h('div', { style: { fontSize: 11, color: '#64748b' } }, k),
        h('div', { style: { fontSize: 16, fontWeight: 700, color: '#0f172a', marginTop: 2 } }, v),
      )),
    ),

    h('div', { style: S.grid2 },
      h('form', { 'data-testid': 'dxos-datagov-freeze-form', onSubmit: actions.freezeSnapshot, style: S.subCard },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Đóng băng Snapshot Lạnh'),
        h('div', null,
          h('label', { style: S.label }, 'Collection nguồn'),
          h('select', { value: freezeForm.sourceCollection, onChange: (e) => setFreeze({ sourceCollection: e.target.value }), style: S.input },
            FREEZABLE_COLLECTIONS.map((c) => h('option', { key: c, value: c }, c)),
          ),
        ),
        h('div', { style: S.grid2 },
          h('div', null,
            h('label', { style: S.label }, 'Lưu trữ (ngày)'),
            h('input', { type: 'number', min: 1, max: 36500, value: freezeForm.retentionDays, onChange: (e) => setFreeze({ retentionDays: e.target.value }), style: S.input }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Tier'),
            h('select', { value: freezeForm.tier, onChange: (e) => setFreeze({ tier: e.target.value }), style: S.input },
              h('option', { value: 'cold' }, 'cold'),
              h('option', { value: 'warm' }, 'warm'),
            ),
          ),
        ),
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Đóng băng Snapshot Lạnh'),
      ),

      h('form', { 'data-testid': 'dxos-datagov-mkt-form', onSubmit: actions.computeMkt, style: S.subCard },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Máy tính Arrhenius MKT (Mean Kinetic Temperature)'),
        h('div', null,
          h('label', { style: S.label }, 'Chuỗi mẫu nhiệt độ °C (phân tách dấu phẩy)'),
          h('input', { type: 'text', value: mktForm.samplesC, onChange: (e) => setMkt({ samplesC: e.target.value }), style: S.input }),
        ),
        h('div', { style: S.grid2 },
          h('div', null,
            h('label', { style: S.label }, 'ΔH (kJ/mol)'),
            h('input', { type: 'number', step: '0.001', value: mktForm.deltaH_kJ_mol, onChange: (e) => setMkt({ deltaH_kJ_mol: e.target.value }), style: S.input }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Ngưỡng tối đa °C'),
            h('input', { type: 'number', step: '0.1', value: mktForm.maxAllowedC, onChange: (e) => setMkt({ maxAllowedC: e.target.value }), style: S.input }),
          ),
        ),
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Tính Arrhenius MKT'),
        mktResult ? h('div', {
          'data-testid': 'dxos-datagov-mkt-result',
          style: { padding: 8, borderRadius: 6, background: mktResult.breached ? '#fef2f2' : '#f0fdf4', border: `1px solid ${mktResult.breached ? '#fecaca' : '#bbf7d0'}`, fontSize: 12 },
        },
          `MKT: ${mktResult.mktCelsius}°C · Min/Max/Avg: ${mktResult.minTempCelsius}/${mktResult.maxTempCelsius}/${mktResult.avgTempCelsius}°C · Vượt ngưỡng: ${mktResult.excursionCount}/${mktResult.sampleCount} (${mktResult.breached ? 'VI PHẠM' : 'ĐẠT'})`,
        ) : null,
      ),
    ),

    h('div', { style: S.subCard },
      h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Danh sách Cold Snapshots & Cold Reading Room'),
      h('div', { style: S.tableWrap },
        h('table', { style: S.table },
          h('thead', null, h('tr', null, ['Snapshot UID', 'Collection', 'Tier', 'Records', 'Payload Hash', 'Frozen At', 'Reading Room'].map((c) => h('th', { key: c, style: S.th }, c)))),
          h('tbody', null,
            !snapshots.length
              ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có Cold Snapshot nào.'))
              : snapshots.map((snap) => h('tr', { key: snap.snapshotUid },
                h('td', { style: S.td }, snap.snapshotUid),
                h('td', { style: S.td }, snap.sourceCollection),
                h('td', { style: S.td }, h('span', { style: S.badge('info') }, snap.tier)),
                h('td', { style: S.td }, snap.recordCount),
                h('td', { style: S.td }, h('code', null, shortHash(snap.payloadHash))),
                h('td', { style: S.td }, formatTs(snap.frozenAt)),
                h('td', { style: S.td },
                  h('button', { 'data-testid': `dxos-datagov-inspect-${snap.snapshotUid}`, type: 'button', onClick: () => actions.inspectSnapshot(snap.snapshotUid), style: S.btn(false) }, 'Mở Reading Room'),
                ),
              )),
          ),
        ),
      ),
      selectedSnapshot ? h('div', { 'data-testid': 'dxos-cold-reading-room', style: { padding: 12, borderRadius: 8, border: '1px solid #cbd5e1', background: '#ffffff', display: 'grid', gap: 8 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          h('strong', { style: { fontSize: 13 } }, `Cold Reading Room (Chỉ đọc): ${selectedSnapshot.snapshotUid}`),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: S.badge(selectedSnapshot.hashVerified ? 'ok' : 'danger') }, `SHA-256: ${selectedSnapshot.hashVerified ? 'VERIFIED' : 'MISMATCH'}`),
            h('span', { style: S.badge(selectedSnapshot.signatureVerified === true ? 'ok' : selectedSnapshot.signatureVerified === false ? 'danger' : 'neutral') },
              selectedSnapshot.signatureVerified === true ? 'Ed25519: VERIFIED' : selectedSnapshot.signatureVerified === false ? 'Ed25519: INVALID' : 'Ed25519: N/A',
            ),
          ),
        ),
        h('pre', { 'data-testid': 'dxos-cold-reading-room-json', style: { margin: 0, maxHeight: 220, overflow: 'auto', padding: 8, background: '#f8fafc', borderRadius: 6, fontSize: 11 } },
          JSON.stringify(selectedSnapshot.payloadJson ?? [], null, 2),
        ),
      ) : null,
    ),

    h('div', { style: S.subCard },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Hàng đợi Cách ly Dữ liệu (Quarantine Queue)'),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { type: 'text', value: resolveNote, placeholder: 'Ghi chú xử lý (tùy chọn)', onChange: (e) => patchState((p) => ({ ...p, resolveNote: e.target.value })), style: { ...S.input, width: 210 } }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
            h('input', { type: 'checkbox', checked: Boolean(releaseToTelemetry), onChange: (e) => patchState((p) => ({ ...p, releaseToTelemetry: Boolean(e?.target?.checked) })) }),
            'Đẩy lại Telemetry khi duyệt',
          ),
        ),
      ),
      h('div', { style: S.tableWrap },
        h('table', { style: S.table },
          h('thead', null, h('tr', null, ['UID', 'Nguồn', 'Asset / Metric', 'Giá trị', 'Lý do', 'Trạng thái', 'Xử lý'].map((c) => h('th', { key: c, style: S.th }, c)))),
          h('tbody', null,
            !quarantine.length
              ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Không có bản ghi cách ly.'))
              : quarantine.map((q) => h('tr', { key: q.quarantineUid },
                h('td', { style: S.td }, q.quarantineUid),
                h('td', { style: S.td }, q.sourceSystem),
                h('td', { style: S.td }, `${q.assetEntityId || '-'} · ${q.metricName || '-'}`),
                h('td', { style: S.td }, q.numericValue != null ? `${q.numericValue} ${q.unit || ''}`.trim() : '-'),
                h('td', { style: S.td }, q.reasonCode),
                h('td', { style: S.td }, h('span', { style: S.badge(renderStatusTone(q.status)) }, q.status)),
                h('td', { style: { ...S.td, display: 'flex', gap: 6 } },
                  q.status === 'quarantined' ? [
                    h('button', { key: 'app', 'data-testid': `dxos-quarantine-approve-${q.quarantineUid}`, type: 'button', disabled: busy, onClick: () => actions.resolveQuarantine(q.quarantineUid, 'approved_release'), style: S.btn(true, false, busy) }, 'Approve / Release'),
                    h('button', { key: 'rej', 'data-testid': `dxos-quarantine-reject-${q.quarantineUid}`, type: 'button', disabled: busy, onClick: () => actions.resolveQuarantine(q.quarantineUid, 'rejected'), style: S.btn(false, true, busy) }, 'Reject'),
                  ] : h('span', { style: { fontSize: 11, color: '#64748b' } }, q.resolvedBy || 'Resolved'),
                ),
              )),
          ),
        ),
      ),
    ),
  );
}

function renderWmsEpodConsole(h, S, state, patchState, actions, busy) {
  const { lots, loading, receiveForm, allocForm, allocResult, mktForm, mktHoldResult, voucherForm, voucherPreview } = state;
  const setRec = (patch) => patchState((p) => ({ ...p, receiveForm: { ...p.receiveForm, ...patch } }));
  const setAlloc = (patch) => patchState((p) => ({ ...p, allocForm: { ...p.allocForm, ...patch } }));
  const setMkt = (patch) => patchState((p) => ({ ...p, mktForm: { ...p.mktForm, ...patch } }));
  const setVch = (patch) => patchState((p) => ({ ...p, voucherForm: { ...p.voucherForm, ...patch } }));

  return h('div', { 'data-testid': 'dxos-governance-console-wms-epod', style: S.card },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 16 } }, 'OMS/WMS Cold-Chain FEFO, MKT Hold & Chứng từ ePOD'),
      h('button', { type: 'button', onClick: actions.loadWmsLots, disabled: loading, style: S.btn(false, false, loading) }, 'Làm mới Tồn kho Lô'),
    ),

    h('div', { style: S.tableWrap },
      h('table', { 'data-testid': 'dxos-wms-lots-table', style: S.table },
        h('thead', null, h('tr', null, ['Lot Code', 'SKU', 'Sản phẩm', 'Tồn kho', 'Đang giữ', 'Hạn dùng', 'MKT (°C)', 'Trạng thái'].map((c) => h('th', { key: c, style: S.th }, c)))),
        h('tbody', null,
          !lots.length
            ? h('tr', null, h('td', { colSpan: 8, style: { ...S.td, color: '#64748b' } }, 'Chưa có lô hàng nào trong kho.'))
            : lots.map((lot) => h('tr', { key: lot.id || lot.lotCode },
              h('td', { style: S.td }, lot.lotCode),
              h('td', { style: S.td }, lot.sku),
              h('td', { style: S.td }, lot.productName),
              h('td', { style: S.td }, `${lot.qtyOnHand} ${lot.unit || ''}`.trim()),
              h('td', { style: S.td }, lot.qtyReserved),
              h('td', { style: S.td }, formatTs(lot.expiryDate)),
              h('td', { style: S.td }, lot.mktCelsius != null ? `${lot.mktCelsius}°C` : '-'),
              h('td', { style: S.td }, h('span', { style: S.badge(renderStatusTone(lot.status)) }, lot.status)),
            )),
        ),
      ),
    ),

    h('div', { style: S.grid2 },
      h('form', { 'data-testid': 'dxos-wms-receive-form', onSubmit: actions.receiveStock, style: S.subCard },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Nhập lô kho (Receive Stock)'),
        h('input', { 'data-testid': 'dxos-wms-receive-lotcode', type: 'text', required: true, placeholder: 'lotCode (VD: LOT-001)', value: receiveForm.lotCode, onChange: (e) => setRec({ lotCode: e.target.value }), style: S.input }),
        h('input', { 'data-testid': 'dxos-wms-receive-sku', type: 'text', required: true, placeholder: 'SKU (VD: VAC-01)', value: receiveForm.sku, onChange: (e) => setRec({ sku: e.target.value }), style: S.input }),
        h('input', { 'data-testid': 'dxos-wms-receive-name', type: 'text', required: true, placeholder: 'Tên hàng hóa', value: receiveForm.productName, onChange: (e) => setRec({ productName: e.target.value }), style: S.input }),
        h('div', { style: S.grid2 },
          h('input', { type: 'number', step: '0.01', required: true, placeholder: 'Số lượng', value: receiveForm.qtyOnHand, onChange: (e) => setRec({ qtyOnHand: e.target.value }), style: S.input }),
          h('input', { type: 'date', required: true, value: receiveForm.expiryDate, onChange: (e) => setRec({ expiryDate: e.target.value }), style: S.input }),
        ),
        h('div', { style: S.grid2 },
          h('input', { type: 'number', step: '0.1', placeholder: 'Nhiệt Min °C', value: receiveForm.targetTempMinC, onChange: (e) => setRec({ targetTempMinC: e.target.value }), style: S.input }),
          h('input', { type: 'number', step: '0.1', placeholder: 'Nhiệt Max °C', value: receiveForm.targetTempMaxC, onChange: (e) => setRec({ targetTempMaxC: e.target.value }), style: S.input }),
        ),
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Nhập kho'),
      ),

      h('form', { 'data-testid': 'dxos-wms-fefo-form', onSubmit: actions.allocateFefo, style: S.subCard },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Phân bổ xuất kho FEFO (First Expired, First Out)'),
        h('input', { 'data-testid': 'dxos-wms-fefo-sku', type: 'text', required: true, placeholder: 'Mã SKU cần phân bổ', value: allocForm.sku, onChange: (e) => setAlloc({ sku: e.target.value }), style: S.input }),
        h('div', { style: S.grid2 },
          h('input', { type: 'number', step: '0.01', required: true, placeholder: 'Số lượng', value: allocForm.quantity, onChange: (e) => setAlloc({ quantity: e.target.value }), style: S.input }),
          h('input', { type: 'text', placeholder: 'Mã đơn hàng (orderCode)', value: allocForm.orderCode, onChange: (e) => setAlloc({ orderCode: e.target.value }), style: S.input }),
        ),
        h('div', { style: S.grid2 },
          h('input', { type: 'number', step: '0.1', placeholder: 'Min °C yêu cầu', value: allocForm.minTempC, onChange: (e) => setAlloc({ minTempC: e.target.value }), style: S.input }),
          h('input', { type: 'number', step: '0.1', placeholder: 'Max °C yêu cầu', value: allocForm.maxTempC, onChange: (e) => setAlloc({ maxTempC: e.target.value }), style: S.input }),
        ),
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Phân bổ FEFO'),
        allocResult ? h('div', { style: { fontSize: 12, color: '#166534', background: '#f0fdf4', padding: 8, borderRadius: 6 } },
          `Đã phân bổ: ${allocResult.allocatedTotal} · Thiếu hụt: ${allocResult.shortfall} · Chi tiết: ${(allocResult.allocations || []).map((a) => `${a.lotCode}:${a.qtyAllocated}`).join(', ') || 'không có lô phù hợp'}`,
        ) : null,
      ),

      h('form', { 'data-testid': 'dxos-wms-mkthold-form', onSubmit: actions.holdLotByMkt, style: S.subCard },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Kiểm tra MKT & Tạm giữ Lô (MKT Hold Check)'),
        h('input', { 'data-testid': 'dxos-wms-mkthold-lotcode', type: 'text', required: true, placeholder: 'lotCode cần kiểm tra', value: mktForm.lotCode, onChange: (e) => setMkt({ lotCode: e.target.value }), style: S.input }),
        h('input', { 'data-testid': 'dxos-wms-mkthold-samples', type: 'text', placeholder: 'Mẫu nhiệt °C (VD: 2.5, 4.0, 9.5)', value: mktForm.samplesC, onChange: (e) => setMkt({ samplesC: e.target.value }), style: S.input }),
        h('div', { style: S.grid2 },
          h('input', { type: 'number', step: '0.1', placeholder: 'Ngưỡng tối đa °C', value: mktForm.maxAllowedC, onChange: (e) => setMkt({ maxAllowedC: e.target.value }), style: S.input }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
            h('input', { type: 'checkbox', checked: Boolean(mktForm.forceHold), onChange: (e) => setMkt({ forceHold: Boolean(e?.target?.checked) }) }),
            'Tạm giữ thủ công (forceHold)',
          ),
        ),
        h('button', { type: 'submit', disabled: busy, style: S.btn(false, true, busy) }, 'Kiểm tra & Hold MKT'),
        mktHoldResult ? h('div', { style: { fontSize: 12, padding: 8, borderRadius: 6, background: mktHoldResult.held ? '#fef2f2' : '#f0fdf4', color: mktHoldResult.held ? '#991b1b' : '#166534' } },
          `Lô ${mktHoldResult.lotCode}: MKT=${mktHoldResult.mktCelsius}°C (ngưỡng ${mktHoldResult.thresholdCelsius}°C) -> ${mktHoldResult.lotStatus}`,
        ) : null,
      ),

      h('form', { 'data-testid': 'dxos-wms-voucher-form', onSubmit: actions.previewVoucher, style: S.subCard },
        h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Xem trước Chứng từ In (Sandboxed Preview)'),
        h('select', { value: voucherForm.documentType, onChange: (e) => setVch({ documentType: e.target.value }), style: S.input },
          h('option', { value: 'delivery_note' }, 'Phiếu xuất kho (delivery_note)'),
          h('option', { value: 'order' }, 'Đơn hàng OMS (order)'),
          h('option', { value: 'epod' }, 'Biên bản ePOD (epod)'),
        ),
        h('input', { 'data-testid': 'dxos-wms-voucher-ordercode', type: 'text', placeholder: 'Mã đơn hàng (orderCode)', value: voucherForm.orderCode, onChange: (e) => setVch({ orderCode: e.target.value }), style: S.input }),
        h('input', { type: 'text', placeholder: 'Hoặc mã ePOD (epodUid)', value: voucherForm.epodUid, onChange: (e) => setVch({ epodUid: e.target.value }), style: S.input }),
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Tạo Xem trước Chứng từ'),
      ),
    ),

    voucherPreview ? h('div', { style: S.subCard },
      h('div', { style: { fontSize: 12, color: '#334155', display: 'flex', gap: 12, flexWrap: 'wrap' } },
        h('strong', null, `Chứng từ: ${voucherPreview.documentType}`),
        h('span', null, `HTML SHA-256: ${shortHash(voucherPreview.htmlSha256)}`),
        h('span', null, `QR Hash: ${shortHash(voucherPreview.qrVerificationHash)}`),
        h('span', null, `Ledger Seq: ${voucherPreview.ledgerSeq ?? 'N/A'}`),
      ),
      h('iframe', {
        'data-testid': 'dxos-wms-voucher-iframe',
        sandbox: '',
        title: 'Xem trước Chứng từ DX-OS',
        srcDoc: voucherPreview.html || '',
        style: { width: '100%', minHeight: 340, border: '1px solid #cbd5e1', borderRadius: 8, background: '#ffffff' },
      }),
    ) : null,
  );
}

function renderDmnConsole(h, S, state, patchState, actions, busy, DmnVisualEditor, api, orgId) {
  const { tables, loading, form, simTableKey, simContextText, simResult, loadedTable } = state;
  const setForm = (patch) => patchState((p) => ({ ...p, form: { ...p.form, ...patch } }));
  const selectTable = (tbl) => {
    const nextSimCtx = JSON.stringify(buildInitialSimContext(tbl), null, 2);
    patchState((p) => ({
      ...p,
      loadedTable: { ...tbl },
      simTableKey: tbl.tableKey,
      simContextText: nextSimCtx,
      simResult: null,
      form: {
        tableKey: tbl.tableKey,
        name: tbl.name || tbl.tableKey,
        description: tbl.description || '',
        hitPolicy: tbl.hitPolicy || 'FIRST',
        inputsText: JSON.stringify(tbl.inputsJson || [], null, 2),
        outputsText: JSON.stringify(tbl.outputsJson || [], null, 2),
        rulesText: JSON.stringify(tbl.rulesJson || [], null, 2),
      },
    }));
  };

  const initialVisualTable = (() => {
    const pIn = safeJsonParse(form.inputsText, 'inputs');
    const pOut = safeJsonParse(form.outputsText, 'outputs');
    const pRules = safeJsonParse(form.rulesText, 'rules');
    return {
      tableKey: form.tableKey || 'cold-chain-rule',
      name: form.name || 'Cold Chain Policy',
      description: form.description || '',
      hitPolicy: form.hitPolicy || 'FIRST',
      inputsJson: pIn.ok && Array.isArray(pIn.value) ? pIn.value : [{ name: 'temperature', type: 'number' }],
      outputsJson: pOut.ok && Array.isArray(pOut.value) ? pOut.value : [{ name: 'action', type: 'string' }],
      rulesJson: pRules.ok && Array.isArray(pRules.value) ? pRules.value : [],
    };
  })();

  return h('div', { 'data-testid': 'dxos-governance-console-dmn', style: S.card },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 16 } }, 'Declarative DMN Decision Table Studio'),
      h('button', { type: 'button', onClick: actions.loadDmnTables, disabled: loading, style: S.btn(false, false, loading) }, 'Làm mới Bảng DMN'),
    ),

    h('div', { style: S.tableWrap },
      h('table', { style: S.table },
        h('thead', null, h('tr', null, ['Table Key', 'Tên bảng', 'Hit Policy', 'Phiên bản', 'Số luật', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
        h('tbody', null,
          !tables.length
            ? h('tr', null, h('td', { colSpan: 6, style: { ...S.td, color: '#64748b' } }, 'Chưa có bảng DMN nào.'))
            : tables.map((tbl) => h('tr', { key: tbl.tableKey },
              h('td', { style: S.td }, tbl.tableKey),
              h('td', { style: S.td }, tbl.name),
              h('td', { style: S.td }, h('span', { style: S.badge('info') }, tbl.hitPolicy || 'FIRST')),
              h('td', { style: S.td }, `v${tbl.version || 1}`),
              h('td', { style: S.td }, Array.isArray(tbl.rulesJson) ? tbl.rulesJson.length : 0),
              h('td', { style: S.td }, h('button', { type: 'button', onClick: () => selectTable(tbl), style: S.btn(false) }, 'Nạp vào Editor')),
            )),
        ),
      ),
    ),

    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h('details', { 'data-testid': 'dxos-dmn-raw-json-details', style: S.subCard },
        h('summary', { style: { cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#334155' } }, 'Chỉnh sửa JSON & Mô phỏng nâng cao (Legacy)'),
        h('div', { style: { ...S.grid2, marginTop: 10 } },
          h('form', { 'data-testid': 'dxos-dmn-save-form', onSubmit: actions.saveDmnTable, style: S.subCard },
            h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Soạn thảo & Lưu Bảng DMN (JSON)'),
            h('div', { style: S.grid2 },
              h('div', null,
                h('label', { style: S.label }, 'tableKey'),
                h('input', { type: 'text', required: true, value: form.tableKey, onChange: (e) => setForm({ tableKey: e.target.value }), style: S.input }),
              ),
              h('div', null,
                h('label', { style: S.label }, 'Hit Policy'),
                h('select', { 'data-testid': 'dxos-dmn-hitpolicy-select', value: form.hitPolicy, onChange: (e) => setForm({ hitPolicy: e.target.value }), style: S.input },
                  h('option', { value: 'FIRST' }, 'FIRST'),
                  h('option', { value: 'UNIQUE' }, 'UNIQUE'),
                  h('option', { value: 'COLLECT' }, 'COLLECT'),
                  h('option', { value: 'PRIORITY' }, 'PRIORITY'),
                ),
              ),
            ),
            h('input', { type: 'text', required: true, placeholder: 'Tên bảng quyết định', value: form.name, onChange: (e) => setForm({ name: e.target.value }), style: S.input }),
            h('div', null,
              h('label', { style: S.label }, 'Inputs Schema JSON'),
              h('textarea', { rows: 2, value: form.inputsText, onChange: (e) => setForm({ inputsText: e.target.value }), style: S.textarea }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Outputs Schema JSON'),
              h('textarea', { rows: 2, value: form.outputsText, onChange: (e) => setForm({ outputsText: e.target.value }), style: S.textarea }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Rules JSON'),
              h('textarea', { rows: 5, value: form.rulesText, onChange: (e) => setForm({ rulesText: e.target.value }), style: S.textarea }),
            ),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Lưu Bảng Quyết định'),
          ),

          h('form', { 'data-testid': 'dxos-dmn-eval-form', onSubmit: actions.evaluateDmn, style: S.subCard },
            h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Mô phỏng Luật (Rule Simulator)'),
            h('div', null,
              h('label', { style: S.label }, 'tableKey đánh giá'),
              h('input', { type: 'text', required: true, value: simTableKey, onChange: (e) => patchState((p) => ({ ...p, simTableKey: e.target.value })), style: S.input }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Context đầu vào JSON'),
              h('textarea', { rows: 5, value: simContextText, onChange: (e) => patchState((p) => ({ ...p, simContextText: e.target.value })), style: S.textarea }),
            ),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Chạy Mô phỏng DMN'),
            simResult ? h('div', { 'data-testid': 'dxos-dmn-eval-result', style: { padding: 10, borderRadius: 6, background: '#ffffff', border: '1px solid #cbd5e1', fontSize: 12, display: 'grid', gap: 4 } },
              h('div', null, h('strong', null, `Matched: ${simResult.matched ? 'YES' : 'NO'}`), ` · Hit Policy: ${simResult.hitPolicy} · Matched Rule Index: ${simResult.matchedRuleIndex ?? '-'}`),
              h('pre', { style: { margin: 0, fontSize: 11, overflowX: 'auto' } }, JSON.stringify(simResult.hitPolicy === 'COLLECT' ? simResult.results : (simResult.outputs ?? simResult.result), null, 2)),
            ) : null,
          ),
        ),
      ),

      DmnVisualEditor ? h('div', { style: { order: -1 } },
        h(DmnVisualEditor, {
          initialTable: initialVisualTable,
          table: loadedTable || tables[0] || undefined,
          organizationId: orgId || undefined,
          api,
          busy,
          onChange: (nextTbl) => {
            patchState((p) => ({
              ...p,
              simTableKey: nextTbl.tableKey || p.simTableKey,
              form: {
                tableKey: nextTbl.tableKey || '',
                name: nextTbl.name || '',
                description: nextTbl.description || '',
                hitPolicy: nextTbl.hitPolicy || 'FIRST',
                inputsText: JSON.stringify(nextTbl.inputsJson || [], null, 2),
                outputsText: JSON.stringify(nextTbl.outputsJson || [], null, 2),
                rulesText: JSON.stringify(nextTbl.rulesJson || [], null, 2),
              },
            }));
          },
          onSave: actions.saveVisualDmnTable,
          onEvaluate: actions.evaluateVisualDmn,
        }),
      ) : null,
    ),
  );
}

function renderDelegationsConsole(h, S, state, patchState, actions, employees, busy) {
  const { items, loading, form } = state;
  const setForm = (patch) => patchState((p) => ({ ...p, form: { ...p.form, ...patch } }));

  return h('div', { 'data-testid': 'dxos-governance-console-delegations', style: S.card },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 16 } }, 'Ủy quyền Vai trò Có Phạm vi (Scoped Role Delegations)'),
      h('button', { type: 'button', onClick: actions.loadDelegations, disabled: loading, style: S.btn(false, false, loading) }, 'Làm mới Ủy quyền'),
    ),

    h('form', { 'data-testid': 'dxos-delegation-create-form', onSubmit: actions.createDelegation, style: S.subCard },
      h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Tạo Ủy quyền mới (tối đa 90 ngày, chống leo thang đặc quyền)'),
      h('div', { style: S.grid2 },
        h('div', null,
          h('label', { style: S.label }, 'Người nhận ủy quyền (delegateUserId)'),
          h('input', { 'data-testid': 'dxos-delegation-user-input', type: 'number', min: 1, required: true, list: 'dxos-dlg-emp-users', value: form.delegateUserId, onChange: (e) => setForm({ delegateUserId: e.target.value }), style: S.input }),
          employees.length ? h('datalist', { id: 'dxos-dlg-emp-users' },
            employees.filter((emp) => emp.userId).map((emp) => h('option', { key: emp.id, value: String(emp.userId) }, `${emp.name} (${emp.code})`)),
          ) : null,
        ),
        h('div', null,
          h('label', { style: S.label }, 'Vai trò ủy quyền (roleName)'),
          h('input', { 'data-testid': 'dxos-delegation-role-input', type: 'text', required: true, value: form.roleName, onChange: (e) => setForm({ roleName: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Phạm vi Collection (tùy chọn)'),
          h('input', { type: 'text', value: form.scopeCollection, placeholder: 'VD: latticeOrders', onChange: (e) => setForm({ scopeCollection: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Lý do'),
          h('input', { type: 'text', value: form.reason, placeholder: 'VD: Bàn giao nghỉ phép', onChange: (e) => setForm({ reason: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Bắt đầu (startsAt, tùy chọn)'),
          h('input', { type: 'datetime-local', value: form.startsAt, onChange: (e) => setForm({ startsAt: e.target.value }), style: S.input }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Kết thúc (endsAt)'),
          h('input', { type: 'datetime-local', required: true, value: form.endsAt, onChange: (e) => setForm({ endsAt: e.target.value }), style: S.input }),
        ),
      ),
      h('div', null,
        h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Tạo Ủy quyền'),
      ),
    ),

    h('div', { style: S.tableWrap },
      h('table', { style: S.table },
        h('thead', null, h('tr', null, ['UID', 'Delegate User', 'Vai trò', 'Scope', 'Hiệu lực', 'Trạng thái', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
        h('tbody', null,
          !items.length
            ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có ủy quyền nào.'))
            : items.map((d) => {
              const active = d.status === 'active';
              return h('tr', { key: d.delegationUid || d.id },
                h('td', { style: S.td }, d.delegationUid),
                h('td', { style: S.td }, `User #${d.delegateUserId}`),
                h('td', { style: S.td }, d.roleName),
                h('td', { style: S.td }, d.scopeCollection || 'Tất cả'),
                h('td', { style: S.td }, `${formatTs(d.startsAt)} -> ${formatTs(d.endsAt)}`),
                h('td', { style: S.td }, h('span', { style: S.badge(renderStatusTone(d.status)) }, d.status)),
                h('td', { style: S.td },
                  active
                    ? h('button', { 'data-testid': `dxos-delegation-revoke-${d.delegationUid}`, type: 'button', disabled: busy, onClick: () => actions.revokeDelegation(d), style: S.btn(false, true, busy) }, 'Thu hồi')
                    : h('span', { style: { fontSize: 11, color: '#94a3b8' } }, d.revokedBy || 'Đã thu hồi'),
                ),
              );
            }),
        ),
      ),
    ),
  );
}

function createDxosGovernanceConsoles(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const S = makeStyles();
  const DmnVisualEditor = createDmnVisualEditor(React, _antd);

  return function DxosGovernanceConsoles(props = {}) {
    const hookApi = useApi();
    const api = props.api || hookApi;
    const hasApi = Boolean(api?.request);
    const allEmployees = Array.isArray(props.employees) ? props.employees : [];
    const organizations = Array.isArray(props.organizations) ? props.organizations : [];

    const [internalSection, setInternalSection] = React.useState(props.initialSection || 'api-keys');
    const [orgOverride, setOrgOverride] = React.useState(null);
    const [feedback, setFeedback] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [runtimeRef] = React.useState(() => ({
      api,
      ledgerSeq: 0,
      ledgerPage: 1,
      ledgerEventType: '',
      ledgerTargetCollection: '',
    }));
    runtimeRef.api = api;

    const [apiKeyState, setApiKeyState] = React.useState({
      items: [],
      issuedToken: null,
      loading: false,
      form: { name: '', roleName: 'ldx_operator', scopes: ['read', 'write'], expiresInDays: '30', userId: '' },
    });
    const [ledgerState, setLedgerState] = React.useState({
      publicKey: null,
      status: null,
      entries: [],
      total: 0,
      page: 1,
      eventType: '',
      targetCollection: '',
      appliedEventType: '',
      appliedTargetCollection: '',
      verifyResult: null,
      loading: false,
    });
    const [dataGovState, setDataGovState] = React.useState({
      tierSummary: null,
      snapshots: [],
      selectedSnapshot: null,
      quarantine: [],
      freezeForm: { sourceCollection: 'latticeOrders', retentionDays: '1825', tier: 'cold', coldStorageUri: '' },
      mktForm: { samplesC: '2.1, 4.5, 6.2', deltaH_kJ_mol: '83.14472', maxAllowedC: '8' },
      mktResult: null,
      resolveNote: '',
      releaseToTelemetry: false,
      loading: false,
    });
    const [wmsState, setWmsState] = React.useState({
      lots: [],
      loading: false,
      receiveForm: { lotCode: '', sku: '', productName: '', qtyOnHand: '10', unit: 'BOX', expiryDate: '2027-12-31', targetTempMinC: '2', targetTempMaxC: '8', warehouseCode: '' },
      allocForm: { sku: '', quantity: '5', orderCode: '', lineNo: '1', minTempC: '2', maxTempC: '8' },
      allocResult: null,
      mktForm: { lotCode: '', samplesC: '2.5, 4.0, 9.5', maxAllowedC: '8', forceHold: false, reason: '' },
      mktHoldResult: null,
      voucherForm: { documentType: 'delivery_note', orderCode: '', epodUid: '' },
      voucherPreview: null,
    });
    const [dmnState, setDmnState] = React.useState(() => ({
      tables: [],
      loading: false,
      loadedTable: null,
      form: { tableKey: 'cold-chain-rule', name: 'Cold Chain Policy', description: '', hitPolicy: 'FIRST', inputsText: DEFAULT_DMN_INPUTS, outputsText: DEFAULT_DMN_OUTPUTS, rulesText: DEFAULT_DMN_RULES },
      simTableKey: 'cold-chain-rule',
      simContextText: JSON.stringify(buildInitialSimContext({ inputsJson: JSON.parse(DEFAULT_DMN_INPUTS) }), null, 2),
      simResult: null,
    }));
    const [delegationState, setDelegationState] = React.useState({
      items: [],
      loading: false,
      form: { delegateUserId: '', roleName: 'ldx_operator', scopeCollection: 'latticeOrders', reason: '', startsAt: '', endsAt: defaultEndsAtIso() },
    });

    const activeSection = GOVERNANCE_SECTIONS.some((s) => s.id === props.activeSection)
      ? props.activeSection
      : internalSection;
    React.useEffect(() => {
      setOrgOverride(null);
    }, [props.selectedOrg]);
    const orgInputValue = orgOverride !== null ? orgOverride : String(props.selectedOrg || '');
    const effectiveOrg = String(orgInputValue).trim();
    const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};
    const employees = effectiveOrg
      ? allEmployees.filter((emp) => !emp.organizationId || emp.organizationId === effectiveOrg)
      : allEmployees;

    function selectSection(nextId) {
      setInternalSection(nextId);
      setFeedback(null);
      if (typeof props.onSelectSection === 'function') props.onSelectSection(nextId);
    }

    async function runMutation(fallbackMsg, fn) {
      if (!api?.request || busy) return;
      setBusy(true);
      setFeedback(null);
      try {
        await fn();
      } catch (err) {
        setFeedback({ type: 'error', text: extractError(err, fallbackMsg) });
      } finally {
        setBusy(false);
      }
    }

    const loadApiKeys = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setApiKeyState((p) => ({ ...p, loading: true }));
      try {
        const res = await clientApi.request({ url: 'dxosApiKeys:list', method: 'get', params: { ...orgPayload, limit: 50 }, skipNotify: true });
        const d = unwrapData(res);
        setApiKeyState((p) => ({ ...p, items: Array.isArray(d.items) ? d.items : [], loading: false }));
      } catch (err) {
        setApiKeyState((p) => ({ ...p, loading: false }));
        setFeedback({ type: 'error', text: extractError(err, 'Không tải được danh sách API Key.') });
      }
    }, [hasApi, effectiveOrg]);

    const loadLedger = React.useCallback(async (opts = {}) => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      const reqSeq = ++runtimeRef.ledgerSeq;
      const nextPage = Math.max(1, Number(opts.page ?? runtimeRef.ledgerPage ?? 1));
      const nextEventType = String(opts.eventType ?? runtimeRef.ledgerEventType ?? '').trim();
      const nextTargetCollection = String(opts.targetCollection ?? runtimeRef.ledgerTargetCollection ?? '').trim();
      runtimeRef.ledgerPage = nextPage;
      runtimeRef.ledgerEventType = nextEventType;
      runtimeRef.ledgerTargetCollection = nextTargetCollection;

      setLedgerState((p) => ({
        ...p,
        page: nextPage,
        appliedEventType: nextEventType,
        appliedTargetCollection: nextTargetCollection,
        loading: true,
      }));
      try {
        const [pkRes, stRes, entRes] = await Promise.all([
          clientApi.request({ url: 'dxosLedger:publicKey', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({ url: 'dxosLedger:status', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({
            url: 'dxosLedger:entries',
            method: 'get',
            params: {
              ...orgPayload,
              page: nextPage,
              pageSize: 20,
              ...(nextEventType ? { eventType: nextEventType } : {}),
              ...(nextTargetCollection ? { targetCollection: nextTargetCollection } : {}),
            },
            skipNotify: true,
          }),
        ]);
        if (reqSeq !== runtimeRef.ledgerSeq) return;
        const ent = unwrapData(entRes);
        setLedgerState((p) => ({
          ...p,
          publicKey: unwrapData(pkRes),
          status: unwrapData(stRes),
          entries: Array.isArray(ent.items) ? ent.items : [],
          total: Number(ent.total || 0),
          loading: false,
        }));
      } catch (err) {
        if (reqSeq !== runtimeRef.ledgerSeq) return;
        setLedgerState((p) => ({ ...p, loading: false }));
        setFeedback({ type: 'error', text: extractError(err, 'Không tải được Crypto Ledger.') });
      }
    }, [hasApi, effectiveOrg]);

    const loadDataGov = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setDataGovState((p) => ({ ...p, loading: true }));
      try {
        const [sumRes, snapRes, qRes] = await Promise.all([
          clientApi.request({ url: 'dxosDataGov:tierSummary', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({ url: 'dxosDataGov:listSnapshots', method: 'get', params: { ...orgPayload, page: 1, pageSize: 20 }, skipNotify: true }),
          clientApi.request({ url: 'dxosDataGov:quarantineList', method: 'get', params: { ...orgPayload, page: 1, pageSize: 50 }, skipNotify: true }),
        ]);
        setDataGovState((p) => ({
          ...p,
          tierSummary: unwrapData(sumRes),
          snapshots: Array.isArray(unwrapData(snapRes).items) ? unwrapData(snapRes).items : [],
          quarantine: Array.isArray(unwrapData(qRes).items) ? unwrapData(qRes).items : [],
          loading: false,
        }));
      } catch (err) {
        setDataGovState((p) => ({ ...p, loading: false }));
        setFeedback({ type: 'error', text: extractError(err, 'Không tải được dữ liệu Data Governance.') });
      }
    }, [hasApi, effectiveOrg]);

    const loadWmsLots = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setWmsState((p) => ({ ...p, loading: true }));
      try {
        const res = await clientApi.request({ url: 'dxosWms:lots', method: 'get', params: { ...orgPayload, limit: 100 }, skipNotify: true });
        const d = unwrapData(res);
        setWmsState((p) => ({ ...p, lots: Array.isArray(d.items) ? d.items : [], loading: false }));
      } catch (err) {
        setWmsState((p) => ({ ...p, loading: false }));
        setFeedback({ type: 'error', text: extractError(err, 'Không tải được danh sách lô kho.') });
      }
    }, [hasApi, effectiveOrg]);

    const loadDmnTables = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setDmnState((p) => ({ ...p, loading: true }));
      try {
        const res = await clientApi.request({ url: 'dxosDmn:listTables', method: 'get', params: { ...orgPayload, limit: 100 }, skipNotify: true });
        const d = unwrapData(res);
        setDmnState((p) => ({ ...p, tables: Array.isArray(d.items) ? d.items : [], loading: false }));
      } catch (err) {
        setDmnState((p) => ({ ...p, loading: false }));
        setFeedback({ type: 'error', text: extractError(err, 'Không tải được bảng DMN.') });
      }
    }, [hasApi, effectiveOrg]);

    const loadDelegations = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setDelegationState((p) => ({ ...p, loading: true }));
      try {
        const res = await clientApi.request({ url: 'dxosDelegations:list', method: 'get', params: { ...orgPayload, limit: 100 }, skipNotify: true });
        const d = unwrapData(res);
        setDelegationState((p) => ({ ...p, items: Array.isArray(d.items) ? d.items : [], loading: false }));
      } catch (err) {
        setDelegationState((p) => ({ ...p, loading: false }));
        setFeedback({ type: 'error', text: extractError(err, 'Không tải được danh sách ủy quyền.') });
      }
    }, [hasApi, effectiveOrg]);

    React.useEffect(() => {
      if (activeSection === 'api-keys') loadApiKeys();
      else if (activeSection === 'ledger') loadLedger({ page: 1 });
      else {
        runtimeRef.ledgerSeq += 1;
        if (activeSection === 'data-gov') loadDataGov();
        else if (activeSection === 'wms-epod') loadWmsLots();
        else if (activeSection === 'dmn') loadDmnTables();
        else if (activeSection === 'delegations') loadDelegations();
      }
    }, [activeSection, effectiveOrg, hasApi]);

    const actions = {
      loadApiKeys,
      issueApiKey: (e) => {
        e?.preventDefault?.();
        const f = apiKeyState.form;
        const rawUserId = String(f.userId ?? '').trim();
        let parsedUserId;
        if (rawUserId !== '') {
          parsedUserId = Number(rawUserId);
          if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
            setFeedback({ type: 'error', text: 'userId không hợp lệ: phải là số nguyên dương hoặc để trống.' });
            return;
          }
        }
        const rawExpires = String(f.expiresInDays ?? '').trim();
        return runMutation('Không cấp phát được API Key.', async () => {
          const res = await api.request({
            url: 'dxosApiKeys:issue',
            method: 'post',
            data: {
              ...orgPayload,
              name: String(f.name || '').trim(),
              roleName: String(f.roleName || '').trim(),
              scopes: f.scopes || [],
              ...(rawExpires ? { expiresInDays: Number(rawExpires) } : {}),
              ...(parsedUserId !== undefined ? { userId: parsedUserId } : {}),
            },
          });
          const d = unwrapData(res);
          setApiKeyState((p) => ({ ...p, issuedToken: d.token || null, form: { ...p.form, name: '' } }));
          setFeedback({ type: 'success', text: `Đã cấp phát API Key "${d.name || f.name}".` });
          await loadApiKeys();
        });
      },
      revokeApiKey: (id) => runMutation('Không thu hồi được API Key.', async () => {
        await api.request({ url: 'dxosApiKeys:revoke', method: 'post', data: { id } });
        setFeedback({ type: 'success', text: `Đã thu hồi API Key #${id}.` });
        await loadApiKeys();
      }),

      loadLedger,
      applyLedgerFilters: () => loadLedger({
        page: 1,
        eventType: ledgerState.eventType,
        targetCollection: ledgerState.targetCollection,
      }),
      changeLedgerPage: (nextPage) => loadLedger({
        page: nextPage,
        eventType: runtimeRef.ledgerEventType,
        targetCollection: runtimeRef.ledgerTargetCollection,
      }),
      verifyLedger: () => runMutation('Không kiểm toán được chuỗi Merkle.', async () => {
        const res = await api.request({ url: 'dxosLedger:verify', method: 'post', data: orgPayload });
        const report = unwrapData(res);
        setLedgerState((p) => ({ ...p, verifyResult: report }));
      }),

      loadDataGov,
      freezeSnapshot: (e) => {
        e?.preventDefault?.();
        return runMutation('Không đóng băng được Cold Snapshot.', async () => {
          const f = dataGovState.freezeForm;
          const res = await api.request({
            url: 'dxosDataGov:freezeSnapshot',
            method: 'post',
            data: {
              ...orgPayload,
              sourceCollection: f.sourceCollection,
              tier: f.tier || 'cold',
              retentionDays: Number(f.retentionDays || 1825),
              ...(f.coldStorageUri ? { coldStorageUri: f.coldStorageUri } : {}),
            },
          });
          const d = unwrapData(res);
          setFeedback({ type: 'success', text: `Đã đóng băng snapshot ${d.snapshotUid} (${d.recordCount || 0} bản ghi).` });
          await loadDataGov();
        });
      },
      inspectSnapshot: (snapshotUid) => runMutation('Không đọc được Cold Snapshot.', async () => {
        const res = await api.request({ url: 'dxosDataGov:getSnapshot', method: 'get', params: { ...orgPayload, snapshotUid }, skipNotify: true });
        setDataGovState((p) => ({ ...p, selectedSnapshot: unwrapData(res) }));
      }),
      resolveQuarantine: (quarantineUid, status) => runMutation('Không xử lý được bản ghi cách ly.', async () => {
        await api.request({
          url: 'dxosDataGov:quarantineResolve',
          method: 'post',
          data: {
            ...orgPayload,
            quarantineUid,
            status,
            ...(dataGovState.resolveNote ? { resolutionNote: dataGovState.resolveNote } : {}),
            ...(status === 'approved_release' && dataGovState.releaseToTelemetry ? { releaseToTelemetry: true } : {}),
          },
        });
        setFeedback({ type: 'success', text: `Đã cập nhật bản ghi cách ly ${quarantineUid} -> ${status}.` });
        await loadDataGov();
      }),
      computeMkt: (e) => {
        e?.preventDefault?.();
        const f = dataGovState.mktForm;
        const parsed = parseSamplesInput(f.samplesC);
        if (!parsed.ok) {
          setFeedback({ type: 'error', text: parsed.error });
          return;
        }
        if (!parsed.samples.length) {
          setFeedback({ type: 'error', text: 'Vui lòng nhập ít nhất 1 mẫu nhiệt độ °C hợp lệ.' });
          return;
        }
        return runMutation('Không tính được Arrhenius MKT.', async () => {
          const res = await api.request({
            url: 'dxosDataGov:computeMkt',
            method: 'post',
            data: {
              ...orgPayload,
              samplesC: parsed.samples,
              ...(f.deltaH_kJ_mol ? { deltaH_kJ_mol: Number(f.deltaH_kJ_mol) } : {}),
              ...(f.maxAllowedC !== '' ? { maxAllowedC: Number(f.maxAllowedC) } : {}),
            },
          });
          setDataGovState((p) => ({ ...p, mktResult: unwrapData(res) }));
        });
      },

      loadWmsLots,
      receiveStock: (e) => {
        e?.preventDefault?.();
        return runMutation('Không nhập kho được lô hàng.', async () => {
          const f = wmsState.receiveForm;
          const res = await api.request({
            url: 'dxosWms:receiveStock',
            method: 'post',
            data: {
              ...orgPayload,
              lotCode: f.lotCode,
              sku: f.sku,
              productName: f.productName,
              qtyOnHand: Number(f.qtyOnHand),
              unit: f.unit || 'BOX',
              expiryDate: f.expiryDate,
              ...(f.targetTempMinC !== '' ? { targetTempMinC: Number(f.targetTempMinC) } : {}),
              ...(f.targetTempMaxC !== '' ? { targetTempMaxC: Number(f.targetTempMaxC) } : {}),
              ...(f.warehouseCode ? { warehouseCode: f.warehouseCode } : {}),
            },
          });
          const d = unwrapData(res);
          setFeedback({ type: 'success', text: `Đã nhập lô ${d.lot?.lotCode || f.lotCode}.` });
          await loadWmsLots();
        });
      },
      allocateFefo: (e) => {
        e?.preventDefault?.();
        return runMutation('Không phân bổ FEFO được.', async () => {
          const f = wmsState.allocForm;
          const res = await api.request({
            url: 'dxosWms:allocateFefo',
            method: 'post',
            data: {
              ...orgPayload,
              sku: f.sku,
              quantity: Number(f.quantity),
              ...(f.orderCode ? { orderCode: f.orderCode } : {}),
              ...(f.lineNo ? { lineNo: Number(f.lineNo) } : {}),
              ...(f.minTempC !== '' ? { minTempC: Number(f.minTempC) } : {}),
              ...(f.maxTempC !== '' ? { maxTempC: Number(f.maxTempC) } : {}),
            },
          });
          setWmsState((p) => ({ ...p, allocResult: unwrapData(res) }));
          await loadWmsLots();
        });
      },
      holdLotByMkt: (e) => {
        e?.preventDefault?.();
        const f = wmsState.mktForm;
        const parsed = parseSamplesInput(f.samplesC);
        if (!parsed.ok) {
          setFeedback({ type: 'error', text: parsed.error });
          return;
        }
        return runMutation('Không kiểm tra MKT lô hàng được.', async () => {
          const res = await api.request({
            url: 'dxosWms:holdLotByMkt',
            method: 'post',
            data: {
              ...orgPayload,
              lotCode: f.lotCode,
              ...(parsed.samples.length ? { samplesC: parsed.samples } : {}),
              ...(f.maxAllowedC !== '' ? { maxAllowedC: Number(f.maxAllowedC) } : {}),
              forceHold: Boolean(f.forceHold),
              ...(f.reason ? { reason: f.reason } : {}),
            },
          });
          setWmsState((p) => ({ ...p, mktHoldResult: unwrapData(res) }));
          await loadWmsLots();
        });
      },
      previewVoucher: (e) => {
        e?.preventDefault?.();
        return runMutation('Không tạo được xem trước chứng từ.', async () => {
          const f = wmsState.voucherForm;
          const res = await api.request({
            url: 'dxosWms:printVoucher',
            method: 'get',
            params: {
              ...orgPayload,
              documentType: f.documentType,
              ...(f.orderCode ? { orderCode: f.orderCode } : {}),
              ...(f.epodUid ? { epodUid: f.epodUid } : {}),
            },
            skipNotify: true,
          });
          setWmsState((p) => ({ ...p, voucherPreview: unwrapData(res) }));
        });
      },

      loadDmnTables,
      saveDmnTable: (e) => {
        e?.preventDefault?.();
        const f = dmnState.form;
        const pInputs = safeJsonParse(f.inputsText, 'inputsJson');
        if (!pInputs.ok) { setFeedback({ type: 'error', text: pInputs.error }); return; }
        const pOutputs = safeJsonParse(f.outputsText, 'outputsJson');
        if (!pOutputs.ok) { setFeedback({ type: 'error', text: pOutputs.error }); return; }
        const pRules = safeJsonParse(f.rulesText, 'rulesJson');
        if (!pRules.ok) { setFeedback({ type: 'error', text: pRules.error }); return; }

        return runMutation('Không lưu được bảng quyết định DMN.', async () => {
          const res = await api.request({
            url: 'dxosDmn:saveTable',
            method: 'post',
            data: {
              ...orgPayload,
              tableKey: f.tableKey,
              name: f.name,
              description: f.description,
              hitPolicy: f.hitPolicy,
              inputsJson: pInputs.value,
              outputsJson: pOutputs.value,
              rulesJson: pRules.value,
            },
          });
          const d = unwrapData(res);
          setFeedback({ type: 'success', text: `Đã lưu bảng DMN "${d.table?.tableKey || f.tableKey}" (v${d.table?.version || 1}).` });
          await loadDmnTables();
        });
      },
      evaluateDmn: (e) => {
        e?.preventDefault?.();
        const pCtx = safeJsonParse(dmnState.simContextText, 'context JSON');
        if (!pCtx.ok) { setFeedback({ type: 'error', text: pCtx.error }); return; }
        return runMutation('Không mô phỏng được bảng DMN.', async () => {
          const res = await api.request({
            url: 'dxosDmn:evaluate',
            method: 'post',
            data: {
              ...orgPayload,
              tableKey: dmnState.simTableKey,
              context: pCtx.value,
            },
          });
          setDmnState((p) => ({ ...p, simResult: unwrapData(res) }));
        });
      },
      saveVisualDmnTable: async (payload) => {
        if (!api?.request) return null;
        let saved = null;
        await runMutation('Không lưu được bảng quyết định DMN.', async () => {
          const res = await api.request({
            url: 'dxosDmn:saveTable',
            method: 'post',
            data: { ...orgPayload, ...payload },
          });
          saved = unwrapData(res);
          setFeedback({ type: 'success', text: `Đã lưu bảng DMN "${saved.table?.tableKey || payload.tableKey}" (v${saved.table?.version || 1}).` });
          await loadDmnTables();
        });
        return saved;
      },
      evaluateVisualDmn: async ({ tableKey, context }) => {
        if (!api?.request) return null;
        const res = await api.request({
          url: 'dxosDmn:evaluate',
          method: 'post',
          data: {
            ...orgPayload,
            tableKey: tableKey || dmnState.simTableKey,
            context: context || {},
          },
        });
        const evalOut = unwrapData(res);
        setDmnState((p) => ({ ...p, simResult: evalOut }));
        return evalOut;
      },

      loadDelegations,
      createDelegation: (e) => {
        e?.preventDefault?.();
        return runMutation('Không tạo được ủy quyền vai trò.', async () => {
          const f = delegationState.form;
          const res = await api.request({
            url: 'dxosDelegations:create',
            method: 'post',
            data: {
              ...orgPayload,
              delegateUserId: Number(f.delegateUserId),
              roleName: f.roleName,
              ...(f.scopeCollection ? { scopeCollection: f.scopeCollection } : {}),
              ...(f.reason ? { reason: f.reason } : {}),
              ...(f.startsAt ? { startsAt: f.startsAt } : {}),
              endsAt: f.endsAt,
            },
          });
          const d = unwrapData(res);
          setFeedback({ type: 'success', text: `Đã tạo ủy quyền ${d.delegation?.delegationUid || ''}.` });
          await loadDelegations();
        });
      },
      revokeDelegation: (item) => runMutation('Không thu hồi được ủy quyền.', async () => {
        await api.request({
          url: 'dxosDelegations:revoke',
          method: 'post',
          data: {
            ...orgPayload,
            ...(item.id != null ? { id: item.id } : {}),
            ...(item.delegationUid ? { delegationUid: item.delegationUid } : {}),
          },
        });
        setFeedback({ type: 'success', text: `Đã thu hồi ủy quyền ${item.delegationUid || item.id}.` });
        await loadDelegations();
      }),
    };

    return h('div', { 'data-testid': 'dxos-governance-consoles', style: { display: 'grid', gap: 12 } },
      props.showLocalTabs ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
        GOVERNANCE_SECTIONS.map((sec) => h('button', {
          key: sec.id,
          type: 'button',
          'data-testid': `dxos-gov-subtab-${sec.id}`,
          onClick: () => selectSection(sec.id),
          style: S.btn(activeSection === sec.id),
        }, sec.label)),
      ) : null,

      !props.selectedOrg || organizations.length > 1 ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
        h('span', { style: { fontWeight: 600, color: '#475569' } }, 'Phạm vi Organization ID:'),
        h('input', {
          'data-testid': 'dxos-gov-org-override-input',
          type: 'text',
          value: orgInputValue,
          placeholder: 'VD: org-a (bắt buộc với root)',
          onChange: (e) => setOrgOverride(e.target.value),
          style: { ...S.input, width: 220 },
        }),
      ) : null,

      feedback ? h('div', {
        role: 'status',
        style: {
          padding: 10,
          borderRadius: 8,
          fontSize: 12,
          background: feedback.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${feedback.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: feedback.type === 'error' ? '#991b1b' : '#166534',
        },
      }, feedback.text) : null,

      activeSection === 'api-keys' ? renderApiKeysConsole(h, S, apiKeyState, setApiKeyState, actions, employees, busy) : null,
      activeSection === 'ledger' ? renderLedgerConsole(h, S, ledgerState, setLedgerState, actions, busy) : null,
      activeSection === 'data-gov' ? renderDataGovConsole(h, S, dataGovState, setDataGovState, actions, busy) : null,
      activeSection === 'wms-epod' ? renderWmsEpodConsole(h, S, wmsState, setWmsState, actions, busy) : null,
      activeSection === 'dmn' ? renderDmnConsole(h, S, dmnState, setDmnState, actions, busy, DmnVisualEditor, api, effectiveOrg) : null,
      activeSection === 'delegations' ? renderDelegationsConsole(h, S, delegationState, setDelegationState, actions, employees, busy) : null,
    );
  };
}

module.exports = {
  createDxosGovernanceConsoles,
  GOVERNANCE_SECTIONS,
  defaultEndsAtIso,
  parseSamplesInput,
};

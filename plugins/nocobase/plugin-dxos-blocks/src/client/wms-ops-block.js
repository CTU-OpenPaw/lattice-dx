/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const IMPORT_COLLECTIONS = [
  { label: 'Lô kho lạnh (latticeStockLots)', value: 'latticeStockLots' },
  { label: 'Tài sản & Thiết bị (latticeAssets)', value: 'latticeAssets' },
  { label: 'Đơn Logistics (latticeOrders)', value: 'latticeOrders' },
  { label: 'Yêu cầu mua sắm (latticeRequests)', value: 'latticeRequests' },
];

function parseSamplesList(rawText) {
  const parts = String(rawText || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `Mẫu nhiệt độ không hợp lệ: "${part}".`, samples: [] };
    }
    nums.push(n);
  }
  if (!nums.length) {
    return { ok: false, error: 'Vui lòng nhập ít nhất 1 mẫu nhiệt độ (°C).', samples: [] };
  }
  return { ok: true, error: null, samples: nums };
}

function unwrapPayload(res) {
  return res?.data?.data ?? res?.data ?? res ?? {};
}

function extractErr(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message || err?.message || fallback;
}

function createWmsOpsBlockView(client, React, antd, app, hooks = {}) {
  const subscribeModelConfig = hooks.subscribeModelConfig || (() => () => {});

  return function DxosWmsOpsView({ model, liveConfig }) {
    const h = React.createElement;
    const api = client?.useAPIClient?.() || app?.apiClient;
    const [cfgTick, setCfgTick] = React.useState(0);

    React.useEffect(() => subscribeModelConfig(model, () => setCfgTick((n) => n + 1)), [model]);
    void cfgTick;

    const cfg = liveConfig || model?.props || {};
    const orgId = String(cfg.defaultOrganizationId || '').trim();
    const showBulkImport = cfg.showBulkImport !== false;

    const [activeTab, setActiveTab] = React.useState(cfg.defaultTab === 'import' && showBulkImport ? 'import' : 'fefo');
    const [lots, setLots] = React.useState([]);
    const [loadingLots, setLoadingLots] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [feedback, setFeedback] = React.useState(null);

    const [fefoSku, setFefoSku] = React.useState('');
    const [fefoQty, setFefoQty] = React.useState('10');
    const [fefoOrder, setFefoOrder] = React.useState('');
    const [fefoResult, setFefoResult] = React.useState(null);

    const [issueLot, setIssueLot] = React.useState('');
    const [issueQty, setIssueQty] = React.useState('5');
    const [issueOrder, setIssueOrder] = React.useState('');
    const [issueResult, setIssueResult] = React.useState(null);

    const [mktLot, setMktLot] = React.useState('');
    const [mktSamples, setMktSamples] = React.useState('2.5, 4.0, 9.5');
    const [mktMax, setMktMax] = React.useState('8');
    const [mktResult, setMktResult] = React.useState(null);

    const [importCollection, setImportCollection] = React.useState(cfg.defaultImportCollection || 'latticeStockLots');
    const [importFormat, setImportFormat] = React.useState('csv');
    const [importContent, setImportContent] = React.useState('');
    const [dryRunResult, setDryRunResult] = React.useState(null);
    const [commitResult, setCommitResult] = React.useState(null);

    const loadLots = React.useCallback(async () => {
      if (!api?.request) return;
      setLoadingLots(true);
      try {
        const res = await api.request({
          url: 'dxosWms:lots',
          method: 'get',
          params: { ...(orgId ? { organizationId: orgId } : {}), limit: 50 },
          skipNotify: true,
        });
        const d = unwrapPayload(res);
        setLots(Array.isArray(d.items) ? d.items : []);
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không tải được danh sách lô kho.') });
      } finally {
        setLoadingLots(false);
      }
    }, [api, orgId]);

    React.useEffect(() => {
      loadLots();
    }, [loadLots]);

    const handleAllocateFefo = async (e) => {
      e?.preventDefault?.();
      if (!api?.request || busy) return;
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:allocateFefo',
          method: 'post',
          data: {
            ...(orgId ? { organizationId: orgId } : {}),
            sku: String(fefoSku || '').trim(),
            quantity: Number(fefoQty),
            ...(String(fefoOrder || '').trim() ? { orderCode: String(fefoOrder).trim() } : {}),
          },
        });
        const d = unwrapPayload(res);
        setFefoResult(d);
        setFeedback({ type: 'success', text: `Đã phân bổ FEFO: ${d.allocatedTotal ?? 0}.` });
        await loadLots();
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không phân bổ được FEFO.') });
      } finally {
        setBusy(false);
      }
    };

    const handleIssueStock = async (e) => {
      e?.preventDefault?.();
      if (!api?.request || busy) return;
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:issueStock',
          method: 'post',
          data: {
            ...(orgId ? { organizationId: orgId } : {}),
            lotCode: String(issueLot || '').trim(),
            quantity: Number(issueQty),
            ...(String(issueOrder || '').trim() ? { orderCode: String(issueOrder).trim() } : {}),
          },
        });
        const d = unwrapPayload(res);
        setIssueResult(d);
        setFeedback({ type: 'success', text: `Đã xuất kho ${d.issuedQty ?? issueQty} từ lô ${issueLot}.` });
        await loadLots();
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không xuất kho được.') });
      } finally {
        setBusy(false);
      }
    };

    const handleHoldMkt = async (e) => {
      e?.preventDefault?.();
      if (!api?.request || busy) return;
      const parsed = parseSamplesList(mktSamples);
      if (!parsed.ok) {
        setFeedback({ type: 'error', text: parsed.error });
        return;
      }
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:holdLotByMkt',
          method: 'post',
          data: {
            ...(orgId ? { organizationId: orgId } : {}),
            lotCode: String(mktLot || '').trim(),
            samplesC: parsed.samples,
            maxAllowedC: Number(mktMax || 8),
          },
        });
        const d = unwrapPayload(res);
        setMktResult(d);
        setFeedback({ type: 'success', text: `MKT=${d.mktCelsius ?? '—'}°C -> ${d.lotStatus || (d.held ? 'hold_mkt' : 'ok')}.` });
        await loadLots();
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không kiểm định MKT được.') });
      } finally {
        setBusy(false);
      }
    };

    const handleBulkDryRun = async () => {
      if (!api?.request || busy) return;
      setBusy(true);
      setFeedback(null);
      setCommitResult(null);
      try {
        const res = await api.request({
          url: 'dxosBlocks:bulkImportDryRun',
          method: 'post',
          data: {
            ...(orgId ? { organizationId: orgId } : {}),
            collection: importCollection,
            format: importFormat,
            content: importContent,
          },
        });
        const d = unwrapPayload(res);
        setDryRunResult(d);
        setFeedback({ type: 'success', text: `Dry-Run hoàn tất: ${d.validCount ?? 0} dòng hợp lệ / ${d.totalRows ?? 0}.` });
      } catch (err) {
        setDryRunResult(null);
        setFeedback({ type: 'error', text: extractErr(err, 'Dry-Run nhập lô thất bại.') });
      } finally {
        setBusy(false);
      }
    };

    const handleBulkCommit = async () => {
      if (!api?.request || busy || !dryRunResult?.previewToken) return;
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosBlocks:bulkImportCommit',
          method: 'post',
          data: {
            ...(orgId ? { organizationId: orgId } : {}),
            collection: importCollection,
            format: importFormat,
            content: importContent,
            previewToken: dryRunResult.previewToken,
            payloadSha256: dryRunResult.payloadSha256,
          },
        });
        const d = unwrapPayload(res);
        setDryRunResult(null);
        setCommitResult(d);
        setFeedback({ type: 'success', text: `Đã commit ${d.committedCount ?? 0} bản ghi vào ${d.collection || importCollection}.` });
        await loadLots();
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Commit nhập lô thất bại.') });
      } finally {
        setBusy(false);
      }
    };

    const S = {
      root: { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, display: 'grid', gap: 14 },
      header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
      tabs: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      tabBtn: (active) => ({
        padding: '6px 12px',
        borderRadius: 8,
        border: active ? '1px solid #0284c7' : '1px solid #cbd5e1',
        background: active ? '#0284c7' : '#f8fafc',
        color: active ? '#ffffff' : '#0f172a',
        fontWeight: 600,
        fontSize: 12,
        cursor: 'pointer',
      }),
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 },
      card: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, display: 'grid', gap: 8 },
      input: { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box' },
      btn: (primary = false, disabled = false) => ({
        padding: '6px 12px',
        borderRadius: 6,
        border: primary ? '1px solid #0284c7' : '1px solid #cbd5e1',
        background: disabled ? '#e2e8f0' : primary ? '#0284c7' : '#ffffff',
        color: disabled ? '#94a3b8' : primary ? '#ffffff' : '#0f172a',
        fontWeight: 600,
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }),
    };

    return h(
      'div',
      { 'data-testid': 'dxos-wms-ops-block', style: S.root },
      h('div', { style: S.header },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' } }, cfg.title || 'Vận hành Kho FEFO & Nhập lô hàng loạt [W]'),
          h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Phân bổ FEFO, xuất kho, phong tỏa Arrhenius MKT & Import 2 pha SHA-256'),
        ),
        h('div', { style: S.tabs },
          h('button', {
            type: 'button',
            'data-testid': 'dxos-wms-ops-tab-fefo',
            onClick: () => setActiveTab('fefo'),
            style: S.tabBtn(activeTab === 'fefo'),
          }, 'Kho FEFO & MKT'),
          showBulkImport ? h('button', {
            type: 'button',
            'data-testid': 'dxos-wms-ops-tab-import',
            onClick: () => setActiveTab('import'),
            style: S.tabBtn(activeTab === 'import'),
          }, 'Nhập lô hàng loạt (2-Phase)') : null,
          h('button', {
            type: 'button',
            'data-testid': 'dxos-wms-ops-refresh-btn',
            onClick: loadLots,
            disabled: loadingLots,
            style: S.btn(false, loadingLots),
          }, loadingLots ? 'Đang tải...' : 'Làm mới lô kho'),
        ),
      ),

      feedback ? h('div', {
        'data-testid': 'dxos-wms-ops-feedback',
        role: feedback.type === 'error' ? 'alert' : 'status',
        style: {
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          background: feedback.type === 'error' ? '#fee2e2' : '#dcfce7',
          color: feedback.type === 'error' ? '#991b1b' : '#166534',
        },
      }, feedback.text) : null,

      activeTab === 'fefo' ? h('div', { style: { display: 'grid', gap: 12 } },
        h('div', { style: { overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
            h('thead', null, h('tr', { style: { background: '#f1f5f9', textAlign: 'left' } },
              ['Mã lô', 'SKU', 'Tên hàng', 'Khả dụng', 'MKT (°C)', 'Trạng thái'].map((col) => h('th', { key: col, style: { padding: '6px 8px' } }, col)),
            )),
            h('tbody', null,
              !lots.length
                ? h('tr', null, h('td', { colSpan: 6, style: { padding: 10, color: '#64748b' } }, 'Chưa có lô kho nào.'))
                : lots.map((lot) => h('tr', { key: lot.lotCode || lot.id, style: { borderTop: '1px solid #f1f5f9' } },
                  h('td', { style: { padding: '6px 8px', fontWeight: 600 } }, lot.lotCode),
                  h('td', { style: { padding: '6px 8px' } }, lot.sku),
                  h('td', { style: { padding: '6px 8px' } }, lot.productName || '—'),
                  h('td', { style: { padding: '6px 8px' } }, `${lot.qtyAvailable ?? lot.qtyOnHand ?? 0} ${lot.unit || ''}`),
                  h('td', { style: { padding: '6px 8px' } }, lot.mktCelsius ?? '—'),
                  h('td', { style: { padding: '6px 8px' } }, lot.status || 'available'),
                )),
            ),
          ),
        ),
        h('div', { style: S.grid },
          h('form', { 'data-testid': 'dxos-wms-ops-fefo-form', onSubmit: handleAllocateFefo, style: S.card },
            h('strong', { style: { fontSize: 13 } }, '1. Phân bổ FEFO'),
            h('input', { 'data-testid': 'dxos-wms-ops-fefo-sku', placeholder: 'Mã SKU (VD: VAC-01)', value: fefoSku, onChange: (e) => setFefoSku(e.target.value), style: S.input }),
            h('input', { 'data-testid': 'dxos-wms-ops-fefo-qty', type: 'number', placeholder: 'Số lượng', value: fefoQty, onChange: (e) => setFefoQty(e.target.value), style: S.input }),
            h('input', { 'data-testid': 'dxos-wms-ops-fefo-order', placeholder: 'Mã đơn (tùy chọn)', value: fefoOrder, onChange: (e) => setFefoOrder(e.target.value), style: S.input }),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, busy) }, 'Phân bổ FEFO'),
            fefoResult ? h('div', { 'data-testid': 'dxos-wms-ops-fefo-result', style: { fontSize: 11, color: '#0f172a' } },
              `Đã giữ ${fefoResult.allocatedTotal ?? 0}: ${(fefoResult.allocations || []).map((a) => `${a.lotCode}:${a.qtyAllocated}`).join(', ')}`,
            ) : null,
          ),
          h('form', { 'data-testid': 'dxos-wms-ops-issue-form', onSubmit: handleIssueStock, style: S.card },
            h('strong', { style: { fontSize: 13 } }, '2. Xuất kho thực tế (issueStock)'),
            h('input', { 'data-testid': 'dxos-wms-ops-issue-lot', placeholder: 'Mã lô (lotCode)', value: issueLot, onChange: (e) => setIssueLot(e.target.value), style: S.input }),
            h('input', { 'data-testid': 'dxos-wms-ops-issue-qty', type: 'number', placeholder: 'Số lượng xuất', value: issueQty, onChange: (e) => setIssueQty(e.target.value), style: S.input }),
            h('input', { 'data-testid': 'dxos-wms-ops-issue-order', placeholder: 'Mã đơn (tùy chọn)', value: issueOrder, onChange: (e) => setIssueOrder(e.target.value), style: S.input }),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, busy) }, 'Xuất kho'),
            issueResult ? h('div', { 'data-testid': 'dxos-wms-ops-issue-result', style: { fontSize: 11, color: '#0f172a' } },
              `Đã xuất ${issueResult.issuedQty ?? 0} từ ${issueResult.lot?.lotCode || issueLot}`,
            ) : null,
          ),
          h('form', { 'data-testid': 'dxos-wms-ops-mkt-form', onSubmit: handleHoldMkt, style: S.card },
            h('strong', { style: { fontSize: 13 } }, '3. Phong tỏa Lô theo MKT'),
            h('input', { 'data-testid': 'dxos-wms-ops-mkt-lot', placeholder: 'Mã lô (lotCode)', value: mktLot, onChange: (e) => setMktLot(e.target.value), style: S.input }),
            h('input', { 'data-testid': 'dxos-wms-ops-mkt-samples', placeholder: 'Mẫu °C (VD: 2.5, 14.0)', value: mktSamples, onChange: (e) => setMktSamples(e.target.value), style: S.input }),
            h('input', { 'data-testid': 'dxos-wms-ops-mkt-max', type: 'number', placeholder: 'Ngưỡng tối đa °C', value: mktMax, onChange: (e) => setMktMax(e.target.value), style: S.input }),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, busy) }, 'Kiểm định & Phong tỏa MKT'),
            mktResult ? h('div', { 'data-testid': 'dxos-wms-ops-mkt-result', style: { fontSize: 11, color: '#0f172a' } },
              `Trạng thái: ${mktResult.lotStatus || (mktResult.held ? 'hold_mkt' : 'ok')} (MKT ${mktResult.mktCelsius ?? '—'}°C)`,
            ) : null,
          ),
        ),
      ) : null,

      activeTab === 'import' && showBulkImport ? h('div', { 'data-testid': 'dxos-wms-ops-import-wizard', style: S.card },
        h('strong', { style: { fontSize: 13 } }, 'Wizard Nhập lô hàng loạt 2 pha (Dry-Run SHA-256 -> Commit)'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('select', {
            'data-testid': 'dxos-wms-ops-import-collection',
            value: importCollection,
            onChange: (e) => { setImportCollection(e.target.value); setDryRunResult(null); },
            style: { ...S.input, maxWidth: 260 },
          }, IMPORT_COLLECTIONS.map((c) => h('option', { key: c.value, value: c.value }, c.label))),
          h('select', {
            'data-testid': 'dxos-wms-ops-import-format',
            value: importFormat,
            onChange: (e) => { setImportFormat(e.target.value); setDryRunResult(null); },
            style: { ...S.input, maxWidth: 140 },
          }, h('option', { value: 'csv' }, 'CSV (RFC-4180)'), h('option', { value: 'json' }, 'JSON Array')),
        ),
        h('textarea', {
          'data-testid': 'dxos-wms-ops-import-content',
          rows: 6,
          placeholder: 'Dán nội dung CSV hoặc JSON...',
          value: importContent,
          onChange: (e) => { setImportContent(e.target.value); setDryRunResult(null); },
          style: { ...S.input, fontFamily: 'monospace' },
        }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            'data-testid': 'dxos-wms-ops-import-dryrun-btn',
            disabled: busy,
            onClick: handleBulkDryRun,
            style: S.btn(false, busy),
          }, 'Pha 1: Kiểm thử Dry-Run'),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-wms-ops-import-commit-btn',
            disabled: busy || !dryRunResult?.previewToken,
            onClick: handleBulkCommit,
            style: S.btn(true, busy || !dryRunResult?.previewToken),
          }, 'Pha 2: Xác nhận Commit'),
        ),
        dryRunResult ? h('div', { 'data-testid': 'dxos-wms-ops-import-preview', style: { padding: 10, background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12 } },
          h('div', null, `Tổng: ${dryRunResult.totalRows ?? 0} · Hợp lệ: ${dryRunResult.validCount ?? 0} · Lỗi: ${dryRunResult.invalidCount ?? 0}`),
          h('div', { style: { fontSize: 11, color: '#475569' } }, `SHA-256: ${dryRunResult.payloadSha256 || '—'}`),
        ) : null,
        commitResult ? h('div', { 'data-testid': 'dxos-wms-ops-import-commit-result', style: { padding: 10, background: '#dcfce7', borderRadius: 6, fontSize: 12, color: '#166534' } },
          `Đã nhập thành công ${commitResult.committedCount ?? 0} bản ghi (bỏ qua trùng: ${commitResult.skippedDuplicates ?? 0}).`,
        ) : null,
      ) : null,
    );
  };
}

module.exports = {
  IMPORT_COLLECTIONS,
  parseSamplesList,
  createWmsOpsBlockView,
};

/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  getStatusMeta,
  formatStatusLabel,
  stripDevBracketTags,
  createCompactIdBadge,
} = require('./blocks-helpers');

const IMPORT_COLLECTIONS = [
  { label: 'Lô kho lạnh', value: 'latticeStockLots' },
  { label: 'Tài sản & Thiết bị', value: 'latticeAssets' },
  { label: 'Đơn Logistics', value: 'latticeOrders' },
  { label: 'Yêu cầu mua sắm', value: 'latticeRequests' },
];

const MAX_BULK_IMPORT_BYTES = 2 * 1024 * 1024;

function readWmsModelConfig(model, defaults, liveConfig) {
  const stepCfg = model?.getStepParams?.('dxosBlockSettings', 'config')
    || model?.stepParams?.dxosBlockSettings?.config
    || {};
  return { ...defaults, ...(model?.props || {}), ...stepCfg, ...(liveConfig || {}) };
}

function getUtf8ByteLength(text) {
  const str = String(text || '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(str, 'utf8');
  return str.length;
}

function parseSamplesList(rawText) {
  const parts = String(rawText || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n <= -273.15) {
      return { ok: false, error: `Mẫu nhiệt độ không hợp lệ (> -273.15°C): "${part}".`, samples: [] };
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

    const cfg = readWmsModelConfig(
      model,
      { defaultTab: 'fefo', defaultImportCollection: 'latticeStockLots', showBulkImport: true },
      liveConfig,
    );
    const orgId = String(cfg.defaultOrganizationId || '').trim();
    const currentRole = String(client?.useCurrentUserContext?.()?.data?.currentRole || app?.apiClient?.auth?.role || '').trim();
    const showBulkImport = cfg.showBulkImport !== false;
    const configTab = cfg.defaultTab === 'import' && showBulkImport ? 'import' : 'fefo';
    const configImportCollection = IMPORT_COLLECTIONS.some((c) => c.value === cfg.defaultImportCollection)
      ? cfg.defaultImportCollection
      : 'latticeStockLots';

    const [activeTab, setActiveTab] = React.useState(configTab);
    const [detectedRoot, setDetectedRoot] = React.useState(currentRole === 'root');
    const [availableOrgs, setAvailableOrgs] = React.useState(() => (orgId ? [orgId] : []));
    const [selectedOrg, setSelectedOrg] = React.useState(orgId);
    const [lots, setLots] = React.useState([]);
    const [loadingLots, setLoadingLots] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [feedback, setFeedback] = React.useState(null);

    const isRootUser = detectedRoot || currentRole === 'root';
    const effectiveOrgId = String(isRootUser ? (selectedOrg || orgId) : orgId).trim();

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

    const [importCollection, setImportCollection] = React.useState(configImportCollection);
    const [importFormat, setImportFormat] = React.useState('csv');
    const [importContent, setImportContent] = React.useState('');
    const [dryRunResult, setDryRunResult] = React.useState(null);
    const [commitResult, setCommitResult] = React.useState(null);

    React.useEffect(() => { setActiveTab(configTab); }, [configTab]);
    React.useEffect(() => { setImportCollection(configImportCollection); }, [configImportCollection]);
    React.useEffect(() => {
      if (orgId) {
        setSelectedOrg((prev) => prev || orgId);
        setAvailableOrgs((prev) => (prev.includes(orgId) ? prev : [orgId, ...prev]));
      }
    }, [orgId]);

    const loadLots = React.useCallback(async () => {
      if (!api?.request) return;
      setLoadingLots(true);
      try {
        const res = await api.request({
          url: 'dxosWms:lots',
          method: 'get',
          params: { ...(effectiveOrgId ? { organizationId: effectiveOrgId } : {}), limit: 50 },
          skipNotify: true,
        });
        const d = unwrapPayload(res);
        const loadedLots = Array.isArray(d.items) ? d.items : [];
        setLots(loadedLots);

        const rootDetectedHere = (!effectiveOrgId && d.organizationId === null) || currentRole === 'root';
        if (rootDetectedHere) {
          setDetectedRoot(true);
          const mergedSet = new Set();
          if (orgId) mergedSet.add(orgId);
          for (const l of loadedLots) {
            const oid = String(l?.organizationId || '').trim();
            if (oid) mergedSet.add(oid);
          }
          try {
            const orgRes = await api.request({
              url: 'latticeOrganizations:list',
              method: 'get',
              params: { pageSize: 50, filter: { active: true }, sort: ['id'] },
              skipNotify: true,
            });
            const orgRows = Array.isArray(orgRes?.data?.data) ? orgRes.data.data : [];
            for (const row of orgRows) {
              const oid = String(row?.organizationId || row?.code || row?.id || '').trim();
              if (oid) mergedSet.add(oid);
            }
          } catch {
            // Gracefully ignore 403/404 when latticeOrganizations:list is unavailable
          }
          const merged = [...mergedSet];
          if (merged.length) {
            setAvailableOrgs((prev) => [...new Set([...prev, ...merged])]);
            setSelectedOrg((prev) => prev || orgId || merged[0]);
          }
        }
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không tải được danh sách lô kho.') });
      } finally {
        setLoadingLots(false);
      }
    }, [api, effectiveOrgId, orgId, currentRole]);

    React.useEffect(() => {
      loadLots();
    }, [loadLots]);

    const handleAllocateFefo = async (e) => {
      e?.preventDefault?.();
      if (!api?.request || busy) return;
      const sku = String(fefoSku || '').trim();
      const qty = Number(fefoQty);
      if (!sku) {
        setFeedback({ type: 'error', text: 'Vui lòng nhập hoặc chọn Mã SKU trước khi phân bổ FEFO.' });
        return;
      }
      if (sku.length > 128) {
        setFeedback({ type: 'error', text: 'Mã SKU không được vượt quá 128 ký tự.' });
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        setFeedback({ type: 'error', text: 'Số lượng phân bổ FEFO phải lớn hơn 0.' });
        return;
      }
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:allocateFefo',
          method: 'post',
          data: {
            ...(effectiveOrgId ? { organizationId: effectiveOrgId } : {}),
            sku,
            quantity: qty,
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
      const lotCode = String(issueLot || '').trim();
      const qty = Number(issueQty);
      if (!lotCode) {
        setFeedback({ type: 'error', text: 'Vui lòng nhập hoặc chọn Mã lô hàng trước khi xuất kho.' });
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        setFeedback({ type: 'error', text: 'Số lượng xuất kho phải lớn hơn 0.' });
        return;
      }
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:issueStock',
          method: 'post',
          data: {
            ...(effectiveOrgId ? { organizationId: effectiveOrgId } : {}),
            lotCode,
            quantity: qty,
            ...(String(issueOrder || '').trim() ? { orderCode: String(issueOrder).trim() } : {}),
          },
        });
        const d = unwrapPayload(res);
        setIssueResult(d);
        setFeedback({ type: 'success', text: `Đã xuất kho ${d.issuedQty ?? qty} từ lô ${lotCode}.` });
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
      const lotCode = String(mktLot || '').trim();
      if (!lotCode) {
        setFeedback({ type: 'error', text: 'Vui lòng nhập hoặc chọn Mã lô hàng trước khi kiểm định MKT.' });
        return;
      }
      const parsed = parseSamplesList(mktSamples);
      if (!parsed.ok) {
        setFeedback({ type: 'error', text: parsed.error });
        return;
      }
      const rawMax = String(mktMax ?? '').trim();
      const maxC = rawMax === '' ? 8 : Number(rawMax);
      if (!Number.isFinite(maxC) || maxC <= -273.15) {
        setFeedback({ type: 'error', text: 'Ngưỡng nhiệt tối đa (°C) phải là số hợp lệ lớn hơn -273.15°C.' });
        return;
      }
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:holdLotByMkt',
          method: 'post',
          data: {
            ...(effectiveOrgId ? { organizationId: effectiveOrgId } : {}),
            lotCode,
            samplesC: parsed.samples,
            maxAllowedC: maxC,
          },
        });
        const d = unwrapPayload(res);
        setMktResult(d);
        const mktStatusLabel = formatStatusLabel(d.lotStatus || (d.held ? 'hold_mkt' : 'ok'));
        setFeedback({ type: 'success', text: `MKT=${d.mktCelsius ?? '—'}°C → ${mktStatusLabel}.` });
        await loadLots();
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không kiểm định MKT được.') });
      } finally {
        setBusy(false);
      }
    };

    const handleReleaseLot = async (lot) => {
      if (!api?.request || busy || !lot) return;
      const targetOrgId = effectiveOrgId || String(lot.organizationId || '').trim();
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosWms:releaseLotByQa',
          method: 'post',
          data: {
            ...(lot.id != null ? { lotId: lot.id } : {}),
            ...(lot.lotCode ? { lotCode: lot.lotCode } : {}),
            ...(targetOrgId ? { organizationId: targetOrgId } : {}),
            releaseReason: 'QA kiểm định đạt chuẩn — mở khóa từ WMS Ops',
          },
        });
        const d = unwrapPayload(res);
        setFeedback({
          type: 'success',
          text: d.message || `Đã mở khóa QA lô ${lot.lotCode || lot.id}.`,
        });
        await loadLots();
      } catch (err) {
        setFeedback({ type: 'error', text: extractErr(err, 'Không mở khóa QA được cho lô hàng.') });
      } finally {
        setBusy(false);
      }
    };

    const handleBulkDryRun = async () => {
      if (!api?.request || busy) return;
      const rawContent = String(importContent || '');
      if (!rawContent.trim()) {
        setFeedback({ type: 'error', text: 'Vui lòng nhập nội dung CSV hoặc JSON trước khi kiểm thử Dry-Run.' });
        return;
      }
      if (getUtf8ByteLength(rawContent) > MAX_BULK_IMPORT_BYTES) {
        setFeedback({ type: 'error', text: 'Nội dung nhập lô vượt quá giới hạn tối đa 2 MiB.' });
        return;
      }
      setBusy(true);
      setFeedback(null);
      setCommitResult(null);
      try {
        const res = await api.request({
          url: 'dxosBlocks:bulkImportDryRun',
          method: 'post',
          data: {
            ...(effectiveOrgId ? { organizationId: effectiveOrgId } : {}),
            collection: importCollection,
            format: importFormat,
            content: rawContent,
          },
        });
        const d = unwrapPayload(res);
        setDryRunResult(d);
        setFeedback({
          type: Number(d.invalidCount) > 0 && !(Number(d.validCount) > 0) ? 'error' : 'success',
          text: `Dry-Run hoàn tất: ${d.validCount ?? 0} dòng hợp lệ / ${d.totalRows ?? 0} (lỗi: ${d.invalidCount ?? 0}).`,
        });
      } catch (err) {
        setDryRunResult(null);
        setFeedback({ type: 'error', text: extractErr(err, 'Dry-Run nhập lô thất bại.') });
      } finally {
        setBusy(false);
      }
    };

    const handleBulkCommit = async () => {
      if (!api?.request || busy || !dryRunResult?.previewToken || !(Number(dryRunResult?.validCount) > 0)) return;
      setBusy(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosBlocks:bulkImportCommit',
          method: 'post',
          data: {
            ...(effectiveOrgId ? { organizationId: effectiveOrgId } : {}),
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
      root: { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, paddingBottom: 56, display: 'grid', gap: 14, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' },
      header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 },
      tabs: { display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0 },
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
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12, minWidth: 0 },
      card: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, display: 'grid', gap: 8, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' },
      fieldLabel: { display: 'grid', gap: 4, fontSize: 11, fontWeight: 600, color: '#475569', minWidth: 0 },
      input: { width: '100%', minWidth: 0, maxWidth: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: '#ffffff', color: '#0f172a' },
      btn: (primary = false, disabled = false) => ({
        padding: '6px 12px',
        borderRadius: 6,
        border: primary ? '1px solid #0284c7' : '1px solid #cbd5e1',
        background: disabled ? '#e2e8f0' : primary ? '#0284c7' : '#ffffff',
        color: disabled ? '#94a3b8' : primary ? '#ffffff' : '#0f172a',
        fontWeight: 600,
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }),
    };

    const uniqueSkus = React.useMemo(
      () => [...new Set(lots.map((l) => String(l?.sku || '').trim()).filter(Boolean))],
      [lots],
    );
    const applySelectedLot = (lot) => {
      if (!lot) return;
      if (isRootUser && lot.organizationId && !selectedOrg) {
        setSelectedOrg(String(lot.organizationId));
      }
      if (lot.sku) setFefoSku(String(lot.sku));
      if (lot.lotCode) {
        setIssueLot(String(lot.lotCode));
        setMktLot(String(lot.lotCode));
      }
    };
    const commitDisabled = busy || !dryRunResult?.previewToken || !(Number(dryRunResult?.validCount) > 0);
    const dryRunErrors = Array.isArray(dryRunResult?.errors) ? dryRunResult.errors : [];

    return h(
      'div',
      { 'data-testid': 'dxos-wms-ops-block', style: S.root },
      h('div', { style: S.header },
        h('div', { style: { minWidth: 0 } },
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' } }, stripDevBracketTags(cfg.title || 'Vận hành Kho FEFO & Nhập lô hàng loạt')),
          h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Phân bổ FEFO, xuất kho, phong tỏa Arrhenius MKT & Nhập lô kiểm tra toàn vẹn'),
        ),
        h('div', { style: S.tabs },
          isRootUser ? h('select', {
            'data-testid': 'dxos-wms-org-select',
            'aria-label': 'Chọn tổ chức WMS',
            value: effectiveOrgId,
            onChange: (e) => setSelectedOrg(String(e?.target?.value || '').trim()),
            style: { ...S.input, width: 'auto', minWidth: 140, maxWidth: '100%' },
          },
            availableOrgs.length
              ? availableOrgs.map((oid) => h('option', { key: oid, value: oid }, oid))
              : h('option', { value: '' }, '-- Chọn tổ chức --'),
          ) : null,
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
          }, 'Nhập lô hàng loạt (2 pha)') : null,
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

      activeTab === 'fefo' ? h('div', { style: { display: 'grid', gap: 12, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' } },
        h('datalist', { id: 'dxos-wms-sku-datalist', 'data-testid': 'dxos-wms-sku-datalist' },
          uniqueSkus.map((sku) => h('option', { key: sku, value: sku }, sku)),
        ),
        h('datalist', { id: 'dxos-wms-lot-datalist', 'data-testid': 'dxos-wms-lot-datalist' },
          lots.filter((l) => l?.lotCode).map((l) => h('option', {
            key: l.lotCode,
            value: l.lotCode,
          }, `${l.lotCode} — ${l.sku || ''} (${l.qtyAvailable ?? l.qtyOnHand ?? 0})`)),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, minWidth: 0 } },
          h('strong', { style: { color: '#334155' } }, 'Chọn nhanh từ lô đang tải:'),
          h('select', {
            'data-testid': 'dxos-wms-lot-quickselect',
            'aria-label': 'Chọn nhanh lô kho để điền biểu mẫu',
            defaultValue: '',
            onChange: (e) => {
              const code = String(e?.target?.value || '').trim();
              const matched = lots.find((l) => l.lotCode === code);
              if (matched) applySelectedLot(matched);
            },
            style: { ...S.input, maxWidth: 'min(340px, 100%)' },
          },
            h('option', { value: '' }, '-- Chọn nhanh Mã lô / SKU --'),
            lots.filter((l) => l?.lotCode).map((l) => h('option', { key: l.lotCode, value: l.lotCode }, `${l.lotCode} · ${l.sku || '—'} (Khả dụng: ${l.qtyAvailable ?? l.qtyOnHand ?? 0})`)),
          ),
        ),
        h('div', { style: { overflowX: 'auto', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', border: '1px solid #e2e8f0', borderRadius: 8 } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
            h('thead', null, h('tr', { style: { background: '#f1f5f9', textAlign: 'left' } },
              ['Mã lô', 'SKU', 'Tên hàng', 'Khả dụng', 'MKT (°C)', 'Trạng thái', 'Thao tác'].map((col) => h('th', { key: col, style: { padding: '6px 8px' } }, col)),
            )),
            h('tbody', null,
              !lots.length
                ? h('tr', null, h('td', { colSpan: 7, style: { padding: 10, color: '#64748b' } }, 'Chưa có lô kho nào.'))
                : lots.map((lot) => {
                  const lotStatus = String(lot.status || 'available').trim().toLowerCase();
                  const lotStatusMeta = getStatusMeta(lotStatus);
                  const isHeldLot = lotStatus === 'hold_mkt' || lotStatus === 'quarantined';
                  return h('tr', { key: lot.lotCode || lot.id, style: { borderTop: '1px solid #f1f5f9' } },
                    h('td', { style: { padding: '6px 8px', fontWeight: 600 } }, lot.lotCode),
                    h('td', { style: { padding: '6px 8px' } }, lot.sku),
                    h('td', { style: { padding: '6px 8px' } }, lot.productName || '—'),
                    h('td', { style: { padding: '6px 8px' } }, `${lot.qtyAvailable ?? lot.qtyOnHand ?? 0} ${lot.unit || ''}`),
                    h('td', { style: { padding: '6px 8px' } }, lot.mktCelsius ?? '—'),
                    h('td', { style: { padding: '6px 8px' } }, h('span', {
                      'data-testid': `dxos-wms-lot-status-${lot.lotCode || lot.id}`,
                      style: {
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background: lotStatusMeta.bg,
                        color: lotStatusMeta.color,
                        border: `1px solid ${lotStatusMeta.border}`,
                        whiteSpace: 'nowrap',
                      },
                    }, lotStatusMeta.label)),
                    h('td', { style: { padding: '6px 8px' } }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
                      h('button', {
                        type: 'button',
                        'data-testid': `dxos-wms-select-lot-${lot.lotCode || lot.id}`,
                        onClick: () => applySelectedLot(lot),
                        style: { ...S.btn(false, false), padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' },
                      }, 'Chọn'),
                      isHeldLot ? h('button', {
                        type: 'button',
                        'data-testid': `dxos-wms-release-lot-${lot.lotCode || lot.id}`,
                        disabled: busy,
                        onClick: () => handleReleaseLot(lot),
                        style: {
                          ...S.btn(false, busy),
                          padding: '3px 8px',
                          fontSize: 11,
                          whiteSpace: 'nowrap',
                          borderColor: '#059669',
                          color: busy ? '#94a3b8' : '#059669',
                        },
                      }, 'Mở khóa QA') : null,
                    )),
                  );
                }),
            ),
          ),
        ),
        h('div', { style: S.grid },
          h('form', { 'data-testid': 'dxos-wms-ops-fefo-form', onSubmit: handleAllocateFefo, style: S.card },
            h('strong', { style: { fontSize: 13 } }, '1. Phân bổ FEFO'),
            h('label', { style: S.fieldLabel },
              'Mã SKU',
              h('input', { 'data-testid': 'dxos-wms-ops-fefo-sku', list: 'dxos-wms-sku-datalist', placeholder: 'VD: VAC-01', value: fefoSku, onChange: (e) => setFefoSku(e.target.value), style: S.input }),
            ),
            h('label', { style: S.fieldLabel },
              'Số lượng phân bổ',
              h('input', { 'data-testid': 'dxos-wms-ops-fefo-qty', type: 'number', min: 1, placeholder: 'Nhập số lượng', value: fefoQty, onChange: (e) => setFefoQty(e.target.value), style: S.input }),
            ),
            h('label', { style: S.fieldLabel },
              'Mã đơn hàng (tùy chọn)',
              h('input', { 'data-testid': 'dxos-wms-ops-fefo-order', placeholder: 'VD: ORD-001', value: fefoOrder, onChange: (e) => setFefoOrder(e.target.value), style: S.input }),
            ),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, busy) }, 'Phân bổ FEFO'),
            fefoResult ? h('div', { 'data-testid': 'dxos-wms-ops-fefo-result', style: { fontSize: 11, color: '#0f172a' } },
              `Đã giữ ${fefoResult.allocatedTotal ?? 0}: ${(fefoResult.allocations || []).map((a) => `${a.lotCode}:${a.qtyAllocated}`).join(', ')}`,
            ) : null,
          ),
          h('form', { 'data-testid': 'dxos-wms-ops-issue-form', onSubmit: handleIssueStock, style: S.card },
            h('strong', { style: { fontSize: 13 } }, '2. Xuất kho thực tế (FEFO)'),
            h('label', { style: S.fieldLabel },
              'Mã lô hàng',
              h('input', { 'data-testid': 'dxos-wms-ops-issue-lot', list: 'dxos-wms-lot-datalist', placeholder: 'VD: LOT-CT-01', value: issueLot, onChange: (e) => setIssueLot(e.target.value), style: S.input }),
            ),
            h('label', { style: S.fieldLabel },
              'Số lượng xuất kho',
              h('input', { 'data-testid': 'dxos-wms-ops-issue-qty', type: 'number', min: 1, placeholder: 'Nhập số lượng xuất', value: issueQty, onChange: (e) => setIssueQty(e.target.value), style: S.input }),
            ),
            h('label', { style: S.fieldLabel },
              'Mã đơn hàng (tùy chọn)',
              h('input', { 'data-testid': 'dxos-wms-ops-issue-order', placeholder: 'VD: ORD-001', value: issueOrder, onChange: (e) => setIssueOrder(e.target.value), style: S.input }),
            ),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, busy) }, 'Xuất kho'),
            issueResult ? h('div', { 'data-testid': 'dxos-wms-ops-issue-result', style: { fontSize: 11, color: '#0f172a' } },
              `Đã xuất ${issueResult.issuedQty ?? 0} từ ${issueResult.lot?.lotCode || issueLot}`,
            ) : null,
          ),
          h('form', { 'data-testid': 'dxos-wms-ops-mkt-form', onSubmit: handleHoldMkt, style: S.card },
            h('strong', { style: { fontSize: 13 } }, '3. Phong tỏa Lô theo MKT'),
            h('label', { style: S.fieldLabel },
              'Mã lô hàng',
              h('input', { 'data-testid': 'dxos-wms-ops-mkt-lot', list: 'dxos-wms-lot-datalist', placeholder: 'VD: LOT-CT-01', value: mktLot, onChange: (e) => setMktLot(e.target.value), style: S.input }),
            ),
            h('label', { style: S.fieldLabel },
              'Chuỗi mẫu nhiệt độ (°C)',
              h('input', { 'data-testid': 'dxos-wms-ops-mkt-samples', placeholder: 'VD: 2.5, 14.0', value: mktSamples, onChange: (e) => setMktSamples(e.target.value), style: S.input }),
            ),
            h('label', { style: S.fieldLabel },
              'Ngưỡng nhiệt tối đa (°C)',
              h('input', { 'data-testid': 'dxos-wms-ops-mkt-max', type: 'number', placeholder: 'VD: 8', value: mktMax, onChange: (e) => setMktMax(e.target.value), style: S.input }),
            ),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, busy) }, 'Kiểm định & Phong tỏa MKT'),
            mktResult ? h('div', { 'data-testid': 'dxos-wms-ops-mkt-result', style: { fontSize: 11, color: '#0f172a' } },
              `Trạng thái: ${formatStatusLabel(mktResult.lotStatus || (mktResult.held ? 'hold_mkt' : 'ok'))} (MKT ${mktResult.mktCelsius ?? '—'}°C)`,
            ) : null,
          ),
        ),
      ) : null,

      activeTab === 'import' && showBulkImport ? h('div', { 'data-testid': 'dxos-wms-ops-import-wizard', style: S.card },
        h('strong', { style: { fontSize: 13 } }, 'Nhập lô hàng loạt 2 pha (Kiểm thử dữ liệu → Xác nhận lưu)'),
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
            disabled: commitDisabled,
            onClick: handleBulkCommit,
            style: S.btn(true, commitDisabled),
          }, 'Pha 2: Xác nhận Commit'),
        ),
        dryRunResult ? h('div', { 'data-testid': 'dxos-wms-ops-import-preview', style: { padding: 10, background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, display: 'grid', gap: 6 } },
          h('div', null, `Tổng: ${dryRunResult.totalRows ?? 0} · Hợp lệ: ${dryRunResult.validCount ?? 0} · Lỗi: ${dryRunResult.invalidCount ?? 0}`),
          dryRunResult.payloadSha256 ? h('div', null, createCompactIdBadge(React, dryRunResult.payloadSha256, { labelPrefix: 'SHA-256' })) : null,
          dryRunErrors.length > 0 ? h('div', { style: { overflowX: 'auto', marginTop: 4 } },
            h('table', { 'data-testid': 'dxos-wms-ops-import-errors', style: { width: '100%', borderCollapse: 'collapse', fontSize: 11 } },
              h('thead', null, h('tr', { style: { background: '#fef2f2', color: '#991b1b', textAlign: 'left' } },
                ['Dòng', 'Mã lỗi', 'Chi tiết'].map((col) => h('th', { key: col, style: { padding: '4px 6px', border: '1px solid #fecaca' } }, col)),
              )),
              h('tbody', null, dryRunErrors.map((err, idx) => h('tr', { key: `${err.row ?? idx}-${err.code || idx}` },
                h('td', { style: { padding: '4px 6px', border: '1px solid #fecaca', fontWeight: 600 } }, String(err.row ?? '—')),
                h('td', { style: { padding: '4px 6px', border: '1px solid #fecaca', fontFamily: 'monospace' } }, String(err.code || 'ERROR')),
                h('td', { style: { padding: '4px 6px', border: '1px solid #fecaca', color: '#7f1d1d' } }, String(err.message || '')),
              ))),
            ),
          ) : null,
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

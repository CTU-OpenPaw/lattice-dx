/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define('@latticedx/plugin-dxos-para', ['@nocobase/client', 'react', 'antd'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client'), require('react'), require('antd'));
  }
})(function (client, React, antd) {
  'use strict';

  const PARA_SPACE_LABELS = {
    projects: 'Projects (Dự án)',
    areas: 'Areas (Lĩnh vực)',
    resources: 'Resources (Tài nguyên)',
    archives: 'Archives (Lưu trữ)',
  };

  const TARGET_COLLECTION_OPTIONS = [
    { value: 'latticeOrders', label: 'Đơn hàng (latticeOrders)' },
    { value: 'latticeRequests', label: 'Yêu cầu (latticeRequests)' },
    { value: 'latticeStockLots', label: 'Lô hàng tồn kho (latticeStockLots)' },
    { value: 'latticeServiceTickets', label: 'Phiếu dịch vụ (latticeServiceTickets)' },
  ];

  function encodeUtf8Base64(text) {
    const str = String(text || '');
    if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
      const bytes = new TextEncoder().encode(str);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(str, 'utf8').toString('base64');
    }
    return '';
  }

  function unwrapPayload(res) {
    if (!res) return {};
    if (res.data && res.data.data && typeof res.data.data === 'object') return res.data.data;
    if (res.data && typeof res.data === 'object') return res.data;
    return res;
  }

  function createDxosParaSettingsPage(_clientRef, ReactRef, antdRef, app) {
    const h = ReactRef.createElement;
    const useApi = typeof _clientRef?.useAPIClient === 'function'
      ? _clientRef.useAPIClient
      : () => app?.apiClient || null;

    return function DxosParaSettingsPage() {
      const api = useApi();
      const [selectedOrg, setSelectedOrg] = ReactRef.useState('');
      const [organizations, setOrganizations] = ReactRef.useState([]);
      const [summary, setSummary] = ReactRef.useState(null);
      const [health, setHealth] = ReactRef.useState(null);
      const [loadingHealth, setLoadingHealth] = ReactRef.useState(false);
      const [reindexing, setReindexing] = ReactRef.useState(false);
      const [statusMsg, setStatusMsg] = ReactRef.useState(null);

      const [searchQuery, setSearchQuery] = ReactRef.useState('kho lạnh Cần Thơ');
      const [searchSpace, setSearchSpace] = ReactRef.useState('');
      const [searching, setSearching] = ReactRef.useState(false);
      const [searchResult, setSearchResult] = ReactRef.useState(null);

      const [targetCollection, setTargetCollection] = ReactRef.useState('latticeOrders');
      const [ocrFilename, setOcrFilename] = ReactRef.useState('mau-don-kho-lanh.txt');
      const [ocrMimeType, setOcrMimeType] = ReactRef.useState('text/plain');
      const [ocrBase64, setOcrBase64] = ReactRef.useState('');
      const [ocrSampleText, setOcrSampleText] = ReactRef.useState(
        'Mã đơn: ORD-2026-990\nKhách hàng: Bệnh viện Đa khoa Cần Thơ\nĐiểm đến: Kho lạnh Cần Thơ\nNhiệt độ yêu cầu: 2..8 °C\nSKU-VAC-01\t120 hộp\t2027-12-31',
      );
      const [ocrRunning, setOcrRunning] = ReactRef.useState(false);
      const [ocrResult, setOcrResult] = ReactRef.useState(null);

      const loadHealthAndSummary = ReactRef.useCallback(async (orgOverride) => {
        if (!api || typeof api.request !== 'function') return;
        setLoadingHealth(true);
        try {
          const orgParam = orgOverride !== undefined ? orgOverride : selectedOrg;
          const params = orgParam ? { organizationId: orgParam } : undefined;
          const [sumRes, healthRes] = await Promise.all([
            api.request({ url: 'latticePara:summary', method: 'get', params, skipNotify: true }),
            api.request({ url: 'latticePara:indexHealth', method: 'get', params, skipNotify: true }),
          ]);
          const sumData = unwrapPayload(sumRes);
          const healthData = unwrapPayload(healthRes);
          setSummary(sumData);
          setHealth(healthData);
          if (Array.isArray(sumData?.organizations) && sumData.organizations.length) {
            setOrganizations(sumData.organizations);
          }
          if (!orgParam && (sumData?.organizationId || healthData?.organizationId)) {
            setSelectedOrg(sumData?.organizationId || healthData?.organizationId || '');
          }
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: err?.message || 'Không tải được trạng thái chỉ mục P.A.R.A.',
          });
        } finally {
          setLoadingHealth(false);
        }
      }, [api, selectedOrg]);

      ReactRef.useEffect(() => {
        void loadHealthAndSummary('');
      }, [Boolean(api?.request)]);

      const handleReindex = async () => {
        if (!api || typeof api.request !== 'function') return;
        setReindexing(true);
        setStatusMsg(null);
        try {
          const res = await api.request({
            url: 'latticePara:reindex',
            method: 'post',
            data: selectedOrg ? { organizationId: selectedOrg } : {},
            skipNotify: true,
          });
          const data = unwrapPayload(res);
          setStatusMsg({
            type: 'success',
            message: `Đã lập chỉ mục lại ${data.documentsProcessed || 0} tài liệu (${data.chunksIndexed || 0} phân đoạn, ${data.neuralChunks || 0} neural).`,
          });
          await loadHealthAndSummary(selectedOrg);
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: err?.message || 'Lập chỉ mục lại P.A.R.A. thất bại.',
          });
        } finally {
          setReindexing(false);
        }
      };

      const handleHybridSearch = async () => {
        if (!api || typeof api.request !== 'function') return;
        setSearching(true);
        setStatusMsg(null);
        try {
          const res = await api.request({
            url: 'latticePara:hybridSearch',
            method: 'post',
            data: {
              query: searchQuery,
              ...(searchSpace ? { paraSpace: searchSpace } : {}),
              ...(selectedOrg ? { organizationId: selectedOrg } : {}),
              limit: 10,
            },
            skipNotify: true,
          });
          setSearchResult(unwrapPayload(res));
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: err?.message || 'Tìm kiếm P.A.R.A. thất bại.',
          });
        } finally {
          setSearching(false);
        }
      };

      const handleFileSelect = (evt) => {
        const file = evt?.target?.files?.[0];
        if (!file) return;
        setOcrFilename(file.name || 'document');
        setOcrMimeType(file.type || '');
        if (typeof FileReader !== 'undefined') {
          const reader = new FileReader();
          reader.onload = () => {
            const raw = typeof reader.result === 'string' ? reader.result : '';
            setOcrBase64(raw);
          };
          reader.readAsDataURL(file);
        }
      };

      const handleRunOcrTest = async () => {
        if (!api || typeof api.request !== 'function') return;
        setOcrRunning(true);
        setStatusMsg(null);
        try {
          const contentBase64 = ocrBase64 || encodeUtf8Base64(ocrSampleText);
          const res = await api.request({
            url: 'latticePara:extractFormFields',
            method: 'post',
            data: {
              filename: ocrFilename,
              mimeType: ocrMimeType,
              contentBase64,
              targetCollection,
              ...(selectedOrg ? { organizationId: selectedOrg } : {}),
            },
            skipNotify: true,
          });
          setOcrResult(unwrapPayload(res));
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: err?.message || 'Kiểm thử OCR / Auto-fill thất bại.',
          });
        } finally {
          setOcrRunning(false);
        }
      };

      const spaces = summary?.spaces || {};
      const recentFailures = Array.isArray(health?.recentFailures) ? health.recentFailures : [];
      const searchItems = Array.isArray(searchResult?.items) ? searchResult.items : [];
      const lineItems = Array.isArray(ocrResult?.lineItems) ? ocrResult.lineItems : [];

      return h(
        'div',
        { 'data-testid': 'dxos-para-settings-page', style: { padding: 20, maxWidth: 1120 } },
        h(
          antdRef.Space,
          { direction: 'vertical', size: 'middle', style: { width: '100%' } },
          h(
            antdRef.Card,
            {
              title: 'Kho tri thức P.A.R.A. & Sức khỏe Chỉ mục Vector',
              extra: h(
                antdRef.Space,
                null,
                organizations.length > 1
                  ? h(antdRef.Select, {
                      value: selectedOrg || undefined,
                      placeholder: 'Tổ chức',
                      style: { width: 180 },
                      options: organizations.map((o) => ({ value: o, label: o })),
                      onChange: (val) => {
                        setSelectedOrg(val);
                        void loadHealthAndSummary(val);
                      },
                    })
                  : null,
                h(
                  antdRef.Button,
                  { loading: loadingHealth, onClick: () => void loadHealthAndSummary(selectedOrg) },
                  'Làm mới',
                ),
                h(
                  antdRef.Button,
                  { type: 'primary', loading: reindexing, onClick: handleReindex },
                  'Lập chỉ mục lại (Reindex)',
                ),
              ),
            },
            statusMsg ? h(antdRef.Alert, { type: statusMsg.type, message: statusMsg.message, showIcon: true, style: { marginBottom: 12 } }) : null,
            h(
              antdRef.Row,
              { gutter: [12, 12] },
              h(antdRef.Col, { xs: 12, sm: 6 }, h(antdRef.Statistic, { title: 'Tổng tài liệu P.A.R.A.', value: health?.documentsCount ?? summary?.total ?? 0 })),
              h(antdRef.Col, { xs: 12, sm: 6 }, h(antdRef.Statistic, { title: 'Tổng phân đoạn (Chunks)', value: health?.chunksCount ?? 0 })),
              h(antdRef.Col, { xs: 12, sm: 6 }, h(antdRef.Statistic, { title: 'Neural Chunks', value: health?.neuralChunks ?? 0 })),
              h(antdRef.Col, { xs: 12, sm: 6 }, h(antdRef.Statistic, { title: 'Deterministic Fallback', value: health?.fallbackChunks ?? 0 })),
            ),
            h(antdRef.Divider, { style: { margin: '12px 0' } }),
            h(
              antdRef.Space,
              { wrap: true },
              h(antdRef.Tag, { color: health?.pgvectorAvailable ? 'green' : 'orange' }, `pgvector: ${health?.pgvectorAvailable ? 'Bật (linh hoạt)' : 'Fallback JSONB'}`),
              h(antdRef.Tag, { color: 'blue' }, `Dimension mục tiêu: ${health?.targetEmbeddingDim ?? 1536}`),
              h(antdRef.Tag, null, `Dimensions đang lưu: ${(health?.embeddingDims || []).join(', ') || '—'}`),
              h(antdRef.Tag, { color: health?.embeddingConfigured ? 'green' : 'default' }, `Embedding API: ${health?.embeddingConfigured ? 'Đã cấu hình' : 'Offline Fallback'}`),
              h(antdRef.Tag, { color: health?.ocrConfigured ? 'green' : 'default' }, `Remote OCR: ${health?.ocrConfigured ? 'Đã cấu hình' : 'Offline Parser'}`),
              h(antdRef.Tag, { color: (health?.pendingRetries || 0) > 0 ? 'red' : 'green' }, `Retry hàng đợi: ${health?.pendingRetries ?? 0}`),
            ),
            h(
              antdRef.Space,
              { wrap: true, style: { marginTop: 10 } },
              ...Object.entries(PARA_SPACE_LABELS).map(([key, label]) =>
                h(antdRef.Tag, { key }, `${label}: ${spaces[key] ?? 0}`),
              ),
            ),
            recentFailures.length > 0
              ? h(
                  'div',
                  { style: { marginTop: 14 } },
                  h(antdRef.Typography.Text, { strong: true }, 'Nhật ký Retry sau Commit (afterCommit):'),
                  h(antdRef.Table, {
                    size: 'small',
                    pagination: false,
                    rowKey: (r, i) => `${r.operation}:${r.documentId}:${r.attempt}:${i}`,
                    dataSource: recentFailures,
                    columns: [
                      { title: 'Thao tác', dataIndex: 'operation' },
                      { title: 'Doc ID', dataIndex: 'documentId' },
                      { title: 'Lần thử', render: (_v, r) => `${r.attempt || 1}/${r.maxAttempts || 3}` },
                      { title: 'Có thể retry', render: (_v, r) => (r.retryable ? 'Có' : 'Không') },
                      { title: 'Lỗi', dataIndex: 'errorMessage' },
                    ],
                  }),
                )
              : null,
          ),

          h(
            antdRef.Card,
            { title: 'Kiểm thử Tìm kiếm Lai (Hybrid Search RRF + pgvector)' },
            h(
              antdRef.Space,
              { style: { width: '100%', marginBottom: 12 }, wrap: true },
              h(antdRef.Input, {
                value: searchQuery,
                placeholder: 'Nhập câu truy vấn tiếng Việt hoặc mã SOP…',
                style: { width: 340 },
                onChange: (e) => setSearchQuery(e?.target?.value ?? ''),
              }),
              h(antdRef.Select, {
                value: searchSpace,
                style: { width: 180 },
                options: [
                  { value: '', label: 'Tất cả phân vùng' },
                  ...Object.entries(PARA_SPACE_LABELS).map(([value, label]) => ({ value, label })),
                ],
                onChange: setSearchSpace,
              }),
              h(
                antdRef.Button,
                { type: 'primary', loading: searching, onClick: handleHybridSearch },
                'Tìm kiếm RRF',
              ),
            ),
            searchResult
              ? h(antdRef.Table, {
                  size: 'small',
                  pagination: false,
                  rowKey: (r, idx) => `${r.id}:${r.chunkId || idx}`,
                  dataSource: searchItems,
                  locale: { emptyText: 'Không có kết quả phù hợp.' },
                  columns: [
                    { title: 'Mã', dataIndex: 'code', width: 120 },
                    { title: 'Tiêu đề', dataIndex: 'title' },
                    { title: 'Động cơ', dataIndex: 'embeddingEngine', width: 150 },
                    { title: 'Điểm RRF', dataIndex: 'score', width: 90 },
                    { title: 'Trích dẫn', dataIndex: 'citation' },
                    { title: 'Đoạn khớp', dataIndex: 'snippet' },
                  ],
                })
              : null,
          ),

          h(
            antdRef.Card,
            { title: 'Kiểm thử OCR & Trích xuất Biểu mẫu (PDF / DOCX / XLSX / Ảnh)' },
            h(
              antdRef.Space,
              { direction: 'vertical', style: { width: '100%' } },
              h(
                antdRef.Space,
                { wrap: true },
                h(antdRef.Select, {
                  value: targetCollection,
                  style: { width: 260 },
                  options: TARGET_COLLECTION_OPTIONS,
                  onChange: setTargetCollection,
                }),
                h('input', {
                  type: 'file',
                  accept: '.pdf,.docx,.xlsx,.pptx,.csv,.txt,.md,.png,.jpg,.jpeg',
                  onChange: handleFileSelect,
                }),
                h(
                  antdRef.Button,
                  { type: 'primary', loading: ocrRunning, onClick: handleRunOcrTest },
                  'Chạy kiểm thử OCR & Auto-Fill',
                ),
              ),
              h(antdRef.Input.TextArea, {
                rows: 4,
                value: ocrSampleText,
                disabled: Boolean(ocrBase64),
                placeholder: 'Hoặc dán văn bản mẫu khi chưa chọn tệp nhị phân…',
                onChange: (e) => setOcrSampleText(e?.target?.value ?? ''),
              }),
              ocrBase64
                ? h(
                    antdRef.Space,
                    null,
                    h(antdRef.Tag, { color: 'blue' }, `Đã nạp tệp: ${ocrFilename}`),
                    h(antdRef.Button, { size: 'small', onClick: () => { setOcrBase64(''); setOcrFilename('mau-don-kho-lanh.txt'); setOcrMimeType('text/plain'); } }, 'Xóa tệp đã chọn'),
                  )
                : null,
              ocrResult
                ? h(
                    'div',
                    { style: { marginTop: 8 } },
                    h(
                      antdRef.Space,
                      { wrap: true, style: { marginBottom: 8 } },
                      h(antdRef.Tag, { color: 'purple' }, `Định dạng: ${ocrResult.format || '—'}`),
                      h(antdRef.Tag, { color: 'blue' }, `OCR Engine: ${ocrResult.ocrEngine || '—'}`),
                      h(antdRef.Tag, { color: 'green' }, `Độ tin cậy: ${ocrResult.confidence ?? 0}`),
                      ...(Array.isArray(ocrResult.warnings) ? ocrResult.warnings.map((w) => h(antdRef.Tag, { key: w, color: 'orange' }, w)) : []),
                    ),
                    h(
                      'pre',
                      { style: { background: '#f8fafc', padding: 10, borderRadius: 6, fontSize: 12, overflowX: 'auto' } },
                      JSON.stringify(ocrResult.suggestedValues || {}, null, 2),
                    ),
                    lineItems.length > 0
                      ? h(antdRef.Table, {
                          size: 'small',
                          pagination: false,
                          rowKey: (r, i) => `${r.sku || 'item'}:${i}`,
                          dataSource: lineItems,
                          columns: [
                            { title: 'SKU', dataIndex: 'sku' },
                            { title: 'Tên hàng', dataIndex: 'productName' },
                            { title: 'Số lượng', dataIndex: 'quantity' },
                            { title: 'Đơn vị', dataIndex: 'unit' },
                            { title: 'HSD', dataIndex: 'expiryDate' },
                          ],
                        })
                      : null,
                  )
                : null,
            ),
          ),
        ),
      );
    };
  }

  class DxosParaClientPlugin extends client.Plugin {
    async load() {
      const Page = createDxosParaSettingsPage(client, React, antd, this.app);
      if (this.app?.pluginSettingsManager && typeof this.app.pluginSettingsManager.add === 'function') {
        this.app.pluginSettingsManager.add('dxos-para', {
          title: 'DX-OS P.A.R.A. & OCR',
          icon: 'FileSearchOutlined',
          Component: Page,
          aclSnippet: 'pm',
        });
      }
    }
  }

  return { __esModule: true, default: DxosParaClientPlugin, createDxosParaSettingsPage };
});

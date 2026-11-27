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

  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

  const PARA_SPACE_LABELS = {
    projects: 'Projects (Dự án)',
    areas: 'Areas (Lĩnh vực)',
    resources: 'Resources (Tài nguyên)',
    archives: 'Archives (Lưu trữ)',
  };

  const PARA_STATUS_OPTIONS = [
    { value: 'draft', label: 'Bản nháp (draft)' },
    { value: 'active', label: 'Đang hiệu lực (active)' },
    { value: 'archived', label: 'Lưu trữ (archived)' },
  ];

  const TARGET_COLLECTION_OPTIONS = [
    { value: 'latticeOrders', label: 'Đơn hàng (latticeOrders)' },
    { value: 'latticeRequests', label: 'Yêu cầu (latticeRequests)' },
    { value: 'latticeStockLots', label: 'Lô hàng tồn kho (latticeStockLots)' },
    { value: 'latticeServiceTickets', label: 'Phiếu dịch vụ (latticeServiceTickets)' },
  ];

  const COLLECTION_PORTAL_ROUTES = {
    latticeOrders: '/p/logistics',
    latticeRequests: '/p/procurement',
    latticeStockLots: '/p/logistics',
    latticeServiceTickets: '/p/services',
  };

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
    if (res.data && res.data.data && typeof res.data.data === 'object' && !Array.isArray(res.data.data)) return res.data.data;
    if (res.data && typeof res.data === 'object') return res.data;
    return res;
  }

  function unwrapList(res) {
    if (!res) return [];
    if (Array.isArray(res.data?.data)) return res.data.data;
    if (Array.isArray(res.data?.items)) return res.data.items;
    if (Array.isArray(res.data)) return res.data;
    if (Array.isArray(res.items)) return res.items;
    return [];
  }

  function extractErrMsg(err, fallback) {
    return err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message || err?.message || fallback;
  }

  function redactParaSummaryClient(rawText) {
    const input = String(rawText ?? '');
    if (!input) return '';
    return input
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]')
      .replace(/(Bearer[ \t]+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
      .replace(/\bldx_(?:pat|trk)_[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_TOKEN]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
      .replace(
        /(\b(?:cccd|cmnd|căn cước(?:\s+công dân)?|chứng minh(?:\s+nhân dân)?|số định danh(?:\s+cá nhân)?|id(?:\s*(?:no|number|card))?)\s*[:#=-]?\s*)(?:\d(?:[ .-]?\d){11}|\d(?:[ .-]?\d){8})(?![0-9A-Za-z-])/gi,
        '$1[REDACTED_CCCD]',
      )
      .replace(/(?<![0-9A-Za-z.+-])\d{12}(?![0-9A-Za-z-]|\.\d)/g, '[REDACTED_CCCD]')
      .replace(/(?<![0-9A-Za-z.-])(?:(?:\+?84[\s.-]?\d(?:[\s.-]?\d){8,9})|(?:0\d(?:[\s.-]?\d){8,9}))(?![0-9A-Za-z-])/g, '[REDACTED_PHONE]');
  }

  function emptyDocDraft() {
    return {
      id: null,
      code: '',
      title: '',
      paraSpace: 'resources',
      status: 'active',
      summary: '',
      contentMarkdown: '',
      tags: '',
      attachmentUrl: '',
      version: 1,
    };
  }

  const OCR_SERVICE_TYPES = new Set(['leave', 'it_support', 'facilities', 'hr_request']);
  const OCR_SERVICE_PRIORITIES = new Set(['low', 'medium', 'high']);
  const OCR_COLLECTION_FIELDS = {
    latticeStockLots: [
      ['lotCode', 'Mã lô (lotCode)'],
      ['sku', 'SKU'],
      ['productName', 'Tên sản phẩm (productName)'],
      ['qtyOnHand', 'Số lượng tồn (qtyOnHand)'],
      ['unit', 'Đơn vị (unit)'],
      ['expiryDate', 'Hạn sử dụng (YYYY-MM-DD)'],
    ],
    latticeServiceTickets: [
      ['code', 'Mã phiếu (code)'],
      ['name', 'Tiêu đề (name)'],
      ['serviceType', 'Loại dịch vụ (serviceType)'],
      ['priority', 'Độ ưu tiên (priority)'],
      ['description', 'Mô tả (description)'],
    ],
    latticeRequests: [
      ['code', 'Mã yêu cầu (code)'],
      ['name', 'Tên / Tiêu đề (name)'],
      ['category', 'Danh mục (category)'],
      ['quantity', 'Số lượng (quantity)'],
      ['estimatedCost', 'Chi phí dự kiến (estimatedCost)'],
      ['description', 'Mô tả (description)'],
    ],
    latticeOrders: [
      ['code', 'Mã chứng từ (code)'],
      ['name', 'Tên / Tiêu đề (name)'],
      ['customer', 'Khách hàng (customer)'],
      ['origin', 'Điểm đi (origin)'],
      ['destination', 'Điểm đến (destination)'],
      ['quantity', 'Số lượng (quantity)'],
      ['description', 'Mô tả (description)'],
    ],
  };

  function normalizeOcrDraftForCollection(collection, rawValues = {}, ocrResult = null) {
    const src = rawValues && typeof rawValues === 'object' ? { ...rawValues } : {};
    const lineItems = Array.isArray(ocrResult?.lineItems) ? ocrResult.lineItems : [];
    const firstItem = lineItems[0] || {};
    const resultSuggested = ocrResult?.suggestedValues && typeof ocrResult.suggestedValues === 'object'
      ? ocrResult.suggestedValues
      : {};

    if (collection === 'latticeStockLots') {
      const lotCode = Object.hasOwn(src, 'lotCode')
        ? String(src.lotCode ?? '').trim()
        : String(firstItem.lotCode || '').trim();
      const sku = Object.hasOwn(src, 'sku')
        ? String(src.sku ?? '').trim()
        : String(firstItem.sku || '').trim();
      const productName = Object.hasOwn(src, 'productName')
        ? String(src.productName ?? '').trim()
        : String(firstItem.productName || '').trim();
      const qtyOnHand = Object.hasOwn(src, 'qtyOnHand')
        ? src.qtyOnHand
        : (Object.hasOwn(src, 'quantity') ? src.quantity : (firstItem.quantity ?? ''));
      const unit = Object.hasOwn(src, 'unit')
        ? String(src.unit ?? '').trim()
        : String(firstItem.unit || '').trim();
      const expiryDate = Object.hasOwn(src, 'expiryDate')
        ? String(src.expiryDate ?? '').trim()
        : String(firstItem.expiryDate || '').trim();

      const next = {
        ...src,
        lotCode,
        sku,
        productName,
        qtyOnHand,
        unit,
        expiryDate,
      };
      delete next.code;
      delete next.name;
      delete next.quantity;
      return next;
    }

    const next = { ...src };
    delete next.lotCode;
    delete next.qtyOnHand;
    delete next.productName;
    if (!Object.hasOwn(next, 'code') && resultSuggested.code) {
      next.code = resultSuggested.code;
    }
    if (next.quantity == null && src.qtyOnHand != null && src.qtyOnHand !== '') {
      next.quantity = src.qtyOnHand;
    }
    if (!next.name && (next.customer || next.destination || next.code || resultSuggested.name)) {
      next.name = resultSuggested.name || (
        next.customer
          ? `Hồ sơ OCR — ${next.customer}`
          : (next.destination ? `Hồ sơ OCR — ${next.destination}` : String(next.code || ''))
      );
    }
    return next;
  }

  function sanitizeOcrServiceType(raw) {
    const norm = String(raw ?? '').trim().toLowerCase();
    return OCR_SERVICE_TYPES.has(norm) ? norm : undefined;
  }

  function sanitizeOcrServicePriority(raw) {
    const norm = String(raw ?? '').trim().toLowerCase();
    if (norm === 'normal') return 'medium';
    if (norm === 'urgent') return 'high';
    return OCR_SERVICE_PRIORITIES.has(norm) ? norm : undefined;
  }

  function buildOcrRecordPayload(targetCollection, draftValues = {}, ocrResult = null, selectedOrg = '') {
    const vals = draftValues && typeof draftValues === 'object' ? draftValues : {};
    const org = String(selectedOrg || '').trim();
    const lineItems = Array.isArray(ocrResult?.lineItems) ? ocrResult.lineItems : [];
    const firstItem = lineItems[0] || {};
    const extraNotes = [];
    if (vals.temperatureRequirement) extraNotes.push(`Nhiệt độ yêu cầu: ${vals.temperatureRequirement}`);
    if (vals.targetTempMinC != null || vals.targetTempMaxC != null) {
      extraNotes.push(`Dải nhiệt: ${vals.targetTempMinC ?? '—'}..${vals.targetTempMaxC ?? '—'} °C`);
    }
    if (vals.supplier) extraNotes.push(`Nhà cung cấp: ${vals.supplier}`);
    if (lineItems.length > 0) {
      extraNotes.push(`Dòng hàng OCR: ${lineItems.slice(0, 5).map((it) => `${it.sku || ''} x ${it.quantity ?? ''}`).join('; ')}`);
    }
    const baseDesc = String(vals.description || '').trim();
    const description = [baseDesc, ...extraNotes].filter(Boolean).join('\n').slice(0, 2000);

    if (targetCollection === 'latticeStockLots') {
      const lotCode = String(vals.lotCode || '').trim();
      const rawSku = Object.hasOwn(vals, 'sku') ? vals.sku : (firstItem.sku || '');
      const sku = String(rawSku || '').trim();
      const rawProductName = Object.hasOwn(vals, 'productName')
        ? vals.productName
        : (vals.name || firstItem.productName || '');
      const productName = String(rawProductName || '').trim();
      const rawQty = Object.hasOwn(vals, 'qtyOnHand')
        ? vals.qtyOnHand
        : (vals.quantity ?? firstItem.quantity);
      const qtyOnHand = rawQty === '' || rawQty == null ? NaN : Number(rawQty);
      const rawExpiry = Object.hasOwn(vals, 'expiryDate')
        ? vals.expiryDate
        : (firstItem.expiryDate || '');
      const expiryDate = String(rawExpiry || '').trim();
      const rawUnit = Object.hasOwn(vals, 'unit') ? vals.unit : (firstItem.unit || '');
      const unit = String(rawUnit || '').trim();
      if (!lotCode || !sku || !productName || !Number.isFinite(qtyOnHand) || qtyOnHand <= 0 || !expiryDate) {
        return {
          ok: false,
          error: 'Lô kho lạnh yêu cầu đủ Mã lô (lotCode), SKU, Tên hàng, Số lượng > 0 và Hạn sử dụng (expiryDate).',
          payload: null,
        };
      }
      return {
        ok: true,
        error: null,
        payload: {
          lotCode,
          sku,
          productName,
          qtyOnHand,
          expiryDate,
          ...(unit ? { unit } : {}),
          ...(org ? { organizationId: org } : {}),
        },
      };
    }

    const fallbackCode = `OCR-${Date.now().toString().slice(-6)}`;
    const code = String(vals.code || fallbackCode).trim();
    const name = String(
      vals.name
      || vals.title
      || (vals.customer ? `Hồ sơ OCR — ${vals.customer}` : '')
      || (vals.destination ? `Hồ sơ OCR — ${vals.destination}` : '')
      || code,
    ).trim();

    if (!code || !name) {
      return { ok: false, error: 'Cần có Mã (code) và Tên/Tiêu đề (name) để tạo bản ghi từ OCR.', payload: null };
    }

    if (targetCollection === 'latticeRequests') {
      const rawQty = Object.hasOwn(vals, 'quantity') ? vals.quantity : firstItem.quantity;
      const qtyNum = rawQty === '' || rawQty == null ? NaN : Number(rawQty);
      const rawCost = Object.hasOwn(vals, 'estimatedCost') ? vals.estimatedCost : undefined;
      const costNum = rawCost === '' || rawCost == null ? NaN : Number(rawCost);
      const payload = {
        code,
        name,
        ...(vals.category ? { category: String(vals.category).trim() } : {}),
        ...(Number.isFinite(qtyNum) ? { quantity: qtyNum } : {}),
        ...(Number.isFinite(costNum) ? { estimatedCost: costNum } : {}),
        ...(description ? { description } : {}),
        ...(org ? { organizationId: org } : {}),
      };
      return { ok: true, error: null, payload };
    }

    if (targetCollection === 'latticeServiceTickets') {
      const serviceType = sanitizeOcrServiceType(vals.serviceType);
      const priority = sanitizeOcrServicePriority(vals.priority);
      const payload = {
        code,
        name,
        ...(serviceType ? { serviceType } : {}),
        ...(priority ? { priority } : {}),
        ...(description ? { description } : {}),
        ...(org ? { organizationId: org } : {}),
      };
      return { ok: true, error: null, payload };
    }

    // Default: latticeOrders
    const rawQty = Object.hasOwn(vals, 'quantity') ? vals.quantity : firstItem.quantity;
    const qtyNum = rawQty === '' || rawQty == null ? NaN : Number(rawQty);
    const payload = {
      code,
      name,
      ...(vals.customer ? { customer: String(vals.customer).trim() } : {}),
      ...(vals.origin ? { origin: String(vals.origin).trim() } : {}),
      ...(vals.destination ? { destination: String(vals.destination).trim() } : {}),
      ...(Number.isFinite(qtyNum) && qtyNum > 0 ? { quantity: qtyNum } : {}),
      ...(description ? { description } : {}),
      ...(org ? { organizationId: org } : {}),
    };
    return { ok: true, error: null, payload };
  }

  function createDxosParaSettingsPage(_clientRef, ReactRef, antdRef, app) {
    const h = ReactRef.createElement;
    const useApi = typeof _clientRef?.useAPIClient === 'function'
      ? _clientRef.useAPIClient
      : () => app?.apiClient || null;

    const ModalComp = antdRef?.Modal || function FallbackModal(props) {
      if (!props?.open) return null;
      return h('div', { 'data-testid': props['data-testid'], role: 'dialog' },
        h('div', null, props.title),
        props.children,
        h('div', null,
          h('button', { type: 'button', onClick: props.onCancel }, props.cancelText || 'Hủy'),
          props.onOk ? h('button', { type: 'button', onClick: props.onOk }, props.okText || 'Lưu') : null,
        ),
      );
    };
    const PopconfirmComp = antdRef?.Popconfirm || function FallbackPopconfirm(props) {
      return h('span', { onClick: props.onConfirm }, props.children);
    };

    return function DxosParaSettingsPage() {
      const api = useApi();
      const [selectedOrg, setSelectedOrg] = ReactRef.useState('');
      const [organizations, setOrganizations] = ReactRef.useState([]);
      const [summary, setSummary] = ReactRef.useState(null);
      const [health, setHealth] = ReactRef.useState(null);
      const [loadingHealth, setLoadingHealth] = ReactRef.useState(false);
      const [reindexing, setReindexing] = ReactRef.useState(false);
      const [statusMsg, setStatusMsg] = ReactRef.useState(null);

      // P.A.R.A. Documents CRUD Browser state
      const [docs, setDocs] = ReactRef.useState([]);
      const [docsLoading, setDocsLoading] = ReactRef.useState(false);
      const [docSpaceFilter, setDocSpaceFilter] = ReactRef.useState('');
      const [docModalOpen, setDocModalOpen] = ReactRef.useState(false);
      const [docFormMode, setDocFormMode] = ReactRef.useState('create');
      const [docDraft, setDocDraft] = ReactRef.useState(emptyDocDraft);
      const [docSaving, setDocSaving] = ReactRef.useState(false);

      // Preview Modal state (shared by Document Browser & Hybrid Search click)
      const [previewOpen, setPreviewOpen] = ReactRef.useState(false);
      const [previewLoading, setPreviewLoading] = ReactRef.useState(false);
      const [previewDoc, setPreviewDoc] = ReactRef.useState(null);

      // Attachment Extract Modal state
      const [extractModalOpen, setExtractModalOpen] = ReactRef.useState(false);
      const [extractTargetDoc, setExtractTargetDoc] = ReactRef.useState(null);
      const [extractFilename, setExtractFilename] = ReactRef.useState('');
      const [extractMimeType, setExtractMimeType] = ReactRef.useState('text/plain');
      const [extractBase64, setExtractBase64] = ReactRef.useState('');
      const [extracting, setExtracting] = ReactRef.useState(false);

      // Hybrid Search state
      const [searchQuery, setSearchQuery] = ReactRef.useState('kho lạnh Cần Thơ');
      const [searchSpace, setSearchSpace] = ReactRef.useState('');
      const [searching, setSearching] = ReactRef.useState(false);
      const [searchResult, setSearchResult] = ReactRef.useState(null);

      // OCR Auto-Fill state
      const [targetCollection, setTargetCollection] = ReactRef.useState('latticeOrders');
      const [ocrFilename, setOcrFilename] = ReactRef.useState('mau-don-kho-lanh.txt');
      const [ocrMimeType, setOcrMimeType] = ReactRef.useState('text/plain');
      const [ocrBase64, setOcrBase64] = ReactRef.useState('');
      const [ocrSampleText, setOcrSampleText] = ReactRef.useState(
        'Mã đơn: ORD-2026-990\nKhách hàng: Bệnh viện Đa khoa Cần Thơ\nĐiểm đến: Kho lạnh Cần Thơ\nNhiệt độ yêu cầu: 2..8 °C\nSKU-VAC-01\t120 hộp\t2027-12-31',
      );
      const [ocrRunning, setOcrRunning] = ReactRef.useState(false);
      const [ocrResult, setOcrResult] = ReactRef.useState(null);
      const [ocrDraftValues, setOcrDraftValues] = ReactRef.useState({});
      const [ocrCreating, setOcrCreating] = ReactRef.useState(false);
      const [ocrCreatedRecord, setOcrCreatedRecord] = ReactRef.useState(null);

      const loadDocuments = ReactRef.useCallback(async (orgOverride, spaceOverride) => {
        if (!api || typeof api.request !== 'function') return;
        setDocsLoading(true);
        try {
          const orgVal = orgOverride !== undefined ? orgOverride : selectedOrg;
          const spaceVal = spaceOverride !== undefined ? spaceOverride : docSpaceFilter;
          const clauses = [];
          if (orgVal) clauses.push({ organizationId: orgVal });
          if (spaceVal) clauses.push({ paraSpace: spaceVal });
          const filter = clauses.length > 1 ? { $and: clauses } : clauses[0];
          const res = await api.request({
            url: 'latticeParaDocuments:list',
            method: 'get',
            params: {
              pageSize: 50,
              sort: ['-id'],
              ...(filter ? { filter } : {}),
            },
            skipNotify: true,
          });
          setDocs(unwrapList(res));
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: extractErrMsg(err, 'Không tải được danh sách tài liệu P.A.R.A.'),
          });
        } finally {
          setDocsLoading(false);
        }
      }, [api, selectedOrg, docSpaceFilter]);

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
          const orgList = Array.isArray(sumData?.organizations) && sumData.organizations.length
            ? sumData.organizations
            : (Array.isArray(healthData?.organizations) ? healthData.organizations : []);
          if (orgList.length) {
            setOrganizations(orgList);
          }
          const resolvedOrg = orgParam || sumData?.organizationId || healthData?.organizationId || orgList[0] || '';
          if (!orgParam && resolvedOrg) {
            setSelectedOrg(resolvedOrg);
          }
          return resolvedOrg;
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: extractErrMsg(err, 'Không tải được trạng thái chỉ mục P.A.R.A.'),
          });
          return orgOverride ?? selectedOrg;
        } finally {
          setLoadingHealth(false);
        }
      }, [api, selectedOrg]);

      ReactRef.useEffect(() => {
        void (async () => {
          const resolvedOrg = await loadHealthAndSummary('');
          await loadDocuments(resolvedOrg || '', docSpaceFilter);
        })();
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
          await Promise.all([loadHealthAndSummary(selectedOrg), loadDocuments(selectedOrg, docSpaceFilter)]);
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: extractErrMsg(err, 'Lập chỉ mục lại P.A.R.A. thất bại.'),
          });
        } finally {
          setReindexing(false);
        }
      };

      const openCreateDocModal = () => {
        setDocFormMode('create');
        setDocDraft(emptyDocDraft());
        setDocModalOpen(true);
      };

      const openEditDocModal = (record) => {
        if (!record) return;
        setDocFormMode('edit');
        setDocDraft({
          id: record.id,
          code: String(record.code || ''),
          title: String(record.title || ''),
          paraSpace: String(record.paraSpace || 'resources'),
          status: String(record.status || 'active'),
          summary: String(record.summary || ''),
          contentMarkdown: String(record.contentMarkdown || ''),
          tags: Array.isArray(record.tags) ? record.tags.join(', ') : String(record.tags || ''),
          attachmentUrl: String(record.attachmentUrl || ''),
          version: Number(record.version) || 1,
        });
        setDocModalOpen(true);
      };

      const handleSaveDoc = async () => {
        if (!api || typeof api.request !== 'function' || docSaving) return;
        const code = String(docDraft.code || '').trim();
        const title = String(docDraft.title || '').trim();
        if (!code || !title) {
          setStatusMsg({ type: 'warning', message: 'Vui lòng nhập đầy đủ Mã tài liệu và Tiêu đề P.A.R.A.' });
          return;
        }
        setDocSaving(true);
        setStatusMsg(null);
        try {
          const payload = {
            code,
            title,
            paraSpace: docDraft.paraSpace || 'resources',
            status: docDraft.status || 'active',
            summary: String(docDraft.summary || '').trim(),
            contentMarkdown: String(docDraft.contentMarkdown || ''),
            tags: String(docDraft.tags || '').trim(),
            attachmentUrl: String(docDraft.attachmentUrl || '').trim(),
            ...(selectedOrg ? { organizationId: selectedOrg } : {}),
          };
          if (docFormMode === 'edit' && docDraft.id != null) {
            await api.request({
              url: 'latticeParaDocuments:update',
              method: 'post',
              params: { filterByTk: docDraft.id },
              data: { ...payload, expectedVersion: docDraft.version },
              skipNotify: true,
            });
            setStatusMsg({ type: 'success', message: `Đã cập nhật tài liệu ${code}.` });
          } else {
            await api.request({
              url: 'latticeParaDocuments:create',
              method: 'post',
              data: payload,
              skipNotify: true,
            });
            setStatusMsg({ type: 'success', message: `Đã tạo mới tài liệu ${code}.` });
          }
          setDocModalOpen(false);
          await Promise.all([loadDocuments(selectedOrg, docSpaceFilter), loadHealthAndSummary(selectedOrg)]);
        } catch (err) {
          setStatusMsg({ type: 'error', message: extractErrMsg(err, 'Không lưu được tài liệu P.A.R.A.') });
        } finally {
          setDocSaving(false);
        }
      };

      const handleDeleteDoc = async (record) => {
        if (!api || typeof api.request !== 'function' || !record?.id) return;
        setStatusMsg(null);
        try {
          await api.request({
            url: 'latticeParaDocuments:destroy',
            method: 'post',
            params: { filterByTk: record.id },
            skipNotify: true,
          });
          setStatusMsg({ type: 'success', message: `Đã xóa tài liệu ${record.code || `#${record.id}`}.` });
          await Promise.all([loadDocuments(selectedOrg, docSpaceFilter), loadHealthAndSummary(selectedOrg)]);
        } catch (err) {
          setStatusMsg({ type: 'error', message: extractErrMsg(err, 'Không xóa được tài liệu P.A.R.A.') });
        }
      };

      const handleOpenDocPreview = async (record) => {
        const docId = record?.documentId || record?.id;
        setPreviewOpen(true);
        setPreviewDoc(
          record
            ? {
                ...record,
                ...(record.summary != null ? { summary: redactParaSummaryClient(record.summary) } : {}),
              }
            : null,
        );
        if (!api || typeof api.request !== 'function' || !docId) return;
        setPreviewLoading(true);
        try {
          const res = await api.request({
            url: 'latticeParaDocuments:get',
            method: 'get',
            params: { filterByTk: docId },
            skipNotify: true,
          });
          const full = unwrapPayload(res);
          if (full && (full.id || full.title || full.code)) {
            const rawSummary = full.summary ?? record?.summary;
            setPreviewDoc({
              ...record,
              ...full,
              ...(rawSummary != null ? { summary: redactParaSummaryClient(rawSummary) } : {}),
              matchedSnippet: record?.snippet || '',
              matchedCitation: record?.citation || '',
            });
          }
        } catch (err) {
          setStatusMsg({ type: 'error', message: extractErrMsg(err, 'Không tải được chi tiết tài liệu P.A.R.A.') });
        } finally {
          setPreviewLoading(false);
        }
      };

      const openExtractModal = (record) => {
        setExtractTargetDoc(record);
        setExtractFilename('');
        setExtractMimeType('text/plain');
        setExtractBase64('');
        setExtractModalOpen(true);
      };

      const handleExtractFileSelect = (evt) => {
        const file = evt?.target?.files?.[0];
        if (!file) return;
        if (Number(file.size) > MAX_UPLOAD_BYTES) {
          setStatusMsg({ type: 'error', message: 'Tệp đính kèm vượt quá giới hạn tối đa 2 MiB.' });
          return;
        }
        setExtractFilename(file.name || 'attachment');
        setExtractMimeType(file.type || '');
        if (typeof FileReader !== 'undefined') {
          const reader = new FileReader();
          reader.onload = () => {
            setExtractBase64(typeof reader.result === 'string' ? reader.result : '');
          };
          reader.onerror = () => {
            setStatusMsg({ type: 'error', message: 'Không đọc được tệp đính kèm đã chọn.' });
          };
          reader.readAsDataURL(file);
        }
      };

      const handleExtractAttachment = async () => {
        if (!api || typeof api.request !== 'function' || !extractTargetDoc?.id || extracting) return;
        if (!extractBase64) {
          setStatusMsg({ type: 'warning', message: 'Vui lòng chọn tệp đính kèm trước khi trích xuất.' });
          return;
        }
        setExtracting(true);
        setStatusMsg(null);
        try {
          const res = await api.request({
            url: 'latticePara:extractAttachment',
            method: 'post',
            data: {
              documentId: extractTargetDoc.id,
              filename: extractFilename,
              mimeType: extractMimeType,
              contentBase64: extractBase64,
            },
            skipNotify: true,
          });
          const data = unwrapPayload(res);
          setStatusMsg({
            type: 'success',
            message: `Đã trích xuất & lập chỉ mục ${data.chunksIndexed ?? 0} phân đoạn từ "${extractFilename}".`,
          });
          setExtractModalOpen(false);
          await Promise.all([loadDocuments(selectedOrg, docSpaceFilter), loadHealthAndSummary(selectedOrg)]);
        } catch (err) {
          setStatusMsg({ type: 'error', message: extractErrMsg(err, 'Trích xuất tệp đính kèm thất bại.') });
        } finally {
          setExtracting(false);
        }
      };

      const handleHybridSearch = async () => {
        if (!api || typeof api.request !== 'function') return;
        const cleanQuery = String(searchQuery || '').trim();
        if (!cleanQuery) {
          setStatusMsg({ type: 'warning', message: 'Vui lòng nhập từ khóa tìm kiếm P.A.R.A.' });
          return;
        }
        setSearching(true);
        setStatusMsg(null);
        try {
          const res = await api.request({
            url: 'latticePara:hybridSearch',
            method: 'post',
            data: {
              query: cleanQuery,
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
            message: extractErrMsg(err, 'Tìm kiếm P.A.R.A. thất bại.'),
          });
        } finally {
          setSearching(false);
        }
      };

      const handleFileSelect = (evt) => {
        const file = evt?.target?.files?.[0];
        if (!file) return;
        if (Number(file.size) > MAX_UPLOAD_BYTES) {
          setStatusMsg({ type: 'error', message: 'Tệp OCR vượt quá giới hạn tối đa 2 MiB.' });
          return;
        }
        setOcrFilename(file.name || 'document');
        setOcrMimeType(file.type || '');
        if (typeof FileReader !== 'undefined') {
          const reader = new FileReader();
          reader.onload = () => {
            const raw = typeof reader.result === 'string' ? reader.result : '';
            setOcrBase64(raw);
          };
          reader.onerror = () => {
            setStatusMsg({ type: 'error', message: 'Không đọc được tệp đã chọn cho OCR.' });
          };
          reader.readAsDataURL(file);
        }
      };

      const handleRunOcrTest = async () => {
        if (!api || typeof api.request !== 'function') return;
        setOcrRunning(true);
        setStatusMsg(null);
        setOcrCreatedRecord(null);
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
          const parsed = unwrapPayload(res);
          setOcrResult(parsed);
          const suggested = parsed?.suggestedValues && typeof parsed.suggestedValues === 'object'
            ? { ...parsed.suggestedValues }
            : {};
          setOcrDraftValues(normalizeOcrDraftForCollection(targetCollection, suggested, parsed));
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: extractErrMsg(err, 'Kiểm thử OCR / Auto-fill thất bại.'),
          });
        } finally {
          setOcrRunning(false);
        }
      };

      const handleCreateRecordFromOcr = async () => {
        if (!api || typeof api.request !== 'function' || ocrCreating) return;
        const effectiveOrg = selectedOrg || organizations[0] || ocrResult?.organizationId || '';
        if (!effectiveOrg) {
          setStatusMsg({ type: 'warning', message: 'Vui lòng chọn tổ chức trước khi tạo bản ghi từ OCR.' });
          return;
        }
        const built = buildOcrRecordPayload(targetCollection, ocrDraftValues, ocrResult, effectiveOrg);
        if (!built.ok) {
          setStatusMsg({ type: 'error', message: built.error });
          return;
        }
        setOcrCreating(true);
        setStatusMsg(null);
        try {
          const isStockLot = targetCollection === 'latticeStockLots';
          const res = await api.request({
            url: isStockLot ? 'dxosWms:receiveStock' : `${targetCollection}:create`,
            method: 'post',
            data: built.payload,
            skipNotify: true,
          });
          const payload = unwrapPayload(res);
          const created = isStockLot && payload?.lot && typeof payload.lot === 'object'
            ? payload.lot
            : payload;
          const portalPath = COLLECTION_PORTAL_ROUTES[targetCollection] || '/p/logistics';
          setOcrCreatedRecord({
            collection: targetCollection,
            id: created?.id,
            code: created?.code || created?.lotCode || built.payload.code || built.payload.lotCode,
            portalPath,
          });
          setStatusMsg({
            type: 'success',
            message: `Đã tạo bản ghi ${created?.code || created?.lotCode || `#${created?.id || ''}`} trong ${targetCollection}.`,
          });
        } catch (err) {
          setStatusMsg({
            type: 'error',
            message: extractErrMsg(err, `Không tạo được bản ghi trong ${targetCollection}.`),
          });
        } finally {
          setOcrCreating(false);
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
                        void Promise.all([loadHealthAndSummary(val), loadDocuments(val, docSpaceFilter)]);
                      },
                    })
                  : null,
                h(
                  antdRef.Button,
                  { loading: loadingHealth, onClick: () => void Promise.all([loadHealthAndSummary(selectedOrg), loadDocuments(selectedOrg, docSpaceFilter)]) },
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
            {
              title: 'Quản trị Tài liệu P.A.R.A. (CRUD & Trích xuất Đính kèm)',
              extra: h(
                antdRef.Space,
                { wrap: true },
                h(antdRef.Select, {
                  'data-testid': 'dxos-para-space-filter',
                  value: docSpaceFilter,
                  style: { width: 190 },
                  options: [
                    { value: '', label: 'Tất cả phân vùng P.A.R.A.' },
                    ...Object.entries(PARA_SPACE_LABELS).map(([value, label]) => ({ value, label })),
                  ],
                  onChange: (val) => {
                    setDocSpaceFilter(val || '');
                    void loadDocuments(selectedOrg, val || '');
                  },
                }),
                h(
                  antdRef.Button,
                  { loading: docsLoading, onClick: () => void loadDocuments(selectedOrg, docSpaceFilter) },
                  'Tải lại DS',
                ),
                h(
                  antdRef.Button,
                  { 'data-testid': 'dxos-para-create-doc-btn', type: 'primary', onClick: openCreateDocModal },
                  '+ Tạo tài liệu P.A.R.A.',
                ),
              ),
            },
            h(antdRef.Table, {
              'data-testid': 'dxos-para-docs-table',
              size: 'small',
              loading: docsLoading,
              pagination: { pageSize: 10 },
              rowKey: (r, idx) => `${r.id || r.code || idx}`,
              dataSource: docs,
              locale: { emptyText: 'Chưa có tài liệu P.A.R.A. nào trong phân vùng đã chọn.' },
              columns: [
                { title: 'Mã', dataIndex: 'code', width: 120 },
                { title: 'Tiêu đề', dataIndex: 'title' },
                { title: 'Phân vùng', dataIndex: 'paraSpace', width: 130, render: (v) => PARA_SPACE_LABELS[v] || v || '—' },
                { title: 'Trạng thái', dataIndex: 'status', width: 100 },
                { title: 'Ver', dataIndex: 'version', width: 60 },
                {
                  title: 'Thao tác',
                  key: 'actions',
                  width: 280,
                  render: (_v, record) => h(
                    antdRef.Space,
                    { size: 'small', wrap: true },
                    h(antdRef.Button, { size: 'small', onClick: () => void handleOpenDocPreview(record) }, 'Xem'),
                    h(antdRef.Button, { 'data-testid': 'dxos-para-doc-edit-btn', size: 'small', onClick: () => openEditDocModal(record) }, 'Sửa'),
                    h(antdRef.Button, { 'data-testid': 'dxos-para-doc-extract-btn', size: 'small', onClick: () => openExtractModal(record) }, 'Đính kèm & Trích xuất'),
                    h(
                      PopconfirmComp,
                      {
                        'data-testid': 'dxos-para-doc-delete-confirm',
                        title: `Xóa tài liệu ${record.code || ''}?`,
                        okText: 'Xóa',
                        cancelText: 'Hủy',
                        onConfirm: () => handleDeleteDoc(record),
                      },
                      h(antdRef.Button, { size: 'small', danger: true }, 'Xóa'),
                    ),
                  ),
                },
              ],
            }),
          ),

          h(
            antdRef.Card,
            { title: 'Kiểm thử Tìm kiếm Lai (Hybrid Search RRF + pgvector)' },
            h(
              antdRef.Space,
              { style: { width: '100%', marginBottom: 12 }, wrap: true },
              h(antdRef.Input, {
                'data-testid': 'dxos-para-search-input',
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
                { 'data-testid': 'dxos-para-search-btn', type: 'primary', loading: searching, onClick: handleHybridSearch },
                'Tìm kiếm RRF',
              ),
            ),
            searchResult
              ? h(antdRef.Table, {
                  'data-testid': 'dxos-para-search-table',
                  size: 'small',
                  pagination: false,
                  rowKey: (r, idx) => `${r.id}:${r.chunkId || idx}`,
                  dataSource: searchItems,
                  locale: { emptyText: 'Không có kết quả phù hợp.' },
                  onRow: (record) => ({
                    onClick: () => void handleOpenDocPreview(record),
                    style: { cursor: 'pointer' },
                  }),
                  columns: [
                    { title: 'Mã', dataIndex: 'code', width: 120 },
                    { title: 'Tiêu đề', dataIndex: 'title' },
                    { title: 'Động cơ', dataIndex: 'embeddingEngine', width: 150 },
                    { title: 'Điểm RRF', dataIndex: 'score', width: 90 },
                    { title: 'Trích dẫn', dataIndex: 'citation' },
                    { title: 'Đoạn khớp', dataIndex: 'snippet' },
                    {
                      title: 'Chi tiết',
                      key: 'open',
                      width: 110,
                      render: (_v, r) => h(antdRef.Button, {
                        'data-testid': 'dxos-para-search-view-btn',
                        size: 'small',
                        onClick: (e) => {
                          e?.stopPropagation?.();
                          void handleOpenDocPreview(r);
                        },
                      }, 'Xem tài liệu'),
                    },
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
                  'data-testid': 'dxos-para-ocr-target-select',
                  value: targetCollection,
                  style: { width: 260 },
                  options: TARGET_COLLECTION_OPTIONS,
                  onChange: (val) => {
                    setTargetCollection(val);
                    setOcrCreatedRecord(null);
                    setOcrDraftValues((prev) => normalizeOcrDraftForCollection(val, prev, ocrResult));
                  },
                }),
                h('input', {
                  'data-testid': 'dxos-para-ocr-file-input',
                  type: 'file',
                  accept: '.pdf,.docx,.xlsx,.pptx,.csv,.txt,.md,.png,.jpg,.jpeg',
                  onChange: handleFileSelect,
                }),
                h(
                  antdRef.Button,
                  { 'data-testid': 'dxos-para-ocr-run-btn', type: 'primary', loading: ocrRunning, onClick: handleRunOcrTest },
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
                      'div',
                      { style: { background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', marginBottom: 10 } },
                      h(antdRef.Typography.Text, { strong: true, style: { display: 'block', marginBottom: 8 } }, 'Rà soát & Chỉnh sửa giá trị OCR trước khi tạo bản ghi:'),
                      h(
                        antdRef.Row,
                        { gutter: [8, 8] },
                        (OCR_COLLECTION_FIELDS[targetCollection] || OCR_COLLECTION_FIELDS.latticeOrders).map(([fieldKey, label]) => h(
                          antdRef.Col,
                          { key: fieldKey, xs: 24, sm: 12 },
                          h('div', { style: { fontSize: 11, color: '#475569', marginBottom: 2 } }, label),
                          h(antdRef.Input, {
                            'data-testid': `dxos-para-ocr-field-${fieldKey}`,
                            size: 'small',
                            value: ocrDraftValues?.[fieldKey] ?? '',
                            onChange: (e) => setOcrDraftValues((prev) => ({ ...prev, [fieldKey]: e?.target?.value ?? '' })),
                          }),
                        )),
                      ),
                      h(
                        antdRef.Space,
                        { style: { marginTop: 10 }, wrap: true },
                        h(
                          antdRef.Button,
                          {
                            'data-testid': 'dxos-para-ocr-create-record-btn',
                            type: 'primary',
                            loading: ocrCreating,
                            onClick: handleCreateRecordFromOcr,
                          },
                          'Tạo bản ghi từ OCR',
                        ),
                      ),
                    ),
                    ocrCreatedRecord ? h(antdRef.Alert, {
                      'data-testid': 'dxos-para-ocr-created-alert',
                      type: 'success',
                      showIcon: true,
                      style: { marginBottom: 10 },
                      message: `Đã tạo thành công bản ghi ${ocrCreatedRecord.code || `#${ocrCreatedRecord.id || ''}`} trong ${ocrCreatedRecord.collection} — Xem tại ${ocrCreatedRecord.portalPath}`,
                    }) : null,
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

          h(
            ModalComp,
            {
              'data-testid': 'dxos-para-doc-modal',
              open: docModalOpen,
              title: docFormMode === 'edit' ? `Chỉnh sửa tài liệu ${docDraft.code}` : 'Tạo mới tài liệu P.A.R.A.',
              okText: docFormMode === 'edit' ? 'Cập nhật' : 'Tạo mới',
              cancelText: 'Hủy',
              confirmLoading: docSaving,
              onOk: handleSaveDoc,
              onCancel: () => setDocModalOpen(false),
            },
            h(
              antdRef.Space,
              { direction: 'vertical', style: { width: '100%' } },
              h(antdRef.Input, {
                'data-testid': 'dxos-para-doc-code-input',
                placeholder: 'Mã tài liệu (VD: SOP-CL-02)',
                value: docDraft.code,
                onChange: (e) => setDocDraft((p) => ({ ...p, code: e?.target?.value ?? '' })),
              }),
              h(antdRef.Input, {
                'data-testid': 'dxos-para-doc-title-input',
                placeholder: 'Tiêu đề tài liệu P.A.R.A.',
                value: docDraft.title,
                onChange: (e) => setDocDraft((p) => ({ ...p, title: e?.target?.value ?? '' })),
              }),
              h(
                antdRef.Space,
                { wrap: true },
                h(antdRef.Select, {
                  value: docDraft.paraSpace,
                  style: { width: 200 },
                  options: Object.entries(PARA_SPACE_LABELS).map(([value, label]) => ({ value, label })),
                  onChange: (val) => setDocDraft((p) => ({ ...p, paraSpace: val })),
                }),
                h(antdRef.Select, {
                  value: docDraft.status,
                  style: { width: 200 },
                  options: PARA_STATUS_OPTIONS,
                  onChange: (val) => setDocDraft((p) => ({ ...p, status: val })),
                }),
              ),
              h(antdRef.Input, {
                placeholder: 'Thẻ (tags, phân cách bằng dấu phẩy)',
                value: docDraft.tags,
                onChange: (e) => setDocDraft((p) => ({ ...p, tags: e?.target?.value ?? '' })),
              }),
              h(antdRef.Input, {
                placeholder: 'Tóm tắt ngắn',
                value: docDraft.summary,
                onChange: (e) => setDocDraft((p) => ({ ...p, summary: e?.target?.value ?? '' })),
              }),
              h(antdRef.Input.TextArea, {
                rows: 5,
                placeholder: 'Nội dung Markdown tài liệu…',
                value: docDraft.contentMarkdown,
                onChange: (e) => setDocDraft((p) => ({ ...p, contentMarkdown: e?.target?.value ?? '' })),
              }),
            ),
          ),

          h(
            ModalComp,
            {
              'data-testid': 'dxos-para-doc-preview-modal',
              open: previewOpen,
              title: previewDoc ? `${previewDoc.code || ''} — ${previewDoc.title || 'Chi tiết tài liệu'}` : 'Chi tiết tài liệu P.A.R.A.',
              footer: null,
              onCancel: () => setPreviewOpen(false),
              width: 720,
            },
            previewLoading ? h(antdRef.Spin, { tip: 'Đang tải nội dung tài liệu…' }) : null,
            previewDoc ? h(
              antdRef.Space,
              { direction: 'vertical', style: { width: '100%' } },
              h(
                antdRef.Space,
                { wrap: true },
                h(antdRef.Tag, { color: 'blue' }, PARA_SPACE_LABELS[previewDoc.paraSpace] || previewDoc.paraSpace || '—'),
                previewDoc.status ? h(antdRef.Tag, null, `Trạng thái: ${previewDoc.status}`) : null,
                previewDoc.matchedCitation ? h(antdRef.Tag, { color: 'purple' }, `Trích dẫn: ${previewDoc.matchedCitation}`) : null,
              ),
              previewDoc.summary ? h(antdRef.Typography.Paragraph, { strong: true }, previewDoc.summary) : null,
              previewDoc.matchedSnippet ? h(antdRef.Alert, { type: 'info', message: `Đoạn khớp: ${previewDoc.matchedSnippet}` }) : null,
              h(
                'pre',
                { style: { background: '#f8fafc', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap', maxHeight: 360, overflowY: 'auto' } },
                previewDoc.contentMarkdown || previewDoc.summary || 'Chưa có nội dung chi tiết.',
              ),
            ) : null,
          ),

          h(
            ModalComp,
            {
              'data-testid': 'dxos-para-extract-modal',
              open: extractModalOpen,
              title: extractTargetDoc ? `Đính kèm & Trích xuất cho ${extractTargetDoc.code || extractTargetDoc.title}` : 'Đính kèm & Trích xuất',
              okText: 'Trích xuất & Lập chỉ mục',
              cancelText: 'Hủy',
              confirmLoading: extracting,
              onOk: handleExtractAttachment,
              onCancel: () => setExtractModalOpen(false),
            },
            h(
              antdRef.Space,
              { direction: 'vertical', style: { width: '100%' } },
              h(antdRef.Typography.Text, null, 'Chọn tệp PDF / DOCX / XLSX / PPTX / TXT / Markdown (tối đa 2 MiB) để trích xuất và lập chỉ mục vector cho tài liệu này.'),
              h('input', {
                type: 'file',
                accept: '.pdf,.docx,.xlsx,.pptx,.csv,.txt,.md',
                onChange: handleExtractFileSelect,
              }),
              extractFilename ? h(antdRef.Tag, { color: 'blue' }, `Đã chọn: ${extractFilename}`) : null,
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

  return {
    __esModule: true,
    default: DxosParaClientPlugin,
    createDxosParaSettingsPage,
    buildOcrRecordPayload,
  };
});

/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const PUBLIC_FORM_CORE_COLLECTIONS = Object.freeze([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeLocations',
  'latticeAssets',
  'latticeAgentProposals',
]);

const PUBLIC_FORM_FIELD_TYPES = Object.freeze([
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'email',
  'select',
  'file',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROTECTED_FORM_FIELDS = new Set([
  'id',
  'organizationId',
  'status',
  'version',
  'amendedFromId',
  'amendmentNo',
  'requesterId',
  'assigneeId',
  'submittedBy',
  'cancelledBy',
  'userId',
  'identitySubject',
  'createdAt',
  'updatedAt',
  'createdById',
  'updatedById',
]);

const CORE_COLLECTION_FIELD_PRESETS = Object.freeze({
  latticeRequests: [
    { name: 'subject', label: 'Tiêu đề yêu cầu', type: 'string', required: true },
    { name: 'description', label: 'Mô tả chi tiết', type: 'text' },
    { name: 'requesterEmail', label: 'Email liên hệ', type: 'email' },
    { name: 'priority', label: 'Mức ưu tiên', type: 'select', enumText: 'low, normal, high, urgent' },
  ],
  latticeServiceTickets: [
    { name: 'title', label: 'Tiêu đề sự cố', type: 'string', required: true },
    { name: 'description', label: 'Chi tiết', type: 'text' },
    { name: 'contactEmail', label: 'Email khách hàng', type: 'email' },
    { name: 'severity', label: 'Mức độ', type: 'select', enumText: 'low, medium, high, critical' },
  ],
  latticeOrders: [
    { name: 'customerName', label: 'Tên khách hàng', type: 'string', required: true },
    { name: 'customerEmail', label: 'Email khách hàng', type: 'email' },
    { name: 'note', label: 'Ghi chú đơn hàng', type: 'text' },
  ],
  latticeIncidentCases: [
    { name: 'title', label: 'Tên sự cố', type: 'string', required: true },
    { name: 'summary', label: 'Mô tả hiện trạng', type: 'text' },
    { name: 'severity', label: 'Mức độ', type: 'select', enumText: 'low, medium, high, critical' },
  ],
});

function unwrapData(res) {
  return res?.data?.data ?? res?.data ?? {};
}

function extractError(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || fallback;
}

function stripProtoKeys(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stripProtoKeys(item, seen));
  const out = {};
  for (const key of Object.keys(value)) {
    if (BLOCKED_PROTO_KEYS.has(key)) continue;
    const next = stripProtoKeys(value[key], seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function parseJsonSafe(rawText) {
  let blockedFound = false;
  const reviver = (k, v) => {
    if (BLOCKED_PROTO_KEYS.has(k)) {
      blockedFound = true;
      return undefined;
    }
    return v;
  };
  const parsed = JSON.parse(String(rawText || ''), reviver);
  if (blockedFound) {
    throw new Error('JSON chứa khóa bị cấm (__proto__/constructor/prototype).');
  }
  return stripProtoKeys(parsed);
}

function parseObjectJsonStrict(rawText, label) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const val = parseJsonSafe(trimmed);
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      return { ok: false, error: `${label} phải là JSON object hợp lệ.` };
    }
    return { ok: true, value: val };
  } catch (err) {
    return { ok: false, error: err?.message?.includes('khóa bị cấm') ? err.message : `${label} không phải JSON hợp lệ.` };
  }
}

function mapDomainFieldType(rawType) {
  const t = String(rawType || 'string').toLowerCase();
  if (PUBLIC_FORM_FIELD_TYPES.includes(t)) return t;
  if (t === 'float' || t === 'decimal') return 'number';
  if (t === 'datetime') return 'date';
  return 'string';
}

function makeStyles() {
  return {
    stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 14 },
    card: { padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 12 },
    subCard: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 10 },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, minWidth: 0 },
    grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, minWidth: 0 },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    rowWrap: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 },
    input: { width: '100%', padding: '7px 9px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: '#ffffff' },
    textarea: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box', background: '#ffffff' },
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
      padding: '6px 11px',
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

function emptyEditorState() {
  return {
    id: null,
    slug: '',
    title: '',
    description: '',
    targetCollection: 'latticeRequests',
    workflowRuleKey: '',
    active: true,
    requireAccessToken: false,
    accessToken: '',
    honeypotField: '_hp_website',
    rateLimitPerMinute: 20,
    defaultValuesText: '{}',
    allowedFields: [],
  };
}

function normalizeFormField(f) {
  const optionsArr = typeof f.enumText === 'string'
    ? f.enumText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    : (Array.isArray(f.options) ? f.options : []);
  const out = {
    name: String(f.name || '').trim(),
    label: String(f.label || f.title || f.name || '').trim(),
    type: mapDomainFieldType(f.type),
    required: Boolean(f.required),
  };
  if (f.maxLength != null && f.maxLength !== '') out.maxLength = Number(f.maxLength);
  if (f.pattern) out.pattern = String(f.pattern);
  if (optionsArr.length) out.options = optionsArr;
  return out;
}

function copyTextSafely(text, onDone) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      Promise.resolve(navigator.clipboard.writeText(String(text || '')))
        .then(() => onDone?.(true))
        .catch(() => onDone?.(false));
      return;
    }
  } catch {
    // fallback below
  }
  onDone?.(false);
}

function createPublicFormBuilderPanel(client, React, _antd, app) {
  const h = React.createElement;
  const S = makeStyles();

  return function PublicFormBuilderPanelInner(props = {}) {
    const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
    const hookApi = useApi();
    const api = props.api || hookApi;
    const hasApi = Boolean(api?.request);

    const [discoveredOrgs, setDiscoveredOrgs] = React.useState([]);
    const [orgOverride, setOrgOverride] = React.useState(null);
    const [forms, setForms] = React.useState([]);
    const [domains, setDomains] = React.useState([]);
    const [editor, setEditor] = React.useState(emptyEditorState);
    const [ephemeralToken, setEphemeralToken] = React.useState('');
    const [copiedLink, setCopiedLink] = React.useState('');
    const [feedback, setFeedback] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [statusQuery, setStatusQuery] = React.useState({ slug: '', submissionCode: '', token: '' });
    const [statusPreview, setStatusPreview] = React.useState(null);
    const [submissionsDrawer, setSubmissionsDrawer] = React.useState({
      open: false,
      form: null,
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      status: 'all',
      search: '',
      loading: false,
      selectedItem: null,
    });
    const [previewForm, setPreviewForm] = React.useState(null);
    const [runtimeRef] = React.useState(() => ({ api }));
    runtimeRef.api = api;

    React.useEffect(() => {
      setOrgOverride(null);
    }, [props.selectedOrg]);

    const propOrgs = Array.isArray(props.organizations) ? props.organizations : [];
    const organizations = propOrgs.length ? propOrgs : discoveredOrgs;
    const orgInputValue = orgOverride !== null
      ? orgOverride
      : String(props.selectedOrg || discoveredOrgs[0] || '');
    const effectiveOrg = String(orgInputValue).trim();
    const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};

    function reportFeedback(fb) {
      if (typeof props.setFeedback === 'function') {
        props.setFeedback(fb);
        setFeedback(null);
      } else {
        setFeedback(fb);
      }
    }

    async function loadData(currentApi, orgId) {
      if (!currentApi?.request) return;
      const params = orgId ? { organizationId: orgId } : {};
      const [formsRes, domainsRes] = await Promise.all([
        currentApi.request({ url: 'dxosForms:list', method: 'get', params, skipNotify: true }),
        currentApi.request({ url: 'dxosBuilder:listDomains', method: 'get', params, skipNotify: true }).catch(() => null),
      ]);
      const fd = unwrapData(formsRes);
      setForms((Array.isArray(fd.items) ? fd.items : Array.isArray(fd.forms) ? fd.forms : []).filter((x) => x && typeof x === 'object'));
      if (domainsRes) {
        const dd = unwrapData(domainsRes);
        setDomains((Array.isArray(dd.items) ? dd.items : []).filter((x) => x && typeof x === 'object'));
      }
    }

    React.useEffect(() => {
      if (!hasApi) return;
      let cancelled = false;
      async function init() {
        let activeOrg = String(props.selectedOrg || '').trim();
        if (!activeOrg && !propOrgs.length) {
          try {
            const empRes = await api.request({ url: 'dxosStudio:listEmployees', method: 'get', skipNotify: true });
            const ed = unwrapData(empRes);
            const orgs = Array.isArray(ed.organizations) ? ed.organizations : [];
            if (!cancelled && orgs.length) {
              setDiscoveredOrgs(orgs);
              activeOrg = orgs[0];
            }
          } catch {
            // optional fallback
          }
        }
        try {
          await loadData(api, activeOrg || effectiveOrg);
        } catch (err) {
          if (!cancelled) reportFeedback({ type: 'error', text: extractError(err, 'Không thể tải danh sách Public Forms.') });
        }
      }
      init();
      return () => { cancelled = true; };
    }, [hasApi, props.selectedOrg]);

    const domainCatalog = React.useMemo(() => {
      const map = new Map();
      for (const col of PUBLIC_FORM_CORE_COLLECTIONS) {
        map.set(col, CORE_COLLECTION_FIELD_PRESETS[col] || []);
      }
      for (const d of domains) {
        const colName = String(d?.collectionName || '').trim();
        if (!colName) continue;
        if (!PUBLIC_FORM_CORE_COLLECTIONS.includes(colName) && !CUSTOM_COLLECTION_RE.test(colName)) continue;
        const fields = (Array.isArray(d.fields) ? d.fields : [])
          .filter((f) => f?.name && !PROTECTED_FORM_FIELDS.has(f.name))
          .map((f) => ({
            name: f.name,
            label: f.title || f.label || f.name,
            type: mapDomainFieldType(f.type),
            required: Boolean(f.required),
          }));
        if (fields.length || !map.has(colName)) map.set(colName, fields);
      }
      return map;
    }, [domains]);

    const collectionOptions = Array.from(domainCatalog.keys());
    const availablePickerFields = (domainCatalog.get(editor.targetCollection) || [])
      .filter((f) => f?.name && !PROTECTED_FORM_FIELDS.has(f.name));

    function loadFormIntoEditor(form) {
      setEditor({
        id: form.id || null,
        slug: form.slug || '',
        title: form.title || '',
        description: form.description || '',
        targetCollection: form.targetCollection || 'latticeRequests',
        workflowRuleKey: form.workflowRuleKey || '',
        active: form.active !== false,
        requireAccessToken: Boolean(form.requireAccessToken),
        accessToken: '',
        honeypotField: form.honeypotField || '_hp_website',
        rateLimitPerMinute: Number(form.rateLimitPerMinute) || 20,
        defaultValuesText: JSON.stringify(form.defaultValuesJson || {}, null, 2),
        allowedFields: (Array.isArray(form.allowedFieldsJson) ? form.allowedFieldsJson : [])
          .filter((x) => x && typeof x === 'object')
          .map((f) => {
            const { options, ...rest } = f;
            return {
              ...rest,
              enumText: Array.isArray(options) ? options.join(', ') : (f.enumText || ''),
            };
          }),
      });
    }

    function addPickedField(field) {
      if (!field?.name || PROTECTED_FORM_FIELDS.has(field.name)) return;
      setEditor((prev) => {
        if (prev.allowedFields.some((f) => f.name === field.name)) return prev;
        return {
          ...prev,
          allowedFields: [...prev.allowedFields, {
            name: field.name,
            label: field.label || field.name,
            type: mapDomainFieldType(field.type),
            required: Boolean(field.required),
            maxLength: '',
            pattern: '',
            enumText: field.enumText || '',
          }],
        };
      });
    }

    function addCustomFieldRow() {
      setEditor((prev) => ({
        ...prev,
        allowedFields: [
          ...prev.allowedFields,
          { name: `field_${prev.allowedFields.length + 1}`, label: 'Trường mới', type: 'string', required: false, maxLength: '', pattern: '', enumText: '' },
        ],
      }));
    }

    function updateFieldRow(idx, patch) {
      setEditor((prev) => ({
        ...prev,
        allowedFields: prev.allowedFields.map((row, i) => {
          if (i !== idx) return row;
          const next = { ...row, ...patch };
          if (Object.prototype.hasOwnProperty.call(patch, 'enumText')) {
            delete next.options;
          }
          return next;
        }),
      }));
    }

    function removeFieldRow(idx) {
      setEditor((prev) => ({
        ...prev,
        allowedFields: prev.allowedFields.filter((_, i) => i !== idx),
      }));
    }

    async function handleSave(e) {
      e?.preventDefault?.();
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;

      const cleanSlug = String(editor.slug || '').trim();
      if (!SLUG_RE.test(cleanSlug)) {
        reportFeedback({ type: 'error', text: 'Slug không hợp lệ (chỉ gồm a-z, 0-9, dấu gạch ngang, dài 3-63 ký tự).' });
        return;
      }
      const cleanTitle = String(editor.title || '').trim();
      if (!cleanTitle) {
        reportFeedback({ type: 'error', text: 'Vui lòng nhập tiêu đề Form.' });
        return;
      }
      const parsedDefaults = parseObjectJsonStrict(editor.defaultValuesText, 'defaultValuesJson');
      if (!parsedDefaults.ok) {
        reportFeedback({ type: 'error', text: parsedDefaults.error });
        return;
      }
      const allowedFieldsJson = editor.allowedFields
        .filter((x) => x && typeof x === 'object')
        .map(normalizeFormField)
        .filter((f) => f.name && !PROTECTED_FORM_FIELDS.has(f.name) && !BLOCKED_PROTO_KEYS.has(f.name));

      const rateLimit = Math.max(1, Math.min(300, Number(editor.rateLimitPerMinute) || 20));
      const payload = {
        ...orgPayload,
        ...(editor.id ? { id: editor.id } : {}),
        slug: cleanSlug,
        title: cleanTitle,
        description: String(editor.description || ''),
        targetCollection: editor.targetCollection,
        allowedFieldsJson,
        defaultValuesJson: parsedDefaults.value,
        workflowRuleKey: String(editor.workflowRuleKey || '').trim(),
        active: Boolean(editor.active),
        requireAccessToken: Boolean(editor.requireAccessToken),
        ...(String(editor.accessToken || '').trim() ? { accessToken: String(editor.accessToken).trim() } : {}),
        honeypotField: String(editor.honeypotField || '_hp_website').trim() || '_hp_website',
        rateLimitPerMinute: rateLimit,
      };

      setBusy(true);
      reportFeedback(null);
      try {
        const res = await clientApi.request({ url: 'dxosForms:save', method: 'post', data: payload });
        const d = unwrapData(res);
        const tok = d.accessToken || d.token || d.form?.accessToken || '';
        if (tok) setEphemeralToken(String(tok));
        setEditor((prev) => ({ ...prev, id: d.id ?? d.form?.id ?? prev.id, accessToken: '' }));
        await loadData(clientApi, effectiveOrg);
        reportFeedback({ type: 'ok', text: `Đã lưu Public Form "${cleanSlug}".` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không thể lưu Public Form.') });
      } finally {
        setBusy(false);
      }
    }

    async function handleRotateToken(form) {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      setBusy(true);
      reportFeedback(null);
      try {
        const res = await clientApi.request({
          url: 'dxosForms:rotateToken',
          method: 'post',
          data: { ...orgPayload, ...(form.id ? { id: form.id } : {}), slug: form.slug },
        });
        const d = unwrapData(res);
        const tok = d.accessToken || d.token || '';
        if (tok) setEphemeralToken(String(tok));
        await loadData(clientApi, effectiveOrg);
        reportFeedback({ type: 'ok', text: `Đã xoay Access Token cho "${form.slug}".` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không thể xoay token.') });
      } finally {
        setBusy(false);
      }
    }

    async function handleDelete(form) {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      setBusy(true);
      reportFeedback(null);
      try {
        await clientApi.request({
          url: 'dxosForms:delete',
          method: 'post',
          data: { ...orgPayload, ...(form.id ? { id: form.id } : {}), slug: form.slug },
        });
        await loadData(clientApi, effectiveOrg);
        reportFeedback({ type: 'ok', text: `Đã xóa Form "${form.slug}".` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không thể xóa Form.') });
      } finally {
        setBusy(false);
      }
    }

    async function loadSubmissions(targetForm, opts = {}) {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || !targetForm?.slug) return;
      const nextStatus = opts.status ?? submissionsDrawer.status ?? 'all';
      const nextSearch = opts.search ?? submissionsDrawer.search ?? '';
      const nextPage = Math.max(1, Number(opts.page || submissionsDrawer.page || 1));
      setSubmissionsDrawer((p) => ({
        ...p,
        open: true,
        form: targetForm,
        status: nextStatus,
        search: nextSearch,
        page: nextPage,
        loading: true,
      }));
      try {
        const res = await clientApi.request({
          url: 'dxosForms:listSubmissions',
          method: 'get',
          params: {
            ...orgPayload,
            slug: targetForm.slug,
            page: nextPage,
            pageSize: 20,
            ...(nextStatus && nextStatus !== 'all' ? { status: nextStatus } : {}),
            ...(String(nextSearch).trim() ? { search: String(nextSearch).trim() } : {}),
          },
          skipNotify: true,
        });
        const d = unwrapData(res);
        const items = Array.isArray(d.items) ? d.items : [];
        setSubmissionsDrawer((p) => ({
          ...p,
          open: true,
          form: targetForm,
          items,
          total: Number(d.total ?? items.length) || 0,
          page: Number(d.page || nextPage) || 1,
          pageSize: Number(d.pageSize || 20) || 20,
          loading: false,
          selectedItem: p.selectedItem && items.some((it) => (it.id || it.submissionCode) === (p.selectedItem.id || p.selectedItem.submissionCode))
            ? p.selectedItem
            : (items[0] || null),
        }));
      } catch (err) {
        setSubmissionsDrawer((p) => ({ ...p, loading: false }));
        reportFeedback({ type: 'error', text: extractError(err, 'Không tải được danh sách hồ sơ nộp.') });
      }
    }

    function openLivePreview(formObj) {
      const fields = Array.isArray(formObj?.allowedFields)
        ? formObj.allowedFields.map(normalizeFormField)
        : (Array.isArray(formObj?.allowedFieldsJson) ? formObj.allowedFieldsJson : []);
      setPreviewForm({
        slug: formObj?.slug || 'draft-form',
        title: formObj?.title || formObj?.slug || 'Xem thử Public Form',
        description: formObj?.description || '',
        targetCollection: formObj?.targetCollection || 'latticeRequests',
        requireAccessToken: Boolean(formObj?.requireAccessToken),
        honeypotField: formObj?.honeypotField || '_hp_website',
        fields: fields.filter((x) => x && typeof x === 'object'),
      });
    }

    async function handleStatusLookup(e) {
      e?.preventDefault?.();
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      const slug = String(statusQuery.slug || '').trim();
      const submissionCode = String(statusQuery.submissionCode || '').trim();
      if (!slug || !submissionCode) {
        reportFeedback({ type: 'error', text: 'Nhập slug và submissionCode để tra cứu trạng thái.' });
        return;
      }
      setBusy(true);
      reportFeedback(null);
      try {
        const res = await clientApi.request({
          url: 'dxosForms:status',
          method: 'get',
          params: {
            slug,
            submissionCode,
            ...(String(statusQuery.token || '').trim() ? { token: String(statusQuery.token).trim() } : {}),
          },
        });
        const d = unwrapData(res);
        setStatusPreview({
          slug: d.slug || slug,
          submissionCode: d.submissionCode || submissionCode,
          status: d.status || 'unknown',
          submittedAt: d.submittedAt || null,
          updatedAt: d.updatedAt || null,
        });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không tìm thấy hồ sơ.') });
      } finally {
        setBusy(false);
      }
    }

    return h('div', { 'data-testid': 'dxos-public-form-builder', style: S.stack },
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16, color: '#0f172a' } }, 'Public Form Builder (/v/form/:slug)'),
            h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Cấu hình biểu mẫu công khai fail-closed: allowlist trường, rate limit, honeypot & access token.'),
          ),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-forms-refresh-btn',
            onClick: () => loadData(runtimeRef.api, effectiveOrg),
            style: S.btn(false, false, busy),
          }, 'Tải lại'),
        ),

        !props.selectedOrg || organizations.length > 1
          ? h('div', { style: { ...S.rowWrap, fontSize: 12 } },
            h('span', { style: { fontWeight: 600, color: '#475569' } }, 'Organization ID:'),
            h('input', {
              'data-testid': 'dxos-forms-org-input',
              type: 'text',
              value: orgInputValue,
              placeholder: 'org-a',
              onChange: (e) => setOrgOverride(e.target.value),
              style: { ...S.input, width: 220 },
            }),
          )
          : null,

        feedback
          ? h('div', {
            role: 'status',
            style: {
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              background: feedback.type === 'error' ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${feedback.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
              color: feedback.type === 'error' ? '#991b1b' : '#166534',
            },
          }, feedback.text)
          : null,

        ephemeralToken
          ? h('div', {
            'data-testid': 'dxos-form-token-once',
            role: 'alert',
            style: { padding: 12, borderRadius: 8, border: '1px solid #f59e0b', background: '#fffbeb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
          },
            h('div', { style: { fontSize: 12, color: '#92400e' } },
              h('strong', null, 'Access Token hiển thị 1 lần (lưu ngay, không lưu vào trình duyệt): '),
              h('code', null, ephemeralToken),
            ),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-form-token-dismiss',
              onClick: () => setEphemeralToken(''),
              style: S.btn(false, false, false),
            }, 'Đã lưu / Ẩn token'),
          )
          : null,

        copiedLink
          ? h('div', { 'data-testid': 'dxos-forms-link-preview', style: { fontSize: 12, color: '#1e40af', background: '#eff6ff', padding: '6px 10px', borderRadius: 6, border: '1px solid #bfdbfe' } },
            `Đường dẫn công khai: ${copiedLink}`,
          )
          : null,

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-forms-table', style: S.table },
            h('thead', null, h('tr', null, ['Slug', 'Tiêu đề', 'Collection', 'Số trường', 'Bảo mật', 'Trạng thái', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !forms.length
                ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có Public Form nào.'))
                : forms.filter((x) => x && typeof x === 'object').map((f) => h('tr', { key: f.id || f.slug },
                  h('td', { style: S.td }, h('code', null, f.slug)),
                  h('td', { style: S.td }, f.title || '-'),
                  h('td', { style: S.td }, h('code', null, f.targetCollection)),
                  h('td', { style: S.td }, Array.isArray(f.allowedFieldsJson) ? f.allowedFieldsJson.filter((x) => x && typeof x === 'object').length : 0),
                  h('td', { style: S.td },
                    h('div', { style: S.rowWrap },
                      h('span', { style: S.badge(f.requireAccessToken ? 'warn' : 'neutral') }, f.requireAccessToken ? 'Token' : 'Public'),
                      h('span', { style: S.badge('info') }, `${f.rateLimitPerMinute || 20}/phút`),
                      h('span', { style: S.badge('neutral') }, `HP: ${f.honeypotField || '_hp_website'}`),
                    ),
                  ),
                  h('td', { style: S.td }, h('span', { style: S.badge(f.active !== false ? 'ok' : 'danger') }, f.active !== false ? 'Active' : 'Inactive')),
                  h('td', { style: S.td },
                    h('div', { style: S.rowWrap },
                      h('button', { type: 'button', 'data-testid': `dxos-forms-edit-${f.slug}`, onClick: () => loadFormIntoEditor(f), style: S.btn(false) }, 'Sửa'),
                      h('button', { type: 'button', 'data-testid': `dxos-forms-submissions-${f.slug}`, onClick: () => loadSubmissions(f, { page: 1, status: 'all', search: '' }), style: S.btn(false) }, 'Hồ sơ nộp'),
                      h('button', { type: 'button', 'data-testid': `dxos-forms-preview-${f.slug}`, onClick: () => openLivePreview(f), style: S.btn(false) }, 'Xem thử'),
                      h('button', {
                        type: 'button',
                        'data-testid': `dxos-forms-copy-link-${f.slug}`,
                        onClick: () => {
                          const link = `/v/form/${f.slug}`;
                          setCopiedLink(link);
                          copyTextSafely(link, (ok) => reportFeedback({ type: 'ok', text: ok ? `Đã sao chép ${link}` : `Link: ${link}` }));
                        },
                        style: S.btn(false),
                      }, 'Copy Link'),
                      h('button', { type: 'button', 'data-testid': `dxos-forms-rotate-token-${f.slug}`, onClick: () => handleRotateToken(f), style: S.btn(false) }, 'Xoay Token'),
                      h('button', { type: 'button', 'data-testid': `dxos-forms-delete-${f.slug}`, onClick: () => handleDelete(f), style: S.btn(false, true) }, 'Xóa'),
                    ),
                  ),
                )),
            ),
          ),
        ),
      ),

      h('form', { 'data-testid': 'dxos-forms-save-form', onSubmit: handleSave, style: S.card },
        h('div', { style: S.rowBetween },
          h('h4', { style: { margin: 0, fontSize: 14, color: '#0f172a' } }, editor.id ? `Chỉnh sửa Form: ${editor.slug}` : 'Tạo Public Form mới'),
          h('div', { style: S.rowWrap },
            h('button', { type: 'button', 'data-testid': 'dxos-forms-editor-preview-btn', onClick: () => openLivePreview(editor), style: S.btn(false) }, 'Xem thử Form'),
            h('button', { type: 'button', 'data-testid': 'dxos-forms-reset-btn', onClick: () => setEditor(emptyEditorState()), style: S.btn(false) }, 'Form mới'),
          ),
        ),
        h('div', { style: S.grid3 },
          h('div', null,
            h('label', { style: S.label }, 'Slug *'),
            h('input', {
              'data-testid': 'dxos-forms-slug-input',
              type: 'text',
              value: editor.slug,
              placeholder: 'partner-intake-01',
              onChange: (e) => setEditor((p) => ({ ...p, slug: e.target.value })),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Tiêu đề Form *'),
            h('input', {
              'data-testid': 'dxos-forms-title-input',
              type: 'text',
              value: editor.title,
              placeholder: 'Tiếp nhận yêu cầu đối tác',
              onChange: (e) => setEditor((p) => ({ ...p, title: e.target.value })),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Collection đích *'),
            h('select', {
              'data-testid': 'dxos-forms-collection-select',
              value: editor.targetCollection,
              onChange: (e) => setEditor((p) => ({ ...p, targetCollection: e.target.value })),
              style: S.input,
            }, collectionOptions.map((col) => h('option', { key: col, value: col }, col))),
          ),
        ),
        h('div', { style: S.grid2 },
          h('div', null,
            h('label', { style: S.label }, 'Mô tả'),
            h('input', {
              'data-testid': 'dxos-forms-description-input',
              type: 'text',
              value: editor.description,
              onChange: (e) => setEditor((p) => ({ ...p, description: e.target.value })),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Workflow Rule Key (tùy chọn)'),
            h('input', {
              'data-testid': 'dxos-forms-workflow-input',
              type: 'text',
              value: editor.workflowRuleKey,
              placeholder: 'wf_public_intake',
              onChange: (e) => setEditor((p) => ({ ...p, workflowRuleKey: e.target.value })),
              style: S.input,
            }),
          ),
        ),
        h('div', { style: S.subCard },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 12, color: '#334155' } }, 'Chọn trường cho phép (Allowlist Field Picker)'),
            h('button', { type: 'button', 'data-testid': 'dxos-forms-add-custom-field', onClick: addCustomFieldRow, style: S.btn(false) }, '+ Thêm trường tùy chỉnh'),
          ),
          h('div', { 'data-testid': 'dxos-forms-field-picker', style: S.rowWrap },
            availablePickerFields.map((f) => h('button', {
              key: f.name,
              type: 'button',
              'data-testid': `dxos-forms-pick-field-${f.name}`,
              onClick: () => addPickedField(f),
              style: S.btn(false),
            }, `+ ${f.label} (${f.name})`)),
          ),
          editor.allowedFields.filter((x) => x && typeof x === 'object').map((row, idx) => h('div', {
            key: `${row.name}-${idx}`,
            'data-testid': `dxos-forms-field-row-${idx}`,
            style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, padding: 8, background: '#ffffff', borderRadius: 6, border: '1px solid #e2e8f0' },
          },
            h('div', { style: S.grid3 },
              h('input', { type: 'text', value: row.name, placeholder: 'field_name', onChange: (e) => updateFieldRow(idx, { name: e.target.value }), style: S.input }),
              h('input', { type: 'text', value: row.label, placeholder: 'Nhãn hiển thị', onChange: (e) => updateFieldRow(idx, { label: e.target.value }), style: S.input }),
              h('div', { style: S.rowWrap },
                h('select', { 'data-testid': `dxos-forms-field-type-${idx}`, value: row.type, onChange: (e) => updateFieldRow(idx, { type: e.target.value }), style: { ...S.input, width: 110 } },
                  PUBLIC_FORM_FIELD_TYPES.map((ft) => h('option', { key: ft, value: ft }, ft)),
                ),
                h('label', { style: { fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 } },
                  h('input', { type: 'checkbox', checked: Boolean(row.required), onChange: (e) => updateFieldRow(idx, { required: e.target.checked }) }),
                  'Bắt buộc',
                ),
                h('button', { type: 'button', onClick: () => removeFieldRow(idx), style: S.btn(false, true) }, 'Xóa'),
              ),
            ),
            h('div', { style: S.grid3 },
              row.type === 'select' ? h('input', {
                'data-testid': `dxos-forms-field-options-${idx}`,
                type: 'text',
                value: row.enumText ?? (Array.isArray(row.options) ? row.options.join(', ') : ''),
                placeholder: 'Tùy chọn select (cách nhau dấu phẩy: low, high, urgent)',
                onChange: (e) => updateFieldRow(idx, { enumText: e.target.value, options: undefined }),
                style: S.input,
              }) : null,
              ['string', 'text', 'email'].includes(row.type) ? h('input', {
                'data-testid': `dxos-forms-field-maxlen-${idx}`,
                type: 'number',
                min: 1,
                value: row.maxLength ?? '',
                placeholder: 'Độ dài tối đa (maxLength)',
                onChange: (e) => updateFieldRow(idx, { maxLength: e.target.value }),
                style: S.input,
              }) : null,
              ['string', 'text', 'email'].includes(row.type) ? h('input', {
                'data-testid': `dxos-forms-field-pattern-${idx}`,
                type: 'text',
                value: row.pattern || '',
                placeholder: 'Regex pattern (tùy chọn)',
                onChange: (e) => updateFieldRow(idx, { pattern: e.target.value }),
                style: S.input,
              }) : null,
            ),
          )),
        ),
        h('div', { style: S.grid3 },
          h('div', null,
            h('label', { style: S.label }, 'Honeypot Field'),
            h('input', {
              'data-testid': 'dxos-forms-honeypot-input',
              type: 'text',
              value: editor.honeypotField,
              onChange: (e) => setEditor((p) => ({ ...p, honeypotField: e.target.value })),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Rate Limit / phút (1-300)'),
            h('input', {
              'data-testid': 'dxos-forms-ratelimit-input',
              type: 'number',
              value: editor.rateLimitPerMinute,
              onChange: (e) => setEditor((p) => ({ ...p, rateLimitPerMinute: e.target.value })),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Access Token khởi tạo (tùy chọn)'),
            h('input', {
              'data-testid': 'dxos-forms-initial-token-input',
              type: 'password',
              value: editor.accessToken,
              placeholder: 'Để trống để server tự sinh nếu bật Token',
              onChange: (e) => setEditor((p) => ({ ...p, accessToken: e.target.value })),
              style: S.input,
            }),
          ),
        ),
        h('div', { style: S.rowWrap },
          h('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              'data-testid': 'dxos-forms-require-token-checkbox',
              type: 'checkbox',
              checked: Boolean(editor.requireAccessToken),
              onChange: (e) => setEditor((p) => ({ ...p, requireAccessToken: e.target.checked })),
            }),
            'Yêu cầu Access Token khi submit/tra cứu',
          ),
          h('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              'data-testid': 'dxos-forms-active-checkbox',
              type: 'checkbox',
              checked: Boolean(editor.active),
              onChange: (e) => setEditor((p) => ({ ...p, active: e.target.checked })),
            }),
            'Kích hoạt Form',
          ),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Default Values JSON (chặn prototype pollution)'),
          h('textarea', {
            'data-testid': 'dxos-forms-defaults-input',
            rows: 3,
            value: editor.defaultValuesText,
            onChange: (e) => setEditor((p) => ({ ...p, defaultValuesText: e.target.value })),
            style: S.textarea,
          }),
        ),
        h('div', null,
          h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, busy ? 'Đang lưu…' : 'Lưu Public Form'),
        ),
      ),

      h('form', { 'data-testid': 'dxos-forms-status-preview-form', onSubmit: handleStatusLookup, style: S.card },
        h('h4', { style: { margin: 0, fontSize: 14, color: '#0f172a' } }, 'Tra cứu trạng thái Zero-PII (dxosForms:status)'),
        h('div', { style: S.grid3 },
          h('input', {
            'data-testid': 'dxos-forms-status-slug-input',
            type: 'text',
            value: statusQuery.slug,
            placeholder: 'slug',
            onChange: (e) => setStatusQuery((p) => ({ ...p, slug: e.target.value })),
            style: S.input,
          }),
          h('input', {
            'data-testid': 'dxos-forms-status-code-input',
            type: 'text',
            value: statusQuery.submissionCode,
            placeholder: 'submissionCode',
            onChange: (e) => setStatusQuery((p) => ({ ...p, submissionCode: e.target.value })),
            style: S.input,
          }),
          h('input', {
            'data-testid': 'dxos-forms-status-token-input',
            type: 'password',
            value: statusQuery.token,
            placeholder: 'Status Token (bắt buộc khi tra cứu)',
            onChange: (e) => setStatusQuery((p) => ({ ...p, token: e.target.value })),
            style: S.input,
          }),
        ),
        h('div', null,
          h('button', { type: 'submit', disabled: busy, style: S.btn(false, false, busy) }, 'Kiểm tra trạng thái'),
        ),
        statusPreview
          ? h('div', { 'data-testid': 'dxos-forms-status-preview-result', style: S.subCard },
            h('div', { style: S.rowWrap },
              h('strong', null, statusPreview.submissionCode),
              h('span', { style: S.badge('info') }, statusPreview.status),
              h('span', { style: { fontSize: 12, color: '#475569' } }, `Slug: ${statusPreview.slug}`),
              statusPreview.submittedAt ? h('span', { style: { fontSize: 12, color: '#64748b' } }, `Gửi lúc: ${statusPreview.submittedAt}`) : null,
            ),
          )
          : null,
      ),

      submissionsDrawer.open ? h('div', {
        'data-testid': 'dxos-forms-submissions-drawer',
        style: { ...S.card, border: '2px solid #93c5fd', background: '#f8fafc' },
      },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h4', { style: { margin: 0, fontSize: 15, color: '#0f172a' } }, `Hồ sơ đã nộp — /v/form/${submissionsDrawer.form?.slug || ''}`),
            h('div', { style: { fontSize: 12, color: '#64748b', marginTop: 2 } }, `Tổng ${submissionsDrawer.total} hồ sơ · Trang ${submissionsDrawer.page}`),
          ),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-forms-submissions-close-btn',
            onClick: () => setSubmissionsDrawer((p) => ({ ...p, open: false })),
            style: S.btn(false),
          }, 'Đóng Danh sách Hồ sơ'),
        ),
        h('div', { style: S.grid3 },
          h('select', {
            'data-testid': 'dxos-forms-submissions-status',
            value: submissionsDrawer.status,
            onChange: (e) => {
              const nextStatus = e?.target?.value || 'all';
              loadSubmissions(submissionsDrawer.form, { status: nextStatus, search: submissionsDrawer.search, page: 1 });
            },
            style: S.input,
          },
            ['all', 'pending', 'submitted', 'approved', 'rejected', 'completed', 'cancelled'].map((st) => h('option', { key: st, value: st }, `Trạng thái: ${st}`)),
          ),
          h('input', {
            'data-testid': 'dxos-forms-submissions-search',
            type: 'text',
            value: submissionsDrawer.search,
            placeholder: 'Tìm mã hồ sơ / trackingCode / payload…',
            onChange: (e) => setSubmissionsDrawer((p) => ({ ...p, search: e.target.value })),
            style: S.input,
          }),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-forms-submissions-refresh',
            disabled: submissionsDrawer.loading,
            onClick: () => loadSubmissions(submissionsDrawer.form, { status: submissionsDrawer.status, search: submissionsDrawer.search, page: 1 }),
            style: S.btn(true, false, submissionsDrawer.loading),
          }, submissionsDrawer.loading ? 'Đang tải…' : 'Lọc / Làm mới'),
        ),
        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-forms-submissions-table', style: S.table },
            h('thead', null, h('tr', null, ['Mã hồ sơ', 'Tracking', 'Trạng thái', 'Tệp đính kèm', 'Thời điểm nộp', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !(submissionsDrawer.items || []).length
                ? h('tr', null, h('td', { colSpan: 6, style: { ...S.td, color: '#64748b' } }, 'Chưa có hồ sơ nộp nào phù hợp bộ lọc.'))
                : submissionsDrawer.items.map((sub, sIdx) => {
                  const attCount = Array.isArray(sub.attachments) ? sub.attachments.length : (Array.isArray(sub.attachmentsJson) ? sub.attachmentsJson.length : 0);
                  const rowKey = sub.submissionCode || sub.submissionUid || sub.id || sIdx;
                  return h('tr', { key: rowKey },
                    h('td', { style: S.td }, h('code', null, sub.submissionCode || sub.submissionUid || `#${sub.id}`)),
                    h('td', { style: S.td }, sub.trackingCode || '-'),
                    h('td', { style: S.td }, h('span', { style: S.badge('info') }, sub.status || 'submitted')),
                    h('td', { style: S.td }, `${attCount} tệp`),
                    h('td', { style: S.td }, sub.submittedAt || sub.createdAt || '-'),
                    h('td', { style: S.td },
                      h('button', {
                        type: 'button',
                        'data-testid': `dxos-forms-submission-inspect-${rowKey}`,
                        onClick: () => setSubmissionsDrawer((p) => ({ ...p, selectedItem: sub })),
                        style: S.btn(false),
                      }, 'Xem Payload'),
                    ),
                  );
                }),
            ),
          ),
        ),
        submissionsDrawer.selectedItem ? h('div', {
          'data-testid': 'dxos-forms-submission-detail',
          style: { padding: 12, borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1', display: 'grid', gap: 8 },
        },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 13 } }, `Chi tiết hồ sơ: ${submissionsDrawer.selectedItem.submissionCode || submissionsDrawer.selectedItem.submissionUid || submissionsDrawer.selectedItem.id}`),
            h('span', { style: S.badge('info') }, submissionsDrawer.selectedItem.status || 'submitted'),
          ),
          h('pre', { style: { margin: 0, padding: 8, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontSize: 11, overflowX: 'auto' } },
            JSON.stringify({
              payload: submissionsDrawer.selectedItem.payloadJson ?? submissionsDrawer.selectedItem.payload ?? {},
              attachments: submissionsDrawer.selectedItem.attachments ?? submissionsDrawer.selectedItem.attachmentsJson ?? [],
            }, null, 2),
          ),
        ) : null,
        h('div', { style: S.rowBetween },
          h('span', { style: { fontSize: 12, color: '#475569' } }, `Trang ${submissionsDrawer.page} / ${Math.max(1, Math.ceil((submissionsDrawer.total || 0) / (submissionsDrawer.pageSize || 20)))}`),
          h('div', { style: S.rowWrap },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-forms-submissions-prev',
              disabled: submissionsDrawer.loading || submissionsDrawer.page <= 1,
              onClick: () => loadSubmissions(submissionsDrawer.form, { status: submissionsDrawer.status, search: submissionsDrawer.search, page: Math.max(1, submissionsDrawer.page - 1) }),
              style: S.btn(false, false, submissionsDrawer.loading || submissionsDrawer.page <= 1),
            }, '← Trước'),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-forms-submissions-next',
              disabled: submissionsDrawer.loading || (submissionsDrawer.page * (submissionsDrawer.pageSize || 20) >= (submissionsDrawer.total || 0)),
              onClick: () => loadSubmissions(submissionsDrawer.form, { status: submissionsDrawer.status, search: submissionsDrawer.search, page: submissionsDrawer.page + 1 }),
              style: S.btn(false, false, submissionsDrawer.loading || (submissionsDrawer.page * (submissionsDrawer.pageSize || 20) >= (submissionsDrawer.total || 0))),
            }, 'Sau →'),
          ),
        ),
      ) : null,

      previewForm ? h('div', {
        'data-testid': 'dxos-forms-live-preview',
        style: { ...S.card, border: '2px solid #818cf8', background: '#faf5ff' },
      },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h4', { style: { margin: 0, fontSize: 15, color: '#312e81' } }, `Xem thử Form: ${previewForm.title}`),
            h('div', { style: { fontSize: 12, color: '#4338ca' } }, `Đường dẫn: /v/form/${previewForm.slug} · Bảng đích: ${previewForm.targetCollection}`),
          ),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-forms-preview-close-btn',
            onClick: () => setPreviewForm(null),
            style: S.btn(false),
          }, 'Đóng Xem thử'),
        ),
        previewForm.description ? h('p', { style: { margin: 0, fontSize: 13, color: '#334155' } }, previewForm.description) : null,
        h('div', { style: { display: 'grid', gap: 10, padding: 12, borderRadius: 8, background: '#ffffff', border: '1px solid #ddd6fe' } },
          !previewForm.fields.length
            ? h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa có trường nào trong allowlist.')
            : previewForm.fields.map((fld, fIdx) => {
              const opts = typeof fld.enumText === 'string'
                ? fld.enumText.split(',').map((s) => s.trim()).filter(Boolean)
                : (Array.isArray(fld.options) ? fld.options : []);
              return h('div', { key: `${fld.name}-${fIdx}` },
                h('label', { style: S.label }, `${fld.label || fld.name}${fld.required ? ' *' : ''}`),
                fld.type === 'select'
                  ? h('select', { defaultValue: opts[0] || '', style: S.input },
                    opts.length ? opts.map((op) => h('option', { key: op, value: op }, op)) : h('option', { value: '' }, '(Chưa cấu hình lựa chọn)'),
                  )
                  : fld.type === 'text'
                    ? h('textarea', { rows: 2, placeholder: fld.label || fld.name, maxLength: fld.maxLength || undefined, style: S.textarea })
                    : fld.type === 'boolean'
                      ? h('input', { type: 'checkbox' })
                      : fld.type === 'file'
                        ? h('input', { type: 'file', disabled: true, style: S.input })
                        : h('input', {
                          type: fld.type === 'integer' || fld.type === 'number' ? 'number' : (fld.type === 'date' ? 'date' : (fld.type === 'email' ? 'email' : 'text')),
                          placeholder: fld.label || fld.name,
                          maxLength: fld.maxLength || undefined,
                          pattern: fld.pattern || undefined,
                          style: S.input,
                        }),
              );
            }),
          h('div', { style: { fontSize: 11, color: '#64748b' } }, `Honeypot chống spam ẩn: ${previewForm.honeypotField}${previewForm.requireAccessToken ? ' · Yêu cầu Access Token' : ''}`),
          h('div', null,
            h('button', { type: 'button', disabled: true, style: S.btn(true, false, true) }, 'Gửi hồ sơ (Chế độ Xem thử)'),
          ),
        ),
      ) : null,
    );
  };
}

function makeDirectPanelWrapper(factory) {
  return function DirectPanelWrapper(props = {}) {
    const reactImpl = props.React || globalThis.React;
    if (!reactImpl || typeof reactImpl.createElement !== 'function') {
      throw new Error('Pass React via createPublicFormBuilderPanel(client, React, antd, app) or props.React.');
    }
    const Inner = factory(props.client || null, reactImpl, props.antd || {}, props.app || null);
    return Inner(props);
  };
}

module.exports = {
  PUBLIC_FORM_CORE_COLLECTIONS,
  PUBLIC_FORM_FIELD_TYPES,
  SLUG_RE,
  stripProtoKeys,
  parseJsonSafe,
  createPublicFormBuilderPanel,
  PublicFormBuilderPanel: makeDirectPanelWrapper(createPublicFormBuilderPanel),
};

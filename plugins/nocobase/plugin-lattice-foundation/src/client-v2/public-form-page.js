/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const FORM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const FORM_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SUBMISSION_CODE_RE = /^[A-Za-z0-9._-]{4,64}$/;

function sanitizeFormSlug(raw) {
  let val = String(raw || '').trim().toLowerCase();
  if (!val) return '';
  try {
    val = decodeURIComponent(val).trim().toLowerCase();
  } catch {
    return '';
  }
  if (!val || val.includes('..') || val.includes('/') || val.includes('\\')) return '';
  return FORM_SLUG_RE.test(val) ? val : '';
}

function sanitizeSafeToken(raw, re = FORM_TOKEN_RE) {
  let val = String(raw || '').trim();
  if (!val) return '';
  try {
    val = decodeURIComponent(val).trim();
  } catch {
    return '';
  }
  if (!val || val.includes('..') || val.includes('/') || val.includes('\\')) return '';
  return re.test(val) ? val : '';
}

function parseQueryString(searchStr) {
  const out = {};
  const raw = String(searchStr || '').replace(/^\?/, '');
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const k = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    const v = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
    try {
      const key = decodeURIComponent(k.replace(/\+/g, ' '));
      out[key] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      // Ignore malformed query pair
    }
  }
  return out;
}

function parseDetailedFormParams(locationLike) {
  const loc = locationLike || (typeof window !== 'undefined' ? window.location : null);
  if (!loc) return { slug: '', token: '', accessToken: '', statusToken: '', submissionCode: '' };
  const pathname = String(loc.pathname || '');
  const match = pathname.match(/^\/(?:v\/)?form\/([^/?#]+)\/?$/i);
  const slug = match ? sanitizeFormSlug(match[1]) : '';
  const query = parseQueryString(loc.search || '');
  const accessToken = sanitizeSafeToken(query.accessToken || '', FORM_TOKEN_RE);
  const statusToken = sanitizeSafeToken(query.statusToken || '', FORM_TOKEN_RE);
  const legacyToken = sanitizeSafeToken(query.token || '', FORM_TOKEN_RE);
  const token = legacyToken || accessToken || statusToken;
  const submissionCode = sanitizeSafeToken(query.code || query.submissionCode || '', SUBMISSION_CODE_RE);
  return { slug, token, accessToken, statusToken, submissionCode };
}

function parseFormParams(locationLike) {
  const { slug, token, submissionCode } = parseDetailedFormParams(locationLike);
  return { slug, token, submissionCode };
}

function resolveLegacyFormRedirect(winLike) {
  if (!winLike || winLike.__nocobase_app_client_entry_mode__ !== 'legacy-default') return null;
  const loc = winLike.location;
  if (!loc) return null;
  const pathname = String(loc.pathname || '');
  if (!pathname || pathname === '/mobile' || pathname.startsWith('/mobile/') || pathname.startsWith('/v/')) {
    return null;
  }
  if (pathname === '/form' || pathname.startsWith('/form/')) {
    return `/v${pathname}${loc.search || ''}${loc.hash || ''}`;
  }
  return null;
}

function sanitizeFormMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  const fields = [];
  for (const f of rawFields) {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string') continue;
    fields.push({
      name: String(f.name),
      label: String(f.label || f.name),
      type: String(f.type || 'string'),
      required: Boolean(f.required),
      maxLength: Number(f.maxLength) || 2000,
      ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}),
      ...(f.min !== undefined ? { min: Number(f.min) } : {}),
      ...(f.max !== undefined ? { max: Number(f.max) } : {}),
      ...(typeof f.pattern === 'string' && f.pattern ? { pattern: f.pattern } : {}),
      ...(typeof f.placeholder === 'string' && f.placeholder ? { placeholder: f.placeholder } : {}),
    });
  }
  return {
    slug: String(raw.slug || ''),
    title: String(raw.title || ''),
    description: String(raw.description || ''),
    fields,
    honeypotField: String(raw.honeypotField || '_hp_website'),
    requireAccessToken: Boolean(raw.requireAccessToken),
    active: raw.active !== false,
  };
}

function projectZeroPiiSubmissionStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    slug: String(raw.slug || ''),
    submissionCode: String(raw.submissionCode || ''),
    status: String(raw.status || ''),
    submittedAt: raw.submittedAt ? String(raw.submittedAt) : '',
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : '',
  };
}

function extractApiError(err, fallbackMsg) {
  const serverMsg = err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message;
  const status = err?.response?.status || err?.status;
  if (serverMsg) return { message: String(serverMsg), status };
  if (err?.message) return { message: String(err.message), status };
  return { message: fallbackMsg, status };
}

function createPublicFormPage(client, React, app) {
  return function PublicFormPage(props = {}) {
    const h = React.createElement;
    const useAPIClient = client?.useAPIClient;
    let hookApiClient = null;
    if (typeof useAPIClient === 'function') {
      try {
        hookApiClient = useAPIClient();
      } catch {
        hookApiClient = null;
      }
    }
    const apiClient = props?.apiClient || hookApiClient || app?.apiClient || null;

    const initialParams = parseDetailedFormParams(props?.location);
    const propSlug = props?.slug ? sanitizeFormSlug(props.slug) : '';
    const propToken = props?.token ? sanitizeSafeToken(props.token, FORM_TOKEN_RE) : '';
    const propAccessToken = props?.accessToken ? sanitizeSafeToken(props.accessToken, FORM_TOKEN_RE) : '';
    const propStatusToken = props?.statusToken ? sanitizeSafeToken(props.statusToken, FORM_TOKEN_RE) : '';
    const propCode = props?.submissionCode ? sanitizeSafeToken(props.submissionCode, SUBMISSION_CODE_RE) : '';
    const effectiveSlug = propSlug || initialParams.slug;
    const effectiveCode = propCode || initialParams.submissionCode;
    const effectiveStatusToken = propStatusToken
      || initialParams.statusToken
      || (effectiveCode ? (propToken || initialParams.token) : '');
    const initialAccessToken = propAccessToken
      || initialParams.accessToken
      || (!effectiveCode ? (propToken || initialParams.token) : '');

    const [loading, setLoading] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState('');
    const [fieldErrors, setFieldErrors] = React.useState({});
    const [tokenError, setTokenError] = React.useState('');
    const [formMeta, setFormMeta] = React.useState(null);
    const [values, setValues] = React.useState({});
    const [accessToken, setAccessToken] = React.useState(initialAccessToken);
    const [honeypotValue, setHoneypotValue] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);
    const [receipt, setReceipt] = React.useState(null);
    const [checkingStatus, setCheckingStatus] = React.useState(false);
    const [statusData, setStatusData] = React.useState(null);
    const [statusError, setStatusError] = React.useState('');

    async function callEndpoint(actionUrl, opts = {}) {
      if (apiClient && typeof apiClient.request === 'function') {
        const res = await apiClient.request({
          url: actionUrl,
          method: opts.method || 'GET',
          ...(opts.params ? { params: opts.params } : {}),
          ...(opts.data ? { data: opts.data } : {}),
        });
        return res?.data?.data ?? res?.data ?? res;
      }
      if (typeof fetch !== 'function') {
        throw new Error('Không tìm thấy API client khả dụng.');
      }
      const query = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : '';
      const resp = await fetch(`/api/${actionUrl}${query}`, {
        method: opts.method || 'GET',
        headers: opts.data ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.data ? JSON.stringify(opts.data) : undefined,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error(json?.errors?.[0]?.message || json?.message || `HTTP ${resp.status}`);
        err.response = { status: resp.status, data: json };
        throw err;
      }
      return json?.data ?? json;
    }

    React.useEffect(() => {
      let active = true;
      if (!effectiveSlug) {
        setFormMeta(null);
        setErrorMsg('Thiếu mã biểu mẫu công khai hợp lệ (/v/form/:slug).');
        setLoading(false);
        return () => { active = false; };
      }

      if (effectiveCode && effectiveStatusToken) {
        setCheckingStatus(true);
        callEndpoint('dxosForms:status', {
          method: 'GET',
          params: { slug: effectiveSlug, submissionCode: effectiveCode, token: effectiveStatusToken },
        })
          .then((payload) => {
            if (!active) return;
            setStatusData(projectZeroPiiSubmissionStatus(payload));
            setCheckingStatus(false);
          })
          .catch((err) => {
            if (!active) return;
            setStatusError(extractApiError(err, 'Không thể tra cứu trạng thái hồ sơ.').message);
            setCheckingStatus(false);
          });
      }

      setLoading(true);
      setErrorMsg('');
      callEndpoint('dxosForms:meta', {
        method: 'GET',
        params: { slug: effectiveSlug },
      })
        .then((payload) => {
          if (!active) return;
          setFormMeta(sanitizeFormMeta(payload));
          setLoading(false);
        })
        .catch((err) => {
          if (!active) return;
          setFormMeta(null);
          setErrorMsg(extractApiError(err, 'Không thể tải biểu mẫu công khai.').message);
          setLoading(false);
        });

      return () => { active = false; };
    }, [effectiveSlug, effectiveCode, effectiveStatusToken]);

    function updateFieldValue(fieldName, val) {
      setValues((prev) => ({ ...(prev || {}), [fieldName]: val }));
      setFieldErrors((prev) => {
        if (!prev || !prev[fieldName]) return prev;
        const next = { ...prev };
        delete next[fieldName];
        return next;
      });
      setErrorMsg('');
    }

    function validateClientFields() {
      const nextFieldErrors = {};
      let nextTokenError = '';
      if (formMeta.requireAccessToken && !String(accessToken || '').trim()) {
        nextTokenError = 'Vui lòng nhập mã truy cập biểu mẫu (Access Token).';
      }
      for (const field of formMeta.fields || []) {
        const label = String(field.label || field.name);
        const val = values?.[field.name];
        if (field.type === 'boolean') {
          if (field.required && !val) {
            nextFieldErrors[field.name] = `Vui lòng xác nhận ${label}.`;
          }
          continue;
        }
        const raw = String(val ?? '');
        const trimmed = raw.trim();
        if (field.required && !trimmed) {
          nextFieldErrors[field.name] = `Vui lòng nhập ${label}.`;
        } else if (trimmed) {
          if (Number(field.maxLength) > 0 && raw.length > Number(field.maxLength)) {
            nextFieldErrors[field.name] = `${label} không được vượt quá ${Number(field.maxLength)} ký tự.`;
          } else if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            nextFieldErrors[field.name] = 'Email không hợp lệ. Vui lòng kiểm tra lại.';
          } else if (field.type === 'number' || field.type === 'integer') {
            const num = Number(trimmed);
            if (!Number.isFinite(num)) {
              nextFieldErrors[field.name] = `Vui lòng nhập số hợp lệ cho ${label}.`;
            } else if (field.type === 'integer' && !Number.isInteger(num)) {
              nextFieldErrors[field.name] = `Vui lòng nhập số nguyên hợp lệ cho ${label}.`;
            } else if (field.min !== undefined && num < Number(field.min)) {
              nextFieldErrors[field.name] = `${label} tối thiểu là ${field.min}.`;
            } else if (field.max !== undefined && num > Number(field.max)) {
              nextFieldErrors[field.name] = `${label} tối đa là ${field.max}.`;
            }
          }
        }
      }
      setTokenError(nextTokenError);
      setFieldErrors(nextFieldErrors);
      if (nextTokenError || Object.keys(nextFieldErrors).length > 0) {
        setErrorMsg('Vui lòng kiểm tra và điền đầy đủ các thông tin bắt buộc.');
        return false;
      }
      return true;
    }

    async function handleSubmit(evt) {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      if (!formMeta) return;
      if (!validateClientFields()) return;
      setSubmitting(true);
      setErrorMsg('');
      setStatusError('');
      try {
        const hpName = formMeta.honeypotField || '_hp_website';
        const payload = {
          slug: formMeta.slug,
          values: values || {},
          [hpName]: honeypotValue,
          ...(accessToken ? { token: accessToken } : {}),
        };
        const res = await callEndpoint('dxosForms:submit', {
          method: 'POST',
          data: payload,
        });
        setReceipt({
          ok: Boolean(res?.ok),
          slug: String(res?.slug || formMeta.slug),
          submissionCode: String(res?.submissionCode || ''),
          statusToken: String(res?.statusToken || ''),
          status: String(res?.status || 'submitted'),
          submittedAt: res?.submittedAt ? String(res.submittedAt) : '',
        });
      } catch (err) {
        setErrorMsg(extractApiError(err, 'Gửi biểu mẫu thất bại.').message);
      } finally {
        setSubmitting(false);
      }
    }

    async function handleCheckStatus() {
      const code = receipt?.submissionCode || effectiveCode;
      const tok = receipt?.statusToken || effectiveStatusToken;
      if (!effectiveSlug || !code || !tok) {
        setStatusError('Thiếu mã hồ sơ hoặc mã tra cứu trạng thái.');
        return;
      }
      setCheckingStatus(true);
      setStatusError('');
      try {
        const res = await callEndpoint('dxosForms:status', {
          method: 'GET',
          params: { slug: effectiveSlug, submissionCode: code, token: tok },
        });
        setStatusData(projectZeroPiiSubmissionStatus(res));
      } catch (err) {
        setStatusError(extractApiError(err, 'Không thể kiểm tra trạng thái hồ sơ.').message);
      } finally {
        setCheckingStatus(false);
      }
    }

    const inputStyle = {
      width: '100%',
      padding: '8px 10px',
      borderRadius: 6,
      border: '1px solid #cbd5e1',
      fontSize: 14,
      boxSizing: 'border-box',
    };
    const errorInputStyle = {
      ...inputStyle,
      border: '1px solid #dc2626',
      background: '#fef2f2',
    };
    const fieldErrorStyle = {
      color: '#b91c1c',
      fontSize: 12,
      marginTop: 5,
      fontWeight: 500,
    };

    function renderFieldControl(field) {
      const currentVal = values?.[field.name] ?? '';
      const activeStyle = fieldErrors?.[field.name] ? errorInputStyle : inputStyle;
      if (field.type === 'text') {
        return h('textarea', {
          name: field.name,
          required: field.required,
          maxLength: field.maxLength,
          rows: 4,
          placeholder: field.placeholder || '',
          value: currentVal,
          onChange: (e) => updateFieldValue(field.name, e?.target?.value ?? ''),
          style: activeStyle,
        });
      }
      if (field.type === 'select' && Array.isArray(field.options)) {
        return h(
          'select',
          {
            name: field.name,
            required: field.required,
            value: currentVal,
            onChange: (e) => updateFieldValue(field.name, e?.target?.value ?? ''),
            style: activeStyle,
          },
          h('option', { value: '' }, '-- Chọn giá trị --'),
          ...field.options.map((opt) => h('option', { key: opt, value: opt }, opt)),
        );
      }
      if (field.type === 'boolean') {
        return h('input', {
          type: 'checkbox',
          name: field.name,
          checked: Boolean(currentVal),
          onChange: (e) => updateFieldValue(field.name, Boolean(e?.target?.checked)),
        });
      }
      const htmlType = field.type === 'number' || field.type === 'integer'
        ? 'number'
        : (field.type === 'email' ? 'email' : (field.type === 'date' ? 'date' : 'text'));
      return h('input', {
        type: htmlType,
        name: field.name,
        required: field.required,
        maxLength: field.maxLength,
        min: field.min,
        max: field.max,
        placeholder: field.placeholder || '',
        value: currentVal,
        onChange: (e) => updateFieldValue(field.name, e?.target?.value ?? ''),
        style: activeStyle,
      });
    }

    return h(
      'div',
      {
        'data-testid': 'public-form-page',
        style: {
          maxWidth: 720,
          margin: '32px auto',
          padding: 24,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#f8fafc',
          borderRadius: 12,
          border: '1px solid #e2e8f0',
          color: '#0f172a',
        },
      },
      h(
        'header',
        { style: { marginBottom: 20, borderBottom: '1px solid #cbd5e1', paddingBottom: 12 } },
        h('div', { style: { fontSize: 12, fontWeight: 700, color: '#0284c7', textTransform: 'uppercase' } }, 'LatticeDX Public Intake · Zero-PII'),
        h('h1', { style: { margin: '4px 0 0', fontSize: 22, fontWeight: 700 } }, formMeta?.title || 'Biểu mẫu tiếp nhận công khai'),
        formMeta?.description
          ? h('p', { style: { margin: '6px 0 0', fontSize: 14, color: '#475569' } }, formMeta.description)
          : null,
      ),
      loading
        ? h('div', { 'data-testid': 'public-form-loading', role: 'status', style: { padding: 16, background: '#e0f2fe', borderRadius: 8, marginBottom: 16 } }, 'Đang tải cấu hình biểu mẫu...')
        : null,
      errorMsg
        ? h('div', { 'data-testid': 'public-form-error', role: 'alert', style: { padding: 16, background: '#fee2e2', color: '#991b1b', borderRadius: 8, marginBottom: 16 } }, errorMsg)
        : null,
      formMeta && !receipt
        ? h(
          'form',
          {
            'data-testid': 'public-form-element',
            noValidate: true,
            onSubmit: handleSubmit,
            style: { background: '#ffffff', padding: 20, borderRadius: 10, border: '1px solid #cbd5e1' },
          },
          formMeta.requireAccessToken
            ? h(
              'div',
              { style: { marginBottom: 14 } },
              h('label', { style: { display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6 } }, 'Mã truy cập biểu mẫu (Access Token) *'),
              h('input', {
                type: 'password',
                name: 'accessToken',
                'data-testid': 'public-form-token-input',
                required: true,
                value: accessToken,
                onChange: (e) => {
                  setAccessToken(e?.target?.value ?? '');
                  if (tokenError) setTokenError('');
                  if (errorMsg) setErrorMsg('');
                },
                style: tokenError ? errorInputStyle : inputStyle,
              }),
              tokenError
                ? h('div', { 'data-testid': 'public-form-token-error', role: 'alert', style: fieldErrorStyle }, tokenError)
                : null,
            )
            : null,
          ...formMeta.fields.map((field) => h(
            'div',
            { key: field.name, style: { marginBottom: 14 } },
            h('label', { style: { display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6 } },
              `${field.label}${field.required ? ' *' : ''}`,
            ),
            renderFieldControl(field),
            fieldErrors?.[field.name]
              ? h('div', { 'data-testid': `public-form-field-error-${field.name}`, role: 'alert', style: fieldErrorStyle }, fieldErrors[field.name])
              : null,
          )),
          h('input', {
            type: 'text',
            name: formMeta.honeypotField || '_hp_website',
            'data-testid': 'public-form-honeypot',
            'aria-hidden': 'true',
            tabIndex: -1,
            autoComplete: 'off',
            value: honeypotValue,
            onChange: (e) => setHoneypotValue(e?.target?.value ?? ''),
            style: { position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0, pointerEvents: 'none' },
          }),
          h(
            'button',
            {
              type: 'submit',
              'data-testid': 'public-form-submit-btn',
              disabled: submitting,
              style: {
                padding: '10px 18px',
                borderRadius: 6,
                border: '1px solid #0284c7',
                background: '#0284c7',
                color: '#ffffff',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
              },
            },
            submitting ? 'Đang gửi hồ sơ...' : 'Gửi biểu mẫu',
          ),
        )
        : null,
      receipt
        ? h(
          'section',
          {
            'data-testid': 'public-form-receipt',
            role: 'status',
            style: { background: '#f0fdf4', padding: 20, borderRadius: 10, border: '1px solid #86efac', marginBottom: 16 },
          },
          h('div', { style: { fontWeight: 700, fontSize: 16, color: '#166534', marginBottom: 10 } }, 'Đã tiếp nhận hồ sơ (Zero-PII Receipt)'),
          h('div', { style: { fontSize: 14, marginBottom: 6 } }, `Mã hồ sơ: ${receipt.submissionCode}`),
          h('div', { style: { fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 6 } }, `Status Token: ${receipt.statusToken}`),
          h('div', { style: { fontSize: 13, color: '#334155', marginBottom: 12 } }, `Trạng thái ban đầu: ${receipt.status} · Lúc: ${receipt.submittedAt || '—'}`),
          h(
            'button',
            {
              type: 'button',
              'data-testid': 'public-form-check-status-btn',
              disabled: checkingStatus,
              onClick: handleCheckStatus,
              style: {
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid #15803d',
                background: '#15803d',
                color: '#ffffff',
                fontWeight: 600,
                cursor: checkingStatus ? 'not-allowed' : 'pointer',
              },
            },
            checkingStatus ? 'Đang kiểm tra...' : 'Kiểm tra trạng thái hồ sơ',
          ),
        )
        : null,
      statusError
        ? h('div', { 'data-testid': 'public-form-status-error', role: 'alert', style: { padding: 14, background: '#fef3c7', color: '#92400e', borderRadius: 8, marginBottom: 16 } }, statusError)
        : null,
      statusData
        ? h(
          'section',
          {
            'data-testid': 'public-form-status-card',
            role: 'status',
            style: { background: '#ffffff', padding: 20, borderRadius: 10, border: '1px solid #cbd5e1' },
          },
          h('div', { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } }, 'Trạng thái hồ sơ công khai (Zero-PII)'),
          h('div', { style: { fontSize: 14, marginBottom: 4 } }, `Mã hồ sơ: ${statusData.submissionCode || '—'}`),
          h('div', { style: { fontSize: 14, marginBottom: 4 } }, `Trạng thái hiện tại: ${statusData.status || '—'}`),
          h('div', { style: { fontSize: 13, color: '#64748b' } }, `Cập nhật lúc: ${statusData.updatedAt || statusData.submittedAt || '—'}`),
        )
        : null,
    );
  };
}

module.exports = {
  parseFormParams,
  resolveLegacyFormRedirect,
  sanitizeFormMeta,
  projectZeroPiiSubmissionStatus,
  createPublicFormPage,
};

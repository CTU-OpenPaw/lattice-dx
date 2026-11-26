/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomBytes } = require('node:crypto');
const { val } = require('./native-portal-helpers');
const {
  SLUG_RE,
  RESERVED_FORM_SLUGS,
  lookupFormBySlug,
  serializePublicMeta,
} = require('./public-forms');

const NONCE_SAFE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INLINE_FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230284c7'/%3E%3Cpath d='M9 16l5 5 9-9' stroke='%23fff' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeSafeJsonForScript(payload) {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function matchPublicFormPath(pathname) {
  const cleanPath = String(pathname || '').split('?')[0].split('#')[0];
  if (cleanPath === '/v/form' || cleanPath === '/v/form/') {
    return { matched: true, rawSlug: '' };
  }
  const m = cleanPath.match(/^\/v\/form\/([^/]+)\/?$/);
  if (!m) {
    return { matched: false, rawSlug: '' };
  }
  let rawSlug = '';
  try {
    rawSlug = decodeURIComponent(m[1]).trim();
  } catch {
    rawSlug = '';
  }
  return { matched: true, rawSlug };
}

function buildClientScriptSource() {
  return `'use strict';
(function () {
  var root = document.getElementById('dxos-public-form-root');
  var bootstrapEl = document.getElementById('dxos-form-bootstrap');
  if (!root || !bootstrapEl) return;

  var bootstrap = { ok: false, slug: '', form: null, error: 'Public form not found or inactive.', apiBasePath: '/api' };
  try {
    bootstrap = JSON.parse(bootstrapEl.textContent || '{}');
  } catch (e) {
    bootstrap = { ok: false, slug: '', form: null, error: 'Public form bootstrap invalid.', apiBasePath: '/api' };
  }

  var apiBase = String(bootstrap.apiBasePath || '/api').replace(/\\/+$/, '') || '/api';
  var query = new URLSearchParams(window.location.search || '');
  var cleanToken = function (v) { return String(v || '').trim(); };
  var rawCode = cleanToken(query.get('code') || query.get('submissionCode'));
  var rawAccessToken = cleanToken(query.get('accessToken'));
  var rawStatusToken = cleanToken(query.get('statusToken'));
  var rawLegacyToken = cleanToken(query.get('token'));
  var effectiveStatusToken = rawStatusToken || (rawCode ? rawLegacyToken : '');
  var initialAccessToken = rawAccessToken || (!rawCode ? rawLegacyToken : '');

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      });
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  var PRIORITY_LABELS = {
    low: 'Th\u1ea5p',
    normal: 'B\u00ecnh th\u01b0\u1eddng',
    medium: 'Trung b\u00ecnh',
    high: 'Cao',
    urgent: 'Kh\u1ea9n c\u1ea5p',
  };

  function localizeFormError(msg) {
    var text = String(msg || '').trim();
    if (!text || text === 'Public form not found or inactive.') {
      return 'Bi\\u1ec3u m\\u1eabu c\\u00f4ng khai kh\\u00f4ng t\\u1ed3n t\\u1ea1i ho\\u1eb7c \\u0111\\u00e3 ng\\u1eebng ti\\u1ebfp nh\\u1eadn.';
    }
    var lower = text.toLowerCase();
    if (lower.includes('access token') || lower.includes('form_access_token_invalid')) {
      return 'M\\u00e3 truy c\\u1eadp bi\\u1ec3u m\\u1eabu (Access Token) kh\\u00f4ng h\\u1ee3p l\\u1ec7.';
    }
    if (lower.includes('rate limit') || lower.includes('too many requests')) {
      return 'B\\u1ea1n g\\u1eedi qu\\u00e1 nhanh. Vui l\\u00f2ng ch\\u1edd \\u00edt ph\\u00fat r\\u1ed3i th\\u1eed l\\u1ea1i.';
    }
    if (lower.includes('bot protection') || lower.includes('form_bot_detected')) {
      return 'Y\\u00eau c\\u1ea7u b\\u1ecb t\\u1eeb ch\\u1ed1i b\\u1edfi b\\u1ed9 l\\u1ecdc ch\\u1ed1ng spam.';
    }
    if (lower.includes('invalid status lookup credentials') || lower.includes('form_status_unauthorized')) {
      return 'M\\u00e3 h\\u1ed3 s\\u01a1 ho\\u1eb7c m\\u00e3 tra c\\u1ee9u tr\\u1ea1ng th\\u00e1i kh\\u00f4ng \\u0111\\u00fang.';
    }
    if (lower.includes('is required')) {
      return 'Vui l\\u00f2ng \\u0111i\\u1ec1n \\u0111\\u1ea7y \\u0111\\u1ee7 c\\u00e1c tr\\u01b0\\u1eddng b\\u1eaft bu\\u1ed9c.';
    }
    if (lower.includes('exceeds max length')) {
      return 'N\\u1ed9i dung nh\\u1eadp v\\u01b0\\u1ee3t qu\\u00e1 \\u0111\\u1ed9 d\\u00e0i cho ph\\u00e9p.';
    }
    if (lower.includes('valid email')) {
      return 'Email kh\\u00f4ng h\\u1ee3p l\\u1ec7. Vui l\\u00f2ng ki\\u1ec3m tra l\\u1ea1i.';
    }
    if (lower.includes('file type') || lower.includes('not allowed for')) {
      return '\\u0110\\u1ecbnh d\\u1ea1ng t\\u1ec7p kh\\u00f4ng \\u0111\\u01b0\\u1ee3c h\\u1ed7 tr\\u1ee3 (ch\\u1ec9 nh\\u1eadn PDF, PNG, JPEG, WebP, TXT).';
    }
    if (lower.includes('exceeds maximum size') || lower.includes('too large')) {
      return 'Dung l\\u01b0\\u1ee3ng t\\u1ec7p v\\u01b0\\u1ee3t qu\\u00e1 gi\\u1edbi h\\u1ea1n 2 MB.';
    }
    if (lower.includes('does not match declared mime') || lower.includes('invalid base64') || lower.includes('empty file')) {
      return 'N\\u1ed9i dung t\\u1ec7p kh\\u00f4ng h\\u1ee3p l\\u1ec7 ho\\u1eb7c b\\u1ecb gi\\u1ea3 m\\u1ea1o \\u0111\\u1ecbnh d\\u1ea1ng.';
    }
    if (lower.includes('http 401')) return 'X\\u00e1c th\\u1ef1c kh\\u00f4ng h\\u1ee3p l\\u1ec7 (401).';
    if (lower.includes('http 403')) return 'Kh\\u00f4ng c\\u00f3 quy\\u1ec1n th\\u1ef1c hi\\u1ec7n thao t\\u00e1c n\\u00e0y (403).';
    if (lower.includes('http 404')) return 'Kh\\u00f4ng t\\u00ecm th\\u1ea5y bi\\u1ec3u m\\u1eabu ho\\u1eb7c h\\u1ed3 s\\u01a1 (404).';
    if (lower.includes('http 429')) return 'Qu\\u00e1 nhi\\u1ec1u y\\u00eau c\\u1ea7u. Vui l\\u00f2ng th\\u1eed l\\u1ea1i sau.';
    if (lower.includes('http 5')) return 'M\\u00e1y ch\\u1ee7 \\u0111ang b\\u1eadn. Vui l\\u00f2ng th\\u1eed l\\u1ea1i sau.';
    return text;
  }

  function formatTimestampVi(ts) {
    if (!ts) return '\\u2014';
    var d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    try {
      return d.toLocaleString('vi-VN');
    } catch (e) {
      return d.toISOString();
    }
  }

  function resolveOptionLabel(fieldName, opt) {
    if (opt && typeof opt === 'object') {
      return String(opt.label !== undefined ? opt.label : (opt.value !== undefined ? opt.value : ''));
    }
    var raw = String(opt);
    var lower = raw.toLowerCase();
    if ((fieldName === 'priority' || Object.hasOwn(PRIORITY_LABELS, lower)) && Object.hasOwn(PRIORITY_LABELS, lower)) {
      return PRIORITY_LABELS[lower];
    }
    return raw;
  }

  function copyTokenText(text, btn) {
    var value = String(text || '');
    if (!value) return;
    var markCopied = function () {
      if (!btn) return;
      btn.textContent = '\u0110\u00e3 sao ch\u00e9p';
      setTimeout(function () {
        btn.textContent = 'Sao ch\u00e9p m\u00e3 tra c\u1ee9u';
      }, 2000);
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(markCopied).catch(function () {
        fallbackCopyText(value, markCopied, btn);
      });
      return;
    }
    fallbackCopyText(value, markCopied, btn);
  }

  function fallbackCopyText(value, onDone, btn) {
    try {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.className = 'dxos-hp';
      document.body.appendChild(ta);
      ta.select();
      var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
      document.body.removeChild(ta);
      if (ok) {
        onDone();
        return;
      }
    } catch (e) {}
    if (btn) btn.textContent = 'Kh\u00f4ng th\u1ec3 t\u1ef1 sao ch\u00e9p';
  }

  var page = el('div', { 'data-testid': 'public-form-page', class: 'dxos-page' });
  var header = el('header', { class: 'dxos-header' });
  header.appendChild(el('div', { class: 'dxos-eyebrow' }, 'LatticeDX Public Intake \\u00b7 Zero-PII'));
  var titleText = (bootstrap.form && bootstrap.form.title) ? bootstrap.form.title : 'Bi\\u1ec3u m\\u1eabu ti\\u1ebfp nh\\u1eadn c\\u00f4ng khai';
  header.appendChild(el('h1', { class: 'dxos-title' }, titleText));
  if (bootstrap.form && bootstrap.form.description) {
    header.appendChild(el('p', { class: 'dxos-desc' }, bootstrap.form.description));
  }
  page.appendChild(header);

  var errorBox = el('div', { 'data-testid': 'public-form-error', role: 'alert', class: 'dxos-alert dxos-alert-error dxos-hidden' });
  page.appendChild(errorBox);

  var formArea = el('div');
  var receiptArea = el('div');
  var lookupArea = el('div');
  var statusErrorBox = el('div', { 'data-testid': 'public-form-status-error', role: 'alert', class: 'dxos-alert dxos-alert-warn dxos-hidden' });
  var statusArea = el('div');

  page.appendChild(formArea);
  page.appendChild(receiptArea);
  page.appendChild(lookupArea);
  page.appendChild(statusErrorBox);
  page.appendChild(statusArea);
  root.appendChild(page);

  function showError(msg) {
    errorBox.textContent = localizeFormError(msg);
    errorBox.classList.remove('dxos-hidden');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('dxos-hidden');
  }

  function showStatusError(msg) {
    statusErrorBox.textContent = localizeFormError(msg || 'Kh\\u00f4ng th\\u1ec3 tra c\\u1ee9u tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1.');
    statusErrorBox.classList.remove('dxos-hidden');
  }

  function clearStatusError() {
    statusErrorBox.textContent = '';
    statusErrorBox.classList.add('dxos-hidden');
  }

  function renderStatusCard(data) {
    while (statusArea.firstChild) statusArea.removeChild(statusArea.firstChild);
    if (!data) return;
    var card = el('section', { 'data-testid': 'public-form-status-card', role: 'status', class: 'dxos-card' });
    card.appendChild(el('div', { class: 'dxos-card-title' }, 'Tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1 c\\u00f4ng khai (Zero-PII)'));
    card.appendChild(el('div', { class: 'dxos-meta-line' }, 'M\\u00e3 h\\u1ed3 s\\u01a1: ' + (data.submissionCode || '\\u2014')));
    card.appendChild(el('div', { class: 'dxos-meta-line' }, 'Tr\\u1ea1ng th\\u00e1i hi\\u1ec7n t\\u1ea1i: ' + (data.status || '\\u2014')));
    card.appendChild(el('div', { class: 'dxos-meta-sub' }, 'C\\u1eadp nh\\u1eadt l\\u00fac: ' + formatTimestampVi(data.updatedAt || data.submittedAt)));
    statusArea.appendChild(card);
  }

  function checkStatus(slug, submissionCode, statusToken, triggerBtn) {
    if (!slug || !submissionCode || !statusToken) {
      showStatusError('Thi\\u1ebfu m\\u00e3 h\\u1ed3 s\\u01a1 ho\\u1eb7c m\\u00e3 tra c\\u1ee9u tr\\u1ea1ng th\\u00e1i.');
      return Promise.resolve();
    }
    clearStatusError();
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = '\\u0110ang ki\\u1ec3m tra...';
    }
    var qs = new URLSearchParams({ slug: slug, submissionCode: submissionCode, token: statusToken }).toString();
    return fetch(apiBase + '/dxosForms:status?' + qs, { method: 'GET' })
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (json) {
          if (!resp.ok) {
            var msg = (json && json.errors && json.errors[0] && json.errors[0].message) || (json && json.message) || ('HTTP ' + resp.status);
            throw new Error(msg);
          }
          return (json && json.data !== undefined) ? json.data : json;
        });
      })
      .then(function (payload) {
        renderStatusCard(payload);
      })
      .catch(function (err) {
        showStatusError((err && err.message) ? err.message : 'Kh\\u00f4ng th\\u1ec3 ki\\u1ec3m tra tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1.');
      })
      .finally(function () {
        if (triggerBtn) {
          triggerBtn.disabled = false;
          triggerBtn.textContent = 'Ki\\u1ec3m tra tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1';
        }
      });
  }

  if (!bootstrap.ok || !bootstrap.form) {
    showError(bootstrap.error || 'Public form not found or inactive.');
    return;
  }

  var formMeta = bootstrap.form;
  var fields = Array.isArray(formMeta.fields) ? formMeta.fields : [];
  var hpName = formMeta.honeypotField || '_hp_website';

  if (rawCode && effectiveStatusToken) {
    checkStatus(formMeta.slug, rawCode, effectiveStatusToken, null);
  }

  var formEl = el('form', { 'data-testid': 'public-form-element', novalidate: true, class: 'dxos-card' });
  var hpInput = el('input', {
    type: 'text',
    name: hpName,
    'data-testid': 'public-form-honeypot',
    'aria-hidden': 'true',
    tabindex: '-1',
    autocomplete: 'off',
    class: 'dxos-hp',
  });

  var tokenInput = null;
  var tokenErrorEl = null;
  if (formMeta.requireAccessToken) {
    var tokGroup = el('div', { class: 'dxos-field' });
    tokGroup.appendChild(el('label', { class: 'dxos-label' }, 'M\\u00e3 truy c\\u1eadp bi\\u1ec3u m\\u1eabu (Access Token) *'));
    tokenInput = el('input', {
      type: 'password',
      name: 'accessToken',
      'data-testid': 'public-form-token-input',
      required: true,
      class: 'dxos-input',
    });
    if (initialAccessToken) tokenInput.value = initialAccessToken;
    tokenErrorEl = el('div', {
      'data-testid': 'public-form-token-error',
      role: 'alert',
      class: 'dxos-field-error dxos-hidden',
    });
    tokenInput.addEventListener('input', function () {
      tokenInput.classList.remove('dxos-input-error');
      tokenErrorEl.textContent = '';
      tokenErrorEl.classList.add('dxos-hidden');
      clearError();
    });
    tokGroup.appendChild(tokenInput);
    tokGroup.appendChild(tokenErrorEl);
    formEl.appendChild(tokGroup);
  }

  var fieldControls = [];
  fields.forEach(function (field) {
    if (!field || !field.name) return;
    var wrap = el('div', { class: 'dxos-field' });
    var labelText = String(field.label || field.name) + (field.required ? ' *' : '');
    wrap.appendChild(el('label', { class: 'dxos-label' }, labelText));

    var control;
    var fileState = null;
    if (field.type === 'text') {
      control = el('textarea', {
        name: field.name,
        required: Boolean(field.required),
        maxlength: Number(field.maxLength) || 2000,
        rows: 4,
        placeholder: field.placeholder || '',
        class: 'dxos-input',
      });
    } else if (field.type === 'file') {
      var fileContainer = el('div', { class: 'dxos-file-box' });
      control = el('input', {
        type: 'file',
        name: field.name,
        accept: '.pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain',
        'data-testid': 'public-form-file-input-' + field.name,
        class: 'dxos-input',
      });
      var fileInfoEl = el('div', { class: 'dxos-meta-sub dxos-hidden' });
      var fileClearBtn = el('button', {
        type: 'button',
        'data-testid': 'public-form-file-clear-' + field.name,
        class: 'dxos-btn dxos-btn-secondary dxos-hidden',
      }, 'X\\u00f3a t\\u1ec7p');
      fileState = { data: null, infoEl: fileInfoEl, clearBtn: fileClearBtn };
      fileContainer.appendChild(control);
      fileContainer.appendChild(fileInfoEl);
      fileContainer.appendChild(fileClearBtn);
    } else if (field.type === 'select' && Array.isArray(field.options)) {
      control = el('select', {
        name: field.name,
        required: Boolean(field.required),
        class: 'dxos-input',
      });
      control.appendChild(el('option', { value: '' }, '-- Ch\\u1ecdn gi\\u00e1 tr\\u1ecb --'));
      field.options.forEach(function (opt) {
        var optVal = (opt && typeof opt === 'object') ? String(opt.value !== undefined ? opt.value : '') : String(opt);
        control.appendChild(el('option', { value: optVal }, resolveOptionLabel(field.name, opt)));
      });
    } else if (field.type === 'boolean') {
      control = el('input', {
        type: 'checkbox',
        name: field.name,
        class: 'dxos-checkbox',
      });
    } else {
      var htmlType = (field.type === 'number' || field.type === 'integer')
        ? 'number'
        : (field.type === 'email' ? 'email' : (field.type === 'date' ? 'date' : 'text'));
      control = el('input', {
        type: htmlType,
        name: field.name,
        required: Boolean(field.required),
        maxlength: Number(field.maxLength) || 2000,
        min: field.min !== undefined ? field.min : null,
        max: field.max !== undefined ? field.max : null,
        step: field.type === 'integer' ? '1' : (field.type === 'number' ? 'any' : null),
        pattern: field.pattern || null,
        placeholder: field.placeholder || '',
        class: 'dxos-input',
      });
    }
    var fieldErrorEl = el('div', {
      'data-testid': 'public-form-field-error-' + field.name,
      role: 'alert',
      class: 'dxos-field-error dxos-hidden',
    });
    var clearFieldErr = function () {
      control.classList.remove('dxos-input-error');
      fieldErrorEl.textContent = '';
      fieldErrorEl.classList.add('dxos-hidden');
      clearError();
    };
    control.addEventListener('input', clearFieldErr);
    control.addEventListener('change', clearFieldErr);
    if (field.type === 'file' && fileState) {
      var ALLOWED_MIMES = { 'application/pdf': 1, 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'text/plain': 1 };
      fileState.clearBtn.addEventListener('click', function () {
        fileState.data = null;
        control.value = '';
        fileState.infoEl.textContent = '';
        fileState.infoEl.classList.add('dxos-hidden');
        fileState.clearBtn.classList.add('dxos-hidden');
        clearFieldErr();
      });
      control.addEventListener('change', function (ev) {
        var f = ev && ev.target && ev.target.files && ev.target.files[0];
        if (!f) return;
        var fType = String(f.type || '').toLowerCase();
        if (fType && !ALLOWED_MIMES[fType]) {
          setControlError(control, fieldErrorEl, '\\u0110\\u1ecbnh d\\u1ea1ng t\\u1ec7p kh\\u00f4ng \\u0111\\u01b0\\u1ee3c h\\u1ed7 tr\\u1ee3 (ch\\u1ec9 nh\\u1eadn PDF, PNG, JPEG, WebP, TXT).');
          control.value = '';
          return;
        }
        if (Number(f.size) > 2 * 1024 * 1024) {
          setControlError(control, fieldErrorEl, 'Dung l\\u01b0\\u1ee3ng t\\u1ec7p v\\u01b0\\u1ee3t qu\\u00e1 2 MB.');
          control.value = '';
          return;
        }
        var ReaderCtor = typeof FileReader !== 'undefined' ? FileReader : null;
        if (!ReaderCtor) return;
        var reader = new ReaderCtor();
        reader.onload = function () {
          var resStr = typeof reader.result === 'string' ? reader.result : '';
          var comma = resStr.indexOf(',');
          var b64 = comma >= 0 ? resStr.slice(comma + 1) : '';
          fileState.data = { filename: f.name || 'attachment', mimeType: fType || 'application/octet-stream', contentBase64: b64 };
          fileState.infoEl.textContent = (f.name || 'attachment') + ' (' + Math.max(1, Math.round(Number(f.size || 0) / 1024)) + ' KB)';
          fileState.infoEl.classList.remove('dxos-hidden');
          fileState.clearBtn.classList.remove('dxos-hidden');
          clearFieldErr();
        };
        reader.readAsDataURL(f);
      });
      wrap.appendChild(fileContainer);
    } else {
      wrap.appendChild(control);
    }
    wrap.appendChild(fieldErrorEl);
    formEl.appendChild(wrap);
    fieldControls.push({ field: field, control: control, errorEl: fieldErrorEl, fileState: fileState });
  });

  formEl.appendChild(hpInput);

  var submitBtn = el('button', {
    type: 'submit',
    'data-testid': 'public-form-submit-btn',
    class: 'dxos-btn dxos-btn-primary',
  }, 'G\\u1eedi bi\\u1ec3u m\\u1eabu');
  formEl.appendChild(submitBtn);
  formArea.appendChild(formEl);

  function setControlError(ctrl, errEl, message) {
    if (ctrl && ctrl.classList) ctrl.classList.add('dxos-input-error');
    if (errEl) {
      errEl.textContent = message;
      errEl.classList.remove('dxos-hidden');
    }
  }

  function clearControlError(ctrl, errEl) {
    if (ctrl && ctrl.classList) ctrl.classList.remove('dxos-input-error');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('dxos-hidden');
    }
  }

  function validateFormInputs() {
    var firstInvalid = null;
    var hasErrors = false;
    clearControlError(tokenInput, tokenErrorEl);
    fieldControls.forEach(function (entry) {
      clearControlError(entry.control, entry.errorEl);
    });

    if (formMeta.requireAccessToken && tokenInput) {
      var tokVal = String(tokenInput.value || '').trim();
      if (!tokVal) {
        setControlError(tokenInput, tokenErrorEl, 'Vui l\\u00f2ng nh\\u1eadp m\\u00e3 truy c\\u1eadp bi\\u1ec3u m\\u1eabu (Access Token).');
        if (!firstInvalid) firstInvalid = tokenInput;
        hasErrors = true;
      }
    }

    fieldControls.forEach(function (entry) {
      var f = entry.field;
      var ctrl = entry.control;
      var label = String(f.label || f.name);
      var msg = '';
      if (f.type === 'boolean') {
        if (f.required && !ctrl.checked) {
          msg = 'Vui l\\u00f2ng x\\u00e1c nh\\u1eadn ' + label + '.';
        }
      } else if (f.type === 'file') {
        if (f.required && !(entry.fileState && entry.fileState.data)) {
          msg = 'Vui l\\u00f2ng \\u0111\\u00ednh k\\u00e8m ' + label + '.';
        }
      } else {
        var raw = String(ctrl.value || '');
        var trimmed = raw.trim();
        if (f.required && !trimmed) {
          msg = 'Vui l\\u00f2ng nh\\u1eadp ' + label + '.';
        } else if (trimmed) {
          var maxLen = Number(f.maxLength);
          if (maxLen > 0 && raw.length > maxLen) {
            msg = label + ' kh\\u00f4ng \\u0111\\u01b0\\u1ee3c v\\u01b0\\u1ee3t qu\\u00e1 ' + maxLen + ' k\\u00fd t\\u1ef1.';
          } else if (f.type === 'email' && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(trimmed)) {
            msg = 'Email kh\\u00f4ng h\\u1ee3p l\\u1ec7. Vui l\\u00f2ng ki\\u1ec3m tra l\\u1ea1i.';
          } else if (f.type === 'number' || f.type === 'integer') {
            var num = Number(trimmed);
            if (!Number.isFinite(num)) {
              msg = 'Vui l\\u00f2ng nh\\u1eadp s\\u1ed1 h\\u1ee3p l\\u1ec7 cho ' + label + '.';
            } else if (f.type === 'integer' && !Number.isInteger(num)) {
              msg = 'Vui l\\u00f2ng nh\\u1eadp s\\u1ed1 nguy\\u00ean h\\u1ee3p l\\u1ec7 cho ' + label + '.';
            } else if (f.min !== undefined && num < Number(f.min)) {
              msg = label + ' t\\u1ed1i thi\\u1ec3u l\\u00e0 ' + f.min + '.';
            } else if (f.max !== undefined && num > Number(f.max)) {
              msg = label + ' t\\u1ed1i \\u0111a l\\u00e0 ' + f.max + '.';
            }
          }
        }
      }
      if (msg) {
        setControlError(ctrl, entry.errorEl, msg);
        if (!firstInvalid) firstInvalid = ctrl;
        hasErrors = true;
      }
    });

    if (hasErrors) {
      showError('Vui l\\u00f2ng ki\\u1ec3m tra v\\u00e0 \\u0111i\\u1ec1n \\u0111\\u1ea7y \\u0111\\u1ee7 c\\u00e1c th\\u00f4ng tin b\\u1eaft bu\\u1ed9c.');
      if (firstInvalid && typeof firstInvalid.focus === 'function') {
        firstInvalid.focus();
      }
      return false;
    }
    return true;
  }

  formEl.addEventListener('submit', function (evt) {
    evt.preventDefault();
    clearError();
    clearStatusError();
    if (!validateFormInputs()) {
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '\\u0110ang g\\u1eedi h\\u1ed3 s\\u01a1...';

    var values = {};
    fieldControls.forEach(function (entry) {
      if (entry.field.type === 'boolean') {
        values[entry.field.name] = Boolean(entry.control.checked);
      } else if (entry.field.type === 'file') {
        if (entry.fileState && entry.fileState.data) {
          values[entry.field.name] = entry.fileState.data;
        }
      } else {
        values[entry.field.name] = entry.control.value;
      }
    });

    var payload = {
      slug: formMeta.slug,
      values: values,
    };
    payload[hpName] = hpInput.value || '';
    if (tokenInput && tokenInput.value) {
      payload.token = tokenInput.value;
    }

    fetch(apiBase + '/dxosForms:submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (json) {
          if (!resp.ok) {
            var msg = (json && json.errors && json.errors[0] && json.errors[0].message) || (json && json.message) || ('HTTP ' + resp.status);
            throw new Error(msg);
          }
          return (json && json.data !== undefined) ? json.data : json;
        });
      })
      .then(function (res) {
        formArea.classList.add('dxos-hidden');
        while (receiptArea.firstChild) receiptArea.removeChild(receiptArea.firstChild);
        var rec = el('section', { 'data-testid': 'public-form-receipt', role: 'status', class: 'dxos-receipt' });
        rec.appendChild(el('div', { class: 'dxos-receipt-title' }, 'Đã tiếp nhận hồ sơ — Biên nhận bảo mật (Không lộ PII)'));
        rec.appendChild(el('div', { class: 'dxos-meta-line' }, 'Mã hồ sơ: ' + (res.submissionCode || '')));
        var tokenRow = el('div', { class: 'dxos-token-row' });
        tokenRow.appendChild(el('div', { class: 'dxos-token-line' }, 'Status Token: ' + (res.statusToken || '')));
        var copyBtn = el('button', {
          type: 'button',
          'data-testid': 'public-form-copy-token-btn',
          class: 'dxos-btn dxos-btn-secondary',
        }, 'Sao chép mã tra cứu');
        copyBtn.addEventListener('click', function () {
          copyTokenText(res.statusToken || '', copyBtn);
        });
        tokenRow.appendChild(copyBtn);
        rec.appendChild(tokenRow);
        rec.appendChild(el('div', { class: 'dxos-meta-sub' }, 'Trạng thái ban đầu: ' + (res.status || 'submitted') + ' · Lúc: ' + formatTimestampVi(res.submittedAt)));
        var recActions = el('div', { class: 'dxos-token-row' });
        var checkBtn = el('button', {
          type: 'button',
          'data-testid': 'public-form-check-status-btn',
          class: 'dxos-btn dxos-btn-success',
        }, 'Ki\\u1ec3m tra tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1');
        checkBtn.addEventListener('click', function () {
          checkStatus(formMeta.slug, res.submissionCode, res.statusToken, checkBtn);
        });
        var resetBtn = el('button', {
          type: 'button',
          'data-testid': 'public-form-reset-btn',
          class: 'dxos-btn dxos-btn-secondary',
        }, 'G\\u1eedi h\\u1ed3 s\\u01a1 kh\\u00e1c');
        resetBtn.addEventListener('click', function () {
          while (receiptArea.firstChild) receiptArea.removeChild(receiptArea.firstChild);
          while (statusArea.firstChild) statusArea.removeChild(statusArea.firstChild);
          clearStatusError();
          clearError();
          fieldControls.forEach(function (entry) {
            if (entry.field.type === 'boolean') entry.control.checked = false;
            else entry.control.value = '';
            if (entry.fileState) {
              entry.fileState.data = null;
              entry.fileState.infoEl.textContent = '';
              entry.fileState.infoEl.classList.add('dxos-hidden');
              entry.fileState.clearBtn.classList.add('dxos-hidden');
            }
            clearControlError(entry.control, entry.errorEl);
          });
          formArea.classList.remove('dxos-hidden');
        });
        recActions.appendChild(checkBtn);
        recActions.appendChild(resetBtn);
        rec.appendChild(recActions);
        receiptArea.appendChild(rec);
      })
      .catch(function (err) {
        showError((err && err.message) ? err.message : 'G\\u1eedi bi\\u1ec3u m\\u1eabu th\\u1ea5t b\\u1ea1i.');
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'G\\u1eedi bi\\u1ec3u m\\u1eabu';
      });
  });

  var lookupForm = el('form', { 'data-testid': 'public-form-manual-status-form', novalidate: true, class: 'dxos-card' });
  lookupForm.appendChild(el('div', { class: 'dxos-card-title' }, 'Tra c\\u1ee9u tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1 \\u0111\\u00e3 n\\u1ed9p'));
  var lookupCodeInput = el('input', {
    type: 'text',
    'data-testid': 'public-form-lookup-code-input',
    value: rawCode,
    placeholder: 'M\\u00e3 h\\u1ed3 s\\u01a1 (VD: LDX-FRM-...)',
    class: 'dxos-input dxos-field',
  });
  var lookupTokenRow = el('div', { class: 'dxos-token-row dxos-field' });
  var lookupTokenInput = el('input', {
    type: 'password',
    'data-testid': 'public-form-lookup-token-input',
    value: effectiveStatusToken,
    placeholder: 'M\\u00e3 tra c\\u1ee9u tr\\u1ea1ng th\\u00e1i (Status Token)',
    class: 'dxos-input dxos-input-flex',
  });
  var lookupTokenToggle = el('button', {
    type: 'button',
    'data-testid': 'public-form-lookup-token-toggle',
    'aria-label': 'Hi\\u1ec7n/\\u1ea9n m\\u00e3 tra c\\u1ee9u',
    'aria-pressed': 'false',
    class: 'dxos-btn dxos-btn-secondary',
  }, 'Hi\\u1ec7n');
  lookupTokenToggle.addEventListener('click', function () {
    var cur = lookupTokenInput.getAttribute ? lookupTokenInput.getAttribute('type') : lookupTokenInput.type;
    var nextType = cur === 'password' ? 'text' : 'password';
    lookupTokenInput.type = nextType;
    if (lookupTokenInput.setAttribute) lookupTokenInput.setAttribute('type', nextType);
    lookupTokenToggle.setAttribute('aria-pressed', nextType === 'text' ? 'true' : 'false');
    lookupTokenToggle.textContent = nextType === 'text' ? '\\u1ea8n' : 'Hi\\u1ec7n';
  });
  lookupTokenRow.appendChild(lookupTokenInput);
  lookupTokenRow.appendChild(lookupTokenToggle);
  var lookupBtn = el('button', {
    type: 'submit',
    'data-testid': 'public-form-lookup-btn',
    class: 'dxos-btn dxos-btn-secondary',
  }, 'Tra c\\u1ee9u h\\u1ed3 s\\u01a1');
  lookupForm.appendChild(lookupCodeInput);
  lookupForm.appendChild(lookupTokenRow);
  lookupForm.appendChild(lookupBtn);
  lookupForm.addEventListener('submit', function (evt) {
    evt.preventDefault();
    checkStatus(formMeta.slug, cleanToken(lookupCodeInput.value), cleanToken(lookupTokenInput.value), lookupBtn);
  });
  lookupArea.appendChild(lookupForm);
})();`;
}

function renderPublicFormHtml({
  slug = '',
  formMeta = null,
  errorMessage = '',
  nonce = '',
  apiBasePath = '/api',
} = {}) {
  const safeNonce = NONCE_SAFE_RE.test(String(nonce || ''))
    ? String(nonce)
    : randomBytes(16).toString('base64url');
  const normalizedApiBase = String(apiBasePath || '/api').replace(/\/+$/, '') || '/api';
  const bootstrap = {
    ok: Boolean(formMeta),
    slug: String(slug || ''),
    form: formMeta || null,
    error: formMeta ? '' : String(errorMessage || 'Biểu mẫu công khai không tồn tại hoặc đã ngừng tiếp nhận.'),
    apiBasePath: normalizedApiBase,
  };
  const pageTitle = formMeta?.title
    ? `${formMeta.title} — LatticeDX Public Form`
    : 'LatticeDX Public Form';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon" type="image/svg+xml" href="${INLINE_FAVICON_DATA_URI}">
  <style nonce="${safeNonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px 16px; background: #f1f5f9; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .dxos-page { max-width: 720px; margin: 16px auto; padding: 24px; background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0; }
    .dxos-header { margin-bottom: 20px; border-bottom: 1px solid #cbd5e1; padding-bottom: 12px; }
    .dxos-eyebrow { font-size: 12px; font-weight: 700; color: #0284c7; text-transform: uppercase; letter-spacing: 0.03em; }
    .dxos-title { margin: 4px 0 0; font-size: 22px; font-weight: 700; }
    .dxos-desc { margin: 6px 0 0; font-size: 14px; color: #475569; }
    .dxos-card { background: #ffffff; padding: 20px; border-radius: 10px; border: 1px solid #cbd5e1; margin-bottom: 16px; }
    .dxos-card-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; }
    .dxos-field { margin-bottom: 14px; }
    .dxos-label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
    .dxos-input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 14px; font-family: inherit; }
    .dxos-input-flex { flex: 1; min-width: 0; }
    .dxos-file-box { display: grid; gap: 6px; }
    .dxos-input-error { border-color: #dc2626; background: #fef2f2; }
    .dxos-field-error { color: #b91c1c; font-size: 12px; margin-top: 5px; font-weight: 500; }
    .dxos-checkbox { width: 16px; height: 16px; }
    .dxos-btn { min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; }
    .dxos-btn:disabled { cursor: not-allowed; opacity: 0.65; }
    .dxos-btn-primary { border: 1px solid #0284c7; background: #0284c7; color: #ffffff; }
    .dxos-btn-secondary { border: 1px solid #94a3b8; background: #ffffff; color: #0f172a; padding: 8px 14px; min-height: 44px; min-width: 44px; font-size: 13px; flex-shrink: 0; }
    .dxos-btn-success { border: 1px solid #15803d; background: #15803d; color: #ffffff; padding: 8px 14px; min-height: 44px; min-width: 44px; margin-top: 8px; }
    .dxos-token-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
    .dxos-alert { padding: 14px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .dxos-alert-error { background: #fee2e2; color: #991b1b; }
    .dxos-alert-warn { background: #fef3c7; color: #92400e; }
    .dxos-receipt { background: #f0fdf4; padding: 20px; border-radius: 10px; border: 1px solid #86efac; margin-bottom: 16px; }
    .dxos-receipt-title { font-weight: 700; font-size: 16px; color: #166534; margin-bottom: 10px; }
    .dxos-meta-line { font-size: 14px; margin-bottom: 4px; }
    .dxos-meta-sub { font-size: 13px; color: #475569; margin-bottom: 6px; }
    .dxos-token-line { font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; margin-bottom: 6px; }
    .dxos-hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .dxos-hidden { display: none; }
  </style>
</head>
<body>
  <main id="dxos-public-form-root"></main>
  <script type="application/json" id="dxos-form-bootstrap" nonce="${safeNonce}">${serializeSafeJsonForScript(bootstrap)}</script>
  <script nonce="${safeNonce}">${buildClientScriptSource()}</script>
</body>
</html>`;
}

function createPublicFormGatewayHandler({ db = null, getDb = null, apiBasePath = '/api' } = {}) {
  return async function publicFormGatewayHandler(req, res, appInstance) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }

    let pathname = '/';
    try {
      pathname = new URL(req?.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      return false;
    }

    const match = matchPublicFormPath(pathname);
    if (!match.matched) {
      return false;
    }

    const candidateSlug = String(match.rawSlug || '').trim().toLowerCase();
    const isValidSlug = Boolean(
      candidateSlug
      && SLUG_RE.test(candidateSlug)
      && !RESERVED_FORM_SLUGS.has(candidateSlug),
    );

    const activeDb = (typeof getDb === 'function' ? getDb() : null) || db || appInstance?.db || null;
    let formMeta = null;
    let errorMessage = 'Biểu mẫu công khai không tồn tại hoặc đã ngừng tiếp nhận.';

    if (isValidSlug && activeDb) {
      try {
        const form = await lookupFormBySlug(activeDb, candidateSlug);
        if (form && val(form, 'active') === true) {
          formMeta = serializePublicMeta(form);
          errorMessage = '';
        }
      } catch {
        formMeta = null;
        errorMessage = 'Biểu mẫu công khai không tồn tại hoặc đã ngừng tiếp nhận.';
      }
    }

    const nonce = randomBytes(16).toString('base64url');
    const html = renderPublicFormHtml({
      slug: candidateSlug,
      formMeta,
      errorMessage,
      nonce,
      apiBasePath,
    });

    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'`,
    };

    if (typeof res?.writeHead === 'function') {
      res.writeHead(200, headers);
    } else if (typeof res?.setHeader === 'function') {
      res.statusCode = 200;
      for (const [k, v] of Object.entries(headers)) {
        res.setHeader(k, v);
      }
    }

    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(html);
    }
    return true;
  };
}

module.exports = {
  matchPublicFormPath,
  renderPublicFormHtml,
  createPublicFormGatewayHandler,
};

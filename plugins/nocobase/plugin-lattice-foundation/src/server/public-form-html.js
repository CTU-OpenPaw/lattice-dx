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
  var statusErrorBox = el('div', { 'data-testid': 'public-form-status-error', role: 'alert', class: 'dxos-alert dxos-alert-warn dxos-hidden' });
  var statusArea = el('div');

  page.appendChild(formArea);
  page.appendChild(receiptArea);
  page.appendChild(statusErrorBox);
  page.appendChild(statusArea);
  root.appendChild(page);

  function showError(msg) {
    errorBox.textContent = String(msg || 'Public form not found or inactive.');
    errorBox.classList.remove('dxos-hidden');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('dxos-hidden');
  }

  function showStatusError(msg) {
    statusErrorBox.textContent = String(msg || 'Kh\\u00f4ng th\\u1ec3 tra c\\u1ee9u tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1.');
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
    card.appendChild(el('div', { class: 'dxos-meta-sub' }, 'C\\u1eadp nh\\u1eadt l\\u00fac: ' + (data.updatedAt || data.submittedAt || '\\u2014')));
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

  var formEl = el('form', { 'data-testid': 'public-form-element', class: 'dxos-card' });
  var hpInput = el('input', {
    type: 'text',
    name: hpName,
    'data-testid': 'public-form-honeypot',
    'aria-hidden': 'true',
    tabindex: '-1',
    autocomplete: 'off',
    class: 'dxos-hp',
  });
  formEl.appendChild(hpInput);

  var tokenInput = null;
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
    tokGroup.appendChild(tokenInput);
    formEl.appendChild(tokGroup);
  }

  var fieldControls = [];
  fields.forEach(function (field) {
    if (!field || !field.name) return;
    var wrap = el('div', { class: 'dxos-field' });
    var labelText = String(field.label || field.name) + (field.required ? ' *' : '');
    wrap.appendChild(el('label', { class: 'dxos-label' }, labelText));

    var control;
    if (field.type === 'text') {
      control = el('textarea', {
        name: field.name,
        required: Boolean(field.required),
        maxlength: Number(field.maxLength) || 2000,
        rows: 4,
        placeholder: field.placeholder || '',
        class: 'dxos-input',
      });
    } else if (field.type === 'select' && Array.isArray(field.options)) {
      control = el('select', {
        name: field.name,
        required: Boolean(field.required),
        class: 'dxos-input',
      });
      control.appendChild(el('option', { value: '' }, '-- Ch\\u1ecdn gi\\u00e1 tr\\u1ecb --'));
      field.options.forEach(function (opt) {
        control.appendChild(el('option', { value: String(opt) }, String(opt)));
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
    wrap.appendChild(control);
    formEl.appendChild(wrap);
    fieldControls.push({ field: field, control: control });
  });

  var submitBtn = el('button', {
    type: 'submit',
    'data-testid': 'public-form-submit-btn',
    class: 'dxos-btn dxos-btn-primary',
  }, 'G\\u1eedi bi\\u1ec3u m\\u1eabu');
  formEl.appendChild(submitBtn);
  formArea.appendChild(formEl);

  formEl.addEventListener('submit', function (evt) {
    evt.preventDefault();
    clearError();
    clearStatusError();
    submitBtn.disabled = true;
    submitBtn.textContent = '\\u0110ang g\\u1eedi h\\u1ed3 s\\u01a1...';

    var values = {};
    fieldControls.forEach(function (entry) {
      if (entry.field.type === 'boolean') {
        values[entry.field.name] = Boolean(entry.control.checked);
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
        rec.appendChild(el('div', { class: 'dxos-receipt-title' }, '\\u0110\\u00e3 ti\\u1ebfp nh\\u1eadn h\\u1ed3 s\\u01a1 (Zero-PII Receipt)'));
        rec.appendChild(el('div', { class: 'dxos-meta-line' }, 'M\\u00e3 h\\u1ed3 s\\u01a1: ' + (res.submissionCode || '')));
        rec.appendChild(el('div', { class: 'dxos-token-line' }, 'Status Token: ' + (res.statusToken || '')));
        rec.appendChild(el('div', { class: 'dxos-meta-sub' }, 'Tr\\u1ea1ng th\\u00e1i ban \\u0111\\u1ea7u: ' + (res.status || 'submitted') + ' \\u00b7 L\\u00fac: ' + (res.submittedAt || '\\u2014')));
        var checkBtn = el('button', {
          type: 'button',
          'data-testid': 'public-form-check-status-btn',
          class: 'dxos-btn dxos-btn-success',
        }, 'Ki\\u1ec3m tra tr\\u1ea1ng th\\u00e1i h\\u1ed3 s\\u01a1');
        checkBtn.addEventListener('click', function () {
          checkStatus(formMeta.slug, res.submissionCode, res.statusToken, checkBtn);
        });
        rec.appendChild(checkBtn);
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
    error: formMeta ? '' : String(errorMessage || 'Public form not found or inactive.'),
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
    .dxos-checkbox { width: 16px; height: 16px; }
    .dxos-btn { padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; }
    .dxos-btn:disabled { cursor: not-allowed; opacity: 0.65; }
    .dxos-btn-primary { border: 1px solid #0284c7; background: #0284c7; color: #ffffff; }
    .dxos-btn-success { border: 1px solid #15803d; background: #15803d; color: #ffffff; padding: 8px 14px; margin-top: 8px; }
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
    let errorMessage = 'Public form not found or inactive.';

    if (isValidSlug && activeDb) {
      try {
        const form = await lookupFormBySlug(activeDb, candidateSlug);
        if (form && val(form, 'active') === true) {
          formMeta = serializePublicMeta(form);
          errorMessage = '';
        }
      } catch {
        formMeta = null;
        errorMessage = 'Public form not found or inactive.';
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

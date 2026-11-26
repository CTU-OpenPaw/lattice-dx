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

const NONCE_SAFE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TRACK_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRACK_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
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

function sanitizeTrackCode(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  try {
    text = decodeURIComponent(text).trim();
  } catch {
    return '';
  }
  if (!text || text.includes('..') || text.includes('/') || text.includes('\\')) return '';
  return TRACK_CODE_RE.test(text) ? text : '';
}

function sanitizeTrackToken(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  try {
    text = decodeURIComponent(text).trim();
  } catch {
    return '';
  }
  if (!text || text.includes('..') || text.includes('/') || text.includes('\\')) return '';
  return TRACK_TOKEN_RE.test(text) ? text : '';
}

function matchPublicTrackPath(pathname) {
  const cleanPath = String(pathname || '').split('?')[0].split('#')[0];
  if (
    cleanPath === '/v/track'
    || cleanPath === '/v/track/'
    || cleanPath === '/track'
    || cleanPath === '/track/'
  ) {
    return { matched: true, rawCode: '' };
  }
  const m = cleanPath.match(/^\/(?:v\/)?track\/([^/]+)\/?$/);
  if (!m) {
    return { matched: false, rawCode: '' };
  }
  return { matched: true, rawCode: sanitizeTrackCode(m[1]) };
}

function buildClientScriptSource() {
  return `'use strict';
(function () {
  var root = document.getElementById('dxos-public-track-root');
  var bootstrapEl = document.getElementById('dxos-track-bootstrap');
  if (!root || !bootstrapEl) return;

  var bootstrap = { trackingCode: '', token: '', verify: '', apiBasePath: '/api' };
  try {
    bootstrap = JSON.parse(bootstrapEl.textContent || '{}');
  } catch (e) {
    bootstrap = { trackingCode: '', token: '', verify: '', apiBasePath: '/api' };
  }

  var apiBase = String(bootstrap.apiBasePath || '/api').replace(/\\/+$/, '') || '/api';
  var query = new URLSearchParams(window.location.search || '');
  var cleanInput = function (v) { return String(v || '').trim(); };
  var initialCode = cleanInput(bootstrap.trackingCode);
  var initialToken = cleanInput(bootstrap.token || query.get('token') || query.get('trackingToken'));
  var initialVerify = cleanInput(bootstrap.verify || query.get('verify'));

  var STATUS_LABELS = {
    draft: 'B\u1ea3n nh\u00e1p',
    submitted: '\u0110\u00e3 ti\u1ebfp nh\u1eadn',
    pending: 'Ch\u1edd x\u1eed l\u00fd',
    approved: '\u0110\u00e3 ph\u00ea duy\u1ec7t',
    in_transit: '\u0110ang v\u1eadn chuy\u1ec3n',
    delivered: '\u0110\u00e3 giao h\u00e0ng',
    completed: 'Ho\u00e0n t\u1ea5t',
    cancelled: '\u0110\u00e3 h\u1ee7y',
  };

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

  function formatStatusLabel(status) {
    var key = String(status || '').trim().toLowerCase();
    if (!key) return '\\u2014';
    return STATUS_LABELS[key] ? (STATUS_LABELS[key] + ' (' + key + ')') : String(status);
  }

  var page = el('div', { 'data-testid': 'public-track-page', class: 'dxos-page' });
  var header = el('header', { class: 'dxos-header' });
  header.appendChild(el('div', { class: 'dxos-eyebrow' }, 'LatticeDX Cold-Chain Trust \\u00b7 Zero-PII'));
  header.appendChild(el('h1', { class: 'dxos-title' }, 'Tra c\u1ee9u V\u1eadn \u0111\u01a1n & X\u00e1c th\u1ef1c Chu\u1ed7i k\u00fd s\u1ed1 Ed25519'));
  header.appendChild(el('p', { class: 'dxos-desc' }, 'Nh\u1eadp m\u00e3 v\u1eadn \u0111\u01a1n v\u00e0 m\u00e3 x\u00e1c th\u1ef1c theo d\u00f5i (Tracking Token) \u0111\u1ec3 ki\u1ec3m tra tr\u1ea1ng th\u00e1i giao nh\u1eadn kh\u00f4ng l\u1ed9 d\u1eef li\u1ec7u c\u00e1 nh\u00e2n.'));
  page.appendChild(header);

  var lookupForm = el('form', { 'data-testid': 'public-track-lookup-form', novalidate: true, class: 'dxos-card' });
  var grid = el('div', { class: 'dxos-form-grid' });

  var codeGroup = el('div', { class: 'dxos-field' });
  codeGroup.appendChild(el('label', { class: 'dxos-label', for: 'dxos-track-code-input' }, 'M\u00e3 v\u1eadn \u0111\u01a1n (Tracking Code) *'));
  var codeInput = el('input', {
    id: 'dxos-track-code-input',
    type: 'text',
    name: 'trackingCode',
    'data-testid': 'public-track-code-input',
    required: true,
    value: initialCode,
    placeholder: 'VD: LDX-TRK-001 ho\u1eb7c ORD-V100-001',
    class: 'dxos-input',
  });
  var codeErrorEl = el('div', {
    'data-testid': 'public-track-code-error',
    role: 'alert',
    class: 'dxos-field-error dxos-hidden',
  });
  codeGroup.appendChild(codeInput);
  codeGroup.appendChild(codeErrorEl);
  grid.appendChild(codeGroup);

  var tokenGroup = el('div', { class: 'dxos-field' });
  tokenGroup.appendChild(el('label', { class: 'dxos-label', for: 'dxos-track-token-input' }, 'M\\u00e3 x\\u00e1c th\\u1ef1c (Tracking Token) *'));
  var tokenWrap = el('div', { class: 'dxos-input-wrap' });
  var tokenInput = el('input', {
    id: 'dxos-track-token-input',
    type: 'password',
    name: 'token',
    'data-testid': 'public-track-token-input',
    required: true,
    value: initialToken,
    placeholder: 'Nh\\u1eadp token t\\u1eeb phi\\u1ebfu giao nh\\u1eadn / QR (?token=...)',
    class: 'dxos-input dxos-input-with-toggle',
  });
  var tokenToggleBtn = el('button', {
    type: 'button',
    'data-testid': 'public-track-token-toggle',
    'aria-label': 'Hi\\u1ec7n/\\u1ea9n m\\u00e3 x\\u00e1c th\\u1ef1c',
    'aria-pressed': 'false',
    class: 'dxos-eye-btn',
  }, 'Hi\\u1ec7n');
  tokenToggleBtn.addEventListener('click', function () {
    var cur = tokenInput.getAttribute ? tokenInput.getAttribute('type') : tokenInput.type;
    var nextType = cur === 'password' ? 'text' : 'password';
    tokenInput.type = nextType;
    if (tokenInput.setAttribute) tokenInput.setAttribute('type', nextType);
    tokenToggleBtn.setAttribute('aria-pressed', nextType === 'text' ? 'true' : 'false');
    tokenToggleBtn.textContent = nextType === 'text' ? '\\u1ea8n' : 'Hi\\u1ec7n';
  });
  var tokenErrorEl = el('div', {
    'data-testid': 'public-track-token-error',
    role: 'alert',
    class: 'dxos-field-error dxos-hidden',
  });
  tokenWrap.appendChild(tokenInput);
  tokenWrap.appendChild(tokenToggleBtn);
  tokenGroup.appendChild(tokenWrap);
  tokenGroup.appendChild(tokenErrorEl);
  grid.appendChild(tokenGroup);
  lookupForm.appendChild(grid);

  var lookupBtn = el('button', {
    type: 'submit',
    'data-testid': 'public-track-lookup-btn',
    class: 'dxos-btn dxos-btn-primary',
  }, 'Tra c\u1ee9u v\u1eadn \u0111\u01a1n');
  lookupForm.appendChild(lookupBtn);
  page.appendChild(lookupForm);

  var loadingBox = el('div', { 'data-testid': 'public-track-loading', role: 'status', class: 'dxos-alert dxos-alert-info dxos-hidden' }, '\u0110ang t\u1ea3i th\u00f4ng tin v\u1eadn \u0111\u01a1n...');
  var errorBox = el('div', { 'data-testid': 'public-track-error', role: 'alert', class: 'dxos-alert dxos-alert-error dxos-hidden' });
  var resultArea = el('div');

  page.appendChild(loadingBox);
  page.appendChild(errorBox);
  page.appendChild(resultArea);
  root.appendChild(page);

  var activeTrackState = { code: initialCode, token: initialToken };

  function showError(msg) {
    errorBox.textContent = String(msg || 'Kh\u00f4ng th\u1ec3 tra c\u1ee9u v\u1eadn \u0111\u01a1n.');
    errorBox.classList.remove('dxos-hidden');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('dxos-hidden');
  }

  function setLoading(flag) {
    if (flag) loadingBox.classList.remove('dxos-hidden');
    else loadingBox.classList.add('dxos-hidden');
    lookupBtn.disabled = Boolean(flag);
    lookupBtn.textContent = flag ? '\u0110ang tra c\u1ee9u...' : 'Tra c\u1ee9u v\u1eadn \u0111\u01a1n';
  }

  function renderTimeline(data) {
    var box = el('div', { 'data-testid': 'public-track-timeline', class: 'dxos-timeline' });
    box.appendChild(el('div', { class: 'dxos-section-title' }, 'Ti\u1ebfn tr\u00ecnh v\u1eadn \u0111\u01a1n (Zero-PII)'));
    var statusKey = String(data.status || '').toLowerCase();
    var steps = [
      {
        title: 'Kh\u1edfi t\u1ea1o ch\u1ee9ng t\u1eeb giao nh\u1eadn',
        detail: data.orderCode ? ('\u0110\u01a1n h\u00e0ng: ' + data.orderCode) : ('M\u00e3 v\u1eadn \u0111\u01a1n: ' + (data.trackingCode || '\\u2014')),
        done: true,
      },
      {
        title: 'Gi\u00e1m s\u00e1t chu\u1ed7i l\u1ea1nh & ni\u00eam phong',
        detail: data.tempSummary && data.tempSummary.mktCelsius !== undefined && data.tempSummary.mktCelsius !== null
          ? ('MKT: ' + data.tempSummary.mktCelsius + ' \\u00b0C (' + (data.tempSummary.inRange === false ? 'C\u1ea3nh b\u00e1o v\u01b0\u1ee3t ng\u01b0\u1ee1ng' : '\u0110\u1ea1t chu\u1ea9n 2\\u20138 \\u00b0C') + ')')
          : 'Theo d\u00f5i tr\u1ea1ng th\u00e1i chu\u1ed7i cung \u1ee9ng',
        done: statusKey === 'in_transit' || statusKey === 'delivered' || statusKey === 'completed',
      },
      {
        title: 'B\u00e0n giao & K\u00fd s\u1ed1 ePOD PKI',
        detail: data.deliveredAt
          ? ('Th\u1eddi \u0111i\u1ec3m giao: ' + formatTimestampVi(data.deliveredAt))
          : ('Tr\u1ea1ng th\u00e1i hi\u1ec7n t\u1ea1i: ' + formatStatusLabel(data.status)),
        done: statusKey === 'delivered' || statusKey === 'completed',
      },
    ];
    steps.forEach(function (step) {
      var item = el('div', { class: 'dxos-timeline-item' + (step.done ? ' dxos-timeline-done' : '') });
      item.appendChild(el('div', { class: 'dxos-timeline-dot' }));
      var body = el('div');
      body.appendChild(el('div', { class: 'dxos-timeline-title' }, step.title));
      body.appendChild(el('div', { class: 'dxos-timeline-detail' }, step.detail));
      item.appendChild(body);
      box.appendChild(item);
    });
    return box;
  }

  function renderTrackResult(data, code, token) {
    while (resultArea.firstChild) resultArea.removeChild(resultArea.firstChild);
    if (!data) return;

    var card = el('section', { 'data-testid': 'public-track-status-card', class: 'dxos-card' });
    var metaGrid = el('div', { class: 'dxos-meta-grid' });

    function addMeta(label, valText) {
      var cell = el('div');
      cell.appendChild(el('div', { class: 'dxos-meta-label' }, label));
      cell.appendChild(el('strong', { class: 'dxos-meta-val' }, valText || '\\u2014'));
      metaGrid.appendChild(cell);
    }

    addMeta('M\u00e3 theo d\u00f5i (Tracking Code)', data.trackingCode || code);
    addMeta('M\u00e3 \u0111\u01a1n h\u00e0ng (Order)', data.orderCode || '\\u2014');
    addMeta('Tr\u1ea1ng th\u00e1i giao nh\u1eadn', formatStatusLabel(data.status));
    addMeta('Th\u1eddi \u0111i\u1ec3m giao', formatTimestampVi(data.deliveredAt));
    card.appendChild(metaGrid);

    card.appendChild(renderTimeline(data));

    if (data.tempSummary && (data.tempSummary.mktCelsius !== undefined && data.tempSummary.mktCelsius !== null || data.tempSummary.inRange !== null)) {
      var inRange = data.tempSummary.inRange;
      var tempBox = el('div', { class: 'dxos-pill-box ' + (inRange === false ? 'dxos-pill-warn' : 'dxos-pill-ok') });
      var tempTxt = 'Chu\u1ed7i l\u1ea1nh (MKT): '
        + (data.tempSummary.mktCelsius !== undefined && data.tempSummary.mktCelsius !== null ? (data.tempSummary.mktCelsius + ' \\u00b0C') : 'Ch\u01b0a ghi nh\u1eadn')
        + ' \\u00b7 '
        + (inRange === false ? 'C\u1ea3nh b\u00e1o v\u01b0\u1ee3t ng\u01b0\u1ee1ng' : '\u0110\u1ea1t chu\u1ea9n 2\\u20138 \\u00b0C');
      tempBox.textContent = tempTxt;
      card.appendChild(tempBox);
    }

    var ledger = data.ledgerVerification;
    if (ledger) {
      var ledgerBox = el('div', { class: 'dxos-ledger-box' });
      ledgerBox.appendChild(el('div', null, 'S\u1ed5 c\u00e1i b\u1ea5t bi\u1ebfn #' + (ledger.seq != null ? ledger.seq : '\\u2014') + ' \\u00b7 Kh\u00f3a: ' + (ledger.keyId || '\\u2014')));
      ledgerBox.appendChild(el('div', { class: 'dxos-meta-sub' }, ledger.verifiedFormat ? '\u0110\u1ecbnh d\u1ea1ng ch\u1eef k\u00fd Ed25519 h\u1ee3p l\u1ec7' : 'Ch\u01b0a c\u00f3 ch\u1eef k\u00fd Ed25519'));
      card.appendChild(ledgerBox);
    }

    var verifyBtn = el('button', {
      type: 'button',
      'data-testid': 'public-track-verify-btn',
      class: 'dxos-btn dxos-btn-primary',
    }, 'X\u00e1c th\u1ef1c ch\u1eef k\u00fd Ed25519');
    var verifyArea = el('div');

    verifyBtn.addEventListener('click', function () {
      while (verifyArea.firstChild) verifyArea.removeChild(verifyArea.firstChild);
      if (!code || !token) {
        verifyArea.appendChild(el('div', { 'data-testid': 'public-track-verify-error', class: 'dxos-alert dxos-alert-warn' }, 'Thi\u1ebfu m\u00e3 v\u1eadn \u0111\u01a1n ho\u1eb7c m\u00e3 x\u00e1c th\u1ef1c \u0111\u1ec3 ki\u1ec3m \u0111\u1ecbnh ch\u1eef k\u00fd.'));
        return;
      }
      verifyBtn.disabled = true;
      verifyBtn.textContent = '\\u0110ang ki\\u1ec3m \\u0111\\u1ecbnh ch\\u1eef k\\u00fd...';
      fetch(apiBase + '/dxosWms:verifyTrackSignature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: data.trackingCode || code, trackingCode: data.trackingCode || code, token: token }),
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
          var ok = Boolean(res && res.verified);
          var box = el('div', {
            'data-testid': 'public-track-verify-result',
            class: 'dxos-alert ' + (ok ? 'dxos-alert-success' : 'dxos-alert-error'),
          });
          var seq = res && (res.ledgerSeq != null ? res.ledgerSeq : res.seq);
          box.appendChild(el('div', { class: 'dxos-card-title' }, (ok ? 'Ch\u1eef k\u00fd Ed25519 h\u1ee3p l\u1ec7' : 'Ch\u1eef k\u00fd Ed25519 kh\u00f4ng h\u1ee3p l\u1ec7') + (seq != null ? (' \\u00b7 Seq #' + seq) : '') + ' \\u00b7 Key: ' + ((res && res.keyId) || '\\u2014')));
          if (res && res.publicKeyFingerprint) {
            box.appendChild(el('div', { class: 'dxos-mono' }, 'Fingerprint: ' + res.publicKeyFingerprint));
          }
          if (res && res.entryHash) {
            box.appendChild(el('div', { class: 'dxos-mono' }, 'Entry Hash: ' + res.entryHash));
          }
          if (res && res.verifiedAt) {
            box.appendChild(el('div', { class: 'dxos-meta-sub' }, 'Ki\u1ec3m \u0111\u1ecbnh l\u00fac: ' + formatTimestampVi(res.verifiedAt)));
          }
          if (res && res.reason) {
            box.appendChild(el('div', { class: 'dxos-meta-sub' }, 'L\u00fd do: ' + res.reason));
          }
          verifyArea.appendChild(box);
        })
        .catch(function (err) {
          verifyArea.appendChild(el('div', {
            'data-testid': 'public-track-verify-error',
            class: 'dxos-alert dxos-alert-warn',
          }, (err && err.message) ? err.message : 'Kh\u00f4ng th\u1ec3 ki\u1ec3m \u0111\u1ecbnh ch\u1eef k\u00fd Ed25519.'));
        })
        .finally(function () {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'X\u00e1c th\u1ef1c ch\u1eef k\u00fd Ed25519';
        });
    });

    card.appendChild(verifyBtn);
    card.appendChild(verifyArea);
    resultArea.appendChild(card);
  }

  function setFieldError(inputEl, errEl, msg) {
    if (inputEl && inputEl.classList) inputEl.classList.add('dxos-input-error');
    if (errEl) {
      errEl.textContent = String(msg || '');
      errEl.classList.remove('dxos-hidden');
    }
  }

  function clearFieldError(inputEl, errEl) {
    if (inputEl && inputEl.classList) inputEl.classList.remove('dxos-input-error');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('dxos-hidden');
    }
  }

  codeInput.addEventListener('input', function () {
    clearFieldError(codeInput, codeErrorEl);
    clearError();
  });
  tokenInput.addEventListener('input', function () {
    clearFieldError(tokenInput, tokenErrorEl);
    clearError();
  });

  function performTrackLookup(code, token) {
    clearError();
    clearFieldError(codeInput, codeErrorEl);
    clearFieldError(tokenInput, tokenErrorEl);
    while (resultArea.firstChild) resultArea.removeChild(resultArea.firstChild);
    if (!code || !token) {
      if (!code) setFieldError(codeInput, codeErrorEl, 'Vui l\\u00f2ng nh\\u1eadp m\\u00e3 v\\u1eadn \\u0111\\u01a1n.');
      if (!token) setFieldError(tokenInput, tokenErrorEl, 'Vui l\\u00f2ng nh\\u1eadp m\\u00e3 x\\u00e1c th\\u1ef1c (Tracking Token).');
      showError('Vui l\\u00f2ng nh\\u1eadp \\u0111\\u1ea7y \\u0111\\u1ee7 m\\u00e3 v\\u1eadn \\u0111\\u01a1n v\\u00e0 m\\u00e3 x\\u00e1c th\\u1ef1c (?token=...) \\u0111\\u1ec3 tra c\\u1ee9u.');
      var focusTarget = !code ? codeInput : tokenInput;
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
      return Promise.resolve();
    }
    activeTrackState = { code: code, token: token };
    setLoading(true);
    var qs = new URLSearchParams({ trackingCode: code, token: token }).toString();
    return fetch(apiBase + '/dxosWms:publicTrack?' + qs, { method: 'GET' })
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
        renderTrackResult(payload, code, token);
      })
      .catch(function (err) {
        showError((err && err.message) ? err.message : 'Kh\u00f4ng th\u1ec3 t\u1ea3i tr\u1ea1ng th\u00e1i v\u1eadn \u0111\u01a1n c\u00f4ng khai.');
      })
      .finally(function () {
        setLoading(false);
      });
  }

  function verifyPublicProof(code, verifyCode) {
    clearError();
    while (resultArea.firstChild) resultArea.removeChild(resultArea.firstChild);
    if (!code || !verifyCode) return Promise.resolve();
    setLoading(true);
    return fetch(apiBase + '/dxosWms:verifyTrackSignature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, trackingCode: code, verify: verifyCode }),
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
        var ok = Boolean(res && res.verified);
        var card = el('section', {
          'data-testid': 'public-track-proof-card',
          class: 'dxos-card',
        });
        card.appendChild(el('div', { class: 'dxos-card-title' }, ok ? 'Ch\\u1ee9ng th\\u1ef1c S\\u1ed5 c\\u00e1i c\\u00f4ng khai Ed25519 h\\u1ee3p l\\u1ec7' : 'Kh\\u00f4ng x\\u00e1c th\\u1ef1c \\u0111\\u01b0\\u1ee3c ch\\u1ee9ng th\\u1ef1c c\\u00f4ng khai'));
        card.appendChild(el('div', { class: 'dxos-meta-line' }, 'M\\u00e3 v\\u1eadn \\u0111\\u01a1n: ' + ((res && res.trackingCode) || code)));
        if (res && res.keyId) card.appendChild(el('div', { class: 'dxos-meta-sub' }, 'Kh\\u00f3a k\\u00fd s\\u1ed1: ' + res.keyId));
        var hashVal = res && (res.ledgerEntryHash || res.entryHash);
        if (hashVal) card.appendChild(el('div', { class: 'dxos-mono' }, 'Ledger Hash: ' + hashVal));
        var signedAt = res && (res.signedAt || res.verifiedAt);
        if (signedAt) card.appendChild(el('div', { class: 'dxos-meta-sub' }, 'Th\\u1eddi \\u0111i\\u1ec3m k\\u00fd: ' + formatTimestampVi(signedAt)));
        card.appendChild(el('div', { class: 'dxos-alert dxos-alert-info' }, 'Ch\\u1ebf \\u0111\\u1ed9 x\\u00e1c th\\u1ef1c c\\u00f4ng khai (Zero-PII). Vui l\\u00f2ng nh\\u1eadp M\\u00e3 x\\u00e1c th\\u1ef1c (Tracking Token) \\u1edf tr\\u00ean \\u0111\\u1ec3 xem chi ti\\u1ebft ePOD v\\u00e0 nh\\u1eadt k\\u00fd giao nh\\u1eadn.'));
        resultArea.appendChild(card);
      })
      .catch(function (err) {
        showError((err && err.message) ? err.message : 'Kh\\u00f4ng th\\u1ec3 x\\u00e1c th\\u1ef1c m\\u00e3 QR c\\u00f4ng khai.');
      })
      .finally(function () {
        setLoading(false);
      });
  }

  lookupForm.addEventListener('submit', function (evt) {
    evt.preventDefault();
    performTrackLookup(cleanInput(codeInput.value), cleanInput(tokenInput.value));
  });

  if (activeTrackState.code && activeTrackState.token) {
    performTrackLookup(activeTrackState.code, activeTrackState.token);
  } else if (activeTrackState.code && initialVerify) {
    verifyPublicProof(activeTrackState.code, initialVerify);
  }
})();`;
}

function renderPublicTrackHtml({
  trackingCode = '',
  token = '',
  verify = '',
  nonce = '',
  apiBasePath = '/api',
} = {}) {
  const safeNonce = NONCE_SAFE_RE.test(String(nonce || ''))
    ? String(nonce)
    : randomBytes(16).toString('base64url');
  const normalizedApiBase = String(apiBasePath || '/api').replace(/\/+$/, '') || '/api';
  const safeVerify = sanitizeTrackToken(verify);
  const bootstrap = {
    trackingCode: sanitizeTrackCode(trackingCode),
    token: sanitizeTrackToken(token),
    ...(safeVerify ? { verify: safeVerify } : {}),
    apiBasePath: normalizedApiBase,
  };

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tra cứu vận đơn — LatticeDX</title>
  <link rel="icon" type="image/svg+xml" href="${INLINE_FAVICON_DATA_URI}">
  <style nonce="${safeNonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px 16px; background: #f1f5f9; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .dxos-page { max-width: 760px; margin: 16px auto; padding: 24px; background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0; }
    .dxos-header { margin-bottom: 20px; border-bottom: 1px solid #cbd5e1; padding-bottom: 12px; }
    .dxos-eyebrow { font-size: 12px; font-weight: 700; color: #0284c7; text-transform: uppercase; letter-spacing: 0.03em; }
    .dxos-title { margin: 4px 0 0; font-size: 22px; font-weight: 700; }
    .dxos-desc { margin: 6px 0 0; font-size: 14px; color: #475569; }
    .dxos-card { background: #ffffff; padding: 20px; border-radius: 10px; border: 1px solid #cbd5e1; margin-bottom: 16px; }
    .dxos-card-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .dxos-section-title { font-weight: 700; font-size: 14px; margin-bottom: 10px; color: #0f172a; }
    .dxos-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 12px; }
    .dxos-field { margin-bottom: 4px; }
    .dxos-label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
    .dxos-input { width: 100%; min-height: 44px; padding: 9px 10px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 14px; font-family: inherit; }
    .dxos-input-wrap { display: flex; gap: 6px; align-items: center; }
    .dxos-input-with-toggle { flex: 1; min-width: 0; }
    .dxos-eye-btn { min-height: 44px; min-width: 44px; padding: 9px 12px; border-radius: 6px; border: 1px solid #cbd5e1; background: #ffffff; color: #334155; font-size: 12px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
    .dxos-input-error { border-color: #dc2626; background: #fef2f2; }
    .dxos-field-error { color: #b91c1c; font-size: 12px; margin-top: 5px; font-weight: 500; }
    .dxos-btn { min-height: 44px; min-width: 44px; padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; }
    .dxos-btn:disabled { cursor: not-allowed; opacity: 0.65; }
    .dxos-btn-primary { border: 1px solid #0284c7; background: #0284c7; color: #ffffff; }
    .dxos-alert { padding: 14px 16px; border-radius: 8px; margin-top: 12px; margin-bottom: 16px; font-size: 14px; }
    .dxos-alert-info { background: #e0f2fe; color: #075985; }
    .dxos-alert-error { background: #fee2e2; color: #991b1b; }
    .dxos-alert-warn { background: #fef3c7; color: #92400e; }
    .dxos-alert-success { background: #dcfce7; color: #166534; }
    .dxos-meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .dxos-meta-label { font-size: 12px; color: #64748b; margin-bottom: 2px; }
    .dxos-meta-val { font-size: 14px; color: #0f172a; }
    .dxos-meta-sub { font-size: 13px; color: #475569; margin-top: 4px; }
    .dxos-pill-box { padding: 12px; border-radius: 8px; margin-bottom: 14px; font-size: 14px; font-weight: 600; }
    .dxos-pill-ok { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
    .dxos-pill-warn { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .dxos-ledger-box { padding: 12px; border-radius: 8px; background: #f1f5f9; margin-bottom: 14px; font-size: 14px; }
    .dxos-timeline { border-top: 1px solid #e2e8f0; padding-top: 14px; margin-bottom: 14px; }
    .dxos-timeline-item { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 10px; }
    .dxos-timeline-dot { width: 10px; height: 10px; border-radius: 999px; background: #94a3b8; margin-top: 5px; flex-shrink: 0; }
    .dxos-timeline-done .dxos-timeline-dot { background: #0284c7; }
    .dxos-timeline-title { font-size: 14px; font-weight: 600; color: #0f172a; }
    .dxos-timeline-detail { font-size: 13px; color: #475569; }
    .dxos-mono { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; margin-top: 4px; }
    .dxos-hidden { display: none; }
  </style>
</head>
<body>
  <main id="dxos-public-track-root"></main>
  <script type="application/json" id="dxos-track-bootstrap" nonce="${safeNonce}">${serializeSafeJsonForScript(bootstrap)}</script>
  <script nonce="${safeNonce}">${buildClientScriptSource()}</script>
</body>
</html>`;
}

function createPublicTrackGatewayHandler({ apiBasePath = '/api' } = {}) {
  return async function publicTrackGatewayHandler(req, res) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }

    let urlObj;
    try {
      urlObj = new URL(req?.url || '/', 'http://127.0.0.1');
    } catch {
      return false;
    }

    const match = matchPublicTrackPath(urlObj.pathname);
    if (!match.matched) {
      return false;
    }

    const token = sanitizeTrackToken(
      urlObj.searchParams.get('token') || urlObj.searchParams.get('trackingToken') || '',
    );
    const verify = sanitizeTrackToken(urlObj.searchParams.get('verify') || '');
    const nonce = randomBytes(16).toString('base64url');
    const html = renderPublicTrackHtml({
      trackingCode: match.rawCode,
      token,
      verify,
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
  matchPublicTrackPath,
  renderPublicTrackHtml,
  createPublicTrackGatewayHandler,
};

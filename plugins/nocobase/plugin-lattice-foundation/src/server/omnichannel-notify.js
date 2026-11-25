/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { createHmac, randomUUID } = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { val, getRepo, callerRoles } = require('./native-portal-helpers');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');
const {
  assertSafeConnectorUrlAsync,
  buildConnectorAuthHeaders,
  getFreshConnectorToken,
  resolveAllowInternalConnectorHosts,
  resolveConnectorSecrets,
  serializeConnector,
} = require('./connector-vault');
const {
  canUsePgRlsSession,
  getActiveRlsContext,
  isValidOrganizationId,
  runInRlsSavepoint,
  withTenantRlsContext,
} = require('./pg-rls');

const SUPPORTED_CHANNELS = Object.freeze(['smtp', 'telegram', 'slack', 'webhook']);
const SUPPORTED_CHANNEL_SET = new Set(SUPPORTED_CHANNELS);
const TELEGRAM_TOKEN_RE = /^[0-9]{5,16}:[A-Za-z0-9_-]{20,120}$/;
const TELEGRAM_CHAT_RE = /^-?[0-9a-zA-Z_@.-]{1,64}$/;
const HEADER_INJECTION_RE = /[\r\n\0]/;
const BLOCKED_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ELEVATED_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const OPERATOR_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_manager', 'operator']);
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 250;
const MAX_BACKOFF_MS = 5000;

function failNotify(code, status = 400, message = code, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeResolvePath(root, dotPath) {
  if (!root || typeof root !== 'object') return undefined;
  const parts = String(dotPath || '').split('.').filter(Boolean);
  if (parts.length === 0) return undefined;
  let cur = root;
  for (const part of parts) {
    if (BLOCKED_PATH_KEYS.has(part)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function renderTemplate(template, vars = {}, { htmlEscape = false } = {}) {
  if (template === undefined || template === null) return '';
  const source = String(template);
  const safeVars = isPlainObject(vars) ? vars : {};
  return source.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, expr) => {
    const resolved = safeResolvePath(safeVars, expr);
    if (resolved === undefined || resolved === null) return '';
    if (typeof resolved === 'object') return '';
    const text = String(resolved);
    return htmlEscape ? escapeHtml(text) : text;
  });
}

function sanitizeAndInterpolateNode(node, vars) {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string') {
    return renderTemplate(node, vars, { htmlEscape: false });
  }
  if (typeof node === 'number' || typeof node === 'boolean') return node;
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeAndInterpolateNode(item, vars));
  }
  if (typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      if (BLOCKED_PATH_KEYS.has(key)) continue;
      if (!Object.hasOwn(node, key)) continue;
      out[key] = sanitizeAndInterpolateNode(node[key], vars);
    }
    return out;
  }
  return String(node);
}

function renderWebhookPayload(templateObj, vars = {}) {
  const safeVars = isPlainObject(vars) ? vars : {};
  if (templateObj === undefined || templateObj === null || templateObj === '') {
    return {
      event: safeVars.eventType || 'lattice.notification',
      organizationId: safeVars.organizationId || null,
      category: safeVars.category || 'system',
      severity: safeVars.severity || 'info',
      title: safeVars.title || '',
      body: safeVars.body || '',
      targetCollection: safeVars.targetCollection || null,
      targetRecordId: safeVars.targetRecordId ?? null,
      targetPath: safeVars.targetPath || null,
      timestamp: safeVars.timestamp || new Date().toISOString(),
    };
  }
  if (typeof templateObj === 'string') {
    const trimmed = templateObj.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      return sanitizeAndInterpolateNode(parsed, safeVars);
    }
    return { text: renderTemplate(templateObj, safeVars) };
  }
  return sanitizeAndInterpolateNode(templateObj, safeVars);
}

function collectSecretValues(secrets, out = new Set()) {
  if (!secrets) return out;
  if (typeof secrets === 'string') {
    const trimmed = secrets.trim();
    if (trimmed.length >= 4) out.add(trimmed);
    return out;
  }
  if (Array.isArray(secrets)) {
    for (const item of secrets) collectSecretValues(item, out);
    return out;
  }
  if (typeof secrets === 'object') {
    for (const key of Object.keys(secrets)) {
      if (BLOCKED_PATH_KEYS.has(key) || !Object.hasOwn(secrets, key)) continue;
      const v = secrets[key];
      if (typeof v === 'string' && v.trim().length >= 4) {
        out.add(v.trim());
      } else if (v && typeof v === 'object') {
        collectSecretValues(v, out);
      }
    }
  }
  return out;
}

function scrubStringSecrets(str, secretList) {
  let text = String(str ?? '');
  for (const secret of secretList) {
    if (secret && text.includes(secret)) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  text = text.replace(/\bbot[0-9]{5,16}:[A-Za-z0-9_-]{20,120}\b/g, 'bot[REDACTED]');
  text = text.replace(/\b[0-9]{5,16}:[A-Za-z0-9_-]{20,120}\b/g, '[REDACTED]');
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
  text = text.replace(/\bxox[bpa]-[A-Za-z0-9-]{8,}\b/g, '[REDACTED]');
  return text;
}

function scrubSecrets(input, secrets = {}) {
  const secretList = [...collectSecretValues(secrets)].sort((a, b) => b.length - a.length);
  const walk = (value) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return scrubStringSecrets(value, secretList);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) {
        if (BLOCKED_PATH_KEYS.has(key) || !Object.hasOwn(value, key)) continue;
        if (/secret|password|token|apikey|private|auth/i.test(key) && typeof value[key] === 'string' && value[key]) {
          out[key] = '[REDACTED]';
        } else {
          out[key] = walk(value[key]);
        }
      }
      return out;
    }
    return scrubStringSecrets(String(value), secretList);
  };
  return walk(input);
}

function assertNoHeaderInjection(value, fieldName = 'header') {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (HEADER_INJECTION_RE.test(text)) {
    throw failNotify(
      'SMTP_HEADER_INJECTION_BLOCKED',
      400,
      `Control characters (CR/LF/NUL) are forbidden in ${fieldName}.`,
      { retryable: false },
    );
  }
  return text;
}

function extractEmailAddress(raw) {
  const clean = assertNoHeaderInjection(raw, 'email address').trim();
  if (!clean) {
    throw failNotify('SMTP_RECIPIENT_INVALID', 400, 'Email address cannot be empty.', { retryable: false });
  }
  const angle = /<([^<>]+)>/.exec(clean);
  const addr = (angle ? angle[1] : clean).trim();
  if (!addr || HEADER_INJECTION_RE.test(addr) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) {
    throw failNotify('SMTP_RECIPIENT_INVALID', 400, `Invalid email address: ${addr || '<empty>'}`, { retryable: false });
  }
  return { headerValue: clean, envelopeAddress: addr };
}

function normalizeRecipientList(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items.map((s) => String(s || '').trim()).filter(Boolean);
}

function maskEmail(email) {
  const clean = String(email || '').trim();
  const at = clean.indexOf('@');
  if (at <= 1) return clean ? `***${clean.slice(Math.max(0, at))}` : '';
  return `${clean[0]}***${clean.slice(at)}`;
}

function maskTarget(channel, rawTarget, secrets = {}) {
  let masked = '';
  if (channel === 'smtp') {
    const list = normalizeRecipientList(rawTarget);
    masked = list.length ? list.map(maskEmail).join(', ') : 'smtp:unknown';
  } else if (channel === 'telegram') {
    const chat = String(rawTarget || '').trim();
    const tail = chat.length > 4 ? `${chat.slice(0, 2)}***${chat.slice(-2)}` : '***';
    masked = `telegram:chat:${tail}`;
  } else if (channel === 'slack') {
    const t = String(rawTarget || '').trim();
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        masked = `${u.origin}/***`;
      } catch {
        masked = 'slack:webhook:***';
      }
    } else {
      masked = t ? `slack:channel:${t}` : 'slack:channel:***';
    }
  } else if (channel === 'webhook') {
    try {
      const u = new URL(String(rawTarget || ''));
      masked = `${u.origin}${u.pathname}`;
    } catch {
      masked = 'webhook:invalid';
    }
  }
  return scrubSecrets(masked, secrets).slice(0, 500);
}

function readSmtpResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines = [];
    let settled = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onError = (err) => fail(failNotify('SMTP_SOCKET_ERROR', 502, err?.message || 'SMTP socket error', { retryable: true }));
    const onClose = () => fail(failNotify('SMTP_CONNECTION_CLOSED', 502, 'SMTP connection closed unexpectedly.', { retryable: true }));
    const onTimeout = () => fail(failNotify('SMTP_TIMEOUT', 504, `SMTP command timed out after ${timeoutMs}ms`, { retryable: true }));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const nlIdx = buffer.indexOf('\n');
        const rawLine = buffer.slice(0, nlIdx).replace(/\r$/, '');
        buffer = buffer.slice(nlIdx + 1);
        if (!rawLine) continue;
        lines.push(rawLine);
        const match = /^(\d{3})([ -])(.*)$/.exec(rawLine);
        if (match && match[2] === ' ') {
          settled = true;
          cleanup();
          resolve({
            code: Number(match[1]),
            lines,
            message: lines.join(' | '),
          });
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
  });
}

function classifySmtpCodeError(code, message, fallbackCode = 'SMTP_ERROR') {
  const retryable = code >= 400 && code < 500;
  const status = retryable ? 503 : (code === 535 ? 401 : 502);
  return failNotify(fallbackCode, status, `SMTP ${code}: ${message}`, { retryable, smtpCode: code });
}

async function sendSmtpCommand(socket, cmd, expectedCodes, timeoutMs) {
  const wait = readSmtpResponse(socket, timeoutMs);
  socket.write(`${cmd}\r\n`);
  const res = await wait;
  if (!expectedCodes.includes(res.code)) {
    throw classifySmtpCodeError(res.code, res.message);
  }
  return res;
}

function encodeMimeHeaderValue(value) {
  const clean = assertNoHeaderInjection(value, 'MIME header');
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function dotStuffSmtpBody(rawBody) {
  const crlf = String(rawBody ?? '').replace(/\r?\n/g, '\r\n');
  return crlf.replace(/^\./gm, '..');
}

function validateSmtpHeaders(headers) {
  const validated = [];
  if (!isPlainObject(headers)) return validated;
  for (const [k, v] of Object.entries(headers)) {
    if (BLOCKED_PATH_KEYS.has(k) || !Object.hasOwn(headers, k)) continue;
    const safeKey = assertNoHeaderInjection(k, 'header name').trim();
    if (!/^[A-Za-z0-9-]+$/.test(safeKey)) {
      throw failNotify('SMTP_HEADER_INVALID', 400, `Invalid header name: ${safeKey}`, { retryable: false });
    }
    const safeValue = assertNoHeaderInjection(v, safeKey);
    if (/^(from|to|cc|bcc|subject|date|message-id|mime-version|content-type)$/i.test(safeKey)) continue;
    validated.push(`${safeKey}: ${safeValue}`);
  }
  return validated;
}

function resolveSmtpTargetConfig({ host: rawHost, port: rawPort, baseUrl, secure: rawSecure } = {}) {
  let host = rawHost ? String(rawHost).trim() : '';
  let port = rawPort != null && String(rawPort).trim() !== '' ? Number(rawPort) : null;
  let secure = Boolean(rawSecure);

  if (baseUrl && (!host || !port)) {
    const parsedBase = new URL(String(baseUrl));
    if (!host) host = parsedBase.hostname;
    if (!port && parsedBase.port) port = Number(parsedBase.port);
    if (parsedBase.protocol === 'smtps:') secure = true;
  }
  if (!port) port = secure ? 465 : 587;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw failNotify('SMTP_CONFIG_INVALID', 400, 'Valid SMTP host and port are required.', { retryable: false });
  }

  const hostForUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const smtpUrl = `${secure ? 'smtps' : 'smtp'}://${hostForUrl}:${port}`;
  return { host, port, secure, hostForUrl, smtpUrl };
}

function buildSmtpMimePayload({ from, to, cc, replyTo, subject, text, html, headers = {}, messageId }) {
  const headerLines = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `From: ${from}`,
    `To: ${to.join(', ')}`,
  ];
  if (cc && cc.length) headerLines.push(`Cc: ${cc.join(', ')}`);
  if (replyTo) headerLines.push(`Reply-To: ${replyTo}`);
  headerLines.push(`Subject: ${encodeMimeHeaderValue(subject)}`);
  headerLines.push('MIME-Version: 1.0');
  headerLines.push(...validateSmtpHeaders(headers));

  const hasText = typeof text === 'string' && text.length > 0;
  const hasHtml = typeof html === 'string' && html.length > 0;
  let bodyPart;
  if (hasText && hasHtml) {
    const boundary = `ldx_${randomUUID().replace(/-/g, '')}`;
    headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    bodyPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${boundary}--`,
    ].join('\r\n');
  } else if (hasHtml) {
    headerLines.push('Content-Type: text/html; charset=UTF-8');
    headerLines.push('Content-Transfer-Encoding: 8bit');
    bodyPart = html;
  } else {
    headerLines.push('Content-Type: text/plain; charset=UTF-8');
    headerLines.push('Content-Transfer-Encoding: 8bit');
    bodyPart = typeof text === 'string' ? text : '';
  }

  return `${headerLines.join('\r\n')}\r\n\r\n${bodyPart}`;
}

async function sendSmtpEmail(options = {}) {
  const {
    host: rawHost,
    port: rawPort,
    baseUrl,
    secure: rawSecure,
    starttls = true,
    requireTls = false,
    username = '',
    password = '',
    from: rawFrom,
    to: rawTo,
    cc: rawCc,
    bcc: rawBcc,
    replyTo: rawReplyTo,
    subject: rawSubject = '(No Subject)',
    text = '',
    html = '',
    headers = {},
    ehloHost = 'latticedx.local',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    allowInternal,
    lookupImpl,
    skipDnsCheck,
    netConnectImpl = net.connect,
    tlsConnectImpl = tls.connect,
    tlsOptions = {},
    secrets = {},
  } = options;

  // 1. Validate headers & addresses BEFORE any DNS/SSRF/network operation
  const fromParsed = extractEmailAddress(rawFrom);
  const toList = normalizeRecipientList(rawTo).map(extractEmailAddress);
  const ccList = normalizeRecipientList(rawCc).map(extractEmailAddress);
  const bccList = normalizeRecipientList(rawBcc).map(extractEmailAddress);
  if (toList.length === 0 && ccList.length === 0 && bccList.length === 0) {
    throw failNotify('SMTP_RECIPIENT_REQUIRED', 400, 'At least one recipient (to/cc/bcc) is required.', { retryable: false });
  }
  const replyToParsed = rawReplyTo ? extractEmailAddress(rawReplyTo) : null;
  const subject = assertNoHeaderInjection(rawSubject, 'subject');
  assertNoHeaderInjection(ehloHost, 'ehloHost');
  validateSmtpHeaders(headers);

  const { host, port, secure, smtpUrl } = resolveSmtpTargetConfig({
    host: rawHost,
    port: rawPort,
    baseUrl,
    secure: rawSecure,
  });
  const isMockTransport = netConnectImpl !== net.connect || tlsConnectImpl !== tls.connect;
  const effectiveSkipDns = skipDnsCheck !== undefined
    ? Boolean(skipDnsCheck)
    : (isMockTransport && typeof lookupImpl !== 'function');

  // 2. Fail-closed SSRF guard (including DNS rebinding check)
  await assertSafeConnectorUrlAsync(smtpUrl, {
    connectorType: 'email_smtp',
    env,
    allowInternal,
    lookupImpl,
    skipDnsCheck: effectiveSkipDns,
  });

  const bareHost = host.replace(/^\[|\]$/g, '');
  const connectTimeoutMs = Math.max(500, Math.min(30000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  let socket;
  try {
    socket = secure
      ? tlsConnectImpl({
          host: bareHost,
          port,
          servername: bareHost,
          rejectUnauthorized: true,
          ...tlsOptions,
        })
      : netConnectImpl({ host: bareHost, port });
    socket.setTimeout?.(connectTimeoutMs);

    // Wait for greeting (220)
    const greeting = await readSmtpResponse(socket, connectTimeoutMs);
    if (greeting.code !== 220) {
      throw classifySmtpCodeError(greeting.code, greeting.message, 'SMTP_GREETING_FAILED');
    }

    let ehloRes = await sendSmtpCommand(socket, `EHLO ${ehloHost}`, [250], connectTimeoutMs);
    let capabilities = ehloRes.lines.join('\n').toUpperCase();

    if (!secure && starttls !== false && (requireTls || /\bSTARTTLS\b/.test(capabilities))) {
      if (!/\bSTARTTLS\b/.test(capabilities) && requireTls) {
        throw failNotify('SMTP_TLS_REQUIRED', 502, 'SMTP server does not advertise STARTTLS.', { retryable: false });
      }
      await sendSmtpCommand(socket, 'STARTTLS', [220], connectTimeoutMs);
      const upgraded = await new Promise((resolve, reject) => {
        const tlsSock = tlsConnectImpl({
          socket,
          servername: bareHost,
          rejectUnauthorized: true,
          ...tlsOptions,
        });
        let done = false;
        const onErr = (err) => {
          if (done) return;
          done = true;
          reject(failNotify('SMTP_TLS_HANDSHAKE_FAILED', 502, err?.message || 'TLS handshake failed', { retryable: true }));
        };
        tlsSock.once('error', onErr);
        tlsSock.once('secureConnect', () => {
          if (done) return;
          done = true;
          tlsSock.removeListener('error', onErr);
          resolve(tlsSock);
        });
      });
      socket = upgraded;
      socket.setTimeout?.(connectTimeoutMs);
      ehloRes = await sendSmtpCommand(socket, `EHLO ${ehloHost}`, [250], connectTimeoutMs);
      capabilities = ehloRes.lines.join('\n').toUpperCase();
    } else if (!secure && requireTls) {
      throw failNotify('SMTP_TLS_REQUIRED', 502, 'TLS is required but STARTTLS was disabled.', { retryable: false });
    }

    const userStr = String(username ?? '');
    const passStr = String(password ?? '');
    if (userStr || passStr) {
      assertNoHeaderInjection(userStr, 'smtp username');
      const hasLoginOnly = /\bAUTH\b[^\n]*\bLOGIN\b/.test(capabilities) && !/\bAUTH\b[^\n]*\bPLAIN\b/.test(capabilities);
      if (hasLoginOnly) {
        await sendSmtpCommand(socket, 'AUTH LOGIN', [334], connectTimeoutMs);
        await sendSmtpCommand(socket, Buffer.from(userStr, 'utf8').toString('base64'), [334], connectTimeoutMs);
        await sendSmtpCommand(socket, Buffer.from(passStr, 'utf8').toString('base64'), [235], connectTimeoutMs);
      } else {
        const token = Buffer.from(`\0${userStr}\0${passStr}`, 'utf8').toString('base64');
        await sendSmtpCommand(socket, `AUTH PLAIN ${token}`, [235], connectTimeoutMs);
      }
    }

    await sendSmtpCommand(socket, `MAIL FROM:<${fromParsed.envelopeAddress}>`, [250], connectTimeoutMs);
    for (const rcpt of [...toList, ...ccList, ...bccList]) {
      await sendSmtpCommand(socket, `RCPT TO:<${rcpt.envelopeAddress}>`, [250, 251], connectTimeoutMs);
    }
    await sendSmtpCommand(socket, 'DATA', [354], connectTimeoutMs);

    const messageId = `<${randomUUID()}@${bareHost}>`;
    const mimeRaw = buildSmtpMimePayload({
      from: fromParsed.headerValue,
      to: toList.map((r) => r.headerValue),
      cc: ccList.map((r) => r.headerValue),
      replyTo: replyToParsed?.headerValue || null,
      subject,
      text,
      html,
      headers,
      messageId,
    });
    const stuffed = dotStuffSmtpBody(mimeRaw);
    const dataWait = readSmtpResponse(socket, connectTimeoutMs);
    socket.write(`${stuffed}\r\n.\r\n`);
    const dataRes = await dataWait;
    if (dataRes.code !== 250) {
      throw classifySmtpCodeError(dataRes.code, dataRes.message, 'SMTP_DATA_REJECTED');
    }

    await sendSmtpCommand(socket, 'QUIT', [221, 250], connectTimeoutMs).catch(() => {});
    try { socket.end?.(); } catch {}

    return {
      ok: true,
      providerMessageId: messageId,
      smtpReply: scrubSecrets(dataRes.message, { password, ...secrets }),
    };
  } catch (err) {
    try { socket?.destroy?.(); } catch {}
    if (err?.message) {
      err.message = scrubSecrets(err.message, { password, ...secrets });
    }
    throw err;
  }
}

async function safeReadResponseText(response) {
  try {
    if (typeof response?.text === 'function') {
      return await response.text();
    }
    if (typeof response?.json === 'function') {
      return JSON.stringify(await response.json());
    }
  } catch {}
  return '';
}

function classifyHttpFailure(status, detail) {
  const codeNum = Number(status) || 0;
  const retryable = codeNum === 429 || codeNum >= 500 || codeNum === 0;
  return {
    retryable,
    httpStatus: codeNum || null,
    errorCode: codeNum === 429 ? 'UPSTREAM_RATE_LIMITED' : (codeNum >= 500 ? 'UPSTREAM_SERVER_ERROR' : 'UPSTREAM_REJECTED'),
    detail: detail || `HTTP ${codeNum || 'error'}`,
  };
}

async function postJsonSafe({
  url,
  headers = {},
  bodyObj,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  secrets = {},
}) {
  if (typeof fetchImpl !== 'function') {
    throw failNotify('FETCH_UNAVAILABLE', 503, 'HTTP fetch implementation unavailable.', { retryable: false });
  }
  const rawBody = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj ?? {});
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: rawBody,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw failNotify(
      'HTTP_TRANSPORT_ERROR',
      502,
      scrubSecrets(err?.message || 'HTTP transport failed', secrets),
      { retryable: true },
    );
  }

  const rawText = await safeReadResponseText(response);
  let json = null;
  if (rawText) {
    try { json = JSON.parse(rawText); } catch {}
  }
  if (!response?.ok) {
    const info = classifyHttpFailure(response?.status, scrubSecrets(rawText.slice(0, 500), secrets));
    throw failNotify(info.errorCode, Number(response?.status) || 502, info.detail, {
      retryable: info.retryable,
      httpStatus: info.httpStatus,
    });
  }
  return { status: Number(response.status) || 200, json, text: rawText };
}

async function sendTelegramMessage(params = {}, options = {}) {
  const secrets = params.secrets || {};
  const botToken = String(params.botToken || secrets.botToken || '').trim();
  const chatId = String(params.chatId || params.target || secrets.defaultChatId || '').trim();
  if (!TELEGRAM_TOKEN_RE.test(botToken)) {
    throw failNotify('TELEGRAM_TOKEN_INVALID', 400, 'Valid Telegram botToken is required.', { retryable: false });
  }
  if (!TELEGRAM_CHAT_RE.test(chatId)) {
    throw failNotify('TELEGRAM_CHAT_INVALID', 400, 'Valid Telegram chatId is required.', { retryable: false });
  }

  const baseUrl = String(params.baseUrl || 'https://api.telegram.org').trim().replace(/\/+$/, '');
  const endpointUrl = `${baseUrl}/bot${botToken}/sendMessage`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const isMockFetch = fetchImpl !== globalThis.fetch;
  const skipDnsCheck = options.skipDnsCheck !== undefined
    ? Boolean(options.skipDnsCheck)
    : (isMockFetch && typeof options.lookupImpl !== 'function' && !options.enforceDnsInMock);

  try {
    await assertSafeConnectorUrlAsync(endpointUrl, {
      connectorType: 'http_api',
      env: options.env || process.env,
      allowInternal: options.allowInternal,
      lookupImpl: options.lookupImpl,
      skipDnsCheck,
    });
  } catch (err) {
    err.message = scrubSecrets(err.message, { botToken, ...secrets });
    err.retryable = false;
    throw err;
  }

  const vars = params.vars || {};
  const text = params.template
    ? renderTemplate(params.template, vars)
    : `[${String(vars.severity || params.severity || 'info').toUpperCase()}] ${vars.title || params.title || ''}${vars.body || params.body ? `\n${vars.body || params.body}` : ''}`.trim();

  const payload = {
    chat_id: chatId,
    text: text.slice(0, 4096) || 'LatticeDX Notification',
    disable_web_page_preview: params.disableWebPagePreview !== false,
    ...(params.parseMode ? { parse_mode: String(params.parseMode) } : {}),
  };

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      httpStatus: null,
      providerMessageId: null,
      payloadPreview: scrubSecrets(payload, { botToken, ...secrets }),
    };
  }

  const res = await postJsonSafe({
    url: endpointUrl,
    bodyObj: payload,
    fetchImpl,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    secrets: { botToken, ...secrets },
  });

  if (res.json && res.json.ok === false) {
    const errCode = Number(res.json.error_code) || 400;
    throw failNotify(
      'TELEGRAM_API_REJECTED',
      errCode === 429 ? 429 : 400,
      scrubSecrets(res.json.description || 'Telegram API rejected message', { botToken, ...secrets }),
      { retryable: errCode === 429 || errCode >= 500, httpStatus: errCode },
    );
  }

  return {
    ok: true,
    httpStatus: res.status,
    providerMessageId: res.json?.result?.message_id != null ? String(res.json.result.message_id) : null,
    payloadPreview: scrubSecrets(payload, { botToken, ...secrets }),
  };
}

function buildDefaultSlackBlocks(vars = {}) {
  const severity = String(vars.severity || 'info').toUpperCase();
  const title = String(vars.title || 'LatticeDX Notification');
  const body = String(vars.body || '');
  const text = `[${severity}] ${title}${body ? ` — ${body}` : ''}`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `[${severity}] ${title}`.slice(0, 150) },
    },
  ];
  if (body) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: body.slice(0, 3000) },
    });
  }
  return { text, blocks };
}

async function sendSlackMessage(params = {}, options = {}) {
  const secrets = params.secrets || {};
  const vars = params.vars || {};
  const connector = params.connector || {};
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const isMockFetch = fetchImpl !== globalThis.fetch;
  const skipDnsCheck = options.skipDnsCheck !== undefined
    ? Boolean(options.skipDnsCheck)
    : (isMockFetch && typeof options.lookupImpl !== 'function' && !options.enforceDnsInMock);

  const webhookUrl = String(
    params.webhookUrl
      || secrets.webhookUrl
      || (connector.connectorType === 'webhook' ? connector.baseUrl : '')
      || '',
  ).trim();

  const basePayload = params.template
    ? renderWebhookPayload(params.template, vars)
    : buildDefaultSlackBlocks(vars);

  if (webhookUrl) {
    const validatedUrl = await assertSafeConnectorUrlAsync(webhookUrl, {
      connectorType: 'webhook',
      env: options.env || process.env,
      allowInternal: options.allowInternal,
      lookupImpl: options.lookupImpl,
      skipDnsCheck,
    });
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        httpStatus: null,
        providerMessageId: null,
        targetUrl: validatedUrl,
        payloadPreview: scrubSecrets(basePayload, secrets),
      };
    }
    const res = await postJsonSafe({
      url: validatedUrl,
      bodyObj: basePayload,
      fetchImpl,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      secrets,
    });
    return {
      ok: true,
      httpStatus: res.status,
      providerMessageId: res.json?.ts ? String(res.json.ts) : null,
      targetUrl: validatedUrl,
      payloadPreview: scrubSecrets(basePayload, secrets),
    };
  }

  const channel = String(params.channelTarget || params.target || secrets.defaultChannel || '').trim();
  if (!channel) {
    throw failNotify('SLACK_CHANNEL_REQUIRED', 400, 'Slack channel ID or webhookUrl is required.', { retryable: false });
  }
  const rawBase = String(params.baseUrl || connector.baseUrl || 'https://slack.com/api').trim().replace(/\/+$/, '');
  const postUrl = rawBase.endsWith('/chat.postMessage') ? rawBase : `${rawBase}/chat.postMessage`;

  const validatedUrl = await assertSafeConnectorUrlAsync(postUrl, {
    connectorType: 'http_api',
    env: options.env || process.env,
    allowInternal: options.allowInternal,
    lookupImpl: options.lookupImpl,
    skipDnsCheck,
  });

  const payload = { channel, ...basePayload };
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      httpStatus: null,
      providerMessageId: null,
      targetUrl: channel,
      payloadPreview: scrubSecrets(payload, secrets),
    };
  }

  let token = String(secrets.botToken || secrets.accessToken || secrets.token || '').trim();
  if (!token && connector.authType === 'oauth2' && options.db && (connector.id || connector.connectorKey)) {
    const fresh = await getFreshConnectorToken(options.db, connector.id || connector.connectorKey, {
      organizationId: connector.organizationId || params.organizationId,
      env: options.env || process.env,
      fetchImpl,
      lookupImpl: options.lookupImpl,
      enforceDnsInMock: options.enforceDnsInMock,
      allowInternal: options.allowInternal,
    });
    token = fresh.accessToken;
  }
  if (!token) {
    throw failNotify('SLACK_TOKEN_MISSING', 400, 'Slack OAuth2 token or botToken is required.', { retryable: false });
  }

  const authHeaders = buildConnectorAuthHeaders('bearer', { token });
  const res = await postJsonSafe({
    url: validatedUrl,
    headers: authHeaders,
    bodyObj: payload,
    fetchImpl,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    secrets: { token, ...secrets },
  });

  if (res.json && res.json.ok === false) {
    const slackErr = String(res.json.error || 'slack_api_error');
    const retryable = slackErr === 'ratelimited' || slackErr === 'internal_error' || slackErr === 'fatal_error';
    throw failNotify('SLACK_API_REJECTED', retryable ? 429 : 400, `Slack API error: ${slackErr}`, {
      retryable,
      httpStatus: res.status,
    });
  }

  return {
    ok: true,
    httpStatus: res.status,
    providerMessageId: res.json?.ts ? String(res.json.ts) : null,
    targetUrl: channel,
    payloadPreview: scrubSecrets(payload, { token, ...secrets }),
  };
}

function decodeHmacSecret(secret) {
  const raw = String(secret ?? '');
  if (raw.startsWith('whsec_')) {
    return Buffer.from(raw.slice(6), 'base64');
  }
  return Buffer.from(raw, 'utf8');
}

async function sendWebhookMessage(params = {}, options = {}) {
  const secrets = params.secrets || {};
  const connector = params.connector || {};
  const vars = params.vars || {};
  const targetUrl = String(params.url || params.target || connector.baseUrl || secrets.webhookUrl || secrets.url || '').trim();
  if (!targetUrl) {
    throw failNotify('WEBHOOK_URL_REQUIRED', 400, 'Webhook target URL is required.', { retryable: false });
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const isMockFetch = fetchImpl !== globalThis.fetch;
  const skipDnsCheck = options.skipDnsCheck !== undefined
    ? Boolean(options.skipDnsCheck)
    : (isMockFetch && typeof options.lookupImpl !== 'function' && !options.enforceDnsInMock);

  const validatedUrl = await assertSafeConnectorUrlAsync(targetUrl, {
    connectorType: connector.connectorType || 'webhook',
    env: options.env || process.env,
    allowInternal: options.allowInternal,
    lookupImpl: options.lookupImpl,
    skipDnsCheck,
  });

  const payload = renderWebhookPayload(params.template || params.payloadTemplate, vars);
  const rawBody = JSON.stringify(payload);
  const authType = String(params.authType || connector.authType || 'none').toLowerCase();
  const headers = buildConnectorAuthHeaders(authType, secrets);

  if (isPlainObject(params.headers)) {
    for (const [k, v] of Object.entries(params.headers)) {
      if (BLOCKED_PATH_KEYS.has(k) || !Object.hasOwn(params.headers, k)) continue;
      const safeKey = assertNoHeaderInjection(k, 'webhook header name').trim();
      if (/^[A-Za-z0-9-]+$/.test(safeKey)) {
        headers[safeKey] = assertNoHeaderInjection(v, safeKey);
      }
    }
  }

  const signingSecret = String(secrets.secret || secrets.signingSecret || secrets.hmacSecret || '').trim();
  if (authType === 'hmac' && signingSecret) {
    const webhookId = String(params.deliveryUid || randomUUID());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const keyBuf = decodeHmacSecret(signingSecret);
    const stdMac = createHmac('sha256', keyBuf)
      .update(`${webhookId}.${timestamp}.${rawBody}`, 'utf8')
      .digest('base64');
    const hexMac = createHmac('sha256', keyBuf).update(rawBody, 'utf8').digest('hex');
    headers['webhook-id'] = webhookId;
    headers['webhook-timestamp'] = timestamp;
    headers['webhook-signature'] = `v1,${stdMac}`;
    headers['X-Lattice-Signature-256'] = `sha256=${hexMac}`;
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      httpStatus: null,
      providerMessageId: null,
      targetUrl: validatedUrl,
      payloadPreview: scrubSecrets(payload, secrets),
    };
  }

  const res = await postJsonSafe({
    url: validatedUrl,
    headers,
    bodyObj: rawBody,
    fetchImpl,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    secrets,
  });

  return {
    ok: true,
    httpStatus: res.status,
    providerMessageId: res.json?.id ? String(res.json.id) : null,
    targetUrl: validatedUrl,
    payloadPreview: scrubSecrets(payload, secrets),
  };
}

function normalizeChannelName(rawChannel) {
  const ch = String(rawChannel || '').trim().toLowerCase();
  if (ch === 'email' || ch === 'email_smtp' || ch === 'smtp_notify') return 'smtp';
  if (ch === 'partner_webhook') return 'webhook';
  return ch;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function runNotifyDbOp(db, organizationId, fn, explicitTx = null) {
  const activeTx = explicitTx || getActiveRlsContext()?.transaction || null;
  if (!canUsePgRlsSession(db) || activeTx || !organizationId) {
    return fn(activeTx || undefined);
  }
  return withTenantRlsContext(db, organizationId, (tx) => fn(tx));
}

async function persistDeliveryAudit(db, organizationId, record, { transaction = null } = {}) {
  const repo = getRepo(db, 'latticeNotificationDeliveries');
  if (!repo || typeof repo.create !== 'function') return null;
  const writeRow = async (tx) => repo.create({
    values: record,
    ...(tx ? { transaction: tx } : {}),
  });
  try {
    return await runNotifyDbOp(
      db,
      organizationId,
      (tx) => (tx && getActiveRlsContext()?.transaction === tx ? runInRlsSavepoint(db, writeRow) : writeRow(tx)),
      transaction,
    );
  } catch {
    return null;
  }
}

async function resolveChannelConnector(db, organizationId, channel, connectorKey, options = {}) {
  if (connectorKey) {
    return resolveConnectorSecrets(db, organizationId, connectorKey, { env: options.env || process.env });
  }
  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.find !== 'function') return null;
  const rows = (await runNotifyDbOp(db, organizationId, (tx) => repo.find({
    filter: { organizationId, active: true },
    sort: ['id'],
    limit: 100,
    ...(tx ? { transaction: tx } : {}),
  }))) || [];

  const matched = rows.find((r) => {
    if (val(r, 'organizationId') !== organizationId || val(r, 'active') === false) return false;
    const appType = String(val(r, 'appType') || '').toLowerCase();
    const cType = String(val(r, 'connectorType') || '').toLowerCase();
    if (channel === 'smtp') return appType === 'email_smtp' || cType === 'smtp_notify' || cType === 'email_smtp';
    if (channel === 'telegram') return appType === 'telegram' || cType === 'telegram';
    if (channel === 'slack') return appType === 'slack' || cType === 'slack';
    if (channel === 'webhook') return appType === 'partner_webhook' || cType === 'webhook';
    return false;
  });
  if (!matched) return null;
  return resolveConnectorSecrets(db, organizationId, val(matched, 'connectorKey'), { env: options.env || process.env });
}

async function dispatchChannelNotification(db, params = {}, options = {}) {
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId.trim() : '';
  if (!isValidOrganizationId(organizationId)) {
    throw failNotify('NOTIFY_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  const channel = normalizeChannelName(params.channel);
  if (!SUPPORTED_CHANNEL_SET.has(channel)) {
    throw failNotify('NOTIFY_CHANNEL_UNSUPPORTED', 400, `Unsupported notification channel: ${params.channel}`);
  }

  const dryRun = Boolean(params.dryRun);
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(Number(params.maxAttempts) || DEFAULT_MAX_ATTEMPTS)));
  const deliveryUid = String(params.deliveryUid || randomUUID());
  const vars = {
    organizationId,
    category: params.category || 'system',
    severity: params.severity || 'info',
    title: params.title || '',
    body: params.body || '',
    targetCollection: params.targetCollection || null,
    targetRecordId: params.targetRecordId ?? null,
    targetPath: params.targetPath || null,
    eventType: params.eventType || 'lattice.notification',
    timestamp: new Date().toISOString(),
    ...(isPlainObject(params.vars) ? params.vars : {}),
  };

  let resolved = null;
  if (params.connectorKey || (!params.secrets && db)) {
    resolved = await resolveChannelConnector(db, organizationId, channel, params.connectorKey, options);
  }
  const connector = resolved?.connector || params.connector || {};
  const secrets = { ...(resolved?.secrets || {}), ...(isPlainObject(params.secrets) ? params.secrets : {}) };
  const connectorKey = connector.connectorKey || (params.connectorKey ? String(params.connectorKey).trim().toLowerCase() : null);

  if (params.connectorKey && !resolved) {
    throw failNotify('CONNECTOR_NOT_FOUND', 404, 'Connector not found in organization scope.');
  }
  if (!resolved && Object.keys(secrets).length === 0 && !params.url && !params.host) {
    throw failNotify('CONNECTOR_NOT_FOUND', 404, `No active Vault connector found for channel ${channel}.`);
  }

  const execOnce = async () => {
    if (channel === 'smtp') {
      const subjectTemplate = params.subjectTemplate || params.subject || '[{{severity}}] {{title}}';
      const textTemplate = params.textTemplate || params.body || '{{body}}';
      const htmlTemplate = params.htmlTemplate || params.html || '<p><strong>{{title}}</strong></p><p>{{body}}</p>';
      const subject = renderTemplate(subjectTemplate, vars);
      const text = renderTemplate(textTemplate, vars);
      const html = renderTemplate(htmlTemplate, vars, { htmlEscape: true });
      const to = params.to || params.target || secrets.defaultTo || secrets.fromEmail;
      const from = params.from || secrets.fromEmail || secrets.username;
      if (dryRun) {
        assertNoHeaderInjection(from, 'from');
        for (const r of normalizeRecipientList(to)) assertNoHeaderInjection(r, 'to');
        assertNoHeaderInjection(subject, 'subject');
        validateSmtpHeaders(params.headers);
        const { smtpUrl } = resolveSmtpTargetConfig({
          host: params.host || secrets.host,
          port: params.port || secrets.port,
          baseUrl: connector.baseUrl,
          secure: params.secure ?? secrets.secure,
        });
        await assertSafeConnectorUrlAsync(smtpUrl, {
          connectorType: 'email_smtp',
          env: options.env || process.env,
          allowInternal: options.allowInternal,
          lookupImpl: options.lookupImpl,
          skipDnsCheck: options.skipDnsCheck,
        });
        return {
          ok: true,
          dryRun: true,
          httpStatus: null,
          providerMessageId: null,
          targetRaw: to,
          payloadPreview: scrubSecrets({ from, to, subject, text, html }, secrets),
        };
      }
      const smtpRes = await sendSmtpEmail({
        host: params.host || secrets.host,
        port: params.port || secrets.port,
        baseUrl: connector.baseUrl,
        secure: params.secure ?? secrets.secure,
        starttls: params.starttls,
        requireTls: params.requireTls,
        username: secrets.username,
        password: secrets.password,
        from,
        to,
        cc: params.cc,
        bcc: params.bcc,
        replyTo: params.replyTo,
        headers: params.headers,
        subject,
        text,
        html,
        secrets,
        env: options.env,
        allowInternal: options.allowInternal,
        lookupImpl: options.lookupImpl,
        skipDnsCheck: options.skipDnsCheck,
        netConnectImpl: options.netConnectImpl,
        tlsConnectImpl: options.tlsConnectImpl,
        tlsOptions: options.tlsOptions,
      });
      return {
        ...smtpRes,
        targetRaw: to,
        payloadPreview: scrubSecrets({ subject, text }, secrets),
      };
    }

    if (channel === 'telegram') {
      const chatTarget = params.chatId || params.target || secrets.defaultChatId;
      const tgRes = await sendTelegramMessage({
        baseUrl: params.baseUrl || connector.baseUrl || 'https://api.telegram.org',
        botToken: params.botToken || secrets.botToken,
        chatId: chatTarget,
        title: vars.title,
        body: vars.body,
        severity: vars.severity,
        template: params.template,
        parseMode: params.parseMode,
        vars,
        secrets,
      }, { ...options, dryRun });
      return { ...tgRes, targetRaw: chatTarget };
    }

    if (channel === 'slack') {
      const slRes = await sendSlackMessage({
        organizationId,
        connector,
        secrets,
        baseUrl: params.baseUrl,
        webhookUrl: params.webhookUrl,
        channelTarget: params.slackChannel || params.target,
        template: params.template,
        vars,
      }, { ...options, db, dryRun });
      return { ...slRes, targetRaw: slRes.targetUrl };
    }

    const whRes = await sendWebhookMessage({
      deliveryUid,
      connector,
      secrets,
      url: params.url || params.target,
      authType: params.authType,
      headers: params.headers,
      template: params.template || params.payloadTemplate,
      vars,
    }, { ...options, dryRun });
    return { ...whRes, targetRaw: whRes.targetUrl };
  };

  const rawTargetForMask = params.to || params.chatId || params.slackChannel || params.url || params.target || secrets.defaultChatId || secrets.defaultChannel || secrets.webhookUrl || connector.baseUrl || '';
  const sleepImpl = typeof options.sleepImpl === 'function' ? options.sleepImpl : defaultSleep;

  let attempt = 0;
  let lastError = null;
  let outcome = null;

  if (dryRun) {
    try {
      outcome = await execOnce();
    } catch (err) {
      lastError = err;
    }
  } else {
    for (let i = 1; i <= maxAttempts; i += 1) {
      attempt = i;
      try {
        outcome = await execOnce();
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!err?.retryable || i >= maxAttempts) break;
        const delayMs = Math.min(MAX_BACKOFF_MS, DEFAULT_BACKOFF_BASE_MS * (2 ** (i - 1)));
        await sleepImpl(delayMs);
      }
    }
  }

  const ok = Boolean(outcome && !lastError);
  const blocked = !ok && lastError?.code === 'CONNECTOR_URL_UNSAFE';
  const status = dryRun ? (ok ? 'dry_run' : (blocked ? 'blocked' : 'failed')) : (ok ? 'sent' : (blocked ? 'blocked' : 'failed'));
  const targetMasked = maskTarget(channel, outcome?.targetRaw || rawTargetForMask, secrets);
  const previewScrubbed = scrubSecrets(outcome?.payloadPreview || { title: vars.title, severity: vars.severity }, secrets);
  const errorMessage = lastError ? scrubSecrets(lastError.message || lastError.code || 'Delivery failed', secrets) : null;
  const errorCode = lastError ? String(lastError.code || 'DELIVERY_FAILED') : null;
  const sentAt = ok && !dryRun ? new Date() : null;

  const auditRecord = {
    organizationId,
    deliveryUid,
    notificationId: parsePositiveSafeInt(params.notificationId),
    channel,
    connectorKey,
    targetMasked,
    templateKey: params.templateKey ? String(params.templateKey).slice(0, 128) : null,
    eventType: String(vars.eventType || 'lattice.notification').slice(0, 255),
    status,
    attempt,
    maxAttempts,
    httpStatus: outcome?.httpStatus ?? lastError?.httpStatus ?? null,
    providerMessageId: outcome?.providerMessageId || null,
    errorCode,
    errorMessage,
    payloadPreviewJson: previewScrubbed,
    dryRun,
    sentAt,
  };

  await persistDeliveryAudit(db, organizationId, auditRecord, { transaction: options.transaction || null });

  return {
    ok,
    deliveryUid,
    organizationId,
    channel,
    connectorKey,
    status,
    attempt,
    maxAttempts,
    httpStatus: auditRecord.httpStatus,
    providerMessageId: auditRecord.providerMessageId,
    targetMasked,
    dryRun,
    preview: previewScrubbed,
    errorCode,
    errorMessage,
    sentAt: sentAt ? sentAt.toISOString() : null,
  };
}

function parsePositiveSafeInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

const STRIPPED_CHANNEL_SPEC_KEYS = new Set(['organizationId', 'secrets', 'connector', 'allowInternal']);
const ALLOWED_HTTP_CHANNEL_SPEC_KEYS = new Set([
  'channel',
  'connectorKey',
  'to',
  'target',
  'slackChannel',
  'chatId',
  'template',
  'templateKey',
  'vars',
  'subject',
  'title',
  'body',
  'dryRun',
]);

function sanitizeChannelSpec(entry, { httpAllowlist = false } = {}) {
  if (!isPlainObject(entry)) return {};
  const clean = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BLOCKED_PATH_KEYS.has(k) || STRIPPED_CHANNEL_SPEC_KEYS.has(k) || !Object.hasOwn(entry, k)) continue;
    if (httpAllowlist && !ALLOWED_HTTP_CHANNEL_SPEC_KEYS.has(k)) continue;
    clean[k] = v;
  }
  return clean;
}

function sanitizeHttpParams(params) {
  if (!isPlainObject(params)) return {};
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (BLOCKED_PATH_KEYS.has(k) || STRIPPED_CHANNEL_SPEC_KEYS.has(k) || !Object.hasOwn(params, k)) continue;
    if (k === 'channels' && Array.isArray(v)) {
      clean.channels = v.map((item) => (typeof item === 'string' ? item : sanitizeChannelSpec(item, { httpAllowlist: true })));
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

async function resolveActiveConnectorsForOrg(db, organizationId, options = {}) {
  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.find !== 'function') return [];
  const rows = (await runNotifyDbOp(db, organizationId, (tx) => repo.find({
    filter: { organizationId, active: true },
    sort: ['id'],
    limit: 100,
    ...(tx ? { transaction: tx } : {}),
  }))) || [];

  const matched = [];
  for (const row of rows) {
    if (val(row, 'organizationId') !== organizationId || val(row, 'active') === false) continue;
    const appType = String(val(row, 'appType') || '').toLowerCase();
    const cType = String(val(row, 'connectorType') || '').toLowerCase();
    let channel = null;
    if (appType === 'email_smtp' || cType === 'smtp_notify' || cType === 'email_smtp') channel = 'smtp';
    else if (appType === 'telegram' || cType === 'telegram') channel = 'telegram';
    else if (appType === 'slack' || cType === 'slack') channel = 'slack';
    else if (appType === 'partner_webhook' || cType === 'webhook') channel = 'webhook';
    if (channel) {
      matched.push({
        channel,
        connectorKey: val(row, 'connectorKey'),
        connector: serializeConnector(row, { env: options.env || process.env }),
      });
    }
  }
  return matched;
}

async function dispatchOmnichannel(db, payload = {}, options = {}) {
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId.trim() : '';
  if (!isValidOrganizationId(organizationId)) {
    throw failNotify('NOTIFY_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }

  const rawChannels = Array.isArray(payload.channels)
    ? payload.channels
    : (Array.isArray(payload.notifyChannels) ? payload.notifyChannels : []);

  const specs = [];
  for (const entry of rawChannels) {
    if (typeof entry === 'string') {
      const ch = normalizeChannelName(entry);
      if (ch === 'in_app' || !ch) continue;
      if (ch === 'all' || ch === 'external') {
        const active = await resolveActiveConnectorsForOrg(db, organizationId, options);
        for (const item of active) {
          specs.push({ channel: item.channel, connectorKey: item.connectorKey });
        }
      } else if (SUPPORTED_CHANNEL_SET.has(ch)) {
        specs.push({ channel: ch });
      }
    } else if (isPlainObject(entry)) {
      const ch = normalizeChannelName(entry.channel);
      if (SUPPORTED_CHANNEL_SET.has(ch)) {
        const sanitizedSpec = sanitizeChannelSpec(entry);
        sanitizedSpec.channel = ch;
        specs.push(sanitizedSpec);
      }
    }
  }

  const deliveries = [];
  const channelsDispatched = [];
  let okCount = 0;
  let failedCount = 0;
  let dryRunCount = 0;

  for (const spec of specs) {
    try {
      const res = await dispatchChannelNotification(db, {
        notificationId: payload.notificationId,
        category: payload.category,
        severity: payload.severity,
        title: payload.title,
        body: payload.body,
        targetCollection: payload.targetCollection,
        targetRecordId: payload.targetRecordId,
        targetPath: payload.targetPath,
        eventType: payload.eventType,
        vars: payload.vars,
        dryRun: payload.dryRun,
        maxAttempts: payload.maxAttempts,
        ...spec,
        organizationId,
      }, options);
      deliveries.push(res);
      if (res.ok) {
        if (res.dryRun) dryRunCount += 1;
        else {
          okCount += 1;
          if (!channelsDispatched.includes(res.channel)) channelsDispatched.push(res.channel);
        }
      } else {
        failedCount += 1;
      }
    } catch (err) {
      failedCount += 1;
      deliveries.push({
        ok: false,
        organizationId,
        channel: spec.channel,
        connectorKey: spec.connectorKey || null,
        status: 'failed',
        errorCode: err?.code || 'DISPATCH_ERROR',
        errorMessage: scrubSecrets(err?.message || 'Dispatch failed', {}),
      });
    }
  }

  return {
    organizationId,
    channelsDispatched,
    deliveries,
    okCount,
    failedCount,
    dryRunCount,
  };
}

function createNotificationCenterAdapter(defaultOptions = {}) {
  return async function dispatchFromNotificationCenter(db, { notification, notifyChannels = [], channelConfigs = [] } = {}, callOptions = {}) {
    const channels = Array.isArray(channelConfigs) && channelConfigs.length > 0 ? channelConfigs : notifyChannels;
    if (!Array.isArray(channels) || channels.length === 0) {
      return { channelsDispatched: [], deliveries: [] };
    }
    return dispatchOmnichannel(db, {
      organizationId: notification?.organizationId,
      notificationId: notification?.id,
      category: notification?.category,
      severity: notification?.severity,
      title: notification?.title,
      body: notification?.body,
      targetCollection: notification?.targetCollection,
      targetRecordId: notification?.targetRecordId,
      targetPath: notification?.targetPath,
      channels,
    }, { ...defaultOptions, ...callOptions });
  };
}

function serializeDeliveryLog(row) {
  if (!row) return null;
  const sentAt = val(row, 'sentAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    deliveryUid: val(row, 'deliveryUid') || '',
    notificationId: parsePositiveSafeInt(val(row, 'notificationId')),
    channel: val(row, 'channel') || '',
    connectorKey: val(row, 'connectorKey') || null,
    targetMasked: val(row, 'targetMasked') || null,
    templateKey: val(row, 'templateKey') || null,
    eventType: val(row, 'eventType') || null,
    status: val(row, 'status') || 'pending',
    attempt: Number(val(row, 'attempt')) || 0,
    maxAttempts: Number(val(row, 'maxAttempts')) || DEFAULT_MAX_ATTEMPTS,
    httpStatus: val(row, 'httpStatus') != null ? Number(val(row, 'httpStatus')) : null,
    providerMessageId: val(row, 'providerMessageId') || null,
    errorCode: val(row, 'errorCode') || null,
    errorMessage: val(row, 'errorMessage') || null,
    payloadPreviewJson: val(row, 'payloadPreviewJson') || null,
    dryRun: Boolean(val(row, 'dryRun')),
    sentAt: sentAt ? (sentAt instanceof Date ? sentAt.toISOString() : String(sentAt)) : null,
    createdAt: val(row, 'createdAt') || null,
  };
}

async function listDeliveryLogs(db, { organizationId, channel, status, dryRun, limit = 50, offset = 0 } = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!isValidOrganizationId(orgId)) {
    throw failNotify('NOTIFY_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  const repo = getRepo(db, 'latticeNotificationDeliveries');
  if (!repo || typeof repo.find !== 'function') {
    return { organizationId: orgId, total: 0, items: [] };
  }
  const filter = { organizationId: orgId };
  if (typeof channel === 'string' && SUPPORTED_CHANNEL_SET.has(normalizeChannelName(channel))) {
    filter.channel = normalizeChannelName(channel);
  }
  if (typeof status === 'string' && status.trim()) filter.status = status.trim();
  if (dryRun !== undefined) filter.dryRun = dryRun === true || dryRun === 'true';

  const cleanLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const cleanOffset = Math.max(0, Math.floor(Number(offset) || 0));

  const { rows, total } = await runNotifyDbOp(db, orgId, async (tx) => {
    const txOpt = tx ? { transaction: tx } : {};
    const found = (await repo.find({
      filter,
      sort: ['-id'],
      offset: cleanOffset,
      limit: cleanLimit,
      ...txOpt,
    })) || [];
    const cnt = typeof repo.count === 'function' ? await repo.count({ filter, ...txOpt }) : found.length;
    return { rows: found, total: cnt };
  });

  return {
    organizationId: orgId,
    total,
    items: rows.filter((r) => val(r, 'organizationId') === orgId).map(serializeDeliveryLog),
  };
}

async function resolveVerifiedRoles(db, ctx) {
  const claimed = callerRoles(ctx);
  const userId = val(ctx?.state?.currentUser, 'id');
  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null && /^[1-9]\d*$/.test(String(userId))) {
    const uid = Number(userId);
    const bindings = (await ruRepo.find({ filter: { userId: uid } })) || [];
    const assigned = new Set(
      bindings
        .filter((r) => Number(val(r, 'userId')) === uid)
        .map((r) => String(val(r, 'roleName') || '').trim())
        .filter(Boolean),
    );
    if (claimed.length > 0) return claimed.filter((r) => assigned.has(r));
    return [...assigned];
  }
  return claimed;
}

async function isVerifiedAdmin(db, rolesList) {
  if (!Array.isArray(rolesList) || rolesList.length === 0) return false;
  if (rolesList.some((r) => ELEVATED_ROLES.has(String(r).toLowerCase()))) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: rolesList } } })) || [];
  return matched.some((role) => {
    if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function resolveNotifyCaller(db, ctx, requestedOrgId = null) {
  if (!ctx?.state?.currentUser) {
    throw failNotify('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const verifiedRoles = await resolveVerifiedRoles(db, ctx);
  const isRoot = verifiedRoles.includes('root');
  const isAdmin = isRoot || (await isVerifiedAdmin(db, verifiedRoles));
  const isOperator = isAdmin || verifiedRoles.some((r) => OPERATOR_ROLES.has(String(r).toLowerCase()));

  if (isRoot) {
    const cleanReq = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (cleanReq) {
      if (!isValidOrganizationId(cleanReq)) throw failNotify('NOTIFY_ORG_REQUIRED', 400, 'Invalid organizationId.');
      return { isRoot: true, isAdmin: true, isOperator: true, organizationId: cleanReq };
    }
    const actor = await resolveNativeActor(db, ctx.state.currentUser);
    return { isRoot: true, isAdmin: true, isOperator: true, organizationId: actor.organizationId };
  }

  const actor = await resolveNativeActor(db, ctx.state.currentUser);
  if (requestedOrgId != null && String(requestedOrgId).trim() !== '' && String(requestedOrgId).trim() !== actor.organizationId) {
    throw failNotify('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization notification access is forbidden.');
  }
  return { isRoot: false, isAdmin, isOperator, organizationId: actor.organizationId };
}

function registerOmnichannelNotifyDirectGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') {
      const activeDb = app?.db || ctx?.db || ctx?.app?.db;
      const uid = val(ctx?.state?.currentUser, 'id');
      const ruRepo = getRepo(activeDb, 'rolesUsers');
      if (ruRepo && typeof ruRepo.find === 'function') {
        if (uid != null && /^[1-9]\d*$/.test(String(uid))) {
          const verified = await resolveVerifiedRoles(activeDb, ctx);
          if (verified.includes('root')) return next();
        }
      } else {
        return next();
      }
    }
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');
    if (baseResource === 'latticeNotificationDeliveries') {
      throw failNotify('NOTIFY_DIRECT_CRUD_FORBIDDEN', 403, 'Direct access to latticeNotificationDeliveries is forbidden; use dxosNotify.');
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && String(ctx.action?.params?.values?.collection || '') === 'latticeNotificationDeliveries'
    ) {
      throw failNotify('NOTIFY_DIRECT_CRUD_FORBIDDEN', 403, 'Direct chart access to latticeNotificationDeliveries is forbidden.');
    }
    return next();
  }, { tag: 'latticeNotifyDirectGuard', after: 'acl' });
}

function registerOmnichannelNotify(app, deps = {}) {
  const db = app.db;
  const env = deps.env || process.env;
  registerOmnichannelNotifyDirectGuard(app);

  const boundOptions = {
    env,
    fetchImpl: deps.fetchImpl,
    lookupImpl: deps.lookupImpl,
    enforceDnsInMock: deps.enforceDnsInMock,
    netConnectImpl: deps.netConnectImpl,
    tlsConnectImpl: deps.tlsConnectImpl,
    sleepImpl: deps.sleepImpl,
  };

  app.resourceManager.define({
    name: 'dxosNotify',
    actions: {
      send: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveNotifyCaller(db, ctx, params.organizationId);
        if (!scope.isOperator) {
          throw failNotify('NOTIFY_OPERATOR_REQUIRED', 403, 'Operator or administrator role is required to dispatch notifications.');
        }
        const allowInternal = resolveAllowInternalConnectorHosts({ isRoot: scope.isRoot, env });
        const safeParams = sanitizeHttpParams(params);
        if (Array.isArray(safeParams.channels) && !safeParams.channel) {
          ctx.body = await dispatchOmnichannel(
            db,
            { ...safeParams, organizationId: scope.organizationId },
            { ...boundOptions, allowInternal },
          );
        } else {
          ctx.body = await dispatchChannelNotification(
            db,
            { ...safeParams, organizationId: scope.organizationId },
            { ...boundOptions, allowInternal },
          );
        }
        if (next) return next();
      },

      testSend: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveNotifyCaller(db, ctx, params.organizationId);
        if (!scope.isAdmin) {
          throw failNotify('NOTIFY_ADMIN_REQUIRED', 403, 'Administrator role is required to test omnichannel dispatch.');
        }
        const allowInternal = resolveAllowInternalConnectorHosts({ isRoot: scope.isRoot, env });
        const safeParams = sanitizeHttpParams(params);
        ctx.body = await dispatchChannelNotification(
          db,
          {
            ...safeParams,
            organizationId: scope.organizationId,
            title: safeParams.title || 'LatticeDX Test Notification',
            body: safeParams.body || 'Omnichannel Vault test-send verification.',
            eventType: safeParams.eventType || 'lattice.notify.test',
          },
          { ...boundOptions, allowInternal },
        );
        if (next) return next();
      },

      logs: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveNotifyCaller(db, ctx, params.organizationId);
        if (!scope.isAdmin) {
          throw failNotify('NOTIFY_ADMIN_REQUIRED', 403, 'Administrator role is required to view notification delivery logs.');
        }
        ctx.body = await listDeliveryLogs(db, {
          organizationId: scope.organizationId,
          channel: params.channel,
          status: params.status,
          dryRun: params.dryRun,
          limit: params.limit,
          offset: params.offset,
        });
        if (next) return next();
      },

      channels: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveNotifyCaller(db, ctx, params.organizationId);
        const items = await resolveActiveConnectorsForOrg(db, scope.organizationId, boundOptions);
        ctx.body = {
          organizationId: scope.organizationId,
          supportedChannels: SUPPORTED_CHANNELS,
          items: items.map((item) => ({
            channel: item.channel,
            connectorKey: item.connectorKey,
            name: item.connector?.name || item.connectorKey,
            connectorType: item.connector?.connectorType || null,
            appType: item.connector?.appType || null,
            authType: item.connector?.authType || null,
            active: item.connector?.active !== false,
          })),
        };
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.('dxosNotify', ['send', 'testSend', 'logs', 'channels'], 'loggedIn');

  const api = {
    SUPPORTED_CHANNELS,
    renderTemplate,
    renderWebhookPayload,
    escapeHtml,
    scrubSecrets,
    sendSmtpEmail,
    sendTelegramMessage,
    sendSlackMessage,
    sendWebhookMessage,
    dispatchChannelNotification: (params, opts = {}) => dispatchChannelNotification(db, params, { ...boundOptions, ...opts }),
    dispatchOmnichannel: (payload, opts = {}) => dispatchOmnichannel(db, payload, { ...boundOptions, ...opts }),
    listDeliveryLogs: (filters) => listDeliveryLogs(db, filters),
    createNotificationCenterAdapter: (opts = {}) => createNotificationCenterAdapter({ ...boundOptions, ...opts }),
  };
  app.latticeOmnichannelNotify = api;
  return api;
}

module.exports = {
  SUPPORTED_CHANNELS,
  escapeHtml,
  renderTemplate,
  renderWebhookPayload,
  scrubSecrets,
  maskTarget,
  assertNoHeaderInjection,
  sendSmtpEmail,
  sendTelegramMessage,
  sendSlackMessage,
  sendWebhookMessage,
  dispatchChannelNotification,
  dispatchOmnichannel,
  createNotificationCenterAdapter,
  listDeliveryLogs,
  registerOmnichannelNotify,
};

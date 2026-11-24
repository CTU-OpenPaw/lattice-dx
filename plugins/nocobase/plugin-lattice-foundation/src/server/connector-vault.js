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
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const { resolveNativeActor } = require('./native-scope');
const { val, getRepo, callerRoles } = require('./native-portal-helpers');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');
const {
  canUsePgRlsSession,
  getActiveRlsContext,
  withSystemRlsBypass,
  withTenantRlsContext,
} = require('./pg-rls');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const CONNECTOR_KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_CONNECTOR_TYPES = Object.freeze(new Set([
  'n8n',
  'webhook',
  'mqtt',
  'orion_ld',
  'http_api',
  'smtp_notify',
  'n8n_api',
  'telegram',
  'email_smtp',
  'gmail_oauth2',
  'google_sheets_oauth2',
  'slack',
  'discord',
  'teams',
  'github',
  'rustfs_s3',
  'partner_webhook',
  'oauth2',
  'app',
]));
const VALID_AUTH_TYPES = Object.freeze(new Set([
  'bearer',
  'hmac',
  'basic',
  'api_key',
  'oauth2',
  'none',
]));
const DEFAULT_INTERNAL_SERVICE_HOSTS = Object.freeze([
  'n8n',
  'orion-ld',
  'nodered',
  'mosquitto',
]);
const INTERNAL_CONNECTOR_HOST_ALLOWLIST = Object.freeze(new Set(DEFAULT_INTERNAL_SERVICE_HOSTS));
const APP_CONNECTOR_CATALOG = Object.freeze([
  Object.freeze({
    appType: 'telegram',
    name: 'Telegram Bot API',
    category: 'messaging',
    connectorType: 'http_api',
    authTypes: Object.freeze(['api_key', 'bearer']),
    defaultAuthType: 'api_key',
    defaultBaseUrl: 'https://api.telegram.org',
    n8nCredentialType: 'telegramApi',
    capabilities: Object.freeze(['sendMessage', 'sendPhoto', 'webhook']),
    secretFields: Object.freeze(['botToken', 'defaultChatId']),
    description: 'Send real-time operational alerts and approvals via Telegram Bot API.',
  }),
  Object.freeze({
    appType: 'email_smtp',
    name: 'Email (SMTP)',
    category: 'messaging',
    connectorType: 'smtp_notify',
    authTypes: Object.freeze(['basic', 'none']),
    defaultAuthType: 'basic',
    defaultBaseUrl: 'smtp://smtp.example.org:587',
    n8nCredentialType: 'smtp',
    capabilities: Object.freeze(['sendEmail']),
    secretFields: Object.freeze(['host', 'port', 'username', 'password', 'fromEmail']),
    description: 'Transactional SMTP email delivery for incident dossiers and partner notices.',
  }),
  Object.freeze({
    appType: 'gmail_oauth2',
    name: 'Gmail (OAuth2 PKCE)',
    category: 'messaging',
    connectorType: 'http_api',
    authTypes: Object.freeze(['oauth2']),
    defaultAuthType: 'oauth2',
    defaultBaseUrl: 'https://gmail.googleapis.com',
    n8nCredentialType: 'gmailOAuth2',
    oauth2: Object.freeze({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: Object.freeze([
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
      ]),
      pkce: true,
    }),
    capabilities: Object.freeze(['sendEmail', 'readInbox', 'searchThreads']),
    secretFields: Object.freeze(['clientId', 'clientSecret']),
    description: 'Google Workspace Gmail connector with OAuth2 PKCE S256 and automatic token refresh.',
  }),
  Object.freeze({
    appType: 'google_sheets_oauth2',
    name: 'Google Sheets (OAuth2 PKCE)',
    category: 'productivity',
    connectorType: 'http_api',
    authTypes: Object.freeze(['oauth2']),
    defaultAuthType: 'oauth2',
    defaultBaseUrl: 'https://sheets.googleapis.com',
    n8nCredentialType: 'googleSheetsOAuth2Api',
    oauth2: Object.freeze({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: Object.freeze(['https://www.googleapis.com/auth/spreadsheets']),
      pkce: true,
    }),
    capabilities: Object.freeze(['appendRow', 'readRange', 'updateRange']),
    secretFields: Object.freeze(['clientId', 'clientSecret']),
    description: 'Append partner settlement logs and read spreadsheet ranges via OAuth2 PKCE.',
  }),
  Object.freeze({
    appType: 'slack',
    name: 'Slack Workspace',
    category: 'messaging',
    connectorType: 'http_api',
    authTypes: Object.freeze(['oauth2', 'bearer']),
    defaultAuthType: 'oauth2',
    defaultBaseUrl: 'https://slack.com/api',
    n8nCredentialType: 'slackOAuth2Api',
    oauth2: Object.freeze({
      authUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      defaultScopes: Object.freeze(['chat:write', 'channels:read']),
      pkce: true,
    }),
    capabilities: Object.freeze(['postMessage', 'listChannels', 'uploadFile']),
    secretFields: Object.freeze(['clientId', 'clientSecret', 'botToken']),
    description: 'Post incident notifications and interactive cards to Slack channels.',
  }),
  Object.freeze({
    appType: 'discord',
    name: 'Discord Webhook / Bot',
    category: 'messaging',
    connectorType: 'webhook',
    authTypes: Object.freeze(['bearer', 'none']),
    defaultAuthType: 'bearer',
    defaultBaseUrl: 'https://discord.com/api',
    n8nCredentialType: 'discordWebhookApi',
    capabilities: Object.freeze(['postMessage', 'sendEmbed']),
    secretFields: Object.freeze(['webhookUrl', 'botToken']),
    description: 'Dispatch structured embeds and alert summaries to Discord channels.',
  }),
  Object.freeze({
    appType: 'teams',
    name: 'Microsoft Teams',
    category: 'messaging',
    connectorType: 'http_api',
    authTypes: Object.freeze(['oauth2', 'bearer']),
    defaultAuthType: 'oauth2',
    defaultBaseUrl: 'https://graph.microsoft.com',
    n8nCredentialType: 'microsoftTeamsOAuth2Api',
    oauth2: Object.freeze({
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      defaultScopes: Object.freeze(['ChannelMessage.Send', 'offline_access']),
      pkce: true,
    }),
    capabilities: Object.freeze(['postMessage', 'sendAdaptiveCard']),
    secretFields: Object.freeze(['clientId', 'clientSecret']),
    description: 'Send enterprise Adaptive Cards and channel updates to Microsoft Teams.',
  }),
  Object.freeze({
    appType: 'github',
    name: 'GitHub',
    category: 'engineering',
    connectorType: 'http_api',
    authTypes: Object.freeze(['oauth2', 'bearer']),
    defaultAuthType: 'oauth2',
    defaultBaseUrl: 'https://api.github.com',
    n8nCredentialType: 'githubOAuth2Api',
    oauth2: Object.freeze({
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      defaultScopes: Object.freeze(['repo', 'read:user']),
      pkce: true,
    }),
    capabilities: Object.freeze(['createIssue', 'createComment', 'triggerDispatch']),
    secretFields: Object.freeze(['clientId', 'clientSecret', 'token']),
    description: 'Create GitHub issues, post compliance comments, and trigger workflow dispatches.',
  }),
  Object.freeze({
    appType: 'rustfs_s3',
    name: 'RustFS / S3 Storage',
    category: 'storage',
    connectorType: 'http_api',
    authTypes: Object.freeze(['api_key', 'basic']),
    defaultAuthType: 'api_key',
    defaultBaseUrl: 'https://s3.example.org',
    n8nCredentialType: 's3',
    capabilities: Object.freeze(['putObject', 'getObject', 'presignUrl']),
    secretFields: Object.freeze(['accessKeyId', 'secretAccessKey', 'bucket', 'region']),
    description: 'Archive signed ePOD evidence and compliance dossiers to S3-compatible RustFS.',
  }),
  Object.freeze({
    appType: 'n8n_api',
    name: 'Stock n8n Public REST API v1',
    category: 'orchestration',
    connectorType: 'n8n',
    authTypes: Object.freeze(['api_key', 'hmac', 'bearer']),
    defaultAuthType: 'api_key',
    defaultBaseUrl: 'http://n8n:5678',
    n8nCredentialType: 'httpHeaderAuth',
    capabilities: Object.freeze([
      'listWorkflows',
      'createWorkflow',
      'updateWorkflow',
      'activateWorkflow',
      'listExecutions',
      'retryExecution',
      'syncCredential',
    ]),
    secretFields: Object.freeze(['apiKey', 'webhookSecret']),
    description: 'Manage Stock n8nio/n8n workflows, executions, retries, and credentials over REST v1.',
  }),
  Object.freeze({
    appType: 'partner_webhook',
    name: 'B2B Partner Webhook',
    category: 'integration',
    connectorType: 'webhook',
    authTypes: Object.freeze(['hmac', 'bearer', 'api_key']),
    defaultAuthType: 'hmac',
    defaultBaseUrl: 'https://partner.example.org/webhooks/latticedx',
    n8nCredentialType: 'httpHeaderAuth',
    capabilities: Object.freeze(['dispatchEvent', 'verifyCallback']),
    secretFields: Object.freeze(['secret', 'token']),
    description: 'Signed Standard Webhooks / HMAC-SHA256 outbound and inbound B2B partner sync.',
  }),
]);
const APP_CATALOG_BY_TYPE = new Map(APP_CONNECTOR_CATALOG.map((entry) => [entry.appType, entry]));
const ELEVATED_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const TEST_TIMEOUT_MS = 3000;
const OAUTH_REFRESH_BUFFER_SEC_DEFAULT = 180;
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const dbInflightTokenRefresh = new WeakMap();

function failVault(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function resolveVaultMasterKey(env = process.env) {
  const secret = String(
    env?.DX_VAULT_MASTER_KEY
      || env?.ENCRYPTION_FIELD_KEY
      || env?.NOCOBASE_APP_KEY
      || env?.APP_KEY
      || '',
  ).trim();
  if (!secret) {
    if (String(env?.NODE_ENV || '').trim().toLowerCase() === 'production') {
      throw failVault(
        'VAULT_MASTER_KEY_MISSING',
        500,
        'DX_VAULT_MASTER_KEY, ENCRYPTION_FIELD_KEY, NOCOBASE_APP_KEY, or APP_KEY must be set in production.',
      );
    }
    return createHash('sha256').update('latticedx-vault-dev-fallback-key', 'utf8').digest();
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptSecretText(plaintext, env = process.env) {
  const masterKey = resolveVaultMasterKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecretText(ciphertext, env = process.env) {
  const parts = String(ciphertext || '').split(':');
  if (
    parts.length !== 3
    || !/^[0-9a-f]{24}$/i.test(parts[0])
    || !/^[0-9a-f]{32}$/i.test(parts[1])
    || !/^[0-9a-f]*$/i.test(parts[2])
    || parts[2].length % 2 !== 0
  ) {
    throw failVault('VAULT_CIPHERTEXT_INVALID', 500, 'Encrypted vault payload is malformed.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const masterKey = resolveVaultMasterKey(env);
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    if (err?.code === 'VAULT_MASTER_KEY_MISSING') throw err;
    throw failVault('VAULT_CIPHERTEXT_INVALID', 500, 'Encrypted vault payload is invalid or tampered.');
  }
}

function sanitizeJsonValue(valItem) {
  if (valItem === undefined || typeof valItem === 'function' || typeof valItem === 'symbol') return undefined;
  if (valItem === null || typeof valItem !== 'object') return valItem;
  if (Array.isArray(valItem)) {
    return valItem.map((el) => sanitizeJsonValue(el)).filter((el) => el !== undefined);
  }
  const clean = {};
  for (const [k, v] of Object.entries(valItem)) {
    if (PROTO_POLLUTION_KEYS.has(k)) continue;
    const sanitized = sanitizeJsonValue(v);
    if (sanitized !== undefined) clean[k] = sanitized;
  }
  return clean;
}

function sanitizeSecretsObject(rawSecrets) {
  if (rawSecrets === undefined || rawSecrets === null) return {};
  if (typeof rawSecrets !== 'object' || Array.isArray(rawSecrets)) {
    throw failVault('VAULT_SECRETS_INVALID', 400, 'Connector secrets must be a plain JSON object.');
  }
  return sanitizeJsonValue(rawSecrets);
}

function encryptVaultSecrets(secretsObj, env = process.env) {
  const clean = sanitizeSecretsObject(secretsObj);
  return encryptSecretText(JSON.stringify(clean), env);
}

function decryptVaultSecrets(ciphertext, env = process.env) {
  if (!ciphertext || !String(ciphertext).trim()) return {};
  const raw = decryptSecretText(ciphertext, env);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failVault('VAULT_CIPHERTEXT_INVALID', 500, 'Decrypted vault secrets JSON is malformed.');
  }
  return sanitizeSecretsObject(parsed);
}

function isBlockedIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function extractRawAuthorityHost(rawUrl) {
  const m = String(rawUrl || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!m) return '';
  const authority = m[1];
  if (!authority || authority.includes('@') || authority.includes('\\')) return '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return '';
    return authority.slice(1, close).toLowerCase().replace(/\.+$/, '');
  }
  const colonIdx = authority.indexOf(':');
  const host = colonIdx >= 0 ? authority.slice(0, colonIdx) : authority;
  return host.toLowerCase().replace(/\.+$/, '');
}

function isNonCanonicalNumericHost(host) {
  const clean = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!clean) return false;
  if (/^\d+$/.test(clean) || /^0x[0-9a-f]+$/i.test(clean)) {
    return true;
  }
  const parts = clean.split('.');
  if (parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))) {
    if (parts.length !== 4) return true;
    if (parts.some((p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith('0')))) {
      return true;
    }
  }
  return false;
}

function parseIpv6Hextets(rawAddr) {
  let addr = String(rawAddr || '').toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx >= 0) addr = addr.slice(0, zoneIdx);
  if (!addr || !addr.includes(':')) return null;

  const doubleColonParts = addr.split('::');
  if (doubleColonParts.length > 2) return null;

  const expandSide = (side, isRight) => {
    if (!side) return [];
    const tokens = side.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (i !== tokens.length - 1 || (doubleColonParts.length === 2 && !isRight)) {
          return null;
        }
        const octs = tok.split('.');
        if (octs.length !== 4 || !octs.every((o) => /^(?:0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)) {
          return null;
        }
        const [a, b, c, d] = octs.map(Number);
        out.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = expandSide(doubleColonParts[0], true);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = expandSide(doubleColonParts[0], false);
  const right = expandSide(doubleColonParts[1], true);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function hextetsToIpv4(hi, lo) {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpv6(rawHost) {
  const bareHost = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bareHost.includes(':')) return false;
  if (bareHost.includes('%')) return true;

  const h = parseIpv6Hextets(bareHost);
  if (!h) return true;

  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  const isAllZeroPrefix5 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;

  if (isAllZeroPrefix5 && h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) return true;

  // IPv4-mapped IPv6 ::ffff:0:0/96 (covers ::ffff:169.254.169.254, ::ffff:127.0.0.1, 0:0:0:0:0:ffff:...)
  if (isAllZeroPrefix5 && h5 === 0xffff) {
    return true;
  }

  // IPv4-compatible IPv6 ::/96 (e.g. ::127.0.0.1 / ::169.254.169.254)
  if (isAllZeroPrefix5 && h5 === 0 && isBlockedIpv4(hextetsToIpv4(h6, h7))) return true;

  // IPv4-translated IPv6 ::ffff:0:0:0/96
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
    return true;
  }

  // NAT64 prefixes 64:ff9b::/96 and 64:ff9b:1::/48
  if (h0 === 0x0064 && h1 === 0xff9b && (h2 === 0 || h2 === 1)) {
    if (h2 === 1 || isBlockedIpv4(hextetsToIpv4(h6, h7))) return true;
  }

  // 6to4 prefix 2002::/16 embedding IPv4 in h1:h2
  if (h0 === 0x2002 && isBlockedIpv4(hextetsToIpv4(h1, h2))) return true;

  // Link-local fe80::/10, ULA fc00::/7 (includes fd00:ec2::254), Multicast ff00::/8
  if ((h0 & 0xffc0) === 0xfe80) return true;
  if ((h0 & 0xfe00) === 0xfc00) return true;
  if ((h0 & 0xff00) === 0xff00) return true;

  // Discard 100::/64 and Documentation 2001:db8::/32
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  if (h0 === 0x2001 && h1 === 0x0db8) return true;

  return false;
}

function isBlockedIpAddress(rawAddr) {
  const clean = String(rawAddr || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (clean.includes(':')) return isBlockedIpv6(clean);
  if (isNonCanonicalNumericHost(clean)) return true;
  if (net.isIPv4(clean)) return isBlockedIpv4(clean);
  return true;
}

function isBlockedMetadataHost(bare) {
  const clean = String(bare || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return false;
  if (
    clean === 'metadata.google.internal'
    || clean.endsWith('.metadata.google.internal')
    || clean === 'metadata.azure.com'
    || clean.endsWith('.metadata.azure.com')
    || clean === 'metadata.aws.internal'
    || clean === 'instance-data'
    || (net.isIPv4(clean) && clean.startsWith('169.254.'))
    || clean === 'fd00:ec2::254'
  ) {
    return true;
  }
  return false;
}

function resolveAllowInternalConnectorHosts({ allowInternal, isRoot = false, env = process.env } = {}) {
  if (typeof allowInternal === 'boolean') return allowInternal;
  const explicit = String(env?.DX_ALLOW_INTERNAL_CONNECTORS || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  const isProd = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (!isProd) return true;
  return Boolean(isRoot);
}

function isSafeNamedInternalHost(host, { allowInternalSuffix = false } = {}) {
  const clean = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean || clean.includes(':') || net.isIP(clean) !== 0) return false;
  if (isNonCanonicalNumericHost(clean) || isBlockedIpv4(clean) || isBlockedMetadataHost(clean)) return false;
  if (clean === 'localhost' || clean.endsWith('.localhost') || clean.endsWith('.local')) return false;
  if (!allowInternalSuffix && clean.endsWith('.internal')) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*$/.test(clean);
}

function resolveInternalServiceHosts(env = process.env) {
  const raw = String(env?.DX_INTERNAL_SERVICE_HOSTS || '').trim();
  const candidates = raw
    ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_INTERNAL_SERVICE_HOSTS;
  return candidates.filter((h) => isSafeNamedInternalHost(h, { allowInternalSuffix: false }));
}

function isInternalAllowlistedHost(bare, env = process.env) {
  const clean = String(bare || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean || net.isIP(clean) !== 0 || clean.includes(':') || isBlockedMetadataHost(clean)) return false;
  if (clean === 'localhost' || clean.endsWith('.localhost') || clean.endsWith('.local')) return false;
  const serviceHosts = resolveInternalServiceHosts(env);
  if (serviceHosts.includes(clean)) return true;
  const extraAllowlist = String(env?.DX_CONNECTOR_INTERNAL_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((h) => isSafeNamedInternalHost(h, { allowInternalSuffix: true }));
  return extraAllowlist.includes(clean);
}

function resolveAllowedProtocols(connectorType) {
  if (connectorType === 'mqtt') return new Set(['mqtt:', 'mqtts:', 'http:', 'https:']);
  if (connectorType === 'smtp_notify' || connectorType === 'email_smtp') {
    return new Set(['smtp:', 'smtps:', 'http:', 'https:']);
  }
  return new Set(['http:', 'https:']);
}

function assertSafeConnectorUrl(rawUrl, { connectorType = 'http_api', env = process.env, allowInternal } = {}) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Connector URL is required and must be <= 2048 characters.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Malformed connector URL.');
  }

  const allowedProtocols = resolveAllowedProtocols(connectorType);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Protocol ${parsed.protocol} is blocked by SSRF policy.`);
  }
  if (parsed.username || parsed.password) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Embedded credentials in connector URL are forbidden.');
  }

  const rawAuthorityHost = extractRawAuthorityHost(trimmed);
  if (!rawAuthorityHost) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Connector URL authority is invalid.');
  }
  if (isNonCanonicalNumericHost(rawAuthorityHost)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Non-canonical numeric hostname ${rawAuthorityHost} is blocked.`);
  }
  if (rawAuthorityHost.includes(':') && isBlockedIpv6(rawAuthorityHost)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Blocked IPv6 address: ${rawAuthorityHost}`);
  }

  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Connector URL hostname is empty.');
  }
  if (isNonCanonicalNumericHost(bare)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Non-canonical numeric hostname ${bare} is blocked.`);
  }

  // Metadata IPs and hostnames are unconditionally blocked for all callers and environments.
  if (isBlockedMetadataHost(bare) || isBlockedMetadataHost(rawAuthorityHost)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Cloud metadata hostname or IP ${bare} is blocked.`);
  }

  const effectiveAllowInternal = resolveAllowInternalConnectorHosts({ allowInternal, env });
  if (effectiveAllowInternal && isInternalAllowlistedHost(bare, env)) {
    return parsed.toString();
  }

  if (
    bare === 'localhost'
    || bare.endsWith('.localhost')
    || bare.endsWith('.local')
    || bare.endsWith('.internal')
  ) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Internal metadata or local hostname ${bare} is blocked.`);
  }
  if (isBlockedIpv6(bare)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Blocked IPv6 address: ${bare}`);
  }
  if (isBlockedIpv4(bare)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Blocked private or link-local IPv4 address: ${bare}`);
  }
  if (!bare.includes('.') && !bare.includes(':')) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Non-allowlisted internal service hostname ${bare} is blocked.`);
  }
  return parsed.toString();
}

async function assertSafeConnectorUrlAsync(
  rawUrl,
  {
    connectorType = 'http_api',
    env = process.env,
    allowInternal,
    lookupImpl,
    skipDnsCheck = false,
  } = {},
) {
  const validatedUrl = assertSafeConnectorUrl(rawUrl, { connectorType, env, allowInternal });
  const parsed = new URL(validatedUrl);
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  const effectiveAllowInternal = resolveAllowInternalConnectorHosts({ allowInternal, env });
  if (effectiveAllowInternal && isInternalAllowlistedHost(bare, env)) {
    return validatedUrl;
  }
  if (net.isIP(bare) !== 0) {
    return validatedUrl;
  }
  if (skipDnsCheck === true) {
    return validatedUrl;
  }

  const lookup = typeof lookupImpl === 'function' ? lookupImpl : dns.promises.lookup;
  let records;
  try {
    records = await lookup(bare, { all: true });
  } catch (err) {
    throw failVault(
      'CONNECTOR_URL_UNSAFE',
      400,
      `DNS resolution failed for connector host ${bare}: ${err?.code || err?.message || 'unknown error'}`,
    );
  }

  const list = Array.isArray(records) ? records : (records ? [records] : []);
  const addresses = list.map((r) => (typeof r === 'string' ? r : r?.address)).filter(Boolean);
  if (addresses.length === 0) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `DNS resolution returned no IP addresses for ${bare}.`);
  }
  for (const addr of addresses) {
    if (isBlockedIpAddress(addr)) {
      throw failVault('CONNECTOR_URL_UNSAFE', 400, `Resolved IP address ${addr} for ${bare} is blocked by SSRF policy.`);
    }
  }
  return validatedUrl;
}

function sanitizeOauthConfigForStorage(rawCfg) {
  if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) return null;
  const clean = sanitizeSecretsObject(rawCfg);
  for (const key of Object.keys(clean)) {
    if (/secret|verifier|password|private|accesstoken|refreshtoken|access_token|refresh_token/i.test(key)) {
      delete clean[key];
    }
  }
  return Object.keys(clean).length ? clean : null;
}

function runVaultDbOp(db, organizationId, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('runVaultDbOp requires a callback.');
  }
  if (!canUsePgRlsSession(db)) {
    return fn(undefined);
  }
  const active = getActiveRlsContext();
  if (active?.transaction && active.sequelize === db?.sequelize) {
    if (active.systemRlsBypass === true || (organizationId && active.organizationId === organizationId)) {
      return fn(active.transaction);
    }
  }
  if (organizationId && ORG_ID_RE.test(String(organizationId))) {
    return withTenantRlsContext(db, String(organizationId), (transaction) => fn(transaction));
  }
  return withSystemRlsBypass(db, (transaction) => fn(transaction));
}

function serializeConnector(row, { env = process.env } = {}) {
  if (!row) return null;
  const rawEnc = val(row, 'encryptedSecretsJson');
  let secretKeys = [];
  let hasSecrets = false;
  let decryptionError = false;
  if (rawEnc && String(rawEnc).trim()) {
    try {
      const decrypted = decryptVaultSecrets(rawEnc, env);
      secretKeys = Object.keys(decrypted).filter((k) => k !== '_oauthPkce').sort();
      hasSecrets = secretKeys.length > 0;
    } catch {
      secretKeys = [];
      hasSecrets = Boolean(rawEnc);
      decryptionError = true;
    }
  }
  const lastTestedAt = val(row, 'lastTestedAt');
  const oauthTokenExpiresAtRaw = val(row, 'oauthTokenExpiresAt');
  const oauthAccessEnc = val(row, 'oauthAccessTokenEnc');
  const oauthRefreshEnc = val(row, 'oauthRefreshTokenEnc');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    connectorKey: val(row, 'connectorKey') || '',
    name: val(row, 'name') || '',
    connectorType: val(row, 'connectorType') || 'webhook',
    appType: val(row, 'appType') || null,
    capabilitiesJson: val(row, 'capabilitiesJson') || null,
    oauthConfigJson: sanitizeOauthConfigForStorage(val(row, 'oauthConfigJson')),
    oauthConnected: Boolean(oauthAccessEnc && String(oauthAccessEnc).trim()),
    oauthHasRefreshToken: Boolean(oauthRefreshEnc && String(oauthRefreshEnc).trim()),
    oauthTokenExpiresAt: oauthTokenExpiresAtRaw
      ? (oauthTokenExpiresAtRaw instanceof Date ? oauthTokenExpiresAtRaw.toISOString() : String(oauthTokenExpiresAtRaw))
      : null,
    oauthScope: val(row, 'oauthScope') || null,
    n8nCredentialId: val(row, 'n8nCredentialId') || null,
    baseUrl: val(row, 'baseUrl') || null,
    authType: val(row, 'authType') || 'none',
    hasSecrets,
    secretKeys,
    decryptionError,
    secretVersion: Number(val(row, 'secretVersion')) || 1,
    lastTestedAt: lastTestedAt ? (lastTestedAt instanceof Date ? lastTestedAt.toISOString() : String(lastTestedAt)) : null,
    lastTestStatus: val(row, 'lastTestStatus') || null,
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

async function resolveConnectorSecrets(db, organizationId, connectorKeyOrId, options = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failVault('VAULT_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  if (connectorKeyOrId === undefined || connectorKeyOrId === null || String(connectorKeyOrId).trim() === '') {
    throw failVault('CONNECTOR_REF_REQUIRED', 400, 'connectorKey or id is required.');
  }
  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.findOne !== 'function') {
    throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
  }

  const rawRef = String(connectorKeyOrId).trim();
  const filter = /^[1-9]\d*$/.test(rawRef)
    ? { organizationId: orgId, id: Number(rawRef) }
    : { organizationId: orgId, connectorKey: rawRef.toLowerCase() };

  const row = await runVaultDbOp(db, orgId, (transaction) => repo.findOne({
    filter,
    ...(transaction ? { transaction } : {}),
  }));
  if (!row || val(row, 'organizationId') !== orgId) {
    throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found in organization scope.');
  }
  if (!options.allowInactive && val(row, 'active') === false) {
    throw failVault('CONNECTOR_INACTIVE', 403, 'Connector is inactive.');
  }

  const env = options.env || process.env;
  const secrets = decryptVaultSecrets(val(row, 'encryptedSecretsJson'), env);
  delete secrets._oauthPkce;
  return {
    connector: serializeConnector(row, { env }),
    secrets,
  };
}

function generatePkcePair() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

function assertSafeRedirectUri(rawUri) {
  const trimmed = typeof rawUri === 'string' ? rawUri.trim() : '';
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw failVault('OAUTH_REDIRECT_URI_INVALID', 400, 'Valid http/https redirectUri is required.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw failVault('OAUTH_REDIRECT_URI_INVALID', 400, 'Malformed OAuth2 redirectUri.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw failVault('OAUTH_REDIRECT_URI_INVALID', 400, 'OAuth2 redirectUri must use http or https without credentials.');
  }
  return parsed.toString();
}

function normalizeScopeList(rawScopes, fallbackScopes = []) {
  if (Array.isArray(rawScopes)) {
    return rawScopes.map((s) => String(s || '').trim()).filter(Boolean);
  }
  if (typeof rawScopes === 'string' && rawScopes.trim()) {
    return rawScopes.trim().split(/[\s,]+/).filter(Boolean);
  }
  return Array.isArray(fallbackScopes) ? [...fallbackScopes] : [];
}

function timingSafeMatchString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

async function saveConnectorRowValues(repo, existing, organizationId, values, transaction) {
  const txOpt = transaction ? { transaction } : {};
  if (existing) {
    const existingId = val(existing, 'id');
    if (typeof existing.update === 'function') {
      return transaction ? existing.update(values, { transaction }) : existing.update(values);
    }
    if (typeof repo.update === 'function') {
      const res = await repo.update({
        filterByTk: existingId,
        filter: { organizationId },
        values,
        ...txOpt,
      });
      return Array.isArray(res) && res[0] ? res[0] : { ...existing, ...values, id: existingId };
    }
    return Object.assign(existing, values);
  }
  return repo.create({ values, ...txOpt });
}

async function oauthStart(db, params = {}, options = {}) {
  const env = options.env || process.env;
  const orgId = typeof params.organizationId === 'string' ? params.organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failVault('VAULT_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  const connectorKey = typeof params.connectorKey === 'string' ? params.connectorKey.trim().toLowerCase() : '';
  if (!CONNECTOR_KEY_RE.test(connectorKey)) {
    throw failVault('CONNECTOR_KEY_INVALID', 400, 'connectorKey must be a valid lowercase slug (2..64 chars).');
  }

  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.findOne !== 'function' || typeof repo.create !== 'function') {
    throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
  }

  const allowInternal = resolveAllowInternalConnectorHosts({
    allowInternal: options.allowInternal,
    isRoot: Boolean(options.isRoot),
    env,
  });

  return runVaultDbOp(db, orgId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = await repo.findOne({ filter: { organizationId: orgId, connectorKey }, ...txOpt });
    const existingOauthCfg = existing ? sanitizeOauthConfigForStorage(val(existing, 'oauthConfigJson')) || {} : {};
    const rawAppType = String(params.appType || val(existing, 'appType') || '').trim().toLowerCase();
    const catalogEntry = APP_CATALOG_BY_TYPE.get(rawAppType) || null;
    const oauthDefaults = catalogEntry?.oauth2 || {};

    const clientId = String(params.clientId || existingOauthCfg.clientId || '').trim();
    if (!clientId) {
      throw failVault('OAUTH_CLIENT_ID_REQUIRED', 400, 'OAuth2 clientId is required.');
    }

    const rawAuthUrl = params.authorizationUrl || params.authUrl || existingOauthCfg.authorizationUrl || oauthDefaults.authUrl;
    const rawTokenUrl = params.tokenUrl || existingOauthCfg.tokenUrl || oauthDefaults.tokenUrl;
    if (!rawAuthUrl || !rawTokenUrl) {
      throw failVault('OAUTH_ENDPOINTS_REQUIRED', 400, 'OAuth2 authorizationUrl and tokenUrl are required.');
    }
    const authorizationUrl = assertSafeConnectorUrl(String(rawAuthUrl), { connectorType: 'http_api', env, allowInternal });
    const tokenUrl = assertSafeConnectorUrl(String(rawTokenUrl), { connectorType: 'http_api', env, allowInternal });
    const redirectUri = assertSafeRedirectUri(params.redirectUri || existingOauthCfg.redirectUri);

    const scopes = normalizeScopeList(params.scopes ?? params.scope, existingOauthCfg.scopes || oauthDefaults.defaultScopes || []);
    const scopeStr = scopes.join(' ');
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkcePair();
    const stateNonce = randomBytes(24).toString('hex');

    let existingSecrets = {};
    const rawEnc = existing ? val(existing, 'encryptedSecretsJson') : null;
    if (rawEnc && String(rawEnc).trim()) {
      try {
        existingSecrets = decryptVaultSecrets(rawEnc, env);
      } catch {
        existingSecrets = {};
      }
    }
    const nextSecrets = { ...existingSecrets };
    if (params.clientSecret !== undefined && params.clientSecret !== null && String(params.clientSecret).trim() !== '') {
      nextSecrets.clientSecret = String(params.clientSecret);
    }
    nextSecrets._oauthPkce = {
      stateNonce,
      codeVerifier,
      redirectUri,
      issuedAt: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
    };
    const encryptedSecretsJson = encryptVaultSecrets(nextSecrets, env);

    const oauthConfigJson = {
      clientId,
      authorizationUrl,
      tokenUrl,
      redirectUri,
      scopes,
      pkce: true,
    };
    const baseUrlRaw = params.baseUrl || val(existing, 'baseUrl') || catalogEntry?.defaultBaseUrl || new URL(tokenUrl).origin;
    const baseUrl = assertSafeConnectorUrl(String(baseUrlRaw), { connectorType: 'http_api', env, allowInternal });
    const name = String(params.name || val(existing, 'name') || catalogEntry?.name || connectorKey).trim().slice(0, 120);
    const connectorType = String(params.connectorType || val(existing, 'connectorType') || catalogEntry?.connectorType || 'http_api').trim().toLowerCase();
    const capabilitiesJson = params.capabilitiesJson ?? val(existing, 'capabilitiesJson') ?? (catalogEntry?.capabilities ? [...catalogEntry.capabilities] : null);

    const saved = await saveConnectorRowValues(repo, existing, orgId, {
      organizationId: orgId,
      connectorKey,
      name,
      connectorType: VALID_CONNECTOR_TYPES.has(connectorType) ? connectorType : 'http_api',
      appType: rawAppType || null,
      capabilitiesJson,
      baseUrl,
      authType: 'oauth2',
      encryptedSecretsJson,
      secretVersion: existing ? (Number(val(existing, 'secretVersion')) || 1) : 1,
      oauthConfigJson,
      oauthScope: scopeStr || null,
      oauthStateNonce: stateNonce,
      active: params.active === undefined ? (existing ? val(existing, 'active') !== false : true) : Boolean(params.active),
    }, transaction);

    const authUrlObj = new URL(authorizationUrl);
    authUrlObj.searchParams.set('response_type', 'code');
    authUrlObj.searchParams.set('client_id', clientId);
    authUrlObj.searchParams.set('redirect_uri', redirectUri);
    if (scopeStr) authUrlObj.searchParams.set('scope', scopeStr);
    authUrlObj.searchParams.set('state', stateNonce);
    authUrlObj.searchParams.set('code_challenge', codeChallenge);
    authUrlObj.searchParams.set('code_challenge_method', codeChallengeMethod);
    if (params.extraAuthParams && typeof params.extraAuthParams === 'object' && !Array.isArray(params.extraAuthParams)) {
      for (const [k, v] of Object.entries(params.extraAuthParams)) {
        if (!PROTO_POLLUTION_KEYS.has(k) && v !== undefined && v !== null) {
          authUrlObj.searchParams.set(String(k), String(v));
        }
      }
    }

    return {
      ok: true,
      id: val(saved, 'id') ?? null,
      organizationId: orgId,
      connectorKey,
      appType: rawAppType || null,
      authorizeUrl: authUrlObj.toString(),
      state: stateNonce,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      scope: scopeStr,
    };
  });
}

async function parseTokenEndpointResponse(response) {
  let rawText = '';
  if (typeof response?.text === 'function') {
    rawText = await response.text().catch(() => '');
  } else if (typeof response?.json === 'function') {
    const parsed = await response.json().catch(() => null);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const form = new URLSearchParams(trimmed);
    const out = {};
    for (const [k, v] of form.entries()) out[k] = v;
    return out;
  }
}

async function oauthCallback(db, params = {}, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lookupImpl = options.lookupImpl;
  const orgId = typeof params.organizationId === 'string' ? params.organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failVault('VAULT_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  const code = typeof params.code === 'string' ? params.code.trim() : '';
  const state = typeof params.state === 'string' ? params.state.trim() : '';
  if (!code) {
    throw failVault('OAUTH_CODE_REQUIRED', 400, 'OAuth2 authorization code is required.');
  }
  if (!state) {
    throw failVault('OAUTH_STATE_MISMATCH', 400, 'OAuth2 state nonce is required.');
  }

  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.findOne !== 'function') {
    throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
  }

  const allowInternal = resolveAllowInternalConnectorHosts({
    allowInternal: options.allowInternal,
    isRoot: Boolean(options.isRoot),
    env,
  });
  const isMockFetch = typeof options.fetchImpl === 'function' && options.fetchImpl !== globalThis.fetch;
  const skipDnsCheck = isMockFetch && typeof lookupImpl !== 'function' && !options.enforceDnsInMock;

  const tx1 = await runVaultDbOp(db, orgId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const lockOpt = transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {};
    let row = null;
    if (params.id != null || params.filterByTk != null || params.connectorKey) {
      row = await findConnectorInOrg(repo, orgId, params, transaction, { lock: true });
    } else {
      row = await repo.findOne({ filter: { organizationId: orgId, oauthStateNonce: state }, ...txOpt, ...lockOpt });
    }
    if (!row || val(row, 'organizationId') !== orgId) {
      throw failVault('CONNECTOR_NOT_FOUND', 404, 'OAuth2 connector not found in organization scope.');
    }

    const storedNonce = String(val(row, 'oauthStateNonce') || '');
    if (!storedNonce || !timingSafeMatchString(state, storedNonce)) {
      throw failVault('OAUTH_STATE_MISMATCH', 400, 'OAuth2 state nonce mismatch or already consumed.');
    }

    const secrets = decryptVaultSecrets(val(row, 'encryptedSecretsJson'), env);
    const pkceMeta = secrets._oauthPkce && typeof secrets._oauthPkce === 'object' ? secrets._oauthPkce : null;
    if (!pkceMeta || !timingSafeMatchString(state, String(pkceMeta.stateNonce || '')) || !pkceMeta.codeVerifier) {
      throw failVault('OAUTH_STATE_MISMATCH', 400, 'Encrypted PKCE verifier missing or state mismatch.');
    }
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    if (pkceMeta.issuedAt && nowMs - Number(pkceMeta.issuedAt) > OAUTH_STATE_TTL_MS) {
      throw failVault('OAUTH_STATE_EXPIRED', 400, 'OAuth2 authorization state has expired.');
    }

    const oauthCfg = sanitizeOauthConfigForStorage(val(row, 'oauthConfigJson')) || {};
    const remainingSecrets = { ...secrets };
    delete remainingSecrets._oauthPkce;
    const encryptedSecretsJson = Object.keys(remainingSecrets).length > 0
      ? encryptVaultSecrets(remainingSecrets, env)
      : null;

    // Atomically consume the one-time state nonce and PKCE verifier in TX1 before outbound HTTP.
    await saveConnectorRowValues(repo, row, orgId, {
      oauthStateNonce: null,
      encryptedSecretsJson,
    }, transaction);

    return {
      rowId: val(row, 'id') ?? null,
      connectorKey: val(row, 'connectorKey') || '',
      nowMs,
      oauthCfg,
      pkceMeta,
      clientSecret: secrets.clientSecret ? String(secrets.clientSecret) : null,
      existingRefreshTokenEnc: val(row, 'oauthRefreshTokenEnc') || null,
      existingOauthScope: val(row, 'oauthScope') || null,
      fallbackRow: row,
    };
  });

  // Outbound token exchange runs strictly outside any DB transaction.
  const tokenUrl = await assertSafeConnectorUrlAsync(tx1.oauthCfg.tokenUrl, {
    connectorType: 'http_api',
    env,
    allowInternal,
    lookupImpl,
    skipDnsCheck,
  });
  if (typeof fetchImpl !== 'function') {
    throw failVault('OAUTH_FETCH_UNAVAILABLE', 503, 'HTTP fetch implementation unavailable for OAuth2 exchange.');
  }

  const formBody = new URLSearchParams();
  formBody.set('grant_type', 'authorization_code');
  formBody.set('code', code);
  formBody.set('redirect_uri', String(params.redirectUri || tx1.pkceMeta.redirectUri || tx1.oauthCfg.redirectUri || ''));
  formBody.set('client_id', String(tx1.oauthCfg.clientId || ''));
  formBody.set('code_verifier', String(tx1.pkceMeta.codeVerifier));
  if (tx1.clientSecret) {
    formBody.set('client_secret', tx1.clientSecret);
  }

  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(10000)
    : undefined;
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw failVault('OAUTH_TOKEN_EXCHANGE_FAILED', 502, `OAuth2 token exchange error: ${err?.message || 'request failed'}`);
  }

  const tokenData = await parseTokenEndpointResponse(response);
  if (!response?.ok || !tokenData?.access_token) {
    throw failVault(
      'OAUTH_TOKEN_EXCHANGE_FAILED',
      502,
      `OAuth2 token endpoint returned HTTP ${response?.status || 'unknown'}: ${tokenData?.error_description || tokenData?.error || 'missing access_token'}`,
    );
  }

  const oauthAccessTokenEnc = encryptSecretText(String(tokenData.access_token), env);
  const oauthRefreshTokenEnc = tokenData.refresh_token
    ? encryptSecretText(String(tokenData.refresh_token), env)
    : tx1.existingRefreshTokenEnc;
  const expiresInSec = Number(tokenData.expires_in);
  const oauthTokenExpiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0
    ? new Date(tx1.nowMs + expiresInSec * 1000)
    : null;
  const oauthScope = tokenData.scope ? String(tokenData.scope).trim() : tx1.existingOauthScope;

  const updated = await runVaultDbOp(db, orgId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const refFilter = tx1.rowId != null
      ? { organizationId: orgId, id: tx1.rowId }
      : { organizationId: orgId, connectorKey: tx1.connectorKey };
    const targetRow = (await repo.findOne({ filter: refFilter, ...txOpt })) || tx1.fallbackRow;
    return saveConnectorRowValues(repo, targetRow, orgId, {
      oauthAccessTokenEnc,
      oauthRefreshTokenEnc,
      oauthTokenExpiresAt,
      oauthScope,
    }, transaction);
  });

  return {
    ...serializeConnector(updated, { env }),
    connected: true,
    hasAccessToken: true,
    hasRefreshToken: Boolean(oauthRefreshTokenEnc),
  };
}

function getDbRefreshFlightMap(db) {
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
    return new Map();
  }
  let map = dbInflightTokenRefresh.get(db);
  if (!map) {
    map = new Map();
    dbInflightTokenRefresh.set(db, map);
  }
  return map;
}

async function getFreshConnectorToken(db, connectorId, deps = {}) {
  const flightMap = getDbRefreshFlightMap(db);
  const orgScope = typeof deps.organizationId === 'string' ? deps.organizationId.trim() : '';
  const refStr = String(connectorId ?? '').trim();
  if (!refStr) {
    throw failVault('CONNECTOR_REF_REQUIRED', 400, 'connectorId or connectorKey is required.');
  }

  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const lookupImpl = deps.lookupImpl;
  const bufferSec = Number.isFinite(Number(deps.refreshBufferSec))
    ? Math.max(0, Number(deps.refreshBufferSec))
    : OAUTH_REFRESH_BUFFER_SEC_DEFAULT;
  const bufferMs = bufferSec * 1000;

  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.findOne !== 'function') {
    throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
  }

  const filter = /^[1-9]\d*$/.test(refStr)
    ? (orgScope ? { id: Number(refStr), organizationId: orgScope } : { id: Number(refStr) })
    : (() => {
        if (!ORG_ID_RE.test(orgScope)) {
          throw failVault('VAULT_ORG_REQUIRED', 400, 'organizationId is required when resolving by connectorKey.');
        }
        return { organizationId: orgScope, connectorKey: refStr.toLowerCase() };
      })();

  const initialRow = await runVaultDbOp(db, orgScope || null, (transaction) => repo.findOne({
    filter,
    ...(transaction ? { transaction } : {}),
  }));
  if (!initialRow || (orgScope && val(initialRow, 'organizationId') !== orgScope)) {
    throw failVault('CONNECTOR_NOT_FOUND', 404, 'OAuth2 connector not found.');
  }
  if (!deps.allowInactive && val(initialRow, 'active') === false) {
    throw failVault('CONNECTOR_INACTIVE', 403, 'Connector is inactive.');
  }

  const rowOrgId = String(val(initialRow, 'organizationId') || '');
  const rowId = val(initialRow, 'id');
  const rowConnectorKey = String(val(initialRow, 'connectorKey') || '').trim().toLowerCase();
  const nowMs = Number.isFinite(Number(deps.nowMs)) ? Number(deps.nowMs) : Date.now();
  const accessEnc = val(initialRow, 'oauthAccessTokenEnc');
  const expiresRaw = val(initialRow, 'oauthTokenExpiresAt');
  const expiresMs = expiresRaw ? new Date(expiresRaw).getTime() : null;

  const hasValidCachedToken = Boolean(accessEnc && String(accessEnc).trim())
    && (expiresMs === null || (Number.isFinite(expiresMs) && expiresMs - nowMs > bufferMs));

  if (hasValidCachedToken) {
    const accessToken = decryptSecretText(accessEnc, env);
    return {
      connectorId: rowId ?? refStr,
      connectorKey: val(initialRow, 'connectorKey') || '',
      organizationId: rowOrgId,
      accessToken,
      tokenType: 'Bearer',
      refreshed: false,
      expiresAt: expiresMs !== null ? new Date(expiresMs).toISOString() : null,
      scope: val(initialRow, 'oauthScope') || null,
    };
  }

  const flightKey = rowId != null
    ? `${rowOrgId}:id:${rowId}`
    : `${rowOrgId}:key:${rowConnectorKey || refStr.toLowerCase()}`;
  const existingFlight = flightMap.get(flightKey);
  if (existingFlight) {
    return existingFlight;
  }

  const flightPromise = (async () => {
    const refreshEnc = val(initialRow, 'oauthRefreshTokenEnc');
    if (!refreshEnc || !String(refreshEnc).trim()) {
      throw failVault('OAUTH_REFRESH_TOKEN_MISSING', 401, 'OAuth2 access token expired and no refresh token is available.');
    }
    const refreshToken = decryptSecretText(refreshEnc, env);
    const secrets = decryptVaultSecrets(val(initialRow, 'encryptedSecretsJson'), env);
    const oauthCfg = sanitizeOauthConfigForStorage(val(initialRow, 'oauthConfigJson')) || {};
    if (!oauthCfg.tokenUrl || !oauthCfg.clientId) {
      throw failVault('OAUTH_CONFIG_INVALID', 400, 'OAuth2 tokenUrl and clientId are required to refresh token.');
    }

    const allowInternal = resolveAllowInternalConnectorHosts({
      allowInternal: deps.allowInternal,
      isRoot: Boolean(deps.isRoot),
      env,
    });
    const isMockFetch = typeof deps.fetchImpl === 'function' && deps.fetchImpl !== globalThis.fetch;
    const skipDnsCheck = isMockFetch && typeof lookupImpl !== 'function' && !deps.enforceDnsInMock;
    const tokenUrl = await assertSafeConnectorUrlAsync(oauthCfg.tokenUrl, {
      connectorType: 'http_api',
      env,
      allowInternal,
      lookupImpl,
      skipDnsCheck,
    });
    if (typeof fetchImpl !== 'function') {
      throw failVault('OAUTH_FETCH_UNAVAILABLE', 503, 'HTTP fetch implementation unavailable for OAuth2 refresh.');
    }

    const formBody = new URLSearchParams();
    formBody.set('grant_type', 'refresh_token');
    formBody.set('refresh_token', refreshToken);
    formBody.set('client_id', String(oauthCfg.clientId));
    if (secrets.clientSecret) {
      formBody.set('client_secret', String(secrets.clientSecret));
    }

    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(10000)
      : undefined;
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody.toString(),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw failVault('OAUTH_REFRESH_FAILED', 502, `OAuth2 token refresh error: ${err?.message || 'request failed'}`);
    }

    const tokenData = await parseTokenEndpointResponse(response);
    if (!response?.ok || !tokenData?.access_token) {
      throw failVault(
        'OAUTH_REFRESH_FAILED',
        502,
        `OAuth2 refresh endpoint returned HTTP ${response?.status || 'unknown'}: ${tokenData?.error_description || tokenData?.error || 'missing access_token'}`,
      );
    }

    const nextAccessToken = String(tokenData.access_token);
    const nextAccessEnc = encryptSecretText(nextAccessToken, env);
    const nextRefreshEnc = tokenData.refresh_token
      ? encryptSecretText(String(tokenData.refresh_token), env)
      : refreshEnc;
    const nextExpiresIn = Number(tokenData.expires_in);
    const nextExpiresAt = Number.isFinite(nextExpiresIn) && nextExpiresIn > 0
      ? new Date(nowMs + nextExpiresIn * 1000)
      : null;
    const nextScope = tokenData.scope ? String(tokenData.scope).trim() : (val(initialRow, 'oauthScope') || null);

    await runVaultDbOp(db, rowOrgId, (transaction) => saveConnectorRowValues(repo, initialRow, rowOrgId, {
      oauthAccessTokenEnc: nextAccessEnc,
      oauthRefreshTokenEnc: nextRefreshEnc,
      oauthTokenExpiresAt: nextExpiresAt,
      oauthScope: nextScope,
    }, transaction));

    return {
      connectorId: rowId ?? refStr,
      connectorKey: val(initialRow, 'connectorKey') || '',
      organizationId: rowOrgId,
      accessToken: nextAccessToken,
      tokenType: tokenData.token_type ? String(tokenData.token_type) : 'Bearer',
      refreshed: true,
      expiresAt: nextExpiresAt ? nextExpiresAt.toISOString() : null,
      scope: nextScope,
    };
  })();

  flightMap.set(flightKey, flightPromise);
  try {
    return await flightPromise;
  } finally {
    if (flightMap.get(flightKey) === flightPromise) {
      flightMap.delete(flightKey);
    }
  }
}

async function resolveVerifiedRoles(db, ctx) {
  const claimed = callerRoles(ctx);
  const userId = val(ctx?.state?.currentUser, 'id');
  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null && /^[1-9]\d*$/.test(String(userId))) {
    const bindings = (await ruRepo.find({ filter: { userId: Number(userId) } })) || [];
    const assigned = new Set(
      bindings
        .filter((r) => val(r, 'userId') == null || Number(val(r, 'userId')) === Number(userId))
        .map((r) => String(val(r, 'roleName') || '').trim())
        .filter(Boolean),
    );
    if (claimed.length > 0) {
      return claimed.filter((r) => assigned.has(r));
    }
    return [...assigned];
  }
  return claimed;
}

async function isVerifiedVaultAdmin(db, verifiedRoles) {
  if (!Array.isArray(verifiedRoles) || verifiedRoles.length === 0) return false;
  if (verifiedRoles.some((r) => ELEVATED_ROLES.has(String(r).toLowerCase()))) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: verifiedRoles } } })) || [];
  return matched.some((role) => {
    const name = val(role, 'name');
    if (name && !verifiedRoles.includes(name)) return false;
    if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function resolveVaultCaller(db, ctx, requestedOrgId = null, { requireOrg = true } = {}) {
  if (!ctx?.state?.currentUser) {
    throw failVault('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const verifiedRoles = await resolveVerifiedRoles(db, ctx);
  const isRoot = verifiedRoles.includes('root');
  const isAdmin = isRoot || (await isVerifiedVaultAdmin(db, verifiedRoles));

  if (isRoot) {
    const cleanReq = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (cleanReq) {
      if (!ORG_ID_RE.test(cleanReq)) {
        throw failVault('VAULT_ORG_INVALID', 400, 'Invalid organizationId.');
      }
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: cleanReq };
    }
    try {
      const actor = await resolveNativeActor(db, ctx.state.currentUser);
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: actor.organizationId };
    } catch {
      if (requireOrg) {
        throw failVault('VAULT_ORG_REQUIRED', 400, 'organizationId is required for root vault operations.');
      }
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: null };
    }
  }

  const actor = await resolveNativeActor(db, ctx.state.currentUser);
  if (
    requestedOrgId !== undefined
    && requestedOrgId !== null
    && String(requestedOrgId).trim() !== ''
    && String(requestedOrgId).trim() !== actor.organizationId
  ) {
    throw failVault('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization vault access is forbidden.');
  }

  return {
    isRoot: false,
    isAdmin,
    verifiedRoles,
    organizationId: actor.organizationId,
  };
}

function buildConnectorAuthHeaders(authType, secrets = {}) {
  const headers = {};
  if (!secrets || typeof secrets !== 'object') return headers;
  if (authType === 'bearer' || authType === 'oauth2') {
    const token = String(secrets.accessToken || secrets.token || secrets.bearerToken || '').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (authType === 'api_key') {
    const apiKey = String(secrets.apiKey || secrets.key || secrets.token || '').trim();
    const headerName = String(secrets.headerName || 'X-API-Key').trim();
    if (apiKey && /^[A-Za-z0-9-]+$/.test(headerName)) {
      headers[headerName] = apiKey;
    }
  } else if (authType === 'basic') {
    const username = String(secrets.username || '');
    const password = String(secrets.password || '');
    if (username || password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    }
  }
  return headers;
}

function defaultTcpProbe(host, port, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      resolve({ ok, statusCode: ok ? 200 : null, latencyMs: Date.now() - started, message });
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      finish(true, `TCP connection to ${host}:${port} succeeded`);
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish(false, `TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`);
    });
    socket.once('error', (err) => {
      socket.destroy();
      finish(false, err?.message || 'TCP connection error');
    });
  });
}

async function probeConnectorEndpoint(
  { connectorType, baseUrl, authType = 'none', secrets = {} },
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    tcpProbeImpl = defaultTcpProbe,
    allowInternal,
    lookupImpl,
    enforceDnsInMock = false,
  } = {},
) {
  const isMockTransport = fetchImpl !== globalThis.fetch || tcpProbeImpl !== defaultTcpProbe;
  const skipDnsCheck = isMockTransport && typeof lookupImpl !== 'function' && !enforceDnsInMock;
  const validatedUrl = await assertSafeConnectorUrlAsync(baseUrl, {
    connectorType,
    env,
    allowInternal,
    lookupImpl,
    skipDnsCheck,
  });
  const parsed = new URL(validatedUrl);
  const started = Date.now();

  if (connectorType === 'mqtt' || connectorType === 'smtp_notify') {
    if (parsed.protocol === 'mqtt:' || parsed.protocol === 'mqtts:' || parsed.protocol === 'smtp:' || parsed.protocol === 'smtps:') {
      const defaultPort = parsed.protocol === 'mqtt:' ? 1883 : (parsed.protocol === 'mqtts:' ? 8883 : (parsed.protocol === 'smtps:' ? 465 : 25));
      const port = Number(parsed.port) || defaultPort;
      return tcpProbeImpl(parsed.hostname.replace(/^\[|\]$/g, ''), port, TEST_TIMEOUT_MS);
    }
  }

  if (typeof fetchImpl !== 'function') {
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, message: 'HTTP fetch unavailable' };
  }

  let targetUrl = validatedUrl;
  let method = 'HEAD';
  if (connectorType === 'orion_ld') {
    method = 'GET';
    if (parsed.pathname === '/' || !parsed.pathname) {
      targetUrl = `${parsed.origin}/version`;
    }
  } else if (connectorType === 'n8n') {
    method = 'GET';
    if (parsed.pathname === '/' || !parsed.pathname) {
      targetUrl = `${parsed.origin}/healthz`;
    }
  }

  const headers = buildConnectorAuthHeaders(authType, secrets);
  const doFetch = async (httpMethod) => {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(TEST_TIMEOUT_MS)
      : undefined;
    const response = await fetchImpl(targetUrl, {
      method: httpMethod,
      redirect: 'error',
      headers,
      ...(signal ? { signal } : {}),
    });
    try { await response?.body?.cancel?.(); } catch {}
    return response;
  };

  try {
    let response = await doFetch(method);
    if (method === 'HEAD' && response?.status === 405) {
      response = await doFetch('GET');
    }
    const statusCode = Number(response?.status) || null;
    const ok = Boolean(response?.ok);
    return {
      ok,
      statusCode,
      latencyMs: Date.now() - started,
      message: ok ? `Endpoint reachable (HTTP ${statusCode})` : `Endpoint returned HTTP ${statusCode || 'unknown'}`,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - started,
      message: err?.message || 'Connection test failed',
    };
  }
}

async function findConnectorInOrg(repo, organizationId, params, transaction, options = {}) {
  const txOpt = transaction ? { transaction } : {};
  const lockOpt = options.lock && transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {};
  const id = Number(params.id ?? params.filterByTk);
  const connectorKey = typeof params.connectorKey === 'string' ? params.connectorKey.trim().toLowerCase() : '';
  if (Number.isInteger(id) && id > 0) {
    const row = await repo.findOne({ filter: { id, organizationId }, ...txOpt, ...lockOpt });
    return row && val(row, 'organizationId') === organizationId ? row : null;
  }
  if (connectorKey) {
    const row = await repo.findOne({ filter: { organizationId, connectorKey }, ...txOpt, ...lockOpt });
    return row && val(row, 'organizationId') === organizationId ? row : null;
  }
  return null;
}

function registerConnectorVaultDirectGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') return next();
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');
    if (baseResource === 'latticeConnectors') {
      throw failVault('VAULT_DIRECT_CRUD_FORBIDDEN', 403, 'Direct access to latticeConnectors is forbidden; use dxosVault.');
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && String(ctx.action?.params?.values?.collection || '') === 'latticeConnectors'
    ) {
      throw failVault('VAULT_DIRECT_CRUD_FORBIDDEN', 403, 'Direct chart access to latticeConnectors is forbidden.');
    }
    return next();
  }, { tag: 'latticeVaultDirectGuard', after: 'acl' });
}

function registerConnectorVault(app, { env = process.env, fetchImpl, tcpProbeImpl, lookupImpl, enforceDnsInMock = false } = {}) {
  const db = app.db;
  registerConnectorVaultDirectGuard(app);

  app.resourceManager.define({
    name: 'dxosVault',
    actions: {
      list: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: false });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to list connectors.');
        }
        const repo = getRepo(db, 'latticeConnectors');
        if (!repo || typeof repo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, items: [] };
          if (next) return next();
          return;
        }
        const filter = {};
        if (scope.organizationId) filter.organizationId = scope.organizationId;
        if (typeof params.connectorType === 'string' && VALID_CONNECTOR_TYPES.has(params.connectorType.trim())) {
          filter.connectorType = params.connectorType.trim();
        }
        if (params.active !== undefined) {
          filter.active = params.active === true || params.active === 'true';
        }
        const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
        const rows = (await runVaultDbOp(db, scope.organizationId, (transaction) => repo.find({
          filter,
          sort: ['id'],
          limit,
          ...(transaction ? { transaction } : {}),
        }))) || [];
        const items = rows
          .filter((r) => !scope.organizationId || val(r, 'organizationId') === scope.organizationId)
          .map((r) => serializeConnector(r, { env }));
        ctx.body = { organizationId: scope.organizationId, items };
        if (next) return next();
      },

      save: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to save connectors.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        if (!repo || typeof repo.create !== 'function') {
          throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
        }

        const connectorKey = typeof params.connectorKey === 'string' ? params.connectorKey.trim().toLowerCase() : '';
        if (!CONNECTOR_KEY_RE.test(connectorKey)) {
          throw failVault('CONNECTOR_KEY_INVALID', 400, 'connectorKey must be a valid lowercase slug (2..64 chars).');
        }
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > 120) {
          throw failVault('CONNECTOR_NAME_REQUIRED', 400, 'Connector name is required (1..120 chars).');
        }
        const connectorType = String(params.connectorType || (APP_CATALOG_BY_TYPE.get(String(params.appType || '').trim().toLowerCase())?.connectorType) || 'webhook').trim().toLowerCase();
        if (!VALID_CONNECTOR_TYPES.has(connectorType)) {
          throw failVault('CONNECTOR_TYPE_INVALID', 400, `Unsupported connectorType: ${connectorType}`);
        }
        const rawAppType = params.appType !== undefined ? String(params.appType || '').trim().toLowerCase() : undefined;
        const catalogEntry = rawAppType ? APP_CATALOG_BY_TYPE.get(rawAppType) : null;
        const authType = String(params.authType || catalogEntry?.defaultAuthType || 'none').trim().toLowerCase();
        if (!VALID_AUTH_TYPES.has(authType)) {
          throw failVault('CONNECTOR_AUTH_TYPE_INVALID', 400, `Unsupported authType: ${authType}`);
        }

        const allowInternal = resolveAllowInternalConnectorHosts({ isRoot: scope.isRoot, env });
        const rawBaseUrl = params.baseUrl !== undefined && params.baseUrl !== null && String(params.baseUrl).trim() !== ''
          ? String(params.baseUrl)
          : (catalogEntry?.defaultBaseUrl || '');
        let baseUrl = null;
        if (rawBaseUrl) {
          baseUrl = assertSafeConnectorUrl(rawBaseUrl, { connectorType, env, allowInternal });
        } else if (connectorType !== 'smtp_notify' && connectorType !== 'email_smtp') {
          throw failVault('CONNECTOR_URL_UNSAFE', 400, 'baseUrl is required for this connectorType.');
        }

        let saved;
        let fallbackValues;
        await runVaultDbOp(db, scope.organizationId, async (transaction) => {
          const existing = await findConnectorInOrg(repo, scope.organizationId, {
            id: params.id ?? params.filterByTk,
            connectorKey,
          }, transaction);

          let encryptedSecretsJson = existing ? val(existing, 'encryptedSecretsJson') || null : null;
          let secretVersion = existing ? (Number(val(existing, 'secretVersion')) || 1) : 1;
          if (params.secrets !== undefined) {
            const cleanSecrets = sanitizeSecretsObject(params.secrets);
            encryptedSecretsJson = Object.keys(cleanSecrets).length > 0
              ? encryptVaultSecrets(cleanSecrets, env)
              : null;
            if (existing) secretVersion += 1;
          }

          fallbackValues = {
            organizationId: scope.organizationId,
            connectorKey,
            name,
            connectorType,
            appType: rawAppType !== undefined ? (rawAppType || null) : (existing ? val(existing, 'appType') || null : null),
            capabilitiesJson: params.capabilitiesJson !== undefined
              ? sanitizeJsonValue(params.capabilitiesJson)
              : (existing ? val(existing, 'capabilitiesJson') || null : (catalogEntry?.capabilities ? [...catalogEntry.capabilities] : null)),
            oauthConfigJson: params.oauthConfigJson !== undefined
              ? sanitizeOauthConfigForStorage(params.oauthConfigJson)
              : (existing ? val(existing, 'oauthConfigJson') || null : null),
            n8nCredentialId: params.n8nCredentialId !== undefined
              ? (params.n8nCredentialId ? String(params.n8nCredentialId).trim().slice(0, 128) : null)
              : (existing ? val(existing, 'n8nCredentialId') || null : null),
            baseUrl,
            authType,
            encryptedSecretsJson,
            secretVersion,
            active: params.active === undefined ? (existing ? val(existing, 'active') !== false : true) : Boolean(params.active),
          };

          saved = await saveConnectorRowValues(repo, existing, scope.organizationId, fallbackValues, transaction);
        });

        ctx.body = serializeConnector(saved || fallbackValues, { env });
        if (next) return next();
      },

      rotateSecret: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to rotate secrets.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        if (!repo) throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');

        const updated = await runVaultDbOp(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const row = await findConnectorInOrg(repo, scope.organizationId, params, transaction);
          if (!row) throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found.');

          const cleanSecrets = sanitizeSecretsObject(params.secrets);
          if (Object.keys(cleanSecrets).length === 0) {
            throw failVault('VAULT_SECRETS_REQUIRED', 400, 'Non-empty secrets object is required to rotate secret.');
          }
          const encryptedSecretsJson = encryptVaultSecrets(cleanSecrets, env);
          const nextVersion = (Number(val(row, 'secretVersion')) || 1) + 1;
          const patch = { encryptedSecretsJson, secretVersion: nextVersion };

          if (typeof row.update === 'function') {
            return transaction ? row.update(patch, { transaction }) : row.update(patch);
          }
          if (typeof repo.update === 'function') {
            const res = await repo.update({
              filterByTk: val(row, 'id'),
              filter: { organizationId: scope.organizationId },
              values: patch,
              ...txOpt,
            });
            if (Array.isArray(res) && res[0]) return res[0];
          }
          return row;
        });

        ctx.body = serializeConnector(updated, { env });
        if (next) return next();
      },

      delete: async (ctx, next) => {
        if (ctx.method && !['POST', 'DELETE'].includes(ctx.method)) ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to delete connectors.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        if (!repo) throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');

        const deleted = await runVaultDbOp(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const row = await findConnectorInOrg(repo, scope.organizationId, params, transaction);
          if (!row) throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found.');

          const id = val(row, 'id');
          const connectorKey = val(row, 'connectorKey');
          if (typeof repo.destroy === 'function') {
            await repo.destroy({ filter: { id, organizationId: scope.organizationId }, ...txOpt });
          } else if (typeof row.destroy === 'function') {
            await (transaction ? row.destroy({ transaction }) : row.destroy());
          }
          return { deleted: true, id, connectorKey };
        });

        ctx.body = deleted;
        if (next) return next();
      },

      testConnection: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to test connectors.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        const row = repo
          ? await runVaultDbOp(db, scope.organizationId, (transaction) => findConnectorInOrg(repo, scope.organizationId, params, transaction))
          : null;
        if ((params.id != null || params.filterByTk != null || params.connectorKey) && !row) {
          throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found.');
        }

        const connectorType = row
          ? (val(row, 'connectorType') || 'webhook')
          : String(params.connectorType || 'webhook').trim().toLowerCase();
        const baseUrl = row ? val(row, 'baseUrl') : params.baseUrl;
        const authType = row ? (val(row, 'authType') || 'none') : String(params.authType || 'none').trim().toLowerCase();
        const secrets = row
          ? decryptVaultSecrets(val(row, 'encryptedSecretsJson'), env)
          : sanitizeSecretsObject(params.secrets);

        // Outbound probe runs strictly outside any DB transaction.
        const allowInternal = resolveAllowInternalConnectorHosts({ isRoot: scope.isRoot, env });
        const result = await probeConnectorEndpoint(
          { connectorType, baseUrl, authType, secrets },
          { env, fetchImpl, tcpProbeImpl, allowInternal, lookupImpl, enforceDnsInMock },
        );

        const testedAt = new Date();
        const testStatus = result.ok ? 'ok' : (result.statusCode ? `http_${result.statusCode}` : 'error');
        if (row) {
          const patch = { lastTestedAt: testedAt, lastTestStatus: testStatus };
          await runVaultDbOp(db, scope.organizationId, async (transaction) => {
            const txOpt = transaction ? { transaction } : {};
            if (typeof row.update === 'function') {
              await (transaction ? row.update(patch, { transaction }) : row.update(patch));
            } else if (typeof repo?.update === 'function') {
              await repo.update({
                filterByTk: val(row, 'id'),
                filter: { organizationId: scope.organizationId },
                values: patch,
                ...txOpt,
              });
            }
          });
        }

        ctx.body = {
          ...result,
          connectorKey: row ? val(row, 'connectorKey') : (params.connectorKey || null),
          connectorType,
          lastTestedAt: testedAt.toISOString(),
          lastTestStatus: testStatus,
        };
        if (next) return next();
      },

      appCatalog: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: false });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to view app catalog.');
        }
        ctx.body = {
          organizationId: scope.organizationId,
          items: APP_CONNECTOR_CATALOG.map((entry) => ({ ...entry })),
        };
        if (next) return next();
      },

      oauthStart: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to start OAuth2 flow.');
        }
        ctx.body = await oauthStart(
          db,
          { ...params, organizationId: scope.organizationId },
          { env, isRoot: scope.isRoot },
        );
        if (next) return next();
      },

      oauthCallback: async (ctx, next) => {
        if (ctx.method && !['GET', 'POST'].includes(ctx.method)) ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to complete OAuth2 flow.');
        }
        ctx.body = await oauthCallback(
          db,
          { ...params, organizationId: scope.organizationId },
          { env, fetchImpl, lookupImpl, enforceDnsInMock, isRoot: scope.isRoot },
        );
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.(
    'dxosVault',
    ['list', 'save', 'rotateSecret', 'delete', 'testConnection', 'appCatalog', 'oauthStart', 'oauthCallback'],
    'loggedIn',
  );

  return {
    APP_CONNECTOR_CATALOG,
    resolveConnectorSecrets: (arg1, arg2, arg3, arg4) => {
      if (arg1 && typeof arg1.getRepository === 'function') {
        return resolveConnectorSecrets(arg1, arg2, arg3, { env, ...(arg4 || {}) });
      }
      return resolveConnectorSecrets(db, arg1, arg2, { env, ...(arg3 || {}) });
    },
    oauthStart: (params, opts = {}) => oauthStart(db, params, { env, ...opts }),
    oauthCallback: (params, opts = {}) => oauthCallback(db, params, { env, fetchImpl, lookupImpl, ...opts }),
    getFreshConnectorToken: (connectorId, deps = {}) =>
      getFreshConnectorToken(db, connectorId, { env, fetchImpl, lookupImpl, ...deps }),
    assertSafeConnectorUrl: (rawUrl, opts = {}) =>
      assertSafeConnectorUrl(rawUrl, { env, ...opts }),
    assertSafeConnectorUrlAsync: (rawUrl, opts = {}) =>
      assertSafeConnectorUrlAsync(rawUrl, { env, lookupImpl, ...opts }),
    buildConnectorAuthHeaders,
    encryptVaultSecrets: (secretsObj) => encryptVaultSecrets(secretsObj, env),
    decryptVaultSecrets: (ciphertext) => decryptVaultSecrets(ciphertext, env),
  };
}

module.exports = {
  VALID_CONNECTOR_TYPES,
  VALID_AUTH_TYPES,
  DEFAULT_INTERNAL_SERVICE_HOSTS,
  INTERNAL_CONNECTOR_HOST_ALLOWLIST,
  APP_CONNECTOR_CATALOG,
  resolveVaultMasterKey,
  resolveAllowInternalConnectorHosts,
  resolveInternalServiceHosts,
  isInternalAllowlistedHost,
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedIpAddress,
  isNonCanonicalNumericHost,
  isBlockedMetadataHost,
  encryptSecretText,
  decryptSecretText,
  encryptVaultSecrets,
  decryptVaultSecrets,
  buildConnectorAuthHeaders,
  assertSafeConnectorUrl,
  assertSafeConnectorUrlAsync,
  serializeConnector,
  resolveConnectorSecrets,
  oauthStart,
  oauthCallback,
  getFreshConnectorToken,
  defaultTcpProbe,
  probeConnectorEndpoint,
  registerConnectorVault,
};

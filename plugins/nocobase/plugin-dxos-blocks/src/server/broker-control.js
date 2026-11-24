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
const path = require('node:path');
const dns = require('node:dns');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { ingestTelemetryPoint, ingestOrDeduplicateAlarm } = require('./alarm-engine');
const { emitDomainEventSafely, resolvePublishDomainEvent } = require('./domain-events');
const { runWithOptionalRls } = require('./blocks-rls');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const DEVICE_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const SUB_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const ENTITY_TYPE_RE = /^[a-zA-Z0-9_.:/-]{1,128}$/;
const ATTR_NAME_RE = /^[a-zA-Z0-9_.:-]{1,128}$/;
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const ENTITY_ID_RE = /^[a-zA-Z0-9:._-]{1,255}$/;
const MIN_EDGE_TOKEN_LENGTH = 16;
const MAX_MQTT_PACKET_BYTES = 65536;
const MAX_CONNACK_RX_BYTES = 1024;
const DYNSEC_CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
const DEFAULT_ORION_CALLBACK_URL = 'http://nocobase/api/dxosBroker:orionNotify';

const BROKER_READ_ROLES = new Set([
  'root',
  'admin',
  'ldx_admin',
  'ldx_manager',
  'ldx_operator',
  'ldx_dispatcher',
  'ldx_director',
]);
const BROKER_WRITE_ROLES = new Set([
  'root',
  'admin',
  'ldx_admin',
  'ldx_manager',
  'ldx_operator',
  'ldx_dispatcher',
]);

const DEFAULT_ALLOWED_ORION_HOSTS = new Set([
  'orion-ld',
  'localhost',
  '127.0.0.1',
  '::1',
]);

const DEFAULT_ALLOWED_CALLBACK_HOSTS = new Set([
  'nocobase',
  'localhost',
  '127.0.0.1',
  '::1',
]);

const NON_TELEMETRY_NGSI_ATTRS = new Set([
  'id',
  'type',
  '@context',
  'createdAt',
  'modifiedAt',
  'observedAt',
  'businessId',
  'organizationId',
  'name',
  'status',
  'active',
  'source',
  'sourceEventId',
  'belongsToDepartment',
  'locatedAt',
]);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failBroker(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx?.action?.params || {};
  const b = ctx?.request?.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
    ? ctx.request.body
    : {};
  const q = ctx?.query && typeof ctx.query === 'object' && !Array.isArray(ctx.query)
    ? ctx.query
    : {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values)
    ? p.values
    : {};
  return { ...q, ...b, ...p, ...v };
}

function readHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const v = ctx.get(name);
    if (typeof v === 'string' && v) return v;
  }
  const lower = String(name || '').toLowerCase();
  for (const hdrs of [ctx?.headers, ctx?.request?.headers]) {
    if (!hdrs || typeof hdrs !== 'object') continue;
    for (const [k, v] of Object.entries(hdrs)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v) return v;
    }
  }
  return '';
}

function toIsoOrNull(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString() : null;
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? new Date(ts).toISOString() : String(raw);
}

// --- Pure node:net MQTT 3.1.1 Control Client ---

function encodeMqttString(value) {
  const text = String(value ?? '');
  const utf8 = Buffer.from(text, 'utf8');
  if (utf8.length > 65535) {
    throw failBroker('MQTT_STRING_TOO_LONG', 400, 'Chuỗi MQTT vượt quá giới hạn 65535 byte.');
  }
  const out = Buffer.allocUnsafe(2 + utf8.length);
  out.writeUInt16BE(utf8.length, 0);
  utf8.copy(out, 2);
  return out;
}

function encodeRemainingLength(length) {
  if (!Number.isInteger(length) || length < 0 || length > 268435455) {
    throw failBroker('MQTT_REMAINING_LENGTH_INVALID', 400, 'Độ dài gói MQTT vượt quá giới hạn hợp lệ.');
  }
  const bytes = [];
  let x = length;
  do {
    let digit = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) digit |= 0x80;
    bytes.push(digit);
  } while (x > 0);
  return Buffer.from(bytes);
}

function buildConnectPacket({
  clientId = '',
  username = '',
  password = '',
  keepAliveSec = 30,
  cleanSession = true,
} = {}) {
  const cleanClientId = String(clientId || `ldx-ctrl-${randomBytes(4).toString('hex')}`).trim();
  if (!cleanClientId) {
    throw failBroker('MQTT_CLIENT_ID_INVALID', 400, 'clientId MQTT không hợp lệ.');
  }
  const hasUsername = typeof username === 'string' && username.length > 0;
  const hasPassword = typeof password === 'string' && password.length > 0;
  if (hasPassword && !hasUsername) {
    throw failBroker('MQTT_PASSWORD_REQUIRES_USERNAME', 400, 'MQTT 3.1.1 yêu cầu username khi có password.');
  }

  const ka = Number.isInteger(keepAliveSec) && keepAliveSec >= 0 && keepAliveSec <= 65535 ? keepAliveSec : 30;
  const flags = (cleanSession !== false ? 0x02 : 0x00)
    | (hasUsername ? 0x80 : 0x00)
    | (hasPassword ? 0x40 : 0x00);

  const varHeader = Buffer.concat([
    encodeMqttString('MQTT'),
    Buffer.from([0x04, flags, (ka >> 8) & 0xff, ka & 0xff]),
  ]);

  const payloadParts = [encodeMqttString(cleanClientId)];
  if (hasUsername) payloadParts.push(encodeMqttString(username));
  if (hasPassword) payloadParts.push(encodeMqttString(password));
  const payloadBuf = Buffer.concat(payloadParts);

  const remLen = encodeRemainingLength(varHeader.length + payloadBuf.length);
  const packet = Buffer.concat([Buffer.from([0x10]), remLen, varHeader, payloadBuf]);
  if (packet.length > MAX_MQTT_PACKET_BYTES) {
    throw failBroker('MQTT_PACKET_TOO_LARGE', 400, 'Gói MQTT CONNECT vượt quá kích thước cho phép.');
  }
  return packet;
}

function buildPublishPacket({
  topic,
  payload,
  qos = 0,
  retain = false,
  dup = false,
  packetId = 1,
} = {}) {
  if (typeof topic !== 'string' || !topic || /[+#\0]/.test(topic)) {
    throw failBroker('MQTT_TOPIC_INVALID', 400, 'Topic MQTT PUBLISH không hợp lệ.');
  }
  const cleanQos = qos === 1 ? 1 : 0;
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}), 'utf8');
  const varHeader = cleanQos > 0
    ? Buffer.concat([encodeMqttString(topic), Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff])])
    : encodeMqttString(topic);
  const remLen = encodeRemainingLength(varHeader.length + payloadBuf.length);
  const totalLen = 1 + remLen.length + varHeader.length + payloadBuf.length;
  if (totalLen > MAX_MQTT_PACKET_BYTES) {
    throw failBroker('MQTT_PACKET_TOO_LARGE', 400, 'Gói MQTT PUBLISH vượt quá 65536 byte.');
  }
  const headerByte = 0x30 | (dup ? 0x08 : 0) | ((cleanQos & 0x03) << 1) | (retain ? 0x01 : 0);
  return Buffer.concat([Buffer.from([headerByte]), remLen, varHeader, payloadBuf]);
}

function buildDisconnectPacket() {
  return Buffer.from([0xe0, 0x00]);
}

function publishMqttControl({
  host,
  port = 1883,
  username = '',
  password = '',
  clientId = '',
  topic = DYNSEC_CONTROL_TOPIC,
  payload,
  timeoutMs = 4000,
  netImpl = net,
} = {}) {
  const cleanHost = typeof host === 'string' ? host.trim() : '';
  if (!cleanHost || /[\s\0]/.test(cleanHost)) {
    return Promise.reject(failBroker('MQTT_HOST_INVALID', 400, 'Host MQTT không hợp lệ.'));
  }
  const cleanPort = Number(port);
  if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
    return Promise.reject(failBroker('MQTT_PORT_INVALID', 400, 'Cổng MQTT không hợp lệ.'));
  }
  const safeTimeoutMs = Math.max(100, Math.min(30000, Number(timeoutMs) || 4000));

  let connectPkt;
  let publishPkt;
  let disconnectPkt;
  try {
    connectPkt = buildConnectPacket({ clientId, username, password, cleanSession: true });
    publishPkt = buildPublishPacket({ topic, payload, qos: 0, retain: false });
    disconnectPkt = buildDisconnectPacket();
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let connackHandled = false;
    let rxBytes = 0;
    const rxChunks = [];
    let socket = null;

    const cleanup = (destroySocket = true) => {
      clearTimeout(timer);
      if (destroySocket && socket && typeof socket.destroy === 'function' && !socket.destroyed) {
        try {
          socket.destroy();
        } catch {}
      }
    };

    const finish = (err, result, { keepSocketGraceful = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup(!keepSocketGraceful);
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(failBroker('MQTT_TIMEOUT', 504, `Kết nối MQTT tới ${cleanHost}:${cleanPort} quá thời gian.`));
    }, safeTimeoutMs);
    timer.unref?.();

    try {
      socket = netImpl.createConnection({ host: cleanHost, port: cleanPort });
    } catch (err) {
      finish(failBroker('MQTT_CONNECT_FAILED', 502, err?.message || 'Không mở được kết nối TCP MQTT.'));
      return;
    }

    socket.setTimeout?.(safeTimeoutMs, () => {
      finish(failBroker('MQTT_TIMEOUT', 504, `Socket MQTT ${cleanHost}:${cleanPort} quá thời gian.`));
    });

    socket.on('error', (err) => {
      finish(failBroker('MQTT_SOCKET_ERROR', 502, err?.message || 'Lỗi kết nối MQTT broker.'));
    });

    socket.on('connect', () => {
      if (settled) return;
      socket.write(connectPkt);
    });

    socket.on('data', (chunk) => {
      if (settled || connackHandled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rxBytes += buf.length;
      if (rxBytes > MAX_CONNACK_RX_BYTES) {
        finish(failBroker('MQTT_PROTOCOL_ERROR', 502, 'Phản hồi CONNACK vượt quá giới hạn bộ đệm.'));
        return;
      }
      rxChunks.push(buf);
      if (rxBytes < 4) return;

      const joined = Buffer.concat(rxChunks);
      if (joined[0] !== 0x20 || joined[1] !== 0x02) {
        finish(failBroker('MQTT_PROTOCOL_ERROR', 502, 'Gói phản hồi không phải MQTT CONNACK hợp lệ.'));
        return;
      }
      const returnCode = joined[3];
      if (returnCode !== 0x00) {
        const err = failBroker('MQTT_CONNACK_REJECTED', 502, `MQTT broker từ chối kết nối (CONNACK ${returnCode}).`);
        err.returnCode = returnCode;
        finish(err);
        return;
      }

      connackHandled = true;
      const outbound = Buffer.concat([publishPkt, disconnectPkt]);
      socket.write(outbound, () => {
        socket.end(() => {
          try {
            socket.unref?.();
          } catch {}
          finish(null, {
            published: true,
            topic,
            bytesSent: connectPkt.length + outbound.length,
          }, { keepSocketGraceful: true });
        });
      });
    });

    socket.on('close', () => {
      if (!settled) {
        finish(failBroker('MQTT_CLOSED_BEFORE_CONNACK', 502, 'Broker đóng kết nối trước khi gửi CONNACK.'));
      }
    });
  });
}

// --- SSRF Protection for Orion-LD & Webhook Callbacks ---

function extractRawAuthorityHost(trimmedUrl) {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(String(trimmedUrl || ''));
  if (!match) return '';
  let authority = match[1];
  const atIdx = authority.lastIndexOf('@');
  if (atIdx >= 0) authority = authority.slice(atIdx + 1);
  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    return closeIdx >= 0 ? authority.slice(1, closeIdx).toLowerCase() : authority.toLowerCase();
  }
  const colonIdx = authority.indexOf(':');
  return (colonIdx >= 0 ? authority.slice(0, colonIdx) : authority).toLowerCase().replace(/\.+$/, '');
}

function isObfuscatedNumericIp(host) {
  if (!host || host.includes(':')) return false;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  const parts = host.split('.');
  if (parts.length > 1 && parts.every((p) => /^(?:\d+|0x[0-9a-f]+)$/i.test(p))) {
    if (parts.length !== 4) return true;
    if (parts.some((p) => /^0x/i.test(p) || /^0\d+$/.test(p))) return true;
  }
  return false;
}

function parseIpv4Octets(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p))) return null;
  const octets = parts.map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;
  return octets;
}

function isBlockedIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
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

function expandIpv6Groups(rawHost) {
  let host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIdx = host.indexOf('%');
  if (zoneIdx >= 0) host = host.slice(0, zoneIdx);
  if (!host.includes(':')) return null;

  const lastColon = host.lastIndexOf(':');
  const tail = host.slice(lastColon + 1);
  let tailGroups = null;
  if (tail.includes('.')) {
    const octets = parseIpv4Octets(tail);
    if (!octets) return null;
    tailGroups = [((octets[0] << 8) | octets[1]) >>> 0, ((octets[2] << 8) | octets[3]) >>> 0];
    host = host.slice(0, lastColon);
    if (host.endsWith(':')) host = `${host}:`;
  }

  const parts = host.split('::');
  if (parts.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const out = [];
    for (const token of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      out.push(parseInt(token, 16));
    }
    return out;
  };

  const targetGroups = tailGroups ? 6 : 8;
  if (parts.length === 1) {
    const groups = parseSide(parts[0]);
    if (!groups || groups.length !== targetGroups) return null;
    return tailGroups ? [...groups, ...tailGroups] : groups;
  }

  const left = parseSide(parts[0]);
  const right = parseSide(parts[1]);
  if (!left || !right) return null;
  const missing = targetGroups - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right, ...(tailGroups || [])];
}

function groupsToIpv4(hi, lo) {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpv6(bareHost, { allowPublicMapped = false } = {}) {
  if (!String(bareHost || '').includes(':')) return false;
  const groups = expandIpv6Groups(bareHost);
  if (!groups) return true;
  const isZeroPrefix5 = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;
  if (isZeroPrefix5 && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
    return true;
  }
  if (isZeroPrefix5 && groups[5] === 0) {
    return isBlockedIpv4(groupsToIpv4(groups[6], groups[7]));
  }
  if (isZeroPrefix5 && groups[5] === 0xffff) {
    const mappedIpv4 = groupsToIpv4(groups[6], groups[7]);
    if (!allowPublicMapped) return true;
    return isBlockedIpv4(mappedIpv4);
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0xffff && groups[5] === 0) {
    return isBlockedIpv4(groupsToIpv4(groups[6], groups[7]));
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return isBlockedIpv4(groupsToIpv4(groups[6], groups[7]));
  }
  if (groups[0] === 0x2002) {
    return isBlockedIpv4(groupsToIpv4(groups[1], groups[2]));
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xffc0) === 0xfec0) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true;
  return false;
}

function isBlockedResolvedIp(addr) {
  const clean = String(addr || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIdx = clean.indexOf('%');
  const noZone = zoneIdx >= 0 ? clean.slice(0, zoneIdx) : clean;
  if (!noZone || net.isIP(noZone) === 0) return true;
  if (noZone.includes(':')) return isBlockedIpv6(noZone, { allowPublicMapped: true });
  return isBlockedIpv4(noZone);
}

function parseExtraAllowHosts(env, extraEnvKey) {
  return String(env?.[extraEnvKey] || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function validateBrokerUrl(rawUrl, {
  allowHosts = DEFAULT_ALLOWED_ORION_HOSTS,
  extraEnvKey = 'DX_ORION_HOST_ALLOWLIST',
  env = process.env,
  errorCode = 'BROKER_URL_FORBIDDEN',
  preservePath = false,
} = {}) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    throw failBroker(errorCode, 400, 'URL broker vượt quá độ dài cho phép.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw failBroker(errorCode, 400, 'URL broker không hợp lệ.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw failBroker(errorCode, 400, 'URL broker chỉ chấp nhận HTTP/HTTPS và không được chứa thông tin xác thực.');
  }
  const rawHost = extractRawAuthorityHost(trimmed);
  if (isObfuscatedNumericIp(rawHost)) {
    throw failBroker(errorCode, 400, `Host broker "${rawHost}" bị chặn bởi chính sách chống SSRF.`);
  }
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare) {
    throw failBroker(errorCode, 400, 'Hostname broker không hợp lệ.');
  }
  const extraHosts = parseExtraAllowHosts(env, extraEnvKey);
  if (allowHosts.has(bare) || extraHosts.includes(bare)) {
    return preservePath ? parsed.toString() : parsed.origin;
  }
  if (
    bare.endsWith('.localhost')
    || bare.endsWith('.local')
    || bare.endsWith('.internal')
    || bare === 'metadata.google.internal'
    || bare === 'metadata.azure.com'
    || /^\d+$/.test(bare)
    || /^0x[0-9a-f]+$/i.test(bare)
    || isBlockedIpv6(bare)
    || isBlockedIpv4(bare)
    || (!bare.includes('.') && !bare.includes(':'))
  ) {
    throw failBroker(errorCode, 400, `Host broker "${bare}" bị chặn bởi chính sách chống SSRF.`);
  }
  return preservePath ? parsed.toString() : parsed.origin;
}

async function resolveDnsRecords(hostname, lookupImpl) {
  if (lookupImpl.length >= 3) {
    return new Promise((resolve, reject) => {
      lookupImpl(hostname, { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
  }
  return lookupImpl(hostname, { all: true });
}

async function assertSafeBrokerDns(validatedUrl, {
  allowHosts = DEFAULT_ALLOWED_ORION_HOSTS,
  extraEnvKey = 'DX_ORION_HOST_ALLOWLIST',
  env = process.env,
  errorCode = 'BROKER_URL_FORBIDDEN',
  lookupImpl = dns.promises.lookup,
} = {}) {
  if (!validatedUrl) return null;
  const parsed = new URL(validatedUrl);
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const extraHosts = parseExtraAllowHosts(env, extraEnvKey);
  if (allowHosts.has(bare) || extraHosts.includes(bare) || net.isIP(bare) !== 0) {
    return validatedUrl;
  }
  if (typeof lookupImpl !== 'function') {
    throw failBroker(errorCode, 400, 'DNS lookup validator không khả dụng.');
  }
  let records;
  try {
    records = await resolveDnsRecords(bare, lookupImpl);
  } catch {
    throw failBroker(errorCode, 400, `Không phân giải được DNS an toàn cho host broker "${bare}".`);
  }
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  const addresses = list
    .map((item) => (typeof item === 'string' ? item : item?.address))
    .map((addr) => String(addr || '').trim())
    .filter(Boolean);
  if (addresses.length === 0) {
    throw failBroker(errorCode, 400, `Host broker "${bare}" không trả về địa chỉ IP hợp lệ.`);
  }
  for (const addr of addresses) {
    if (isBlockedResolvedIp(addr)) {
      throw failBroker(errorCode, 400, `Host broker "${bare}" phân giải tới địa chỉ nội bộ/bị chặn (${addr}).`);
    }
  }
  return validatedUrl;
}

function validateOrionBrokerUrl(rawUrl, env = process.env) {
  return validateBrokerUrl(rawUrl, {
    allowHosts: DEFAULT_ALLOWED_ORION_HOSTS,
    extraEnvKey: 'DX_ORION_HOST_ALLOWLIST',
    env,
    errorCode: 'BROKER_URL_FORBIDDEN',
    preservePath: false,
  });
}

function validateCallbackUrl(rawUrl, env = process.env) {
  return validateBrokerUrl(rawUrl, {
    allowHosts: DEFAULT_ALLOWED_CALLBACK_HOSTS,
    extraEnvKey: 'DX_ORION_CALLBACK_HOST_ALLOWLIST',
    env,
    errorCode: 'BROKER_CALLBACK_FORBIDDEN',
    preservePath: true,
  });
}

async function validateOrionBrokerUrlAsync(rawUrl, { env = process.env, lookupImpl = dns.promises.lookup } = {}) {
  const safe = validateOrionBrokerUrl(rawUrl, env);
  if (!safe) return null;
  return assertSafeBrokerDns(safe, {
    allowHosts: DEFAULT_ALLOWED_ORION_HOSTS,
    extraEnvKey: 'DX_ORION_HOST_ALLOWLIST',
    env,
    errorCode: 'BROKER_URL_FORBIDDEN',
    lookupImpl,
  });
}

async function validateCallbackUrlAsync(rawUrl, { env = process.env, lookupImpl = dns.promises.lookup } = {}) {
  const safe = validateCallbackUrl(rawUrl, env);
  if (!safe) return null;
  return assertSafeBrokerDns(safe, {
    allowHosts: DEFAULT_ALLOWED_CALLBACK_HOSTS,
    extraEnvKey: 'DX_ORION_CALLBACK_HOST_ALLOWLIST',
    env,
    errorCode: 'BROKER_CALLBACK_FORBIDDEN',
    lookupImpl,
  });
}

// --- Auth & Tenant Helpers ---

function loadFoundationPaasApiKeys() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/paas-api-keys',
        '@latticedx/plugin-lattice-foundation/src/server/paas-api-keys',
        '../../../plugin-lattice-foundation/dist/server/paas-api-keys',
        '../../../plugin-lattice-foundation/src/server/paas-api-keys',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/paas-api-keys',
        '../../../plugin-lattice-foundation/src/server/paas-api-keys',
        '@latticedx/plugin-lattice-foundation/dist/server/paas-api-keys',
        '../../../plugin-lattice-foundation/dist/server/paas-api-keys',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod.assertApiKeyScope === 'function') return mod;
    } catch {
      // Standalone tests or partial plugin setups fall back to local PAT scope verification.
    }
  }
  return null;
}

function assertBrokerApiKeyScope(ctx, requiredScopes) {
  const pat = ctx?.state?.latticeApiKey;
  if (!pat) return true;
  const paasApiKeys = loadFoundationPaasApiKeys();
  if (paasApiKeys) {
    return paasApiKeys.assertApiKeyScope(ctx, requiredScopes);
  }
  const held = new Set(
    Array.isArray(pat.scopes)
      ? pat.scopes.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
      : [],
  );
  const needed = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  if (needed.some((s) => held.has(String(s || '').trim().toLowerCase()))) return true;
  throw failBroker('API_KEY_SCOPE_INSUFFICIENT', 403, `API key lacks required scope (${needed.join(' or ')}).`);
}

async function verifyCallerRoleMembership(db, ctx) {
  const rolesUsersRepo = db?.getRepository?.('rolesUsers');
  if (!rolesUsersRepo || typeof rolesUsersRepo.find !== 'function') return;
  const activeRole = String(ctx?.state?.currentRole || '').trim();
  const userId = val(ctx?.state?.currentUser, 'id');
  if (userId == null) {
    throw failBroker('DXOS_BROKER_FORBIDDEN', 403, 'Không xác định được tài khoản để kiểm tra vai trò.');
  }
  const bindings = (await rolesUsersRepo.find({ filter: { userId }, limit: 50 })) || [];
  const hasBinding = Boolean(activeRole) && bindings.some((b) => (
    (val(b, 'userId') == null || String(val(b, 'userId')) === String(userId))
    && String(val(b, 'roleName') || '').trim() === activeRole
  ));
  if (!hasBinding) {
    throw failBroker('DXOS_BROKER_FORBIDDEN', 403, 'Vai trò yêu cầu không thuộc tài khoản hiện tại.');
  }
}

async function resolveNativeEmployee(db, user) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
  const repo = db?.getRepository?.('latticeEmployees');
  if (!repo) throw failBroker('NATIVE_MEMBERSHIP_REQUIRED', 403);
  const rows = await runWithOptionalRls(db, null, (transaction) =>
    repo.find({ filter: { userId: id }, limit: 2, ...(transaction ? { transaction } : {}) }),
  );
  if (rows.length > 1) throw failBroker('NATIVE_MEMBERSHIP_AMBIGUOUS', 403);
  const emp = rows[0];
  if (!emp || val(emp, 'active') !== true) throw failBroker('NATIVE_MEMBERSHIP_REQUIRED', 403);
  const organizationId = val(emp, 'organizationId');
  if (typeof organizationId !== 'string' || !ORG_ID_RE.test(organizationId)) {
    throw failBroker('NATIVE_MEMBERSHIP_INVALID', 403);
  }
  return { userId: String(id), employeeId: val(emp, 'id'), organizationId };
}

async function resolvePublicRouteJwtUser(db, ctx) {
  let user = null;
  if (typeof ctx?.auth?.check === 'function') {
    try {
      const checked = await ctx.auth.check();
      user = checked || ctx.auth?.user || ctx.state?.currentUser || null;
    } catch {
      throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
    }
  } else if (typeof ctx?.app?.authManager?.get === 'function') {
    const authenticatorName = readHeader(ctx, 'X-Authenticator').trim()
      || String(ctx.app.authManager.defaultAuthenticator || 'basic');
    try {
      const authenticator = await ctx.app.authManager.get(authenticatorName, ctx);
      if (authenticator && typeof authenticator.check === 'function') {
        user = (await authenticator.check(ctx)) || null;
      }
    } catch {
      throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
    }
  }
  if (!val(user, 'id')) {
    throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
  }
  ctx.auth = ctx.auth || {};
  ctx.auth.user = user;
  ctx.state = ctx.state || {};
  ctx.state.currentUser = user;

  const userId = val(user, 'id');
  const verifiedRoles = [];
  let defaultRole = '';
  const rolesUsersRepo = db?.getRepository?.('rolesUsers');
  if (rolesUsersRepo && typeof rolesUsersRepo.find === 'function') {
    const rows = (await rolesUsersRepo.find({ filter: { userId }, limit: 50 })) || [];
    for (const row of rows) {
      const roleName = String(val(row, 'roleName') || '').trim();
      if (!roleName) continue;
      if (!verifiedRoles.includes(roleName)) verifiedRoles.push(roleName);
      if (val(row, 'default') === true && !defaultRole) defaultRole = roleName;
    }
  } else if (typeof user?.getRoles === 'function') {
    const roles = (await user.getRoles()) || [];
    for (const row of roles) {
      const roleName = String(val(row, 'name') || val(row, 'roleName') || '').trim();
      if (!roleName) continue;
      if (!verifiedRoles.includes(roleName)) verifiedRoles.push(roleName);
      if (val(row, 'RolesUsers')?.default === true && !defaultRole) defaultRole = roleName;
    }
  }

  const requestedRole = readHeader(ctx, 'X-Role').trim();
  const resolvedRole = requestedRole && verifiedRoles.includes(requestedRole)
    ? requestedRole
    : defaultRole || verifiedRoles[0] || '';
  ctx.state.currentRole = resolvedRole;
  return resolvedRole;
}

async function hasBrokerUserPermission(db, ctx, hadPreResolvedUser) {
  const aclCtx = hadPreResolvedUser ? ctx : { ...ctx, can: undefined };
  if (typeof aclCtx?.can === 'function') {
    if (
      aclCtx.can({ resource: 'latticeIncidentCases', action: 'create' })
      || aclCtx.can({ resource: 'latticeAssets', action: 'update' })
    ) {
      return true;
    }
  }
  const roleName = String(ctx?.state?.currentRole || '').trim();
  if (!roleName) return false;
  if (BROKER_WRITE_ROLES.has(roleName)) return true;
  const role = await db?.getRepository?.('roles')?.findOne?.({ filter: { name: roleName } });
  if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
  const resRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!resRepo || typeof resRepo.findOne !== 'function') return false;
  for (const [col, act] of [['latticeIncidentCases', 'create'], ['latticeAssets', 'update']]) {
    const res = await resRepo.findOne({ filter: { roleName, name: col, dataSourceKey: 'main' } });
    if (res) {
      if (val(res, 'usingActionsConfig') === false) return true;
      const actions = val(res, 'actions') || [];
      if (actions.some((a) => (a?.name || a) === act)) return true;
    }
  }
  return false;
}

async function resolveEdgeOrJwtAuth(db, ctx, input = {}, { ingestToken } = {}) {
  const providedToken = readHeader(ctx, 'X-Lattice-Edge-Token').trim();
  const rawEnvToken = ingestToken !== undefined ? ingestToken : process.env.DX_IIOT_INGEST_TOKEN;
  const expectedToken = typeof rawEnvToken === 'string' ? rawEnvToken.trim() : '';
  const hadPreResolvedUser = Boolean(ctx?.state?.currentUser?.id);

  if (!providedToken && !hadPreResolvedUser) {
    await resolvePublicRouteJwtUser(db, ctx);
  }

  if (providedToken) {
    if (expectedToken.length < MIN_EDGE_TOKEN_LENGTH) {
      throw failBroker('TELEMETRY_EDGE_AUTH_INVALID', 401, 'Token IIoT edge chưa được cấu hình hợp lệ.');
    }
    const expectedBuf = Buffer.from(expectedToken, 'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw failBroker('TELEMETRY_EDGE_AUTH_INVALID', 401, 'Token IIoT edge không khớp.');
    }
    const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    if (!ORG_ID_RE.test(orgId)) {
      throw failBroker('BROKER_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho ingest broker.');
    }
    return { mode: 'edge-token', organizationId: orgId, isRoot: false, actor: null };
  }

  if (!ctx?.state?.currentUser?.id && ctx?.state?.currentRole !== 'root') {
    throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
  }
  if (ctx?.state?.currentRole === 'root' && !ctx?.state?.currentUser) {
    throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
  }
  assertBrokerApiKeyScope(ctx, ['iot', 'write']);
  await verifyCallerRoleMembership(db, ctx);

  if (ctx?.state?.currentRole === 'root') {
    const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    if (!ORG_ID_RE.test(orgId)) {
      throw failBroker('BROKER_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho thao tác root.');
    }
    return { mode: 'root', organizationId: orgId, isRoot: true, actor: null };
  }

  const actor = await resolveNativeEmployee(db, ctx.state.currentUser);
  const allowed = await hasBrokerUserPermission(db, ctx, hadPreResolvedUser);
  if (!allowed) {
    throw failBroker('DXOS_ACL_DENIED', 403);
  }
  if (
    input.organizationId !== undefined
    && input.organizationId !== null
    && String(input.organizationId).trim() !== ''
    && String(input.organizationId).trim() !== actor.organizationId
  ) {
    throw failBroker('DXOS_CROSS_ORG_FORBIDDEN', 403);
  }
  return { mode: 'user', organizationId: actor.organizationId, isRoot: false, actor };
}

async function resolveBrokerOperator(db, ctx, input = {}, { write = false, requireRootOrg = true } = {}) {
  if (!ctx?.state?.currentUser?.id && ctx?.state?.currentRole !== 'root') {
    throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
  }
  const activeRole = String(ctx?.state?.currentRole || '').trim();
  const isRoot = activeRole === 'root';
  if (isRoot && !ctx?.state?.currentUser) {
    throw failBroker('NATIVE_LOGIN_REQUIRED', 401);
  }
  assertBrokerApiKeyScope(ctx, write ? ['iot', 'write'] : ['read', 'iot', 'write']);

  // Verify role membership against rolesUsers when repository exists (fail closed on empty/missing binding)
  await verifyCallerRoleMembership(db, ctx);

  if (!isRoot) {
    const allowedSet = write ? BROKER_WRITE_ROLES : BROKER_READ_ROLES;
    let roleAllowed = allowedSet.has(activeRole);
    if (!roleAllowed && activeRole) {
      const roleRow = await db?.getRepository?.('roles')?.findOne?.({ filter: { name: activeRole } });
      if (val(roleRow, 'allowAll') === true || val(roleRow, 'allowConfigure') === true) {
        roleAllowed = true;
      }
    }
    if (!roleAllowed) {
      throw failBroker('DXOS_BROKER_FORBIDDEN', 403, 'Chỉ Quản trị viên hoặc Kỹ sư vận hành mới được truy cập Broker.');
    }
  }

  const actor = isRoot ? null : await resolveNativeEmployee(db, ctx.state.currentUser);
  let organizationId = null;
  const rawOrg = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';

  if (!isRoot) {
    if (rawOrg && rawOrg !== actor.organizationId) {
      throw failBroker('DXOS_CROSS_ORG_FORBIDDEN', 403);
    }
    organizationId = actor.organizationId;
  } else if (rawOrg) {
    if (!ORG_ID_RE.test(rawOrg)) {
      throw failBroker('DXOS_ORG_REQUIRED', 400, 'organizationId không hợp lệ.');
    }
    organizationId = rawOrg;
  } else if (typeof input.assetEntityId === 'string' && URN_RE.test(input.assetEntityId.trim())) {
    organizationId = URN_RE.exec(input.assetEntityId.trim())[1];
  } else if (requireRootOrg) {
    throw failBroker('DXOS_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ.');
  }

  const actorName = val(ctx?.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
  return { isRoot, actor, actorName, organizationId };
}

// --- Serializers & Normalizers ---

function serializeDevice(row) {
  if (!row) return null;
  const rawMeta = val(row, 'metadataJson');
  const safeMeta = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? { ...rawMeta } : {};
  delete safeMeta.mqttPassword;
  delete safeMeta.password;
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    deviceKey: val(row, 'deviceKey'),
    name: val(row, 'name'),
    mqttUsername: val(row, 'mqttUsername'),
    mqttClientId: val(row, 'mqttClientId'),
    assetId: val(row, 'assetId') ?? null,
    assetEntityId: val(row, 'assetEntityId') || null,
    topicPrefix: val(row, 'topicPrefix'),
    status: val(row, 'status') || 'provisioned',
    lastSeenAt: toIsoOrNull(val(row, 'lastSeenAt')),
    lastReason: val(row, 'lastReason') || null,
    metadataJson: safeMeta,
    createdAt: toIsoOrNull(val(row, 'createdAt')),
    updatedAt: toIsoOrNull(val(row, 'updatedAt')),
  };
}

function serializeSubscription(row) {
  if (!row) return null;
  const attrs = val(row, 'watchedAttributesJson');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    subscriptionKey: val(row, 'subscriptionKey'),
    brokerType: val(row, 'brokerType') || 'orion_ld',
    externalSubscriptionId: val(row, 'externalSubscriptionId') || null,
    entityType: val(row, 'entityType'),
    watchedAttributesJson: Array.isArray(attrs) ? attrs : [],
    notificationEndpoint: val(row, 'notificationEndpoint'),
    throttlingSec: Number(val(row, 'throttlingSec') ?? 5),
    active: val(row, 'active') !== false,
    lastNotifiedAt: toIsoOrNull(val(row, 'lastNotifiedAt')),
    lastError: val(row, 'lastError') || null,
    createdAt: toIsoOrNull(val(row, 'createdAt')),
    updatedAt: toIsoOrNull(val(row, 'updatedAt')),
  };
}

function normalizeDeviceStatus(raw) {
  const token = String(raw || '').trim().toUpperCase();
  if (token === 'BIRTH' || token === 'ONLINE' || token === 'CONNECTED') return 'online';
  if (token === 'DEATH' || token === 'OFFLINE' || token === 'LWT' || token === 'DISCONNECTED') return 'offline';
  return null;
}

function normalizeWatchedAttributes(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        throw failBroker('BROKER_WATCHED_ATTRS_INVALID', 400, 'watchedAttributes phải là mảng chuỗi hợp lệ.');
      }
    } else {
      list = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) {
    throw failBroker('BROKER_WATCHED_ATTRS_INVALID', 400, 'watchedAttributes phải là mảng chuỗi.');
  }
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = typeof item === 'string' ? item.trim() : '';
    if (!ATTR_NAME_RE.test(clean)) {
      throw failBroker('BROKER_WATCHED_ATTRS_INVALID', 400, `Thuộc tính "${String(item)}" không hợp lệ.`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (out.length > 50) {
      throw failBroker('BROKER_WATCHED_ATTRS_INVALID', 400, 'Tối đa 50 thuộc tính theo dõi mỗi subscription.');
    }
  }
  return out;
}

function parseNgsiValue(rawProp) {
  if (rawProp && typeof rawProp === 'object' && !Array.isArray(rawProp)) {
    if (rawProp.type === 'Relationship') return null;
    if ('value' in rawProp) {
      return {
        rawValue: rawProp.value,
        unit: typeof rawProp.unitCode === 'string' ? rawProp.unitCode.trim() : '',
        observedAt: rawProp.observedAt || null,
      };
    }
    return null;
  }
  return { rawValue: rawProp, unit: '', observedAt: null };
}

function parseFiniteTelemetry(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function buildDynSecProvisionCommands({ organizationId, deviceKey, mqttUsername, mqttClientId, mqttPassword, roleName, topicPrefix }) {
  return {
    commands: [
      { command: 'createRole', rolename: roleName },
      { command: 'addRoleACL', rolename: roleName, acltype: 'publishClientSend', topic: `${topicPrefix}/#`, priority: 0, allow: true },
      { command: 'addRoleACL', rolename: roleName, acltype: 'subscribePattern', topic: `${topicPrefix}/command`, priority: 0, allow: true },
      { command: 'addRoleACL', rolename: roleName, acltype: 'subscribePattern', topic: `${topicPrefix}/ack`, priority: 0, allow: true },
      { command: 'addRoleACL', rolename: roleName, acltype: 'publishClientReceive', topic: `${topicPrefix}/command`, priority: 0, allow: true },
      { command: 'addRoleACL', rolename: roleName, acltype: 'publishClientReceive', topic: `${topicPrefix}/ack`, priority: 0, allow: true },
      { command: 'createClient', username: mqttUsername, password: mqttPassword, clientid: mqttClientId },
      { command: 'addClientRole', username: mqttUsername, rolename: roleName },
    ],
    organizationId,
    deviceKey,
  };
}

// --- Action Factory ---

function createDxosBrokerActions(db, {
  brokerUrl,
  fetchImpl = fetch,
  lookupImpl,
  ingestToken,
  mqtt = null,
  orionCallbackUrl,
  env = process.env,
  netImpl = net,
} = {}) {
  const resolveOrionOrigin = () => {
    const raw = brokerUrl !== undefined ? brokerUrl : env?.DX_NATIVE_CONTEXT_BROKER_URL;
    if (!raw || !String(raw).trim()) return null;
    return validateOrionBrokerUrl(String(raw), env);
  };

  const resolveVerifiedOrionOrigin = async () => {
    const origin = resolveOrionOrigin();
    if (!origin) return null;
    const effectiveLookup = typeof lookupImpl === 'function'
      ? lookupImpl
      : (fetchImpl === fetch ? dns.promises.lookup : null);
    if (effectiveLookup) {
      await assertSafeBrokerDns(origin, {
        allowHosts: DEFAULT_ALLOWED_ORION_HOSTS,
        extraEnvKey: 'DX_ORION_HOST_ALLOWLIST',
        env,
        errorCode: 'BROKER_URL_FORBIDDEN',
        lookupImpl: effectiveLookup,
      });
    }
    return origin;
  };

  const resolveMqttSettings = () => {
    const cfg = mqtt && typeof mqtt === 'object' ? mqtt : {};
    const password = String(cfg.password ?? env?.MQTT_ADMIN_PASSWORD ?? '').trim();
    const explicitHost = cfg.host !== undefined ? String(cfg.host || '').trim() : String(env?.DX_MQTT_BROKER_HOST || '').trim();
    const host = explicitHost || (password ? 'mosquitto' : '');
    const port = Number(cfg.port ?? env?.DX_MQTT_BROKER_PORT ?? 1883);
    const username = String(cfg.username ?? env?.MQTT_ADMIN_USER ?? 'ldx_mqtt_admin').trim();
    const timeoutMs = Number(cfg.timeoutMs ?? 4000);
    const configured = Boolean(host && (password || cfg.host));
    return { configured, host, port, username, password, timeoutMs };
  };

  const resolveCallbackEndpoint = (requestedEndpoint) => {
    const defaultRaw = String(orionCallbackUrl || env?.DX_ORION_NOTIFY_CALLBACK_URL || DEFAULT_ORION_CALLBACK_URL).trim();
    const validDefault = validateCallbackUrl(defaultRaw, env);
    if (requestedEndpoint === undefined || requestedEndpoint === null || String(requestedEndpoint).trim() === '') {
      return validDefault;
    }
    const validReq = validateCallbackUrl(String(requestedEndpoint), env);
    if (validReq !== validDefault) {
      throw failBroker('BROKER_CALLBACK_FORBIDDEN', 400, `Callback Orion-LD bắt buộc phải trỏ tới ${validDefault}.`);
    }
    return validDefault;
  };

  const resolveConfiguredEdgeToken = () => {
    const raw = ingestToken !== undefined ? ingestToken : env?.DX_IIOT_INGEST_TOKEN;
    return typeof raw === 'string' ? raw.trim() : '';
  };

  const findDeviceRow = async (deviceRepo, organizationId, input) => {
    if (!deviceRepo) throw failBroker('BROKER_REPO_UNAVAILABLE', 503, 'Kho thiết bị IoT chưa sẵn sàng.');
    if (input.id !== undefined && input.id !== null && input.id !== '') {
      if (!/^[1-9]\d{0,18}$/.test(String(input.id))) {
        throw failBroker('BROKER_DEVICE_ID_INVALID', 400, 'id thiết bị không hợp lệ.');
      }
      const id = Number(input.id);
      const row = typeof deviceRepo.findOne === 'function'
        ? await deviceRepo.findOne({ filter: { id, ...(organizationId ? { organizationId } : {}) } })
        : ((await deviceRepo.find({ filter: { id, ...(organizationId ? { organizationId } : {}) }, limit: 1 })) || [])[0] || null;
      if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
        throw failBroker('BROKER_DEVICE_NOT_FOUND', 404, 'Không tìm thấy thiết bị trong phạm vi tổ chức.');
      }
      return row;
    }
    const deviceKey = typeof input.deviceKey === 'string' ? input.deviceKey.trim() : '';
    if (!DEVICE_KEY_RE.test(deviceKey)) {
      throw failBroker('BROKER_DEVICE_KEY_INVALID', 400, 'deviceKey không hợp lệ.');
    }
    if (!organizationId) {
      throw failBroker('DXOS_ORG_REQUIRED', 400, 'Cần organizationId khi tra cứu theo deviceKey.');
    }
    const row = typeof deviceRepo.findOne === 'function'
      ? await deviceRepo.findOne({ filter: { organizationId, deviceKey } })
      : ((await deviceRepo.find({ filter: { organizationId, deviceKey }, limit: 1 })) || [])[0] || null;
    if (!row || val(row, 'organizationId') !== organizationId) {
      throw failBroker('BROKER_DEVICE_NOT_FOUND', 404, 'Không tìm thấy thiết bị trong phạm vi tổ chức.');
    }
    return row;
  };

  const findSubscriptionRow = async (subRepo, organizationId, input) => {
    if (!subRepo) throw failBroker('BROKER_REPO_UNAVAILABLE', 503, 'Kho subscription broker chưa sẵn sàng.');
    if (input.id !== undefined && input.id !== null && input.id !== '') {
      if (!/^[1-9]\d{0,18}$/.test(String(input.id))) {
        throw failBroker('BROKER_SUB_ID_INVALID', 400, 'id subscription không hợp lệ.');
      }
      const id = Number(input.id);
      const row = typeof subRepo.findOne === 'function'
        ? await subRepo.findOne({ filter: { id, ...(organizationId ? { organizationId } : {}) } })
        : ((await subRepo.find({ filter: { id, ...(organizationId ? { organizationId } : {}) }, limit: 1 })) || [])[0] || null;
      if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
        throw failBroker('BROKER_SUB_NOT_FOUND', 404, 'Không tìm thấy subscription trong phạm vi tổ chức.');
      }
      return row;
    }
    const subscriptionKey = typeof input.subscriptionKey === 'string' ? input.subscriptionKey.trim() : '';
    if (!SUB_KEY_RE.test(subscriptionKey)) {
      throw failBroker('BROKER_SUB_KEY_INVALID', 400, 'subscriptionKey không hợp lệ.');
    }
    if (!organizationId) {
      throw failBroker('DXOS_ORG_REQUIRED', 400, 'Cần organizationId khi tra cứu theo subscriptionKey.');
    }
    const row = typeof subRepo.findOne === 'function'
      ? await subRepo.findOne({ filter: { organizationId, subscriptionKey } })
      : ((await subRepo.find({ filter: { organizationId, subscriptionKey }, limit: 1 })) || [])[0] || null;
    if (!row || val(row, 'organizationId') !== organizationId) {
      throw failBroker('BROKER_SUB_NOT_FOUND', 404, 'Không tìm thấy subscription trong phạm vi tổ chức.');
    }
    return row;
  };

  const saveRow = async (repo, row, patch, organizationId) => {
    if (typeof row?.update === 'function') {
      await row.update(patch);
      return row;
    }
    const id = val(row, 'id');
    if (repo && typeof repo.update === 'function' && id != null) {
      const res = await repo.update({
        filterByTk: id,
        ...(organizationId ? { filter: { organizationId } } : {}),
        values: patch,
      });
      if (Array.isArray(res) && res[0]) return res[0];
    }
    return Object.assign(row, patch);
  };

  return {
    listDevices: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, organizationId } = await resolveBrokerOperator(db, ctx, input, { write: false, requireRootOrg: false });
      const repo = db?.getRepository?.('latticeIotDevices');
      if (!repo) {
        ctx.body = { items: [], total: 0, organizationId, preview: isRoot && !organizationId };
        return next();
      }
      const statusFilter = typeof input.status === 'string' && input.status.trim() ? input.status.trim().toLowerCase() : null;
      const limit = Math.max(1, Math.min(200, Math.floor(Number(input.limit ?? input.pageSize) || 50)));
      const filter = {
        ...(organizationId ? { organizationId } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      };
      const { filtered, total } = await runWithOptionalRls(db, organizationId || null, async () => {
        const rows = (await repo.find({ filter, limit, sort: ['-id'] })) || [];
        const matched = rows.filter((r) => (!organizationId || val(r, 'organizationId') === organizationId) && (!statusFilter || val(r, 'status') === statusFilter));
        const count = typeof repo.count === 'function' ? await repo.count({ filter }) : matched.length;
        return { filtered: matched, total: count };
      });
      ctx.body = {
        items: filtered.map(serializeDevice),
        total,
        organizationId,
        preview: isRoot && !organizationId,
      };
      return next();
    },

    provisionDevice: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { organizationId, actorName } = await resolveBrokerOperator(db, ctx, input, { write: true, requireRootOrg: true });

      const deviceKey = typeof input.deviceKey === 'string' ? input.deviceKey.trim() : '';
      if (!DEVICE_KEY_RE.test(deviceKey)) {
        throw failBroker('BROKER_DEVICE_KEY_INVALID', 400, 'deviceKey phải gồm 1-64 ký tự [a-zA-Z0-9_.-].');
      }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 120) {
        throw failBroker('BROKER_DEVICE_NAME_INVALID', 400, 'Tên thiết bị phải từ 1 đến 120 ký tự.');
      }

      let assetId = null;
      if (input.assetId !== undefined && input.assetId !== null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) {
          throw failBroker('DXOS_INVALID_ASSET_ID', 400, 'assetId không hợp lệ.');
        }
        assetId = Number(input.assetId);
      }

      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      if (assetEntityId) {
        const urnMatch = URN_RE.exec(assetEntityId);
        if (urnMatch) {
          if (urnMatch[1] !== organizationId) {
            throw failBroker('DXOS_CROSS_ORG_FORBIDDEN', 403, 'assetEntityId không thuộc phạm vi tổ chức.');
          }
          const urnId = Number(urnMatch[2]);
          if (assetId != null && assetId !== urnId) {
            throw failBroker('BROKER_ASSET_MISMATCH', 400, 'assetId và assetEntityId không khớp.');
          }
          if (assetId == null) assetId = urnId;
        } else if (!ENTITY_ID_RE.test(assetEntityId)) {
          throw failBroker('BROKER_ENTITY_INVALID', 400, 'assetEntityId không hợp lệ.');
        }
      } else if (assetId != null) {
        assetEntityId = `urn:ngsi-ld:Asset:${organizationId}:native:${assetId}`;
      }

      const deviceRepo = db?.getRepository?.('latticeIotDevices');
      if (!deviceRepo || typeof deviceRepo.create !== 'function') {
        throw failBroker('BROKER_REPO_UNAVAILABLE', 503, 'Kho thiết bị IoT chưa sẵn sàng.');
      }

      await runWithOptionalRls(db, organizationId, async () => {
        if (assetId != null) {
          const assetRepo = db?.getRepository?.('latticeAssets');
          if (assetRepo && typeof assetRepo.findOne === 'function') {
            const assetRow = await assetRepo.findOne({ filter: { id: assetId, organizationId } });
            if (!assetRow || (val(assetRow, 'organizationId') && val(assetRow, 'organizationId') !== organizationId)) {
              throw failBroker('DXOS_ASSET_NOT_FOUND', 404, 'Không tìm thấy tài sản gắn với thiết bị trong tổ chức.');
            }
          }
        }

        const existing = typeof deviceRepo.findOne === 'function'
          ? await deviceRepo.findOne({ filter: { organizationId, deviceKey } })
          : ((await deviceRepo.find({ filter: { organizationId, deviceKey }, limit: 1 })) || [])[0] || null;
        if (existing) {
          throw failBroker('BROKER_DEVICE_EXISTS', 409, `Thiết bị "${deviceKey}" đã tồn tại trong tổ chức.`);
        }
      });

      const topicPrefix = `latticedx/${organizationId}/${deviceKey}`;
      const mqttUsername = `ldx_${organizationId}_${deviceKey}`.slice(0, 160);
      const rawClientId = typeof input.mqttClientId === 'string' && input.mqttClientId.trim()
        ? input.mqttClientId.trim()
        : `ldx-${organizationId}-${deviceKey}`;
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(rawClientId)) {
        throw failBroker('BROKER_CLIENT_ID_INVALID', 400, 'mqttClientId không hợp lệ.');
      }
      const roleName = `role_${organizationId}_${deviceKey}`.slice(0, 160);
      const mqttPassword = randomBytes(18).toString('base64url');

      const dynsec = buildDynSecProvisionCommands({
        organizationId,
        deviceKey,
        mqttUsername,
        mqttClientId: rawClientId,
        mqttPassword,
        roleName,
        topicPrefix,
      });

      const mqttCfg = resolveMqttSettings();
      let brokerSynced = false;
      let brokerError = null;
      if (mqttCfg.configured) {
        try {
          await publishMqttControl({
            host: mqttCfg.host,
            port: mqttCfg.port,
            username: mqttCfg.username,
            password: mqttCfg.password,
            topic: DYNSEC_CONTROL_TOPIC,
            payload: JSON.stringify({ commands: dynsec.commands }),
            timeoutMs: mqttCfg.timeoutMs,
            netImpl,
          });
          brokerSynced = true;
        } catch (err) {
          brokerSynced = false;
          brokerError = String(err?.code || err?.message || 'MQTT_SYNC_FAILED').slice(0, 200);
        }
      }

      const userMeta = input.metadataJson && typeof input.metadataJson === 'object' && !Array.isArray(input.metadataJson)
        ? { ...input.metadataJson }
        : {};
      delete userMeta.mqttPassword;
      delete userMeta.password;

      const created = await runWithOptionalRls(db, organizationId, () =>
        deviceRepo.create({
          values: {
            organizationId,
            deviceKey,
            name,
            mqttUsername,
            mqttClientId: rawClientId,
            ...(assetId != null ? { assetId } : {}),
            ...(assetEntityId ? { assetEntityId } : {}),
            topicPrefix,
            status: 'provisioned',
            lastSeenAt: null,
            lastReason: null,
            metadataJson: {
              ...userMeta,
              roleName,
              brokerSynced,
              provisionedBy: actorName,
              provisionedAt: new Date().toISOString(),
            },
          },
        }),
      );

      const device = serializeDevice(created);
      await emitDomainEventSafely(
        db,
        {
          organizationId,
          eventType: 'device.provisioned',
          source: '/dxos/broker',
          subject: deviceKey,
          data: {
            organizationId,
            deviceId: device.id,
            deviceKey,
            name,
            mqttUsername,
            mqttClientId: rawClientId,
            topicPrefix,
            assetId,
            assetEntityId: assetEntityId || null,
            brokerSynced,
          },
        },
        { ctx },
      );

      ctx.body = {
        device,
        mqttPassword,
        brokerSynced,
        ...(brokerError ? { brokerError } : {}),
      };
      return next();
    },

    revokeDevice: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const hasNumericId = input.id !== undefined && input.id !== null && input.id !== '';
      const { organizationId: scopedOrg, actorName } = await resolveBrokerOperator(db, ctx, input, {
        write: true,
        requireRootOrg: !hasNumericId,
      });

      const deviceRepo = db?.getRepository?.('latticeIotDevices');
      const row = await runWithOptionalRls(db, scopedOrg || null, () => findDeviceRow(deviceRepo, scopedOrg, input));
      const organizationId = scopedOrg || val(row, 'organizationId');
      const deviceKey = val(row, 'deviceKey');
      const mqttUsername = val(row, 'mqttUsername');
      const reason = typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim().slice(0, 200)
        : 'revoked_by_operator';

      const mqttCfg = resolveMqttSettings();
      let brokerSynced = false;
      let brokerError = null;
      if (mqttCfg.configured && mqttUsername) {
        try {
          await publishMqttControl({
            host: mqttCfg.host,
            port: mqttCfg.port,
            username: mqttCfg.username,
            password: mqttCfg.password,
            topic: DYNSEC_CONTROL_TOPIC,
            payload: JSON.stringify({
              commands: [
                { command: 'disableClient', username: mqttUsername },
                { command: 'deleteClient', username: mqttUsername },
              ],
            }),
            timeoutMs: mqttCfg.timeoutMs,
            netImpl,
          });
          brokerSynced = true;
        } catch (err) {
          brokerSynced = false;
          brokerError = String(err?.code || err?.message || 'MQTT_SYNC_FAILED').slice(0, 200);
        }
      }

      const prevMeta = val(row, 'metadataJson');
      const nextMeta = {
        ...(prevMeta && typeof prevMeta === 'object' && !Array.isArray(prevMeta) ? prevMeta : {}),
        revokedBy: actorName,
        revokedAt: new Date().toISOString(),
        revokeBrokerSynced: brokerSynced,
      };
      delete nextMeta.mqttPassword;
      delete nextMeta.password;

      const updated = await runWithOptionalRls(db, organizationId, () =>
        saveRow(
          deviceRepo,
          row,
          {
            status: 'revoked',
            lastReason: reason,
            metadataJson: nextMeta,
          },
          organizationId,
        ),
      );

      const device = serializeDevice(updated);
      await emitDomainEventSafely(
        db,
        {
          organizationId,
          eventType: 'device.revoked',
          source: '/dxos/broker',
          subject: deviceKey,
          data: {
            organizationId,
            deviceId: device.id,
            deviceKey,
            mqttUsername,
            reason,
            brokerSynced,
          },
        },
        { ctx },
      );

      ctx.body = {
        device,
        brokerSynced,
        ...(brokerError ? { brokerError } : {}),
      };
      return next();
    },

    deviceStatusIngest: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const auth = await resolveEdgeOrJwtAuth(db, ctx, input, { ingestToken });

      const deviceKey = typeof input.deviceKey === 'string' ? input.deviceKey.trim() : '';
      if (!DEVICE_KEY_RE.test(deviceKey)) {
        throw failBroker('BROKER_DEVICE_KEY_INVALID', 400, 'deviceKey không hợp lệ.');
      }

      const normalizedStatus = normalizeDeviceStatus(input.status ?? input.state ?? input.event);
      if (!normalizedStatus) {
        throw failBroker('BROKER_DEVICE_STATUS_INVALID', 400, 'Trạng thái thiết bị phải là online/BIRTH hoặc offline/DEATH/LWT.');
      }

      let observedAt = new Date();
      if (input.observedAt !== undefined && input.observedAt !== null && input.observedAt !== '') {
        observedAt = new Date(String(input.observedAt));
        if (!Number.isFinite(observedAt.getTime())) {
          throw failBroker('BROKER_OBSERVED_AT_INVALID', 400, 'observedAt không hợp lệ.');
        }
      }

      const deviceRepo = db?.getRepository?.('latticeIotDevices');
      const { device, previousStatus, transitionedToOffline, incident } = await runWithOptionalRls(db, auth.organizationId, async () => {
        const row = await findDeviceRow(deviceRepo, auth.organizationId, { deviceKey });
        const prevStatus = String(val(row, 'status') || 'provisioned').toLowerCase();
        if (prevStatus === 'revoked') {
          throw failBroker('BROKER_DEVICE_REVOKED', 403, 'Thiết bị đã bị thu hồi.');
        }

        const reason = typeof input.reason === 'string' && input.reason.trim()
          ? input.reason.trim().slice(0, 200)
          : (normalizedStatus === 'offline' ? 'mqtt_lwt_disconnect' : 'mqtt_birth_connected');
        const toOffline = normalizedStatus === 'offline' && prevStatus !== 'offline';

        const updated = await saveRow(
          deviceRepo,
          row,
          {
            status: normalizedStatus,
            lastSeenAt: observedAt,
            lastReason: reason,
          },
          auth.organizationId,
        );

        const dev = serializeDevice(updated);
        let inc = null;

        if (toOffline) {
          const matchedAssetId = dev.assetId ?? null;
          let matchedEntityId = String(dev.assetEntityId || '').trim();
          if (!matchedEntityId && matchedAssetId != null) {
            matchedEntityId = `urn:ngsi-ld:Asset:${auth.organizationId}:native:${matchedAssetId}`;
          }

          if (matchedEntityId) {
            const incidentRepo = db?.getRepository?.('latticeIncidentCases');
            if (incidentRepo) {
              inc = await ingestOrDeduplicateAlarm(db, {
                organizationId: auth.organizationId,
                assetId: matchedAssetId,
                assetEntityId: matchedEntityId,
                ruleCode: 'MQTT-LWT-OFFLINE',
                attribute: 'connectivity',
                severity: 'high',
                summary: `Thiết bị IoT ${dev.name || deviceKey} mất kết nối MQTT (${reason})`.slice(0, 500),
                handlerId: 'unassigned',
                metricName: 'connectivity',
                numericValue: 0,
                app: ctx?.app,
                publishDomainEvent: resolvePublishDomainEvent(db, ctx)?.fn,
              });
            }
          }
        }

        return {
          device: dev,
          previousStatus: prevStatus,
          transitionedToOffline: toOffline,
          incident: inc,
          reason,
        };
      }).then(async (res) => {
        if (res.transitionedToOffline) {
          await emitDomainEventSafely(
            db,
            {
              organizationId: auth.organizationId,
              eventType: 'device.offline',
              source: '/dxos/broker',
              subject: deviceKey,
              data: {
                organizationId: auth.organizationId,
                deviceId: res.device.id,
                deviceKey,
                name: res.device.name,
                assetId: res.device.assetId ?? null,
                assetEntityId: res.device.assetEntityId || (res.device.assetId != null ? `urn:ngsi-ld:Asset:${auth.organizationId}:native:${res.device.assetId}` : null),
                previousStatus: res.previousStatus,
                reason: res.reason,
                observedAt: observedAt.toISOString(),
                incidentId: res.incident?.id ?? null,
                alarmCode: res.incident?.code ?? null,
              },
            },
            { ctx },
          );
        }
        return res;
      });

      ctx.body = {
        device,
        previousStatus,
        transitionedToOffline,
        incident,
      };
      return next();
    },

    orionEntities: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { organizationId } = await resolveBrokerOperator(db, ctx, input, { write: false, requireRootOrg: true });
      const brokerOrigin = await resolveVerifiedOrionOrigin();
      const entityType = typeof input.entityType === 'string' && input.entityType.trim()
        ? input.entityType.trim()
        : '';
      if (entityType && !ENTITY_TYPE_RE.test(entityType)) {
        throw failBroker('BROKER_ENTITY_TYPE_INVALID', 400, 'entityType không hợp lệ.');
      }
      const limit = Math.max(1, Math.min(200, Math.floor(Number(input.limit) || 100)));

      // Load local assets & locations for org diff
      const localByUrn = new Map();
      await runWithOptionalRls(db, organizationId, async () => {
        const assetRows = (await db?.getRepository?.('latticeAssets')?.find?.({ filter: { organizationId }, limit: 200 })) || [];
        for (const a of Array.isArray(assetRows) ? assetRows : []) {
          if (val(a, 'organizationId') !== organizationId) continue;
          const id = val(a, 'id');
          if (id == null) continue;
          const urn = `urn:ngsi-ld:Asset:${organizationId}:native:${id}`;
          localByUrn.set(urn, {
            entityId: urn,
            type: 'Asset',
            collection: 'latticeAssets',
            recordId: id,
            code: val(a, 'code') || null,
            name: val(a, 'name') || null,
            status: val(a, 'status') || null,
            active: val(a, 'active') !== false,
          });
        }
        const locationRows = (await db?.getRepository?.('latticeLocations')?.find?.({ filter: { organizationId }, limit: 200 })) || [];
        for (const loc of Array.isArray(locationRows) ? locationRows : []) {
          if (val(loc, 'organizationId') !== organizationId) continue;
          const id = val(loc, 'id');
          if (id == null) continue;
          const urn = `urn:ngsi-ld:Location:${organizationId}:native:${id}`;
          localByUrn.set(urn, {
            entityId: urn,
            type: 'Location',
            collection: 'latticeLocations',
            recordId: id,
            code: val(loc, 'code') || null,
            name: val(loc, 'name') || null,
            status: null,
            active: val(loc, 'active') !== false,
          });
        }
      });

      const localFiltered = [...localByUrn.values()].filter((e) => !entityType || e.type === entityType);
      if (!brokerOrigin) {
        ctx.body = {
          organizationId,
          orionReachable: false,
          brokerConfigured: false,
          matched: [],
          orionOnly: [],
          localOnly: localFiltered,
          entities: [],
        };
        return next();
      }

      let orionEntitiesList = null;
      let orionError = null;
      try {
        const qs = new URLSearchParams({ local: 'true', limit: String(limit) });
        if (entityType) qs.set('type', entityType);
        const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/entities?${qs.toString()}`, {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/ld+json, application/json',
            'NGSILD-Tenant': organizationId,
          },
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const parsed = await res.json();
          orionEntitiesList = Array.isArray(parsed) ? parsed : [];
        } else {
          await res.body?.cancel?.();
          orionError = `ORION_HTTP_${res.status}`;
        }
      } catch (err) {
        orionError = err?.message || 'ORION_UNREACHABLE';
      }

      if (!orionEntitiesList) {
        ctx.body = {
          organizationId,
          orionReachable: false,
          brokerConfigured: true,
          ...(orionError ? { error: orionError } : {}),
          matched: [],
          orionOnly: [],
          localOnly: localFiltered,
          entities: [],
        };
        return next();
      }

      const matched = [];
      const orionOnly = [];
      const seenOrionIds = new Set();

      for (const entity of orionEntitiesList) {
        const eid = String(entity?.id || '').trim();
        if (!eid) continue;
        seenOrionIds.add(eid);

        const attrs = {};
        for (const [k, v] of Object.entries(entity)) {
          if (['id', 'type', '@context'].includes(k)) continue;
          const parsedAttr = parseNgsiValue(v);
          attrs[k] = parsedAttr ? parsedAttr.rawValue : (v?.object ?? v);
        }

        const local = localByUrn.get(eid);
        if (local) {
          const attrDiff = [];
          if (attrs.name !== undefined && String(attrs.name) !== String(local.name ?? '')) {
            attrDiff.push({ attribute: 'name', local: local.name, orion: attrs.name });
          }
          if (local.type === 'Asset' && attrs.status !== undefined && String(attrs.status) !== String(local.status ?? '')) {
            attrDiff.push({ attribute: 'status', local: local.status, orion: attrs.status });
          }
          if (attrs.active !== undefined && Boolean(attrs.active) !== Boolean(local.active)) {
            attrDiff.push({ attribute: 'active', local: local.active, orion: attrs.active });
          }
          matched.push({
            entityId: eid,
            type: entity.type || local.type,
            local,
            orion: { id: eid, type: entity.type || local.type, attributes: attrs },
            attrDiff,
            inSync: attrDiff.length === 0,
          });
        } else {
          orionOnly.push({
            entityId: eid,
            type: entity.type || 'Unknown',
            attributes: attrs,
          });
        }
      }

      const localOnly = localFiltered.filter((l) => !seenOrionIds.has(l.entityId));
      ctx.body = {
        organizationId,
        orionReachable: true,
        brokerConfigured: true,
        matched,
        orionOnly,
        localOnly,
        entities: orionEntitiesList,
      };
      return next();
    },

    orionListSubscriptions: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, organizationId } = await resolveBrokerOperator(db, ctx, input, { write: false, requireRootOrg: false });
      const brokerOrigin = await resolveVerifiedOrionOrigin();

      const repo = db?.getRepository?.('latticeBrokerSubscriptions');
      const filter = {
        ...(organizationId ? { organizationId } : {}),
        brokerType: 'orion_ld',
      };
      const rows = repo
        ? await runWithOptionalRls(db, organizationId || null, () => repo.find({ filter, limit: 100, sort: ['-id'] })) || []
        : [];
      const filtered = rows.filter((r) => !organizationId || val(r, 'organizationId') === organizationId);

      let orionReachable = false;
      let remoteSubscriptions = null;
      if (brokerOrigin && organizationId) {
        try {
          const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/subscriptions?limit=100`, {
            method: 'GET',
            redirect: 'error',
            headers: {
              Accept: 'application/ld+json, application/json',
              'NGSILD-Tenant': organizationId,
            },
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const parsed = await res.json();
            remoteSubscriptions = Array.isArray(parsed) ? parsed : [];
            orionReachable = true;
          } else {
            await res.body?.cancel?.();
          }
        } catch {
          orionReachable = false;
        }
      }

      ctx.body = {
        items: filtered.map(serializeSubscription),
        total: filtered.length,
        organizationId,
        orionReachable,
        ...(remoteSubscriptions ? { remoteCount: remoteSubscriptions.length } : {}),
        preview: isRoot && !organizationId,
      };
      return next();
    },

    orionCreateSubscription: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { organizationId } = await resolveBrokerOperator(db, ctx, input, { write: true, requireRootOrg: true });
      const brokerOrigin = await resolveVerifiedOrionOrigin();
      const callbackUri = resolveCallbackEndpoint(input.notificationEndpoint);

      const rawKey = typeof input.subscriptionKey === 'string' && input.subscriptionKey.trim()
        ? input.subscriptionKey.trim()
        : `sub-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      if (!SUB_KEY_RE.test(rawKey)) {
        throw failBroker('BROKER_SUB_KEY_INVALID', 400, 'subscriptionKey phải gồm 1-64 ký tự [a-zA-Z0-9_.-].');
      }

      const entityType = typeof input.entityType === 'string' && input.entityType.trim()
        ? input.entityType.trim()
        : 'Asset';
      if (!ENTITY_TYPE_RE.test(entityType)) {
        throw failBroker('BROKER_ENTITY_TYPE_INVALID', 400, 'entityType không hợp lệ.');
      }

      const watchedAttributes = normalizeWatchedAttributes(input.watchedAttributes ?? input.watchedAttributesJson);
      const rawThrottle = input.throttlingSec !== undefined && input.throttlingSec !== null && input.throttlingSec !== ''
        ? Number(input.throttlingSec)
        : 5;
      if (!Number.isInteger(rawThrottle) || rawThrottle < 0 || rawThrottle > 3600) {
        throw failBroker('BROKER_THROTTLING_INVALID', 400, 'throttlingSec phải là số nguyên trong [0, 3600].');
      }

      const subRepo = db?.getRepository?.('latticeBrokerSubscriptions');
      if (!subRepo || typeof subRepo.create !== 'function') {
        throw failBroker('BROKER_REPO_UNAVAILABLE', 503, 'Kho subscription broker chưa sẵn sàng.');
      }
      const existing = await runWithOptionalRls(db, organizationId, () => (
        typeof subRepo.findOne === 'function'
          ? subRepo.findOne({ filter: { organizationId, subscriptionKey: rawKey } })
          : subRepo.find({ filter: { organizationId, subscriptionKey: rawKey }, limit: 1 }).then((r) => (r || [])[0] || null)
      ));
      if (existing) {
        throw failBroker('BROKER_SUB_EXISTS', 409, `Subscription "${rawKey}" đã tồn tại trong tổ chức.`);
      }

      const subscriptionUrn = `urn:ngsi-ld:Subscription:${organizationId}:${rawKey}`;
      const edgeToken = resolveConfiguredEdgeToken();
      const orionPayload = {
        id: subscriptionUrn,
        type: 'Subscription',
        description: `LatticeDX ${entityType} subscription (${organizationId}/${rawKey})`,
        entities: [{ type: entityType }],
        ...(watchedAttributes.length ? { watchedAttributes } : {}),
        throttling: rawThrottle,
        isActive: true,
        notification: {
          ...(watchedAttributes.length ? { attributes: watchedAttributes } : {}),
          format: 'normalized',
          endpoint: {
            uri: callbackUri,
            accept: 'application/json',
            ...(edgeToken
              ? { receiverInfo: [{ key: 'X-Lattice-Edge-Token', value: edgeToken }] }
              : {}),
          },
        },
      };

      let externalSubscriptionId = null;
      let orionSynced = false;
      let lastError = null;
      if (brokerOrigin) {
        try {
          const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/subscriptions`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'NGSILD-Tenant': organizationId,
            },
            body: JSON.stringify(orionPayload),
            signal: AbortSignal.timeout(4000),
          });
          await res.body?.cancel?.();
          if (res.ok || res.status === 201 || res.status === 204 || res.status === 409) {
            const loc = typeof res.headers?.get === 'function' ? res.headers.get('location') : null;
            externalSubscriptionId = loc ? loc.split('/').pop() : subscriptionUrn;
            orionSynced = true;
          } else {
            lastError = `ORION_HTTP_${res.status}`;
          }
        } catch (err) {
          lastError = String(err?.message || 'ORION_UNREACHABLE').slice(0, 500);
        }
      }

      const created = await runWithOptionalRls(db, organizationId, () =>
        subRepo.create({
          values: {
            organizationId,
            subscriptionKey: rawKey,
            brokerType: 'orion_ld',
            externalSubscriptionId,
            entityType,
            watchedAttributesJson: watchedAttributes,
            notificationEndpoint: callbackUri,
            throttlingSec: rawThrottle,
            active: true,
            lastNotifiedAt: null,
            lastError,
          },
        }),
      );

      ctx.body = {
        subscription: serializeSubscription(created),
        orionSynced,
      };
      return next();
    },

    orionToggleSubscription: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const hasNumericId = input.id !== undefined && input.id !== null && input.id !== '';
      const { organizationId: scopedOrg } = await resolveBrokerOperator(db, ctx, input, {
        write: true,
        requireRootOrg: !hasNumericId,
      });

      const subRepo = db?.getRepository?.('latticeBrokerSubscriptions');
      const row = await runWithOptionalRls(db, scopedOrg || null, () => findSubscriptionRow(subRepo, scopedOrg, input));
      const organizationId = scopedOrg || val(row, 'organizationId');
      const nextActive = input.active !== undefined ? Boolean(input.active) : !Boolean(val(row, 'active'));

      const brokerOrigin = await resolveVerifiedOrionOrigin();
      const externalId = val(row, 'externalSubscriptionId');
      let orionSynced = false;
      let lastError = null;

      if (brokerOrigin && externalId) {
        try {
          const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/subscriptions/${encodeURIComponent(externalId)}`, {
            method: 'PATCH',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'NGSILD-Tenant': organizationId,
            },
            body: JSON.stringify({ isActive: nextActive }),
            signal: AbortSignal.timeout(4000),
          });
          await res.body?.cancel?.();
          if (res.ok || res.status === 204) {
            orionSynced = true;
          } else {
            lastError = `ORION_HTTP_${res.status}`;
          }
        } catch (err) {
          lastError = String(err?.message || 'ORION_UNREACHABLE').slice(0, 500);
        }
      }

      const updated = await runWithOptionalRls(db, organizationId, () =>
        saveRow(
          subRepo,
          row,
          { active: nextActive, lastError },
          organizationId,
        ),
      );

      ctx.body = {
        subscription: serializeSubscription(updated),
        orionSynced,
      };
      return next();
    },

    orionDeleteSubscription: async (ctx, next) => {
      if (!['POST', 'DELETE'].includes(ctx.method || 'POST')) throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const hasNumericId = input.id !== undefined && input.id !== null && input.id !== '';
      const { organizationId: scopedOrg } = await resolveBrokerOperator(db, ctx, input, {
        write: true,
        requireRootOrg: !hasNumericId,
      });

      const subRepo = db?.getRepository?.('latticeBrokerSubscriptions');
      const row = await runWithOptionalRls(db, scopedOrg || null, () => findSubscriptionRow(subRepo, scopedOrg, input));
      const organizationId = scopedOrg || val(row, 'organizationId');
      const id = val(row, 'id');
      const subscriptionKey = val(row, 'subscriptionKey');
      const externalId = val(row, 'externalSubscriptionId');

      const brokerOrigin = await resolveVerifiedOrionOrigin();
      let orionSynced = false;
      if (brokerOrigin && externalId) {
        try {
          const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/subscriptions/${encodeURIComponent(externalId)}`, {
            method: 'DELETE',
            redirect: 'error',
            headers: { 'NGSILD-Tenant': organizationId },
            signal: AbortSignal.timeout(4000),
          });
          await res.body?.cancel?.();
          if (res.ok || res.status === 204 || res.status === 404) {
            orionSynced = true;
          }
        } catch {
          orionSynced = false;
        }
      }

      if (typeof row?.destroy === 'function') {
        await runWithOptionalRls(db, organizationId, () => row.destroy());
      } else if (typeof subRepo?.destroy === 'function') {
        await runWithOptionalRls(db, organizationId, () => subRepo.destroy({ filter: { id, organizationId } }));
      }

      ctx.body = {
        deleted: true,
        id,
        subscriptionKey,
        orionSynced,
      };
      return next();
    },

    orionNotify: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw failBroker('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);

      const tenantHeader = readHeader(ctx, 'NGSILD-Tenant').trim();
      const subscriptionId = typeof input.subscriptionId === 'string' ? input.subscriptionId.trim() : '';
      let inferredOrg = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
      if (!inferredOrg && tenantHeader) inferredOrg = tenantHeader;
      if (!inferredOrg && subscriptionId.startsWith('urn:ngsi-ld:Subscription:')) {
        const subParts = subscriptionId.split(':');
        if (subParts.length >= 4 && ORG_ID_RE.test(subParts[3])) {
          inferredOrg = subParts[3];
        }
      }
      if (!inferredOrg && Array.isArray(input.data)) {
        for (const entity of input.data) {
          const m = URN_RE.exec(String(entity?.id || '').trim());
          if (m) {
            inferredOrg = m[1];
            break;
          }
        }
      }

      if (tenantHeader && inferredOrg && tenantHeader !== inferredOrg) {
        throw failBroker('DXOS_CROSS_ORG_FORBIDDEN', 403, 'NGSILD-Tenant không khớp organizationId.');
      }

      const auth = await resolveEdgeOrJwtAuth(db, ctx, { ...input, organizationId: inferredOrg }, { ingestToken });
      if (tenantHeader && tenantHeader !== auth.organizationId) {
        throw failBroker('DXOS_CROSS_ORG_FORBIDDEN', 403, 'NGSILD-Tenant không khớp phạm vi tổ chức.');
      }

      if (!Array.isArray(input.data) || input.data.length === 0) {
        throw failBroker('ORION_NOTIFY_DATA_REQUIRED', 400, 'Thông báo Orion-LD phải chứa mảng data[] không rỗng.');
      }
      if (input.data.length > 200) {
        throw failBroker('ORION_NOTIFY_TOO_MANY_ENTITIES', 400, 'Tối đa 200 thực thể mỗi lần thông báo Orion-LD.');
      }

      const points = [];
      const quarantined = [];
      const triggeredAlarms = [];
      const entitiesSummary = [];
      const fallbackObservedAt = input.notifiedAt || null;

      await runWithOptionalRls(db, auth.organizationId, async () => {
        for (const entity of input.data) {
          if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
            throw failBroker('ORION_NOTIFY_ENTITY_INVALID', 400, 'Thực thể trong data[] không hợp lệ.');
          }
          const entityId = String(entity.id || '').trim();
          if (!entityId || !ENTITY_ID_RE.test(entityId)) {
            throw failBroker('ORION_NOTIFY_ENTITY_INVALID', 400, 'Thiếu hoặc sai định dạng entity.id.');
          }
          const urnMatch = URN_RE.exec(entityId);
          if (urnMatch && urnMatch[1] !== auth.organizationId) {
            throw failBroker('DXOS_CROSS_ORG_FORBIDDEN', 403, 'Thực thể trong thông báo không thuộc tổ chức.');
          }

          const entityMetrics = [];
          for (const [attrName, rawAttr] of Object.entries(entity)) {
            if (NON_TELEMETRY_NGSI_ATTRS.has(attrName)) continue;
            if (!ATTR_NAME_RE.test(attrName)) continue;
            const parsedAttr = parseNgsiValue(rawAttr);
            if (!parsedAttr) continue;
            const numVal = parseFiniteTelemetry(parsedAttr.rawValue);
            if (numVal === null) continue;

            const res = await ingestTelemetryPoint(db, {
              organizationId: auth.organizationId,
              assetEntityId: entityId,
              metricName: attrName,
              numericValue: numVal,
              unit: parsedAttr.unit || 'CEL',
              sourceProtocol: 'orion_ld',
              observedAt: parsedAttr.observedAt || entity.observedAt || fallbackObservedAt,
              app: ctx?.app,
            });
            if (res?.quarantined) {
              quarantined.push(res);
            } else if (res?.point) {
              points.push(res.point);
              entityMetrics.push({ metricName: attrName, numericValue: numVal, unit: res.point.unit });
            }
            if (Array.isArray(res?.triggeredAlarms) && res.triggeredAlarms.length) {
              triggeredAlarms.push(...res.triggeredAlarms);
            }
          }
          entitiesSummary.push({ entityId, metrics: entityMetrics });
        }

        // Touch matching mirrored subscription row when present
        const subRepo = db?.getRepository?.('latticeBrokerSubscriptions');
        if (subRepo && subscriptionId && typeof subRepo.find === 'function') {
          const subRows = (await subRepo.find({ filter: { organizationId: auth.organizationId }, limit: 100 })) || [];
          const matchedSub = subRows.find((s) => (
            val(s, 'organizationId') === auth.organizationId
            && (
              val(s, 'externalSubscriptionId') === subscriptionId
              || `urn:ngsi-ld:Subscription:${auth.organizationId}:${val(s, 'subscriptionKey')}` === subscriptionId
            )
          ));
          if (matchedSub) {
            await saveRow(subRepo, matchedSub, { lastNotifiedAt: new Date(), lastError: null }, auth.organizationId);
          }
        }
      });

      await emitDomainEventSafely(
        db,
        {
          organizationId: auth.organizationId,
          eventType: 'orion.notification',
          source: '/dxos/broker',
          subject: subscriptionId || auth.organizationId,
          data: {
            organizationId: auth.organizationId,
            subscriptionId: subscriptionId || null,
            notifiedAt: toIsoOrNull(input.notifiedAt) || new Date().toISOString(),
            entityCount: input.data.length,
            ingestedCount: points.length,
            quarantinedCount: quarantined.length,
            triggeredAlarmCount: triggeredAlarms.length,
            entities: entitiesSummary,
          },
        },
        { ctx },
      );

      ctx.body = {
        organizationId: auth.organizationId,
        subscriptionId: subscriptionId || null,
        ingestedCount: points.length,
        quarantinedCount: quarantined.length,
        points,
        quarantined,
        triggeredAlarms,
      };
      return next();
    },
  };
}

module.exports = {
  DYNSEC_CONTROL_TOPIC,
  DEFAULT_ORION_CALLBACK_URL,
  BROKER_READ_ROLES,
  BROKER_WRITE_ROLES,
  encodeMqttString,
  encodeRemainingLength,
  buildConnectPacket,
  buildPublishPacket,
  buildDisconnectPacket,
  publishMqttControl,
  validateOrionBrokerUrl,
  validateCallbackUrl,
  validateOrionBrokerUrlAsync,
  validateCallbackUrlAsync,
  assertSafeBrokerDns,
  assertBrokerApiKeyScope,
  isBlockedResolvedIp,
  normalizeDeviceStatus,
  buildDynSecProvisionCommands,
  emitDomainEventSafely,
  resolvePublishDomainEvent,
  createDxosBrokerActions,
};

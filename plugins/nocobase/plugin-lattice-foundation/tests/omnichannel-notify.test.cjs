/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const net = require('node:net');
const { EventEmitter } = require('node:events');

function withMockedNocobase(fn) {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Migration: MockMigration, Plugin: MockPlugin };
    }
    if (request === '@nocobase/database') {
      return { defineCollection: (def) => def };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      Module._load = origLoad;
    });
}

function makeInMemoryNotifyDb({ dialect = 'postgres' } = {}) {
  const seqs = { connectors: 0, deliveries: 0, employees: 10, orders: 10 };
  const roles = [
    { name: 'root', allowAll: true, allowConfigure: true, snippets: ['pm', 'pm.*'] },
    { name: 'ldx_admin', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'ldx_employee', allowConfigure: false, snippets: [] },
  ];
  const rolesUsers = [
    { userId: 1, roleName: 'root' },
    { userId: 10, roleName: 'ldx_admin' },
    { userId: 20, roleName: 'ldx_employee' },
    { userId: 30, roleName: 'ldx_admin' },
  ];
  const employees = [
    { id: 100, userId: 10, organizationId: 'org-a', departmentId: 1, active: true, code: 'ADM-A', name: 'Admin A' },
    { id: 200, userId: 20, organizationId: 'org-a', departmentId: 1, active: true, code: 'EMP-A', name: 'Emp A' },
    { id: 300, userId: 30, organizationId: 'org-b', departmentId: 2, active: true, code: 'ADM-B', name: 'Admin B' },
  ];
  const connectors = [];
  const deliveries = [];
  const sqlCalls = [];

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (Object.hasOwn(cond, '$eq')) return row[k] === cond.$eq;
      if (Object.hasOwn(cond, '$ne')) return row[k] !== cond.$ne;
    }
    return row[k] === cond;
  });

  const sortRows = (rows, sort) => {
    if (!Array.isArray(sort) || !sort.length) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
      for (const s of sort) {
        const desc = String(s).startsWith('-');
        const key = desc ? String(s).slice(1) : String(s);
        if (a[key] === b[key]) continue;
        const cmp = a[key] < b[key] ? -1 : 1;
        return desc ? -cmp : cmp;
      }
      return 0;
    });
    return copy;
  };

  const wrap = (row) => (row ? {
    ...row,
    toJSON: () => ({ ...row }),
    get: (k) => row[k],
    update: async (patch) => {
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(row);
    },
    destroy: async () => 1,
  } : null);

  const makeRepo = (list, counterKey) => ({
    find: async ({ filter, sort, offset = 0, limit = 100 } = {}) => {
      const filtered = list.filter((r) => match(r, filter));
      return sortRows(filtered, sort).slice(offset, offset + limit).map(wrap);
    },
    findOne: async ({ filter, filterByTk, sort } = {}) => {
      if (filterByTk != null && !filter) {
        return wrap(list.find((r) => Number(r.id) === Number(filterByTk)));
      }
      const filtered = sortRows(list.filter((r) => match(r, filter)), sort);
      return wrap(filtered[0] || null);
    },
    count: async ({ filter } = {}) => list.filter((r) => match(r, filter)).length,
    create: async ({ values }) => {
      const row = {
        id: ++seqs[counterKey],
        createdAt: values.createdAt || new Date().toISOString(),
        updatedAt: values.updatedAt || new Date().toISOString(),
        ...values,
      };
      list.push(row);
      return wrap(row);
    },
    update: async ({ filterByTk, filter, values } = {}) => {
      const targets = list.filter((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : true) && (!filter || match(r, filter)));
      for (const t of targets) {
        Object.assign(t, values, { updatedAt: new Date().toISOString() });
      }
      return targets.map(wrap);
    },
  });

  const fakeTx = { id: 'tx-notify', LOCK: { UPDATE: 'UPDATE' } };
  const db = {
    sequelize: {
      getDialect: () => dialect,
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        sqlCalls.push({ sql, opts });
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'roles') return makeRepo(roles, 'orders');
      if (name === 'rolesUsers') return makeRepo(rolesUsers, 'orders');
      if (name === 'latticeEmployees') return makeRepo(employees, 'employees');
      if (name === 'latticeConnectors') return makeRepo(connectors, 'connectors');
      if (name === 'latticeNotificationDeliveries') return makeRepo(deliveries, 'deliveries');
      return null;
    },
  };

  return { db, connectors, deliveries, sqlCalls };
}

function makeAppHarness(db) {
  const resources = new Map();
  const aclAllows = [];
  const middlewares = [];
  const app = {
    db,
    resourceManager: {
      define(def) { resources.set(def.name, def.actions); },
      use(fn, meta) { middlewares.push({ fn, meta }); },
    },
    acl: {
      allow(...args) { aclAllows.push(args); },
    },
    logger: { error() {}, warn() {}, info() {} },
  };
  return { app, resources, aclAllows, middlewares };
}

function makeHttpCtx({ method = 'GET', state = {}, params = {}, values, resourceName = '', actionName = '' } = {}) {
  const fullParams = values !== undefined ? { ...params, values } : { ...params };
  return {
    method,
    headers: {},
    request: { headers: {}, body: fullParams },
    state: { ...state },
    action: { resourceName, actionName, params: fullParams },
    throw(status, message, props) {
      throw Object.assign(new Error(message || `HTTP ${status}`), { status }, props || {});
    },
  };
}

async function runMiddlewares(middlewares, ctx, handler) {
  let idx = -1;
  const dispatch = async (i) => {
    if (i <= idx) throw new Error('next() called multiple times');
    idx = i;
    if (i < middlewares.length) {
      return middlewares[i].fn(ctx, () => dispatch(i + 1));
    }
    return handler ? handler(ctx, async () => {}) : undefined;
  };
  return dispatch(0);
}

function seedVaultConnector(db, {
  id = 1,
  organizationId = 'org-a',
  connectorKey,
  name,
  connectorType,
  appType,
  baseUrl,
  authType,
  secrets = {},
  oauthAccessToken = null,
  oauthRefreshToken = null,
  oauthTokenExpiresAt = null,
  oauthConfigJson = null,
  active = true,
}) {
  const { encryptVaultSecrets, encryptSecretText } = require('../src/server/connector-vault');
  const row = {
    id,
    organizationId,
    connectorKey,
    name: name || connectorKey,
    connectorType,
    appType: appType || null,
    baseUrl,
    authType,
    encryptedSecretsJson: encryptVaultSecrets(secrets),
    oauthAccessTokenEnc: oauthAccessToken ? encryptSecretText(oauthAccessToken) : null,
    oauthRefreshTokenEnc: oauthRefreshToken ? encryptSecretText(oauthRefreshToken) : null,
    oauthTokenExpiresAt,
    oauthConfigJson,
    secretVersion: 1,
    active,
  };
  return db.getRepository('latticeConnectors').create({ values: row });
}

test('collection latticeNotificationDeliveries and migration 20261202000100 define valid schema, indexes, and reversible FORCE RLS', async () => {
  await withMockedNocobase(async () => {
    const col = require('../src/server/collections/notification-deliveries');
    assert.equal(col.name, 'latticeNotificationDeliveries');
    assert.deepEqual(col.migrationRules, ['schema-only']);
    const orgField = col.fields.find((f) => f.name === 'organizationId');
    assert.equal(orgField?.allowNull, false);
    assert.ok(col.fields.some((f) => f.name === 'payloadPreviewJson' && f.type === 'jsonb'));

    const expectedIndexes = [
      'uidx_lattice_notif_del_org_uid',
      'idx_lattice_notif_del_org_status',
      'idx_lattice_notif_del_org_channel',
    ];
    for (const idxName of expectedIndexes) {
      assert.ok(idxName.length <= 55);
      assert.match(idxName, /^u?idx_lattice_[a-z0-9_]+$/);
      assert.ok(col.indexes.some((i) => i.name === idxName), `Missing index ${idxName}`);
    }

    const Migration = require('../src/server/migrations/20261202000100-omnichannel-notification-deliveries');
    const sqlCalls = [];
    const rlsAttached = [];
    const fakeTx = { id: 'tx-20261202' };
    const fakeDb = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => {
          sqlCalls.push({ sql, opts });
          return [[]];
        },
      },
      attachLatticeRlsPolicy: async (tableName, opts) => {
        rlsAttached.push({ tableName, opts });
      },
    };

    const migration = new Migration({ db: fakeDb });
    assert.equal(migration.on, 'afterSync');
    await migration.up();

    const upSql = sqlCalls.map((x) => x.sql).join('\n');
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeNotificationDeliveries"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_notif_del_org_uid/);
    assert.match(upSql, /CREATE INDEX IF NOT EXISTS idx_lattice_notif_del_org_status/);
    assert.match(upSql, /CREATE INDEX IF NOT EXISTS idx_lattice_notif_del_org_channel/);
    assert.equal(/\bUNIQUE\b/i.test(upSql.replace(/CREATE UNIQUE INDEX/gi, '')), false);
    assert.deepEqual(rlsAttached.map((r) => r.tableName), ['latticeNotificationDeliveries']);
    assert.equal(rlsAttached[0].opts?.transaction, fakeTx);

    sqlCalls.length = 0;
    await migration.down();
    const downSql = sqlCalls.map((x) => x.sql).join('\n');
    assert.match(downSql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeNotificationDeliveries"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeNotificationDeliveries"/);

    // SQLite skips Postgres RLS DDL cleanly
    const sqliteCalls = [];
    const sqliteMig = new Migration({
      db: {
        sequelize: {
          getDialect: () => 'sqlite',
          transaction: async (cb) => cb({ id: 'tx-sqlite' }),
          query: async (sql) => {
            sqliteCalls.push(sql);
            return [[]];
          },
        },
      },
    });
    await sqliteMig.up();
    assert.equal(sqliteCalls.some((s) => /ROW LEVEL SECURITY/i.test(s)), false);
  });
});

test('renderTemplate, renderWebhookPayload, escapeHtml, and scrubSecrets guard against XSS, prototype pollution, and secret leaks', () => {
  const {
    renderTemplate,
    renderWebhookPayload,
    escapeHtml,
    scrubSecrets,
  } = require('../src/server/omnichannel-notify');

  assert.equal(
    renderTemplate('Alert [{{severity}}]: {{order.code}}', { severity: 'HIGH', order: { code: 'ORD-42' } }),
    'Alert [HIGH]: ORD-42',
  );
  assert.equal(
    renderTemplate('<p>{{title}}</p>', { title: '<script>alert("xss")</script>' }, { htmlEscape: true }),
    '<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>',
  );
  assert.equal(escapeHtml("a & b < c > d 'e'"), 'a &amp; b &lt; c &gt; d &#39;e&#39;');

  // Prototype pollution & Object.prototype access blocked
  const renderedProto = renderTemplate(
    '{{__proto__.polluted}}|{{constructor.name}}|{{prototype.x}}|{{toString}}',
    { title: 'Safe' },
  );
  assert.equal(renderedProto, '|||');

  const evilTemplate = JSON.parse('{"text":"{{title}}","__proto__":{"admin":true},"nested":{"constructor":"bad","ok":"{{code}}"}}');
  const renderedPayload = renderWebhookPayload(evilTemplate, { title: 'Alert', code: 'INC-9' });
  assert.equal(renderedPayload.text, 'Alert');
  assert.equal(renderedPayload.nested.ok, 'INC-9');
  assert.equal(Object.hasOwn(renderedPayload, '__proto__'), false);
  assert.equal(Object.hasOwn(renderedPayload.nested, 'constructor'), false);
  assert.equal(({}).admin, undefined);

  const scrubbed = scrubSecrets(
    'Failed connecting with token super_secret_token_1234 and pass p@ssw0rd99',
    { botToken: 'super_secret_token_1234', password: 'p@ssw0rd99', short: 'abc' },
  );
  assert.equal(scrubbed.includes('super_secret_token_1234'), false);
  assert.equal(scrubbed.includes('p@ssw0rd99'), false);
  assert.match(scrubbed, /\[REDACTED\]/);
});

test('sendSmtpEmail delivers RFC 5321 message with AUTH PLAIN and dot-stuffing, supports STARTTLS, and blocks header injection & SSRF', async () => {
  const { sendSmtpEmail } = require('../src/server/omnichannel-notify');

  // 1. Real ephemeral local TCP mock SMTP server
  const received = { commands: [], dataLines: [] };
  const server = net.createServer((socket) => {
    socket.write('220 mock.smtp.example ESMTP\r\n');
    let inData = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const idx = buffer.indexOf('\r\n');
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued as smtp-msg-991\r\n');
          } else {
            received.dataLines.push(line);
          }
          continue;
        }
        received.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO ')) {
          socket.write('250-mock.smtp.example\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN ')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('502 Command not implemented\r\n');
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // Reject header injection BEFORE touching socket
    await assert.rejects(
      () => sendSmtpEmail({
        host: 'smtp.example.org',
        port: 587,
        from: 'noreply@example.org',
        to: 'user@example.org\r\nBcc: attacker@evil.example',
        subject: 'Normal',
        text: 'Hello',
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
      (err) => err.code === 'SMTP_HEADER_INJECTION_BLOCKED' && err.status === 400,
    );

    // Reject SSRF IP BEFORE touching socket
    let socketOpened = false;
    await assert.rejects(
      () => sendSmtpEmail({
        host: '169.254.169.254',
        port: 25,
        from: 'noreply@example.org',
        to: 'user@example.org',
        subject: 'SSRF',
        text: 'Blocked',
        netConnectImpl: () => {
          socketOpened = true;
          throw new Error('should not connect');
        },
      }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE',
    );
    assert.equal(socketOpened, false);

    // Successful SMTP delivery over injected netConnectImpl routing public domain to local ephemeral mock server
    const res = await sendSmtpEmail({
      host: 'smtp.public-partner.example',
      port,
      username: 'mailer',
      password: 'smtp_secret_value_123',
      from: 'alerts@latticedx.example',
      to: ['ops@latticedx.example'],
      subject: 'SLA Breach Alert',
      text: 'Line 1\n.Leading dot line\nLine 3',
      html: '<p>Hello <b>Ops</b></p>',
      starttls: false,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      netConnectImpl: (_opts) => net.connect({ host: '127.0.0.1', port }),
    });

    assert.equal(res.ok, true);
    assert.ok(res.providerMessageId);
    assert.ok(received.commands.some((c) => c.startsWith('EHLO ')));
    const expectedAuth = Buffer.from('\0mailer\0smtp_secret_value_123', 'utf8').toString('base64');
    assert.ok(received.commands.includes(`AUTH PLAIN ${expectedAuth}`));
    assert.ok(received.commands.includes('MAIL FROM:<alerts@latticedx.example>'));
    assert.ok(received.commands.includes('RCPT TO:<ops@latticedx.example>'));
    assert.ok(received.commands.includes('QUIT'));
    // RFC 5321 dot-stuffing check
    assert.ok(received.dataLines.includes('..Leading dot line'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 2. STARTTLS upgrade path with fake stream socket + tlsConnectImpl
  const starttlsCommands = [];
  const makeFakeSmtpSocket = (responses) => {
    const ee = new EventEmitter();
    ee.setTimeout = () => {};
    ee.destroy = () => {};
    ee.end = () => {};
    let inData = false;
    let buf = '';
    ee.write = (chunk) => {
      buf += chunk.toString('utf8');
      while (buf.includes('\r\n')) {
        const idx = buf.indexOf('\r\n');
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const handler = responses.shift();
            if (handler) {
              queueMicrotask(() => ee.emit('data', Buffer.from(handler(line), 'utf8')));
            }
          }
          continue;
        }
        starttlsCommands.push(line);
        if (line.toUpperCase() === 'DATA') inData = true;
        const handler = responses.shift();
        if (handler) {
          queueMicrotask(() => ee.emit('data', Buffer.from(handler(line), 'utf8')));
        }
      }
      return true;
    };
    return ee;
  };

  const tlsRes = await sendSmtpEmail({
    host: 'smtp.tls-partner.example',
    port: 587,
    requireTls: true,
    username: 'tlsuser',
    password: 'tlspassword99',
    from: 'noreply@latticedx.example',
    to: 'admin@latticedx.example',
    subject: 'TLS Test',
    text: 'Encrypted payload',
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    netConnectImpl: () => {
      const sock = makeFakeSmtpSocket([
        () => '250-smtp.tls-partner.example\r\n250 STARTTLS\r\n',
        () => '220 Ready to start TLS\r\n',
      ]);
      queueMicrotask(() => {
        sock.emit('connect');
        sock.emit('data', Buffer.from('220 smtp.tls-partner.example ESMTP\r\n', 'utf8'));
      });
      return sock;
    },
    tlsConnectImpl: () => {
      const tlsSock = makeFakeSmtpSocket([
        () => '250-smtp.tls-partner.example\r\n250 AUTH LOGIN\r\n',
        () => '334 VXNlcm5hbWU6\r\n',
        () => '334 UGFzc3dvcmQ6\r\n',
        () => '235 Authentication succeeded\r\n',
        () => '250 Ok\r\n',
        () => '250 Ok\r\n',
        () => '354 End data\r\n',
        () => '250 Queued as tls-msg-1\r\n',
        () => '221 Bye\r\n',
      ]);
      queueMicrotask(() => tlsSock.emit('secureConnect'));
      return tlsSock;
    },
  });
  assert.equal(tlsRes.ok, true);
  assert.ok(starttlsCommands.includes('STARTTLS'));
  assert.ok(starttlsCommands.includes('AUTH LOGIN'));
});

test('Telegram, Slack (Webhook & OAuth2 chat.postMessage), and Custom Webhook dispatchers use Vault credentials, HMAC signing, and SSRF guards', async () => {
  const { db } = makeInMemoryNotifyDb();
  const { dispatchChannelNotification } = require('../src/server/omnichannel-notify');
  const { verifyStandardWebhookSignature } = require('../src/server/event-bus');

  const tgToken = '123456789:AAFakeTelegramBotToken_Secret9999';
  const slackOauthToken = 'xoxb-slack-oauth-token-secret-12345';
  const webhookSecret = 'whsec_' + Buffer.from('super-hmac-signing-key-32bytes!!').toString('base64');

  await seedVaultConnector(db, {
    id: 1,
    organizationId: 'org-a',
    connectorKey: 'ops-telegram',
    connectorType: 'http_api',
    appType: 'telegram',
    baseUrl: 'https://api.telegram.org',
    authType: 'api_key',
    secrets: { botToken: tgToken, defaultChatId: '-10099887766' },
  });

  await seedVaultConnector(db, {
    id: 2,
    organizationId: 'org-a',
    connectorKey: 'ops-slack-oauth',
    connectorType: 'http_api',
    appType: 'slack',
    baseUrl: 'https://slack.com/api',
    authType: 'oauth2',
    secrets: { clientId: 'cid-1', clientSecret: 'csec-1' },
    oauthAccessToken: slackOauthToken,
    oauthTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  await seedVaultConnector(db, {
    id: 3,
    organizationId: 'org-a',
    connectorKey: 'partner-hook',
    connectorType: 'webhook',
    appType: 'partner_webhook',
    baseUrl: 'https://hooks.partner.example/notify',
    authType: 'hmac',
    secrets: { secret: webhookSecret },
  });

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('slack.com/api/chat.postMessage')) {
      const payload = { ok: true, ts: '1700000.0001', channel: 'C12345' };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    if (url.includes('api.telegram.org')) {
      const payload = { ok: true, result: { message_id: 7788 } };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    return {
      ok: true,
      status: 202,
      json: async () => ({ accepted: true }),
      text: async () => '{"accepted":true}',
    };
  };

  // 1. Telegram dispatch
  const tgRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'telegram',
    connectorKey: 'ops-telegram',
    title: 'Server High CPU',
    body: 'Node 1 at 95%',
    severity: 'critical',
  }, { fetchImpl });

  assert.equal(tgRes.ok, true);
  assert.equal(tgRes.status, 'sent');
  assert.equal(tgRes.targetMasked.includes(tgToken), false);
  assert.equal(tgRes.providerMessageId, '7788');
  assert.ok(calls[0].url.includes(`/bot${tgToken}/sendMessage`));

  // 2. Slack OAuth2 dispatch
  const slackRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'slack',
    connectorKey: 'ops-slack-oauth',
    target: 'C12345',
    title: 'Approval Needed',
    body: 'PO-101 waiting',
    severity: 'high',
  }, { fetchImpl });

  assert.equal(slackRes.ok, true);
  assert.equal(calls[1].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${slackOauthToken}`);
  const slackBody = JSON.parse(calls[1].init.body);
  assert.equal(slackBody.channel, 'C12345');
  assert.ok(Array.isArray(slackBody.blocks));

  // 3. Custom Webhook Template + Standard Webhooks HMAC signature
  const whRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'webhook',
    connectorKey: 'partner-hook',
    title: 'Order Approved',
    body: 'ORD-77 ready',
    template: {
      event: 'custom.alert',
      msg: '{{title}} - {{body}}',
      meta: { org: '{{organizationId}}' },
    },
  }, { fetchImpl });

  assert.equal(whRes.ok, true);
  const whCall = calls[2];
  assert.equal(whCall.init.redirect, 'error');
  const whBody = JSON.parse(whCall.init.body);
  assert.deepEqual(whBody, {
    event: 'custom.alert',
    msg: 'Order Approved - ORD-77 ready',
    meta: { org: 'org-a' },
  });
  assert.ok(whCall.init.headers['X-Lattice-Signature-256'].startsWith('sha256='));
  assert.equal(
    verifyStandardWebhookSignature({
      webhookId: whCall.init.headers['webhook-id'],
      timestamp: whCall.init.headers['webhook-timestamp'],
      body: whCall.init.body,
      signature: whCall.init.headers['webhook-signature'],
      secret: webhookSecret,
    }),
    true,
  );
});

test('SSRF DNS rebinding fails closed before fetch, retry handles transient 503/429 without retrying 400, and dryRun scrubs secrets', async () => {
  const { db, deliveries } = makeInMemoryNotifyDb();
  const { dispatchChannelNotification, dispatchOmnichannel } = require('../src/server/omnichannel-notify');

  const hookSecret = 'very_secret_hmac_token_abcd';
  await seedVaultConnector(db, {
    id: 1,
    organizationId: 'org-a',
    connectorKey: 'rebind-hook',
    connectorType: 'webhook',
    appType: 'partner_webhook',
    baseUrl: 'https://rebind.attacker.example/hook',
    authType: 'hmac',
    secrets: { secret: hookSecret },
  });
  await seedVaultConnector(db, {
    id: 2,
    organizationId: 'org-a',
    connectorKey: 'flaky-hook',
    connectorType: 'webhook',
    appType: 'partner_webhook',
    baseUrl: 'https://hooks.reliable.example/events',
    authType: 'bearer',
    secrets: { token: 'bearer_secret_987654' },
  });

  // 1. DNS rebinding to 169.254.169.254 blocks before fetch
  let fetchCalledOnSsrf = false;
  const ssrfRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'webhook',
    connectorKey: 'rebind-hook',
    title: 'Should block',
  }, {
    fetchImpl: async () => {
      fetchCalledOnSsrf = true;
      return { ok: true, status: 200 };
    },
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    enforceDnsInMock: true,
  });
  assert.equal(fetchCalledOnSsrf, false);
  assert.equal(ssrfRes.ok, false);
  assert.equal(ssrfRes.status, 'blocked');
  assert.equal(ssrfRes.attempt, 1);

  // 2. Transient 503 -> 429 -> 200 retries cleanly and succeeds on 3rd attempt
  let attempts = 0;
  const retryRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'webhook',
    connectorKey: 'flaky-hook',
    title: 'Retry Test',
    maxAttempts: 3,
  }, {
    sleepImpl: async () => {},
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503, text: async () => 'upstream busy bearer_secret_987654' };
      if (attempts === 2) return { ok: false, status: 429, text: async () => 'rate limited' };
      return { ok: true, status: 200, json: async () => ({ id: 'ok-3' }), text: async () => '{"id":"ok-3"}' };
    },
  });
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.status, 'sent');
  assert.equal(retryRes.attempt, 3);
  assert.equal(attempts, 3);

  // 3. Non-retryable 400 fails immediately without retrying and scrubs secret from errorMessage
  let badAttempts = 0;
  const badRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'webhook',
    connectorKey: 'flaky-hook',
    title: 'Bad Request Test',
    maxAttempts: 3,
  }, {
    sleepImpl: async () => {},
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      badAttempts += 1;
      return { ok: false, status: 400, text: async () => 'Rejected token bearer_secret_987654' };
    },
  });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 'failed');
  assert.equal(badRes.attempt, 1);
  assert.equal(badAttempts, 1);
  assert.equal(badRes.errorMessage.includes('bearer_secret_987654'), false);

  // 4. dryRun renders & validates without network call and scrubs secrets
  let dryFetchCalled = false;
  const dryRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'webhook',
    connectorKey: 'flaky-hook',
    title: 'Dry Run Alert',
    body: 'Secret echo bearer_secret_987654',
    dryRun: true,
  }, {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      dryFetchCalled = true;
      return { ok: true, status: 200 };
    },
  });
  assert.equal(dryFetchCalled, false);
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.dryRun, true);
  assert.equal(dryRes.status, 'dry_run');
  assert.equal(JSON.stringify(dryRes).includes('bearer_secret_987654'), false);

  // 5. dispatchOmnichannel fans out across string channel names resolving org active connectors
  const fanout = await dispatchOmnichannel(db, {
    organizationId: 'org-a',
    channels: ['in_app', 'webhook'],
    title: 'Fanout',
    dryRun: true,
  }, {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.ok(fanout.deliveries.length >= 1);
  assert.ok(deliveries.some((d) => d.status === 'dry_run' && d.organizationId === 'org-a'));
});

test('registerOmnichannelNotify enforces RBAC, PAT scopes, org isolation on logs, dryRun testSend, and direct CRUD guard', async () => {
  const { db } = makeInMemoryNotifyDb();
  const { app, resources, aclAllows, middlewares } = makeAppHarness(db);
  const { registerOmnichannelNotify } = require('../src/server/omnichannel-notify');

  await seedVaultConnector(db, {
    id: 1,
    organizationId: 'org-a',
    connectorKey: 'org-a-tg',
    connectorType: 'http_api',
    appType: 'telegram',
    baseUrl: 'https://api.telegram.org',
    authType: 'api_key',
    secrets: { botToken: '998877665:AAOrgATelegramSecretToken1234', defaultChatId: '-100111' },
  });
  await seedVaultConnector(db, {
    id: 2,
    organizationId: 'org-b',
    connectorKey: 'org-b-tg',
    connectorType: 'http_api',
    appType: 'telegram',
    baseUrl: 'https://api.telegram.org',
    authType: 'api_key',
    secrets: { botToken: '112233445:AAOrgBTelegramSecretToken5678', defaultChatId: '-100222' },
  });

  const api = registerOmnichannelNotify(app, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 501 } }),
      text: async () => '{"ok":true}',
    }),
  });

  assert.ok(resources.has('dxosNotify'));
  assert.ok(aclAllows.some(([res]) => res === 'dxosNotify'));
  assert.equal(typeof api.dispatchOmnichannel, 'function');
  assert.equal(typeof api.createNotificationCenterAdapter, 'function');

  const actions = resources.get('dxosNotify');

  // Unauthenticated blocked (401)
  await assert.rejects(
    () => actions.testSend(makeHttpCtx({ method: 'POST', state: {} })),
    (err) => err.status === 401,
  );

  // Non-admin blocked on testSend & logs (403)
  await assert.rejects(
    () => actions.testSend(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20 }, currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
      params: { channel: 'telegram', connectorKey: 'org-a-tg', dryRun: true },
    })),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => actions.logs(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 20 }, currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
    })),
    (err) => err.status === 403,
  );

  // Read-only PAT blocked on send/testSend (403)
  await assert.rejects(
    () => actions.testSend(makeHttpCtx({
      method: 'POST',
      state: {
        currentUser: { id: 10 },
        currentRole: 'ldx_admin',
        currentRoles: ['ldx_admin'],
        latticeApiKey: { id: 1, scopes: ['read'] },
      },
      params: { channel: 'telegram', connectorKey: 'org-a-tg', dryRun: true },
    })),
    (err) => err.code === 'API_KEY_SCOPE_INSUFFICIENT' && err.status === 403,
  );

  // Admin testSend with dryRun: true succeeds and logs under org-a
  const testCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin', currentRoles: ['ldx_admin'] },
    params: { channel: 'telegram', connectorKey: 'org-a-tg', title: 'Dry check', dryRun: true },
  });
  await actions.testSend(testCtx, async () => {});
  assert.equal(testCtx.body.ok, true);
  assert.equal(testCtx.body.dryRun, true);
  assert.equal(JSON.stringify(testCtx.body).includes('AAOrgATelegramSecretToken1234'), false);

  // Org B admin testSend
  const orgBCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 30 }, currentRole: 'ldx_admin', currentRoles: ['ldx_admin'] },
    params: { channel: 'telegram', connectorKey: 'org-b-tg', title: 'Org B live' },
  });
  await actions.testSend(orgBCtx, async () => {});
  assert.equal(orgBCtx.body.ok, true);
  assert.equal(orgBCtx.body.status, 'sent');

  // Org A logs sees only org-a rows
  const logsCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin', currentRoles: ['ldx_admin'] },
  });
  await actions.logs(logsCtx, async () => {});
  assert.equal(logsCtx.body.organizationId, 'org-a');
  assert.equal(logsCtx.body.items.length, 1);
  assert.equal(logsCtx.body.items[0].organizationId, 'org-a');

  // Channels list hides secrets
  const channelsCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
  });
  await actions.channels(channelsCtx, async () => {});
  assert.equal(channelsCtx.body.items.length, 1);
  assert.equal(channelsCtx.body.items[0].connectorKey, 'org-a-tg');
  assert.equal(JSON.stringify(channelsCtx.body).includes('AAOrgATelegramSecretToken1234'), false);

  // Direct CRUD middleware blocks non-root access to latticeNotificationDeliveries
  await assert.rejects(
    () => runMiddlewares(
      middlewares,
      makeHttpCtx({
        method: 'GET',
        state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
        resourceName: 'latticeNotificationDeliveries',
        actionName: 'list',
      }),
    ),
    (err) => err.code === 'NOTIFY_DIRECT_CRUD_FORBIDDEN' && err.status === 403,
  );
  await assert.rejects(
    () => runMiddlewares(
      middlewares,
      makeHttpCtx({
        method: 'POST',
        state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
        resourceName: 'charts',
        actionName: 'queryData',
        values: { collection: 'latticeNotificationDeliveries' },
      }),
    ),
    (err) => err.code === 'NOTIFY_DIRECT_CRUD_FORBIDDEN' && err.status === 403,
  );
});

test('Slack incoming webhook, Slack ok:false classification, Vault SMTP dispatch, and notification-center adapter work end-to-end', async () => {
  const { db } = makeInMemoryNotifyDb();
  const {
    dispatchChannelNotification,
    createNotificationCenterAdapter,
  } = require('../src/server/omnichannel-notify');

  await seedVaultConnector(db, {
    id: 10,
    organizationId: 'org-a',
    connectorKey: 'slack-hook',
    connectorType: 'webhook',
    appType: 'slack',
    baseUrl: 'https://hooks.slack.com/services/T000/B000/SECRET_TOKEN_XYZ',
    authType: 'none',
    secrets: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRET_TOKEN_XYZ' },
  });

  await seedVaultConnector(db, {
    id: 11,
    organizationId: 'org-a',
    connectorKey: 'slack-bot-err',
    connectorType: 'http_api',
    appType: 'slack',
    baseUrl: 'https://slack.com/api',
    authType: 'bearer',
    secrets: { botToken: 'xoxb-slack-err-token-1234', defaultChannel: 'C999' },
  });

  await seedVaultConnector(db, {
    id: 12,
    organizationId: 'org-a',
    connectorKey: 'smtp-primary',
    connectorType: 'smtp_notify',
    appType: 'email_smtp',
    baseUrl: 'smtp://smtp.partner.example:587',
    authType: 'basic',
    secrets: {
      host: 'smtp.partner.example',
      port: '587',
      username: 'mailer@partner.example',
      password: 'smtp_vault_password_999',
      fromEmail: 'noreply@partner.example',
    },
  });

  // 1. Slack incoming webhook scrubs webhookUrl secret from targetMasked & logs
  const slackHookCalls = [];
  const hookRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'slack',
    connectorKey: 'slack-hook',
    title: 'Incident Escalated',
    body: 'Check SLA',
    severity: 'high',
  }, {
    fetchImpl: async (url, init) => {
      slackHookCalls.push({ url, init });
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });
  assert.equal(hookRes.ok, true);
  assert.equal(hookRes.targetMasked.includes('SECRET_TOKEN_XYZ'), false);
  assert.equal(slackHookCalls.length, 1);

  // 2. Slack API { ok: false, error: 'channel_not_found' } does NOT retry
  let errAttempts = 0;
  const errRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'slack',
    connectorKey: 'slack-bot-err',
    title: 'Bad channel',
    maxAttempts: 3,
  }, {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      errAttempts += 1;
      const body = { ok: false, error: 'channel_not_found' };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  assert.equal(errRes.ok, false);
  assert.equal(errAttempts, 1);
  assert.equal(errRes.errorCode, 'SLACK_API_REJECTED');

  // 3. Vault SMTP dryRun + live adapter
  const adapter = createNotificationCenterAdapter({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'ok' }),
  });
  const adapted = await adapter(db, {
    notification: {
      id: 44,
      organizationId: 'org-a',
      category: 'sla',
      severity: 'critical',
      title: 'SLA Breached',
      body: 'Ticket #44 overdue',
    },
    channelConfigs: [
      { channel: 'smtp', connectorKey: 'smtp-primary', to: 'ops@partner.example', dryRun: true },
      { channel: 'slack', connectorKey: 'slack-hook' },
    ],
  });
  assert.equal(adapted.okCount, 1);
  assert.equal(adapted.dryRunCount, 1);
  assert.deepEqual(adapted.channelsDispatched, ['slack']);
  assert.equal(JSON.stringify(adapted).includes('smtp_vault_password_999'), false);
});

test('dispatchOmnichannel and dxosNotify:send block cross-tenant organizationId, secrets, connector, and allowInternal injection in channels[]', async () => {
  const { db, deliveries } = makeInMemoryNotifyDb();
  const { app, resources } = makeAppHarness(db);
  const { dispatchOmnichannel, registerOmnichannelNotify } = require('../src/server/omnichannel-notify');

  // Seed an operator (ldx_manager) in org-a and an admin/connector in org-b
  await db.getRepository('rolesUsers').create({ values: { userId: 15, roleName: 'ldx_manager' } });
  await db.getRepository('latticeEmployees').create({
    values: { id: 150, userId: 15, organizationId: 'org-a', departmentId: 1, active: true, code: 'MGR-A', name: 'Mgr A' },
  });

  await seedVaultConnector(db, {
    id: 21,
    organizationId: 'org-b',
    connectorKey: 'org-b-tg',
    connectorType: 'http_api',
    appType: 'telegram',
    baseUrl: 'https://api.telegram.org',
    authType: 'api_key',
    secrets: { botToken: '112233445:AAOrgBTelegramSecretToken5678', defaultChatId: '-100222' },
  });

  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 999 } }),
      text: async () => '{"ok":true}',
    };
  };

  registerOmnichannelNotify(app, { fetchImpl });
  const actions = resources.get('dxosNotify');

  // 1. HTTP dxosNotify:send from org-a operator attempting cross-tenant override + secret/connector injection
  const sendCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 15 }, currentRole: 'ldx_manager', currentRoles: ['ldx_manager'] },
    params: {
      title: 'Cross-Tenant Probe',
      body: 'Should not reach org-b',
      channels: [
        {
          channel: 'telegram',
          organizationId: 'org-b',
          connectorKey: 'org-b-tg',
          secrets: { botToken: '998877665:AAInjectedAttackerBotToken9999', defaultChatId: '-100999' },
          connector: { connectorKey: 'org-b-tg', baseUrl: 'https://api.telegram.org', organizationId: 'org-b' },
          allowInternal: true,
        },
      ],
    },
  });
  await actions.send(sendCtx, async () => {});
  assert.equal(fetchCalled, false);
  assert.equal(sendCtx.body.organizationId, 'org-a');
  assert.equal(sendCtx.body.okCount, 0);
  assert.equal(sendCtx.body.failedCount, 1);
  assert.equal(sendCtx.body.deliveries[0].organizationId, 'org-a');
  assert.equal(sendCtx.body.deliveries[0].errorCode, 'CONNECTOR_NOT_FOUND');
  assert.equal(deliveries.some((d) => d.organizationId === 'org-b'), false);

  // 2. Direct dispatchOmnichannel call also strips organizationId, secrets, connector, allowInternal from specs
  const directRes = await dispatchOmnichannel(db, {
    organizationId: 'org-a',
    title: 'Direct Probe',
    channels: [
      {
        channel: 'telegram',
        organizationId: 'org-b',
        connectorKey: 'org-b-tg',
        secrets: { botToken: '998877665:AAInjectedAttackerBotToken9999', defaultChatId: '-100999' },
        connector: { connectorKey: 'org-b-tg', baseUrl: 'https://api.telegram.org', organizationId: 'org-b' },
        allowInternal: true,
      },
    ],
  }, { fetchImpl });
  assert.equal(fetchCalled, false);
  assert.equal(directRes.organizationId, 'org-a');
  assert.equal(directRes.okCount, 0);
  assert.equal(directRes.failedCount, 1);
  assert.equal(directRes.deliveries[0].organizationId, 'org-a');
  assert.equal(directRes.deliveries[0].errorCode, 'CONNECTOR_NOT_FOUND');
  assert.equal(deliveries.some((d) => d.organizationId === 'org-b'), false);
});

test('registerOmnichannelNotifyDirectGuard verifies currentRole=root against rolesUsers and blocks forged root', async () => {
  const { db } = makeInMemoryNotifyDb();
  const { app, middlewares } = makeAppHarness(db);
  const { registerOmnichannelNotify } = require('../src/server/omnichannel-notify');

  registerOmnichannelNotify(app);

  // Forged currentRole='root' by ldx_employee (userId: 20) MUST be blocked (403)
  await assert.rejects(
    () => runMiddlewares(
      middlewares,
      makeHttpCtx({
        method: 'GET',
        state: { currentUser: { id: 20 }, currentRole: 'root', currentRoles: ['root'] },
        resourceName: 'latticeNotificationDeliveries',
        actionName: 'list',
      }),
    ),
    (err) => err.code === 'NOTIFY_DIRECT_CRUD_FORBIDDEN' && err.status === 403,
  );

  await assert.rejects(
    () => runMiddlewares(
      middlewares,
      makeHttpCtx({
        method: 'POST',
        state: { currentUser: { id: 20 }, currentRole: 'root', currentRoles: ['root'] },
        resourceName: 'charts',
        actionName: 'queryData',
        values: { collection: 'latticeNotificationDeliveries' },
      }),
    ),
    (err) => err.code === 'NOTIFY_DIRECT_CRUD_FORBIDDEN' && err.status === 403,
  );

  // Verified root (userId: 1 has roleName='root' in rolesUsers) is allowed
  let handlerReached = false;
  await runMiddlewares(
    middlewares,
    makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 1 }, currentRole: 'root', currentRoles: ['root'] },
      resourceName: 'latticeNotificationDeliveries',
      actionName: 'list',
    }),
    async () => {
      handlerReached = true;
    },
  );
  assert.equal(handlerReached, true);
});

test('sendSmtpEmail validates custom headers in pre-flight before opening socket', async () => {
  const { sendSmtpEmail } = require('../src/server/omnichannel-notify');

  let socketOpened = 0;
  await assert.rejects(
    () => sendSmtpEmail({
      host: 'smtp.public-partner.example',
      port: 587,
      from: 'noreply@example.org',
      to: 'ops@example.org',
      subject: 'Normal Subject',
      text: 'Hello',
      headers: { 'X-Custom': 'ok\r\nBcc: attacker@evil.example' },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      netConnectImpl: () => {
        socketOpened += 1;
        throw new Error('should not connect');
      },
    }),
    (err) => err.code === 'SMTP_HEADER_INJECTION_BLOCKED' && err.status === 400,
  );
  assert.equal(socketOpened, 0);

  await assert.rejects(
    () => sendSmtpEmail({
      host: 'smtp.public-partner.example',
      port: 587,
      from: 'noreply@example.org',
      to: 'ops@example.org',
      subject: 'Normal Subject',
      text: 'Hello',
      headers: { 'Bad Header': 'value' },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      netConnectImpl: () => {
        socketOpened += 1;
        throw new Error('should not connect');
      },
    }),
    (err) => err.code === 'SMTP_HEADER_INVALID' && err.status === 400,
  );
  assert.equal(socketOpened, 0);
});

test('dispatchChannelNotification brackets IPv6 hosts in SMTP dryRun, honors secrets.secure, and guards notificationId against NaN', async () => {
  const { db, deliveries } = makeInMemoryNotifyDb();
  const { dispatchChannelNotification } = require('../src/server/omnichannel-notify');

  // 1. IPv6 host in SMTP dryRun produces bracketed URL -> Blocked IPv6 error (not Malformed connector URL)
  const ipv6DryRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'smtp',
    host: '::ffff:127.0.0.1',
    port: 587,
    from: 'noreply@example.org',
    to: 'ops@example.org',
    subject: 'IPv6 Probe',
    dryRun: true,
  });
  assert.equal(ipv6DryRes.ok, false);
  assert.equal(ipv6DryRes.status, 'blocked');
  assert.equal(ipv6DryRes.errorCode, 'CONNECTOR_URL_UNSAFE');
  assert.match(ipv6DryRes.errorMessage, /Blocked IPv6/i);

  // 2. dryRun honors secrets.secure (port 465 default when secure=true and port omitted)
  await seedVaultConnector(db, {
    id: 31,
    organizationId: 'org-a',
    connectorKey: 'smtp-smtps',
    connectorType: 'smtp_notify',
    appType: 'email_smtp',
    baseUrl: 'smtps://smtp.partner.example:465',
    authType: 'basic',
    secrets: {
      host: 'smtp.partner.example',
      secure: true,
      username: 'mailer@partner.example',
      password: 'smtp_vault_password_secure',
      fromEmail: 'noreply@partner.example',
    },
  });
  const secureDryRes = await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'smtp',
    connectorKey: 'smtp-smtps',
    to: 'ops@partner.example',
    subject: 'Secure DryRun',
    dryRun: true,
  }, {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(secureDryRes.ok, true);
  assert.equal(secureDryRes.status, 'dry_run');

  // 3. notificationId coercion guards against NaN / non-positive / non-integer values
  await seedVaultConnector(db, {
    id: 32,
    organizationId: 'org-a',
    connectorKey: 'hook-notif-id',
    connectorType: 'webhook',
    appType: 'partner_webhook',
    baseUrl: 'https://hooks.partner.example/notif',
    authType: 'none',
    secrets: { url: 'https://hooks.partner.example/notif' },
  });

  for (const badId of ['not-a-number', '', '   ', -10, 0, 1.5, true, Infinity]) {
    await dispatchChannelNotification(db, {
      organizationId: 'org-a',
      channel: 'webhook',
      connectorKey: 'hook-notif-id',
      notificationId: badId,
      dryRun: true,
    }, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const lastRow = deliveries[deliveries.length - 1];
    assert.equal(lastRow.notificationId, null, `Expected null for notificationId=${String(badId)}, got ${lastRow.notificationId}`);
  }

  await dispatchChannelNotification(db, {
    organizationId: 'org-a',
    channel: 'webhook',
    connectorKey: 'hook-notif-id',
    notificationId: '42',
    dryRun: true,
  }, {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(deliveries[deliveries.length - 1].notificationId, 42);
});

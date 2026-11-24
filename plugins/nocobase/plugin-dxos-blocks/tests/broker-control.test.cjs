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
const net = require('node:net');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../../..');

function loadWithStubs(filePath, stubs = {}) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  } finally {
    Module._load = origLoad;
  }
}

function decodeRemainingLength(buf, offset) {
  let multiplier = 1;
  let value = 0;
  let pos = offset;
  let digit;
  do {
    assert.ok(pos < buf.length, 'Truncated MQTT remaining length');
    digit = buf[pos++];
    value += (digit & 0x7f) * multiplier;
    multiplier *= 128;
  } while ((digit & 0x80) !== 0);
  return { value, nextOffset: pos };
}

function decodeMqttString(buf, offset) {
  assert.ok(offset + 2 <= buf.length, 'Truncated MQTT string length');
  const len = buf.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + len;
  assert.ok(end <= buf.length, 'Truncated MQTT string bytes');
  return { value: buf.subarray(start, end).toString('utf8'), nextOffset: end };
}

function parseMqttConnect(packet) {
  assert.equal(packet[0], 0x10, 'Expected CONNECT packet type 0x10');
  const { value: remLen, nextOffset: vhStart } = decodeRemainingLength(packet, 1);
  assert.equal(packet.length, vhStart + remLen);
  const proto = decodeMqttString(packet, vhStart);
  assert.equal(proto.value, 'MQTT');
  const level = packet[proto.nextOffset];
  const flags = packet[proto.nextOffset + 1];
  const keepAlive = packet.readUInt16BE(proto.nextOffset + 2);
  let pos = proto.nextOffset + 4;
  const clientId = decodeMqttString(packet, pos);
  pos = clientId.nextOffset;
  let username = null;
  let password = null;
  if (flags & 0x80) {
    const u = decodeMqttString(packet, pos);
    username = u.value;
    pos = u.nextOffset;
  }
  if (flags & 0x40) {
    const p = decodeMqttString(packet, pos);
    password = p.value;
    pos = p.nextOffset;
  }
  assert.equal(pos, packet.length);
  return { level, flags, keepAlive, clientId: clientId.value, username, password };
}

function parseMqttPublishAndDisconnect(buf) {
  assert.equal(buf[0] & 0xf0, 0x30, 'Expected PUBLISH packet type 0x30');
  const qos = (buf[0] >> 1) & 0x03;
  const { value: remLen, nextOffset: vhStart } = decodeRemainingLength(buf, 1);
  const pubEnd = vhStart + remLen;
  const topicRes = decodeMqttString(buf, vhStart);
  let payloadStart = topicRes.nextOffset;
  if (qos > 0) payloadStart += 2;
  const payloadText = buf.subarray(payloadStart, pubEnd).toString('utf8');
  const trailing = buf.subarray(pubEnd);
  assert.deepEqual(trailing, Buffer.from([0xe0, 0x00]), 'Expected DISCONNECT 0xe0 0x00 right after PUBLISH');
  return { qos, topic: topicRes.value, payloadText };
}

async function startMockMqttServer({ connackCode = 0x00, hangConnack = false } = {}) {
  const captured = [];
  const server = net.createServer((socket) => {
    let phase = 'connect';
    let rx = Buffer.alloc(0);
    const record = { connect: null, publish: null };
    captured.push(record);

    socket.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      if (phase === 'connect') {
        if (rx.length < 2) return;
        const { value: remLen, nextOffset } = decodeRemainingLength(rx, 1);
        if (rx.length < nextOffset + remLen) return;
        const connectPkt = rx.subarray(0, nextOffset + remLen);
        rx = rx.subarray(nextOffset + remLen);
        record.connect = parseMqttConnect(connectPkt);
        phase = 'publish';
        if (!hangConnack) {
          socket.write(Buffer.from([0x20, 0x02, 0x00, connackCode]));
        }
      }
      if (phase === 'publish' && rx.length >= 2) {
        const { value: remLen, nextOffset } = decodeRemainingLength(rx, 1);
        const pubEnd = nextOffset + remLen;
        if (rx.length >= pubEnd + 2) {
          record.publish = parseMqttPublishAndDisconnect(rx.subarray(0, pubEnd + 2));
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    port: addr.port,
    captured,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeBrokerHarness({ initialDevices = [], initialSubs = [], rolesUsers = [] } = {}) {
  let seq = 100;
  const devices = [...initialDevices];
  const subscriptions = [...initialSubs];
  const telemetryPoints = [];
  const quarantined = [];
  const incidents = [];
  const notifications = [];
  const domainEvents = [];

  const assets = [
    { id: 12, code: 'COLD-A1', name: 'Kho lạnh Vaccine A1', organizationId: 'org-a', status: 'active', active: true },
    { id: 99, code: 'COLD-B1', name: 'Kho lạnh Org B', organizationId: 'org-b', status: 'active', active: true },
  ];
  const locations = [
    { id: 3, code: 'LOC-CT', name: 'Kho Cần Thơ', organizationId: 'org-a', active: true },
  ];
  const rules = [
    {
      id: 7,
      code: 'TEMP-HIGH',
      name: 'Cảnh báo nhiệt cao',
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '-15',
      unit: 'CEL',
      severity: 'high',
      handlerId: '5',
      active: true,
    },
  ];
  const employees = [
    { id: 5, userId: 101, organizationId: 'org-a', active: true },
    { id: 6, userId: 102, organizationId: 'org-a', active: true },
    { id: 9, userId: 201, organizationId: 'org-b', active: true },
  ];
  const roles = [
    { name: 'root', allowAll: true },
    { name: 'ldx_admin', allowAll: false, allowConfigure: false },
    { name: 'ldx_operator', allowAll: false },
    { name: 'ldx_manager', allowAll: false },
    { name: 'ldx_director', allowAll: false },
    { name: 'ldx_employee', allowAll: false },
  ];

  const matchFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (cond.$eq !== undefined) return row[k] === cond.$eq;
    }
    return row[k] === cond;
  });

  const makeRepo = (arr) => ({
    find: async ({ filter = {}, limit = 100 } = {}) => arr.filter((r) => matchFilter(r, filter)).slice(0, limit),
    findOne: async ({ filter = {}, filterByTk } = {}) => {
      if (filterByTk != null) return arr.find((r) => Number(r.id) === Number(filterByTk)) || null;
      return arr.find((r) => matchFilter(r, filter)) || null;
    },
    count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
    create: async ({ values }) => {
      const row = {
        id: ++seq,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...values,
        update: async (patch) => Object.assign(row, patch, { updatedAt: new Date() }),
        destroy: async () => {
          const idx = arr.indexOf(row);
          if (idx >= 0) arr.splice(idx, 1);
        },
      };
      arr.push(row);
      return row;
    },
    update: async ({ filterByTk, filter = {}, values }) => {
      const updated = [];
      for (const row of arr) {
        const hitTk = filterByTk == null || Number(row.id) === Number(filterByTk);
        if (hitTk && matchFilter(row, filter)) {
          Object.assign(row, values, { updatedAt: new Date() });
          updated.push(row);
        }
      }
      return updated;
    },
    destroy: async ({ filter = {} } = {}) => {
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (matchFilter(arr[i], filter)) arr.splice(i, 1);
      }
    },
  });

  const app = {
    latticeEvents: {
      publishDomainEvent: async (dbOrEv, maybeEv) => {
        const ev = maybeEv !== undefined ? maybeEv : dbOrEv;
        domainEvents.push(ev);
        return ev;
      },
    },
  };

  const db = {
    app,
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (fn) => fn({ id: 'tx-broker' }),
    },
    getRepository(name) {
      if (name === 'latticeIotDevices') return makeRepo(devices);
      if (name === 'latticeBrokerSubscriptions') return makeRepo(subscriptions);
      if (name === 'latticeTelemetryPoints') return makeRepo(telemetryPoints);
      if (name === 'latticeDataQuarantine') return makeRepo(quarantined);
      if (name === 'latticeIncidentCases') return makeRepo(incidents);
      if (name === 'latticeIncidentRules') return makeRepo(rules);
      if (name === 'latticeNotifications') return makeRepo(notifications);
      if (name === 'latticeAssets') return makeRepo(assets);
      if (name === 'latticeLocations') return makeRepo(locations);
      if (name === 'latticeEmployees') return makeRepo(employees);
      if (name === 'roles') return makeRepo(roles);
      if (name === 'rolesUsers' && rolesUsers.length) return makeRepo(rolesUsers);
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter = {} } = {}) => (
            filter.roleName === 'ldx_operator' || filter.roleName === 'ldx_manager' || filter.roleName === 'ldx_admin'
              ? { roleName: filter.roleName, name: filter.name, usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }, { name: 'update' }] }
              : { roleName: filter.roleName, name: filter.name, usingActionsConfig: true, actions: [{ name: 'view' }] }
          ),
        };
      }
      return null;
    },
  };

  return {
    db,
    app,
    devices,
    subscriptions,
    telemetryPoints,
    quarantined,
    incidents,
    domainEvents,
  };
}

test('collections iot-devices & broker-subscriptions and migration 20261125000200 define schema, unique indexes, and reversible PG RLS', async () => {
  const { addSourceHeader } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/source-headers.mjs')).href);

  const devColPath = path.join(PLUGIN_ROOT, 'src/server/collections/iot-devices.js');
  const subColPath = path.join(PLUGIN_ROOT, 'src/server/collections/broker-subscriptions.js');
  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261125000200-broker-devices-and-subscriptions.js');

  for (const filePath of [
    devColPath,
    subColPath,
    migPath,
    path.join(PLUGIN_ROOT, 'src/server/domain-events.js'),
    path.join(PLUGIN_ROOT, 'src/server/broker-control.js'),
    path.join(PLUGIN_ROOT, 'tests/broker-control.test.cjs'),
  ]) {
    const src = readFileSync(filePath, 'utf8');
    assert.equal(addSourceHeader(src, filePath).status, 'present', `Missing SPDX header in ${filePath}`);
  }

  const devCol = loadWithStubs(devColPath, { '@nocobase/database': { defineCollection: (d) => d } });
  assert.equal(devCol.name, 'latticeIotDevices');
  assert.deepEqual(devCol.migrationRules, ['schema-only']);
  for (const f of ['organizationId', 'deviceKey', 'name', 'mqttUsername', 'mqttClientId', 'assetId', 'assetEntityId', 'topicPrefix', 'status', 'lastSeenAt', 'lastReason', 'metadataJson']) {
    assert.ok(devCol.fields.some((x) => x.name === f), `latticeIotDevices missing field ${f}`);
  }
  assert.ok(devCol.indexes.some((i) => i.unique === true && i.fields.join(',') === 'organizationId,deviceKey'));

  const subCol = loadWithStubs(subColPath, { '@nocobase/database': { defineCollection: (d) => d } });
  assert.equal(subCol.name, 'latticeBrokerSubscriptions');
  assert.deepEqual(subCol.migrationRules, ['schema-only']);
  for (const f of ['organizationId', 'subscriptionKey', 'brokerType', 'externalSubscriptionId', 'entityType', 'watchedAttributesJson', 'notificationEndpoint', 'throttlingSec', 'active', 'lastNotifiedAt', 'lastError']) {
    assert.ok(subCol.fields.some((x) => x.name === f), `latticeBrokerSubscriptions missing field ${f}`);
  }
  assert.ok(subCol.indexes.some((i) => i.unique === true && i.fields.join(',') === 'organizationId,subscriptionKey'));

  const migSrc = readFileSync(migPath, 'utf8');
  assert.doesNotMatch(migSrc, /\bUNIQUE\s*,/i, 'Must not declare duplicate inline UNIQUE alongside CREATE UNIQUE INDEX');

  const MigrationCls = loadWithStubs(migPath, {
    '@nocobase/server': { Migration: class { constructor(ctx) { this.context = ctx; this.db = ctx.db; } } },
  });
  const sqlLog = [];
  const rlsAttached = [];
  const rlsDetached = [];
  const pgMig = new MigrationCls({
    db: {
      attachLatticeRlsPolicy: async (tableName, opts) => { rlsAttached.push({ tableName, hasTx: Boolean(opts?.transaction) }); },
      detachLatticeRlsPolicy: async (tableName, opts) => { rlsDetached.push({ tableName, hasTx: Boolean(opts?.transaction) }); },
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn({ id: 'tx-pg' }),
        query: async (sql) => { sqlLog.push(sql); return [[]]; },
      },
    },
  });
  assert.equal(pgMig.on, 'afterSync');
  await pgMig.up();
  assert.ok(sqlLog.some((q) => q.includes('CREATE TABLE IF NOT EXISTS "latticeIotDevices"')));
  assert.ok(sqlLog.some((q) => q.includes('CREATE TABLE IF NOT EXISTS "latticeBrokerSubscriptions"')));
  assert.ok(sqlLog.some((q) => q.includes('CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_iot_devices_org_key')));
  assert.ok(sqlLog.some((q) => q.includes('CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_broker_subs_org_key')));
  assert.deepEqual(rlsAttached, [
    { tableName: 'latticeIotDevices', hasTx: true },
    { tableName: 'latticeBrokerSubscriptions', hasTx: true },
  ]);

  await pgMig.down();
  assert.deepEqual(rlsDetached, [
    { tableName: 'latticeBrokerSubscriptions', hasTx: true },
    { tableName: 'latticeIotDevices', hasTx: true },
  ]);
  assert.ok(sqlLog.some((q) => q.includes('DROP TABLE IF EXISTS "latticeBrokerSubscriptions"')));
  assert.ok(sqlLog.some((q) => q.includes('DROP TABLE IF EXISTS "latticeIotDevices"')));
});

test('pure node:net MQTT 3.1.1 client encodes CONNECT/PUBLISH/DISCONNECT over real TCP loopback and rejects malformed or unauthorized brokers', async () => {
  const {
    encodeMqttString,
    encodeRemainingLength,
    buildConnectPacket,
    buildPublishPacket,
    buildDisconnectPacket,
    publishMqttControl,
    DYNSEC_CONTROL_TOPIC,
  } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));

  assert.deepEqual(encodeMqttString('MQTT'), Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]));
  assert.deepEqual(encodeRemainingLength(0), Buffer.from([0x00]));
  assert.deepEqual(encodeRemainingLength(127), Buffer.from([0x7f]));
  assert.deepEqual(encodeRemainingLength(128), Buffer.from([0x80, 0x01]));
  assert.deepEqual(encodeRemainingLength(16384), Buffer.from([0x80, 0x80, 0x01]));
  assert.deepEqual(buildDisconnectPacket(), Buffer.from([0xe0, 0x00]));

  assert.throws(() => encodeMqttString('a'.repeat(65536)), (e) => e.code === 'MQTT_STRING_TOO_LONG');
  assert.throws(() => encodeRemainingLength(-1), (e) => e.code === 'MQTT_REMAINING_LENGTH_INVALID');
  assert.throws(() => encodeRemainingLength(268435456), (e) => e.code === 'MQTT_REMAINING_LENGTH_INVALID');
  assert.throws(() => buildConnectPacket({ clientId: 'c1', password: 'secret' }), (e) => e.code === 'MQTT_PASSWORD_REQUIRES_USERNAME');
  assert.throws(() => buildPublishPacket({ topic: 'latticedx/+/bad', payload: '{}' }), (e) => e.code === 'MQTT_TOPIC_INVALID');
  assert.throws(() => buildPublishPacket({ topic: DYNSEC_CONTROL_TOPIC, payload: 'x'.repeat(65600) }), (e) => e.code === 'MQTT_PACKET_TOO_LARGE');

  const okServer = await startMockMqttServer({ connackCode: 0x00 });
  try {
    const dynsecPayload = JSON.stringify({ commands: [{ command: 'listRoles' }] });
    const res = await publishMqttControl({
      host: '127.0.0.1',
      port: okServer.port,
      username: 'ldx_mqtt_admin',
      password: 'super-secret-admin-pw',
      clientId: 'ldx-ctrl-test',
      topic: DYNSEC_CONTROL_TOPIC,
      payload: dynsecPayload,
      timeoutMs: 2000,
    });
    assert.equal(res.published, true);
    assert.equal(res.topic, '$CONTROL/dynamic-security/v1');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(okServer.captured.length, 1);
    assert.deepEqual(okServer.captured[0].connect, {
      level: 0x04,
      flags: 0xc2,
      keepAlive: 30,
      clientId: 'ldx-ctrl-test',
      username: 'ldx_mqtt_admin',
      password: 'super-secret-admin-pw',
    });
    assert.equal(okServer.captured[0].publish.qos, 0);
    assert.equal(okServer.captured[0].publish.topic, '$CONTROL/dynamic-security/v1');
    assert.equal(okServer.captured[0].publish.payloadText, dynsecPayload);
  } finally {
    await okServer.close();
  }

  // Non-zero CONNACK code rejected
  const denyServer = await startMockMqttServer({ connackCode: 0x05 });
  try {
    await assert.rejects(
      () => publishMqttControl({
        host: '127.0.0.1',
        port: denyServer.port,
        username: 'bad',
        password: 'bad',
        payload: '{}',
        timeoutMs: 2000,
      }),
      (err) => err.code === 'MQTT_CONNACK_REJECTED' && err.returnCode === 0x05,
    );
  } finally {
    await denyServer.close();
  }

  // Stalled server times out cleanly
  const hangServer = await startMockMqttServer({ hangConnack: true });
  try {
    await assert.rejects(
      () => publishMqttControl({
        host: '127.0.0.1',
        port: hangServer.port,
        payload: '{}',
        timeoutMs: 120,
      }),
      (err) => err.code === 'MQTT_TIMEOUT',
    );
  } finally {
    await hangServer.close();
  }
});

test('dxosBroker provisionDevice, listDevices, and revokeDevice enforce RBAC, publish DynSec commands, mask DB secrets, and emit CloudEvents', async () => {
  const { createDxosBrokerActions } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));
  const mqttSrv = await startMockMqttServer({ connackCode: 0x00 });
  const h = makeBrokerHarness();

  try {
    const actions = createDxosBrokerActions(h.db, {
      mqtt: {
        host: '127.0.0.1',
        port: mqttSrv.port,
        username: 'ldx_mqtt_admin',
        password: 'admin-password-test',
      },
    });

    // Employee & read-only Director cannot provision
    for (const deniedRole of ['ldx_employee', 'ldx_director']) {
      await assert.rejects(
        () => actions.provisionDevice({
          method: 'POST',
          state: { currentUser: { id: 101 }, currentRole: deniedRole },
          action: { params: { values: { deviceKey: 'cold-s1', name: 'Sensor 1' } } },
        }, async () => {}),
        (err) => err.status === 403 && err.code === 'DXOS_BROKER_FORBIDDEN',
      );
    }

    // Cross-org asset URN blocked 403
    await assert.rejects(
      () => actions.provisionDevice({
        method: 'POST',
        state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
        action: { params: { values: { deviceKey: 'cold-s1', name: 'Sensor 1', assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99' } } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_CROSS_ORG_FORBIDDEN',
    );

    // Valid provisionDevice sends real DynSec TCP packet & saves masked device row
    const provCtx = {
      method: 'POST',
      app: h.app,
      state: { currentUser: { id: 101, username: 'op-a' }, currentRole: 'ldx_operator' },
      action: { params: { values: { deviceKey: 'cold-sensor-01', name: 'Cảm biến Kho 12', assetId: 12 } } },
    };
    await actions.provisionDevice(provCtx, async () => {});

    assert.equal(provCtx.body.brokerSynced, true);
    assert.ok(typeof provCtx.body.mqttPassword === 'string' && provCtx.body.mqttPassword.length >= 20);
    assert.equal(provCtx.body.device.deviceKey, 'cold-sensor-01');
    assert.equal(provCtx.body.device.topicPrefix, 'latticedx/org-a/cold-sensor-01');
    assert.equal(provCtx.body.device.assetEntityId, 'urn:ngsi-ld:Asset:org-a:native:12');
    assert.equal(provCtx.body.device.status, 'provisioned');

    // Stored DB row MUST NEVER contain raw mqttPassword
    assert.equal(h.devices.length, 1);
    const dbDump = JSON.stringify(h.devices[0]);
    assert.equal(dbDump.includes(provCtx.body.mqttPassword), false, 'Raw mqttPassword must NEVER be persisted in DB');

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mqttSrv.captured.length, 1);
    const dynsecCmds = JSON.parse(mqttSrv.captured[0].publish.payloadText).commands;
    assert.ok(dynsecCmds.some((c) => c.command === 'createRole' && c.rolename === 'role_org-a_cold-sensor-01'));
    assert.ok(dynsecCmds.some((c) => c.command === 'addRoleACL' && c.acltype === 'publishClientSend' && c.topic === 'latticedx/org-a/cold-sensor-01/#' && c.allow === true));
    assert.ok(dynsecCmds.some((c) => c.command === 'addRoleACL' && c.acltype === 'subscribePattern' && c.topic === 'latticedx/org-a/cold-sensor-01/command' && c.allow === true));
    assert.ok(dynsecCmds.some((c) => c.command === 'addRoleACL' && c.acltype === 'subscribePattern' && c.topic === 'latticedx/org-a/cold-sensor-01/ack' && c.allow === true));
    assert.ok(dynsecCmds.some((c) => c.command === 'addRoleACL' && c.acltype === 'publishClientReceive' && c.topic === 'latticedx/org-a/cold-sensor-01/command' && c.allow === true));
    assert.ok(dynsecCmds.some((c) => c.command === 'addRoleACL' && c.acltype === 'publishClientReceive' && c.topic === 'latticedx/org-a/cold-sensor-01/ack' && c.allow === true));
    assert.ok(dynsecCmds.some((c) => c.command === 'createClient' && c.username === 'ldx_org-a_cold-sensor-01' && c.password === provCtx.body.mqttPassword));
    assert.ok(dynsecCmds.some((c) => c.command === 'addClientRole' && c.username === 'ldx_org-a_cold-sensor-01' && c.rolename === 'role_org-a_cold-sensor-01'));

    // Event bus emitted device.provisioned without password
    const provEv = h.domainEvents.find((e) => e.eventType === 'device.provisioned');
    assert.ok(provEv);
    assert.equal(JSON.stringify(provEv).includes(provCtx.body.mqttPassword), false);

    // Org B cannot list or revoke Org A device
    const listBCtx = {
      method: 'GET',
      state: { currentUser: { id: 201 }, currentRole: 'ldx_admin' },
      action: { params: {} },
    };
    await actions.listDevices(listBCtx, async () => {});
    assert.equal(listBCtx.body.items.length, 0);

    await assert.rejects(
      () => actions.revokeDevice({
        method: 'POST',
        state: { currentUser: { id: 201 }, currentRole: 'ldx_admin' },
        action: { params: { values: { deviceKey: 'cold-sensor-01' } } },
      }, async () => {}),
      (err) => err.status === 404,
    );

    // Org A revokes device -> publishes disableClient + deleteClient & emits device.revoked
    const revCtx = {
      method: 'POST',
      app: h.app,
      state: { currentUser: { id: 101, username: 'op-a' }, currentRole: 'ldx_operator' },
      action: { params: { values: { deviceKey: 'cold-sensor-01', reason: 'sensor_replaced' } } },
    };
    await actions.revokeDevice(revCtx, async () => {});
    assert.equal(revCtx.body.device.status, 'revoked');
    assert.equal(revCtx.body.brokerSynced, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mqttSrv.captured.length, 2);
    const revCmds = JSON.parse(mqttSrv.captured[1].publish.payloadText).commands;
    assert.deepEqual(revCmds, [
      { command: 'disableClient', username: 'ldx_org-a_cold-sensor-01' },
      { command: 'deleteClient', username: 'ldx_org-a_cold-sensor-01' },
    ]);
    assert.ok(h.domainEvents.some((e) => e.eventType === 'device.revoked' && e.data?.deviceKey === 'cold-sensor-01'));
  } finally {
    await mqttSrv.close();
  }

  // Graceful skip with brokerSynced: false when MQTT unconfigured
  const h2 = makeBrokerHarness();
  const offlineActions = createDxosBrokerActions(h2.db, { env: {} });
  const offlineCtx = {
    method: 'POST',
    app: h2.app,
    state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
    action: { params: { values: { deviceKey: 'offline-dev', name: 'Offline Dev' } } },
  };
  await offlineActions.provisionDevice(offlineCtx, async () => {});
  assert.equal(offlineCtx.body.brokerSynced, false);
  assert.equal(h2.devices.length, 1);
});

test('dxosBroker:deviceStatusIngest fails closed on auth, normalizes BIRTH/DEATH LWT, opens deduplicated incident, and emits device.offline', async () => {
  const { createDxosBrokerActions } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));
  const h = makeBrokerHarness({
    initialDevices: [
      {
        id: 1,
        organizationId: 'org-a',
        deviceKey: 'sensor-12',
        name: 'Đầu dò Kho 12',
        mqttUsername: 'ldx_org-a_sensor-12',
        mqttClientId: 'ldx-org-a-sensor-12',
        assetId: 12,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
        topicPrefix: 'latticedx/org-a/sensor-12',
        status: 'provisioned',
        metadataJson: {},
      },
    ],
  });
  const edgeToken = 'edge-secret-token-2026-0123456789';
  const actions = createDxosBrokerActions(h.db, { ingestToken: edgeToken });

  // Unauthenticated / invalid edge token rejected 401
  await assert.rejects(
    () => actions.deviceStatusIngest({
      method: 'POST',
      headers: {},
      state: {},
      action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-12', status: 'DEATH' } } },
    }, async () => {}),
    (err) => err.status === 401,
  );
  await assert.rejects(
    () => actions.deviceStatusIngest({
      method: 'POST',
      headers: { 'X-Lattice-Edge-Token': 'wrong-token-value-1234567890' },
      state: {},
      action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-12', status: 'DEATH' } } },
    }, async () => {}),
    (err) => err.status === 401,
  );

  // BIRTH -> online (no offline incident/event)
  const birthCtx = {
    method: 'POST',
    app: h.app,
    headers: { 'X-Lattice-Edge-Token': edgeToken },
    state: {},
    action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-12', status: 'BIRTH' } } },
  };
  await actions.deviceStatusIngest(birthCtx, async () => {});
  assert.equal(birthCtx.body.device.status, 'online');
  assert.equal(birthCtx.body.transitionedToOffline, false);
  assert.equal(h.incidents.length, 0);

  // DEATH / LWT -> offline, creates high incident case + emits alarm.triggered + device.offline CloudEvents
  const deathCtx = {
    method: 'POST',
    app: h.app,
    headers: { 'X-Lattice-Edge-Token': edgeToken },
    state: {},
    action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-12', status: 'DEATH', reason: 'mqtt_lwt_disconnect' } } },
  };
  await actions.deviceStatusIngest(deathCtx, async () => {});
  assert.equal(deathCtx.body.device.status, 'offline');
  assert.equal(deathCtx.body.transitionedToOffline, true);
  assert.ok(deathCtx.body.incident?.code?.startsWith('ALM-'));
  assert.equal(h.incidents.length, 1);
  assert.equal(h.incidents[0].severity, 'high');
  assert.ok(h.domainEvents.some((e) => e.eventType === 'alarm.triggered' && e.data?.ruleCode === 'MQTT-LWT-OFFLINE'));
  assert.ok(h.domainEvents.some((e) => e.eventType === 'device.offline' && e.data?.deviceKey === 'sensor-12' && e.data?.reason === 'mqtt_lwt_disconnect'));

  // Repeated LWT while already offline does NOT duplicate events
  const eventCountBefore = h.domainEvents.length;
  const dupDeathCtx = {
    method: 'POST',
    app: h.app,
    headers: { 'X-Lattice-Edge-Token': edgeToken },
    state: {},
    action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-12', status: 'LWT' } } },
  };
  await actions.deviceStatusIngest(dupDeathCtx, async () => {});
  assert.equal(dupDeathCtx.body.transitionedToOffline, false);
  assert.equal(h.domainEvents.length, eventCountBefore);
});

test('Orion-LD SSRF guard, orionEntities diff, subscription CRUD, and orionNotify telemetry + CloudEvent ingestion', async () => {
  const {
    validateOrionBrokerUrl,
    validateCallbackUrl,
    createDxosBrokerActions,
  } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));

  // SSRF validation
  assert.equal(validateOrionBrokerUrl('http://orion-ld:1026'), 'http://orion-ld:1026');
  assert.equal(validateOrionBrokerUrl('http://localhost:1026/'), 'http://localhost:1026');
  assert.equal(validateOrionBrokerUrl('http://127.0.0.1:1026'), 'http://127.0.0.1:1026');
  assert.equal(validateOrionBrokerUrl('https://broker.example.org/ngsi-ld'), 'https://broker.example.org');
  for (const badUrl of [
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5:1026',
    'http://192.168.1.50:1026',
    'http://172.18.0.5:1026',
    'http://[fe80::1]:1026',
    'http://metadata.google.internal/',
    'http://user:pass@orion-ld:1026',
    'ftp://orion-ld:21',
  ]) {
    assert.throws(() => validateOrionBrokerUrl(badUrl), (err) => err.code === 'BROKER_URL_FORBIDDEN');
  }
  assert.throws(() => validateCallbackUrl('http://169.254.169.254/hook'), (err) => err.code === 'BROKER_CALLBACK_FORBIDDEN');

  const h = makeBrokerHarness();
  const edgeToken = 'orion-edge-token-2026-0123456789';
  const orionRequests = [];
  const orionSubs = new Map();

  const fetchImpl = async (url, init = {}) => {
    orionRequests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.includes('/ngsi-ld/v1/entities')) {
      return new Response(JSON.stringify([
        {
          id: 'urn:ngsi-ld:Asset:org-a:native:12',
          type: 'Asset',
          name: { type: 'Property', value: 'Kho lạnh Vaccine A1' },
          status: { type: 'Property', value: 'warning' },
          temperature: { type: 'Property', value: -13.5, unitCode: 'CEL' },
        },
        {
          id: 'urn:ngsi-ld:Asset:org-a:external:ext-9',
          type: 'Asset',
          name: { type: 'Property', value: 'External Sensor' },
        },
      ]), { status: 200 });
    }
    if (url.endsWith('/ngsi-ld/v1/subscriptions') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      orionSubs.set(body.id, body);
      return new Response('', {
        status: 201,
        headers: { Location: `/ngsi-ld/v1/subscriptions/${body.id}` },
      });
    }
    if (url.includes('/ngsi-ld/v1/subscriptions') && init.method === 'GET') {
      return new Response(JSON.stringify([...orionSubs.values()]), { status: 200 });
    }
    if (url.includes('/ngsi-ld/v1/subscriptions/') && init.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    if (url.includes('/ngsi-ld/v1/subscriptions/') && init.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 404 });
  };

  const actions = createDxosBrokerActions(h.db, {
    brokerUrl: 'http://orion-ld:1026',
    fetchImpl,
    ingestToken: edgeToken,
  });

  // 1. orionEntities compares live Orion entities vs local assets & locations
  const entCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_manager' },
    action: { params: {} },
  };
  await actions.orionEntities(entCtx, async () => {});
  assert.equal(entCtx.body.orionReachable, true);
  assert.equal(entCtx.body.matched.length, 1);
  assert.equal(entCtx.body.matched[0].entityId, 'urn:ngsi-ld:Asset:org-a:native:12');
  assert.equal(entCtx.body.matched[0].inSync, false);
  assert.equal(entCtx.body.matched[0].attrDiff[0].attribute, 'status');
  assert.equal(entCtx.body.orionOnly.length, 1);
  assert.equal(entCtx.body.localOnly.length, 1);
  assert.equal(entCtx.body.localOnly[0].entityId, 'urn:ngsi-ld:Location:org-a:native:3');

  // 2. orionCreateSubscription -> always targets http://nocobase/api/dxosBroker:orionNotify with X-Lattice-Edge-Token
  const createSubCtx = {
    method: 'POST',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
    action: {
      params: {
        values: {
          subscriptionKey: 'cold-temp-watch',
          entityType: 'Asset',
          watchedAttributes: ['temperature', 'humidity'],
          throttlingSec: 10,
        },
      },
    },
  };
  await actions.orionCreateSubscription(createSubCtx, async () => {});
  assert.equal(createSubCtx.body.orionSynced, true);
  assert.equal(createSubCtx.body.subscription.notificationEndpoint, 'http://nocobase/api/dxosBroker:orionNotify');
  assert.deepEqual(createSubCtx.body.subscription.watchedAttributesJson, ['temperature', 'humidity']);
  const sentOrionBody = JSON.parse(orionRequests.find((r) => r.method === 'POST').body);
  assert.equal(sentOrionBody.notification.endpoint.uri, 'http://nocobase/api/dxosBroker:orionNotify');
  assert.deepEqual(sentOrionBody.notification.endpoint.receiverInfo, [{ key: 'X-Lattice-Edge-Token', value: edgeToken }]);
  assert.equal(JSON.stringify(h.subscriptions).includes(edgeToken), false, 'Edge token must never be stored in DB');

  // Reject unsafe override callback URL
  await assert.rejects(
    () => actions.orionCreateSubscription({
      method: 'POST',
      state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
      action: { params: { values: { subscriptionKey: 'evil-sub', entityType: 'Asset', notificationEndpoint: 'http://evil.example.com/leak' } } },
    }, async () => {}),
    (err) => err.status === 400 && err.code === 'BROKER_CALLBACK_FORBIDDEN',
  );

  // 3. orionListSubscriptions, orionToggleSubscription, orionNotify, orionDeleteSubscription
  const listSubCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_director' },
    action: { params: {} },
  };
  await actions.orionListSubscriptions(listSubCtx, async () => {});
  assert.equal(listSubCtx.body.items.length, 1);
  assert.equal(listSubCtx.body.orionReachable, true);

  const toggleCtx = {
    method: 'POST',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
    action: { params: { values: { subscriptionKey: 'cold-temp-watch', active: false } } },
  };
  await actions.orionToggleSubscription(toggleCtx, async () => {});
  assert.equal(toggleCtx.body.subscription.active, false);
  assert.equal(toggleCtx.body.orionSynced, true);

  // orionNotify: unauthorized rejected 401, cross-org rejected 403
  await assert.rejects(
    () => actions.orionNotify({
      method: 'POST',
      headers: { 'NGSILD-Tenant': 'org-a' },
      state: {},
      request: { body: { subscriptionId: 'urn:ngsi-ld:Subscription:org-a:cold-temp-watch', data: [{ id: 'urn:ngsi-ld:Asset:org-a:native:12' }] } },
    }, async () => {}),
    (err) => err.status === 401,
  );
  await assert.rejects(
    () => actions.orionNotify({
      method: 'POST',
      headers: { 'X-Lattice-Edge-Token': edgeToken, 'NGSILD-Tenant': 'org-a' },
      state: {},
      request: { body: { subscriptionId: 'urn:ngsi-ld:Subscription:org-a:cold-temp-watch', data: [{ id: 'urn:ngsi-ld:Asset:org-b:native:99', temperature: { type: 'Property', value: -10 } }] } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_CROSS_ORG_FORBIDDEN',
  );

  // Valid orionNotify extracts numeric attributes, ingests telemetry (triggering TEMP-HIGH rule -> alarm.triggered), and emits orion.notification
  const notifyCtx = {
    method: 'POST',
    app: h.app,
    headers: { 'X-Lattice-Edge-Token': edgeToken, 'NGSILD-Tenant': 'org-a' },
    state: {},
    request: {
      body: {
        id: 'urn:ngsi-ld:Notification:n1',
        type: 'Notification',
        subscriptionId: 'urn:ngsi-ld:Subscription:org-a:cold-temp-watch',
        notifiedAt: '2026-11-23T15:05:00Z',
        data: [
          {
            id: 'urn:ngsi-ld:Asset:org-a:native:12',
            type: 'Asset',
            name: { type: 'Property', value: 'Kho lạnh Vaccine A1' },
            businessId: { type: 'Property', value: '12' },
            active: { type: 'Property', value: true },
            locatedAt: { type: 'Relationship', object: 'urn:ngsi-ld:Location:org-a:native:3' },
            temperature: { type: 'Property', value: -11.2, unitCode: 'CEL', observedAt: '2026-11-23T15:04:55Z' },
          },
        ],
      },
    },
  };
  await actions.orionNotify(notifyCtx, async () => {});
  assert.equal(notifyCtx.body.ingestedCount, 1);
  assert.equal(h.telemetryPoints.length, 1);
  assert.equal(h.telemetryPoints[0].metricName, 'temperature');
  assert.equal(h.telemetryPoints[0].numericValue, -11.2);
  assert.equal(h.telemetryPoints[0].sourceProtocol, 'orion_ld');
  assert.ok(h.subscriptions[0].lastNotifiedAt);
  assert.ok(h.incidents.length === 1);
  assert.ok(h.domainEvents.some((e) => e.eventType === 'alarm.triggered' && e.data?.numericValue === -11.2));
  assert.ok(h.domainEvents.some((e) => e.eventType === 'orion.notification' && e.data?.ingestedCount === 1));

  // Delete subscription
  const delCtx = {
    method: 'POST',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
    action: { params: { values: { subscriptionKey: 'cold-temp-watch' } } },
  };
  await actions.orionDeleteSubscription(delCtx, async () => {});
  assert.equal(delCtx.body.deleted, true);
  assert.equal(delCtx.body.orionSynced, true);
  assert.equal(h.subscriptions.length, 0);

  // Offline Orion-LD fallback in orionEntities
  const offlineActions = createDxosBrokerActions(h.db, {
    brokerUrl: 'http://orion-ld:1026',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const offEntCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_manager' },
    action: { params: {} },
  };
  await offlineActions.orionEntities(offEntCtx, async () => {});
  assert.equal(offEntCtx.body.orionReachable, false);
  assert.equal(offEntCtx.body.localOnly.length, 2);
});

test('alarm-engine & digital-twin emit CloudEvents cleanly and work standalone when event-bus is absent', async () => {
  const { ingestTelemetryPoint, ingestOrDeduplicateAlarm } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  const { requestDesiredSetpoint, ackCommandFromEdge } = require(path.join(PLUGIN_ROOT, 'src/server/digital-twin.js'));
  const { emitDomainEventSafely } = require(path.join(PLUGIN_ROOT, 'src/server/domain-events.js'));

  const h = makeBrokerHarness();
  const shadows = [];
  const approvals = [];
  const origGetRepo = h.db.getRepository.bind(h.db);
  h.db.getRepository = (name) => {
    if (name === 'latticeTwinShadows') {
      return {
        findOne: async ({ filter = {} } = {}) => shadows.find((r) => r.organizationId === filter.organizationId && r.assetEntityId === filter.assetEntityId) || null,
        create: async ({ values }) => {
          const row = { id: shadows.length + 1, ...values, update: async (p) => Object.assign(row, p) };
          shadows.push(row);
          return row;
        },
        update: async ({ filterByTk, values }) => {
          const hit = shadows.find((r) => r.id === filterByTk);
          if (hit) Object.assign(hit, values);
          return hit ? [hit] : [];
        },
      };
    }
    if (name === 'latticeAiApprovalQueue') {
      return {
        create: async ({ values }) => {
          const row = { id: approvals.length + 1, ...values };
          approvals.push(row);
          return row;
        },
      };
    }
    return origGetRepo(name);
  };

  // 1. Alarm new -> emit, repeat same severity -> no duplicate event, escalated -> emit!
  await ingestTelemetryPoint(h.db, {
    organizationId: 'org-a',
    assetId: 12,
    metricName: 'temperature',
    numericValue: -12.0,
    app: h.app,
  });
  assert.equal(h.domainEvents.filter((e) => e.eventType === 'alarm.triggered').length, 1);
  assert.equal(h.domainEvents[0].data.numericValue, -12.0);
  assert.equal(h.domainEvents[0].data.metricName, 'temperature');
  assert.equal(h.domainEvents[0].data.severity, 'high');

  await ingestOrDeduplicateAlarm(h.db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-HIGH',
    attribute: 'temperature',
    severity: 'high',
    app: h.app,
  });
  assert.equal(h.domainEvents.filter((e) => e.eventType === 'alarm.triggered').length, 1);

  await ingestOrDeduplicateAlarm(h.db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-HIGH',
    attribute: 'temperature',
    severity: 'critical',
    metricName: 'temperature',
    numericValue: -5.5,
    app: h.app,
  });
  const triggeredList = h.domainEvents.filter((e) => e.eventType === 'alarm.triggered');
  assert.equal(triggeredList.length, 2);
  assert.equal(triggeredList[1].data.severity, 'critical');
  assert.equal(triggeredList[1].data.escalated, true);

  // 2. Digital Twin dispatch, HITL approval_required, and ack events
  await requestDesiredSetpoint(h.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18 },
    actor: { userId: '101', username: 'op-a' },
    app: h.app,
  });
  assert.ok(h.domainEvents.some((e) => e.eventType === 'twin.command_dispatched' && e.data?.desiredPatch?.targetTempC === -18));

  await requestDesiredSetpoint(h.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -10 },
    actor: { userId: '101', username: 'op-a' },
    app: h.app,
  });
  assert.ok(h.domainEvents.some((e) => e.eventType === 'twin.approval_required' && e.data?.deltaTempC === 8));

  await ackCommandFromEdge(h.db, {
    organizationId: 'org-a',
    assetId: 12,
    reportedPatch: { targetTempC: -18 },
    ackStatus: 'acked',
    app: h.app,
  });
  assert.ok(h.domainEvents.some((e) => e.eventType === 'twin.command_acked' && e.data?.commandStatus === 'synced'));

  // 3. Cross-plugin event-bus integration & standalone missing event-bus never throws
  const busEvents = [];
  const busDb = {
    getRepository(name) {
      if (name === 'latticeEventBus') {
        return {
          create: async ({ values }) => {
            busEvents.push(values);
            return { id: busEvents.length, ...values, update: async (p) => Object.assign(values, p) };
          },
        };
      }
      return null;
    },
  };
  const liveBusRes = await emitDomainEventSafely(busDb, { organizationId: 'org-a', eventType: 'test.cloudevent', data: { ok: true } });
  assert.equal(liveBusRes.persisted, true);
  assert.equal(liveBusRes.event.specversion, '1.0');
  assert.equal(liveBusRes.event.type, 'test.cloudevent');
  assert.equal(busEvents.length, 1);

  const domainEventsPath = path.join(PLUGIN_ROOT, 'src/server/domain-events.js');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === 'string' && request.includes('event-bus')) {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(domainEventsPath)];
    const isolatedEvents = require(domainEventsPath);
    const standaloneRes = await isolatedEvents.emitDomainEventSafely({ getRepository: () => null }, { organizationId: 'org-a', eventType: 'test.noop', data: {} });
    assert.equal(standaloneRes, null);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(domainEventsPath)];
  }
});

test('src/server/index.js wires dxosBroker ACLs and protects latticeIotDevices & latticeBrokerSubscriptions from direct CRUD', async () => {
  const indexPath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'));
  const DxosBlocksServerPlugin = loadWithStubs(indexPath, {
    '@nocobase/server': { Plugin: class { constructor(opts = {}) { Object.assign(this, opts); } } },
  });

  const { db } = makeBrokerHarness();
  const definedResources = {};
  const aclCalls = [];
  const middlewares = [];

  const plugin = new DxosBlocksServerPlugin({
    db,
    app: {
      resourceManager: {
        define: (def) => { definedResources[def.name] = def; },
        use: (fn, opts) => { middlewares.push({ fn, opts }); },
      },
      acl: { allow: (...args) => aclCalls.push(args) },
    },
  });
  await plugin.load();

  assert.ok(definedResources.dxosBroker);
  assert.ok(definedResources.dxosBlocks);
  for (const act of [
    'listDevices',
    'provisionDevice',
    'revokeDevice',
    'orionEntities',
    'orionListSubscriptions',
    'orionCreateSubscription',
    'orionToggleSubscription',
    'orionDeleteSubscription',
    'deviceStatusIngest',
    'orionNotify',
  ]) {
    assert.equal(typeof definedResources.dxosBroker.actions[act], 'function', `Missing dxosBroker action ${act}`);
  }

  assert.ok(aclCalls.some(([res, acts, role]) => (
    res === 'dxosBroker'
    && role === 'loggedIn'
    && ['listDevices', 'provisionDevice', 'revokeDevice', 'orionEntities', 'orionListSubscriptions', 'orionCreateSubscription', 'orionToggleSubscription', 'orionDeleteSubscription'].every((a) => acts.includes(a))
  )));
  assert.ok(aclCalls.some(([res, acts, role]) => (
    res === 'dxosBroker'
    && role === 'public'
    && acts.includes('deviceStatusIngest')
    && acts.includes('orionNotify')
  )));

  const guardMw = middlewares[0].fn;
  for (const col of ['latticeIotDevices', 'latticeBrokerSubscriptions']) {
    await assert.rejects(
      () => guardMw({ state: { currentRole: 'ldx_operator' }, action: { resourceName: col, actionName: 'create' } }, async () => {}),
      (err) => err.status === 403 && err.code === 'BROKER_DIRECT_CRUD_FORBIDDEN',
    );
    await assert.rejects(
      () => guardMw({ state: { currentRole: 'ldx_operator' }, action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: col } } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'BROKER_DIRECT_CRUD_FORBIDDEN',
    );
  }
});

test('dxosBroker enforces PaaS PAT scopes (403 API_KEY_SCOPE_INSUFFICIENT) across read, write, and PAT-authenticated ingest actions', async () => {
  const { createDxosBrokerActions } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));
  const h = makeBrokerHarness({
    initialDevices: [
      {
        id: 1,
        organizationId: 'org-a',
        deviceKey: 'sensor-pat',
        name: 'PAT Sensor',
        mqttUsername: 'ldx_org-a_sensor-pat',
        mqttClientId: 'ldx-org-a-sensor-pat',
        assetId: 12,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
        topicPrefix: 'latticedx/org-a/sensor-pat',
        status: 'provisioned',
        metadataJson: {},
      },
    ],
    initialSubs: [
      {
        id: 1,
        organizationId: 'org-a',
        subscriptionKey: 'sub-pat',
        brokerType: 'orion_ld',
        externalSubscriptionId: 'urn:ngsi-ld:Subscription:org-a:sub-pat',
        entityType: 'Asset',
        watchedAttributesJson: ['temperature'],
        notificationEndpoint: 'http://nocobase/api/dxosBroker:orionNotify',
        throttlingSec: 5,
        active: true,
      },
    ],
  });

  const actions = createDxosBrokerActions(h.db, {
    brokerUrl: 'http://orion-ld:1026',
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/ngsi-ld/v1/entities')) return new Response('[]', { status: 200 });
      if (url.includes('/ngsi-ld/v1/subscriptions') && init.method === 'GET') return new Response('[]', { status: 200 });
      if (url.endsWith('/ngsi-ld/v1/subscriptions') && init.method === 'POST') return new Response('', { status: 201 });
      return new Response(null, { status: 204 });
    },
    ingestToken: 'edge-token-secret-2026-0123456789',
  });

  // Wrong-scope ldx_pat_* (['ledger']) rejected 403 on all dxosBroker actions
  const wrongPat = { scopes: ['ledger'] };
  const wrongState = { currentUser: { id: 101, username: 'op-a' }, currentRole: 'ldx_operator', latticeApiKey: wrongPat };
  for (const [fn, ctx] of [
    ['listDevices', { method: 'GET', state: wrongState, action: { params: {} } }],
    ['orionEntities', { method: 'GET', state: wrongState, action: { params: {} } }],
    ['orionListSubscriptions', { method: 'GET', state: wrongState, action: { params: {} } }],
    ['provisionDevice', { method: 'POST', state: wrongState, action: { params: { values: { deviceKey: 'pat-dev-1', name: 'PAT Dev 1' } } } }],
    ['revokeDevice', { method: 'POST', state: wrongState, action: { params: { values: { deviceKey: 'sensor-pat' } } } }],
    ['orionCreateSubscription', { method: 'POST', state: wrongState, action: { params: { values: { subscriptionKey: 'sub-ledger-deny', entityType: 'Asset' } } } }],
    ['orionToggleSubscription', { method: 'POST', state: wrongState, action: { params: { values: { subscriptionKey: 'sub-pat', active: false } } } }],
    ['orionDeleteSubscription', { method: 'POST', state: wrongState, action: { params: { values: { subscriptionKey: 'sub-pat' } } } }],
    ['deviceStatusIngest', { method: 'POST', headers: {}, state: wrongState, action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-pat', status: 'BIRTH' } } } }],
    ['orionNotify', { method: 'POST', headers: { 'NGSILD-Tenant': 'org-a' }, state: wrongState, request: { body: { data: [{ id: 'urn:ngsi-ld:Asset:org-a:native:12', temperature: { type: 'Property', value: -18 } }] } } }],
  ]) {
    await assert.rejects(
      () => actions[fn](ctx, async () => {}),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
      `Expected 403 API_KEY_SCOPE_INSUFFICIENT for ['ledger'] PAT on ${fn}`,
    );
  }

  // Read-only PAT (['read']) allowed on read ops, rejected 403 on mutating & PAT ingest ops
  const readState = { currentUser: { id: 101, username: 'op-a' }, currentRole: 'ldx_operator', latticeApiKey: { scopes: ['read'] } };
  const listCtx = { method: 'GET', state: readState, action: { params: {} } };
  await actions.listDevices(listCtx, async () => {});
  assert.equal(listCtx.body.items.length, 1);

  await actions.orionEntities({ method: 'GET', state: readState, action: { params: {} } }, async () => {});
  await actions.orionListSubscriptions({ method: 'GET', state: readState, action: { params: {} } }, async () => {});

  for (const [fn, ctx] of [
    ['provisionDevice', { method: 'POST', state: readState, action: { params: { values: { deviceKey: 'pat-dev-ro', name: 'RO Dev' } } } }],
    ['orionCreateSubscription', { method: 'POST', state: readState, action: { params: { values: { subscriptionKey: 'sub-ro-deny', entityType: 'Asset' } } } }],
    ['deviceStatusIngest', { method: 'POST', headers: {}, state: readState, action: { params: { values: { organizationId: 'org-a', deviceKey: 'sensor-pat', status: 'BIRTH' } } } }],
    ['orionNotify', { method: 'POST', headers: { 'NGSILD-Tenant': 'org-a' }, state: readState, request: { body: { data: [{ id: 'urn:ngsi-ld:Asset:org-a:native:12', temperature: { type: 'Property', value: -18 } }] } } }],
  ]) {
    await assert.rejects(
      () => actions[fn](ctx, async () => {}),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
      `Expected 403 API_KEY_SCOPE_INSUFFICIENT for ['read'] PAT on ${fn}`,
    );
  }

  // 'iot' PAT allowed on read, write, deviceStatusIngest, and orionNotify
  const iotState = { currentUser: { id: 101, username: 'op-a' }, currentRole: 'ldx_operator', latticeApiKey: { scopes: ['iot'] } };
  const provIotCtx = {
    method: 'POST',
    app: h.app,
    state: iotState,
    action: { params: { values: { deviceKey: 'pat-dev-ok', name: 'PAT Dev OK' } } },
  };
  await actions.provisionDevice(provIotCtx, async () => {});
  assert.equal(provIotCtx.body.device.deviceKey, 'pat-dev-ok');

  const ingestIotCtx = {
    method: 'POST',
    app: h.app,
    headers: {},
    state: iotState,
    action: { params: { values: { organizationId: 'org-a', deviceKey: 'pat-dev-ok', status: 'BIRTH' } } },
  };
  await actions.deviceStatusIngest(ingestIotCtx, async () => {});
  assert.equal(ingestIotCtx.body.device.status, 'online');

  const notifyIotCtx = {
    method: 'POST',
    app: h.app,
    headers: { 'NGSILD-Tenant': 'org-a' },
    state: iotState,
    request: {
      body: {
        data: [{ id: 'urn:ngsi-ld:Asset:org-a:native:12', temperature: { type: 'Property', value: -19.5, unitCode: 'CEL' } }],
      },
    },
  };
  await actions.orionNotify(notifyIotCtx, async () => {});
  assert.equal(notifyIotCtx.body.ingestedCount, 1);
});

test('dxosBroker fails closed 403 when rolesUsers repo exists and returns 0 rows for caller', async () => {
  const { createDxosBrokerActions } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));
  const h = makeBrokerHarness({
    rolesUsers: [
      { userId: 102, roleName: 'ldx_operator' },
    ],
  });
  // Also verify explicit empty rolesUsers table returning [] for all users
  const emptyRolesDb = {
    ...h.db,
    getRepository(name) {
      if (name === 'rolesUsers') {
        return { find: async () => [] };
      }
      return h.db.getRepository(name);
    },
  };

  const actionsWithOtherBindings = createDxosBrokerActions(h.db, {});
  const actionsWithEmptyRepo = createDxosBrokerActions(emptyRolesDb, {});

  for (const actions of [actionsWithOtherBindings, actionsWithEmptyRepo]) {
    // Non-root user with 0 role bindings in rolesUsers cannot trust ctx.state.currentRole
    await assert.rejects(
      () => actions.listDevices({
        method: 'GET',
        state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' },
        action: { params: {} },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_BROKER_FORBIDDEN',
    );
    await assert.rejects(
      () => actions.provisionDevice({
        method: 'POST',
        state: { currentUser: { id: 101 }, currentRole: 'ldx_admin' },
        action: { params: { values: { deviceKey: 'spoof-dev', name: 'Spoof' } } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_BROKER_FORBIDDEN',
    );
    // Spoofed root role with 0 role bindings in rolesUsers also fails closed 403
    await assert.rejects(
      () => actions.listDevices({
        method: 'GET',
        state: { currentUser: { id: 101 }, currentRole: 'root' },
        action: { params: {} },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_BROKER_FORBIDDEN',
    );
  }

  // User 102 HAS matching { userId: 102, roleName: 'ldx_operator' } binding -> allowed, but spoofed role denied
  const okListCtx = {
    method: 'GET',
    state: { currentUser: { id: 102 }, currentRole: 'ldx_operator' },
    action: { params: {} },
  };
  await actionsWithOtherBindings.listDevices(okListCtx, async () => {});
  assert.equal(okListCtx.body.organizationId, 'org-a');

  await assert.rejects(
    () => actionsWithOtherBindings.listDevices({
      method: 'GET',
      state: { currentUser: { id: 102 }, currentRole: 'ldx_admin' },
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_BROKER_FORBIDDEN',
  );
});

test('Orion-LD & callback SSRF hardening rejects single-label services, ::ffff: IPv4-mapped IPv6, obfuscated numeric IPs, and DNS rebinding', async () => {
  const {
    validateOrionBrokerUrl,
    validateCallbackUrl,
    validateOrionBrokerUrlAsync,
    createDxosBrokerActions,
  } = require(path.join(PLUGIN_ROOT, 'src/server/broker-control.js'));

  // Non-allowlisted single-label internal Docker/cloud hosts rejected 400
  for (const badSingleLabel of [
    'http://redis:6379',
    'http://postgres:5432',
    'http://keycloak:8080',
    'http://metadata',
    'http://nocobase:3000',
  ]) {
    assert.throws(
      () => validateOrionBrokerUrl(badSingleLabel),
      (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
      `Expected validateOrionBrokerUrl to reject ${badSingleLabel}`,
    );
  }
  for (const badCallbackSingleLabel of [
    'http://redis:6379/hook',
    'http://postgres:5432/hook',
    'http://orion-ld:1026/hook',
    'http://metadata/latest',
  ]) {
    assert.throws(
      () => validateCallbackUrl(badCallbackSingleLabel),
      (err) => err.status === 400 && err.code === 'BROKER_CALLBACK_FORBIDDEN',
      `Expected validateCallbackUrl to reject ${badCallbackSingleLabel}`,
    );
  }

  // ::ffff: IPv4-mapped IPv6 & integer/hex/octal obfuscated numeric IPs rejected 400
  for (const badObfuscated of [
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[::ffff:a9fe:a9fe]/latest',
    'http://[0:0:0:0:0:ffff:169.254.169.254]/latest',
    'http://[::ffff:127.0.0.1]:1026',
    'http://[::ffff:10.0.0.5]:1026',
    'http://2130706433:1026',
    'http://2852039166/latest/meta-data',
    'http://0x7f000001:1026',
    'http://0177.0.0.1:1026',
    'http://017700000001:1026',
    'http://127.1:1026',
  ]) {
    assert.throws(
      () => validateOrionBrokerUrl(badObfuscated),
      (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
      `Expected validateOrionBrokerUrl to reject ${badObfuscated}`,
    );
    assert.throws(
      () => validateCallbackUrl(badObfuscated),
      (err) => err.status === 400 && err.code === 'BROKER_CALLBACK_FORBIDDEN',
      `Expected validateCallbackUrl to reject ${badObfuscated}`,
    );
  }

  // Async DNS-rebinding validator rejects private/link-local/mapped resolved IPs and lookup failures
  await assert.rejects(
    () => validateOrionBrokerUrlAsync('https://rebind.example.org/ngsi-ld', {
      lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
  );
  await assert.rejects(
    () => validateOrionBrokerUrlAsync('https://rebind-mapped.example.org', {
      lookupImpl: async () => [{ address: '::ffff:169.254.169.254', family: 6 }],
    }),
    (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
  );
  await assert.rejects(
    () => validateOrionBrokerUrlAsync('https://rebind-mixed.example.org', {
      lookupImpl: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
  );
  await assert.rejects(
    () => validateOrionBrokerUrlAsync('https://nxdomain.example.org', {
      lookupImpl: async () => { throw new Error('ENOTFOUND'); },
    }),
    (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
  );
  assert.equal(
    await validateOrionBrokerUrlAsync('https://broker.example.org/ngsi-ld', {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    'https://broker.example.org',
  );

  // Action-level DNS-rebinding check blocks outbound fetch before fetchImpl is called
  const h = makeBrokerHarness({
    initialSubs: [
      {
        id: 1,
        organizationId: 'org-a',
        subscriptionKey: 'sub-rebind',
        brokerType: 'orion_ld',
        externalSubscriptionId: 'urn:ngsi-ld:Subscription:org-a:sub-rebind',
        entityType: 'Asset',
        watchedAttributesJson: ['temperature'],
        notificationEndpoint: 'http://nocobase/api/dxosBroker:orionNotify',
        throttlingSec: 5,
        active: true,
      },
    ],
  });
  let fetchCalled = 0;
  const rebindActions = createDxosBrokerActions(h.db, {
    brokerUrl: 'https://rebind.example.org',
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => {
      fetchCalled += 1;
      return new Response('[]', { status: 200 });
    },
  });

  for (const [fn, ctx] of [
    ['orionEntities', { method: 'GET', state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' }, action: { params: {} } }],
    ['orionListSubscriptions', { method: 'GET', state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' }, action: { params: {} } }],
    ['orionCreateSubscription', { method: 'POST', state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' }, action: { params: { values: { subscriptionKey: 'sub-rebind-new', entityType: 'Asset' } } } }],
    ['orionToggleSubscription', { method: 'POST', state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' }, action: { params: { values: { subscriptionKey: 'sub-rebind', active: false } } } }],
    ['orionDeleteSubscription', { method: 'POST', state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' }, action: { params: { values: { subscriptionKey: 'sub-rebind' } } } }],
  ]) {
    await assert.rejects(
      () => rebindActions[fn](ctx, async () => {}),
      (err) => err.status === 400 && err.code === 'BROKER_URL_FORBIDDEN',
      `Expected ${fn} to fail closed 400 on DNS rebinding`,
    );
  }
  assert.equal(fetchCalled, 0, 'Outbound fetchImpl must never be invoked when DNS resolves to private/metadata IP');

  // Unit tests passing fake fetchImpl without lookupImpl for non-internal host still work seamlessly
  const fakeFetchActions = createDxosBrokerActions(h.db, {
    brokerUrl: 'https://broker.example.org',
    fetchImpl: async () => new Response('[]', { status: 200 }),
  });
  const okEntCtx = { method: 'GET', state: { currentUser: { id: 101 }, currentRole: 'ldx_operator' }, action: { params: {} } };
  await fakeFetchActions.orionEntities(okEntCtx, async () => {});
  assert.equal(okEntCtx.body.orionReachable, true);
});

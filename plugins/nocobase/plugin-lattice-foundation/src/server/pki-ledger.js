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
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { isPortalAdmin } = require('./native-portals');
const { val, toPlain, getRepo } = require('./native-portal-helpers');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');
const { canUsePgRlsSession, getActiveRlsContext, withTenantRlsContext } = require('./pg-rls');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SIGNABLE_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
  'latticeAssets',
  'latticeParaDocuments',
  'latticeIncidentCases',
]);
const LEDGER_SECURITY_INVARIANTS = Object.freeze(new Set([
  'PKI_MASTER_KEY_MISSING',
  'PKI_KEY_INACTIVE',
  'PKI_CIPHERTEXT_INVALID',
  'LEDGER_IMMUTABLE',
  'NATIVE_ORGANIZATION_MISMATCH',
  'NATIVE_TENANT_REQUIRED',
]));
const ZERO_HASH = '0'.repeat(64);
const orgWriteQueues = new Map();
let savepointSeq = 0;

function failPki(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function isLedgerSecurityInvariant(err) {
  return Boolean(err && typeof err.code === 'string' && LEDGER_SECURITY_INVARIANTS.has(err.code));
}

function hasLedgerRepositories(db) {
  const ledgerRepo = getRepo(db, 'latticeCryptoLedger');
  const pkiRepo = getRepo(db, 'latticePkiKeys');
  return Boolean(
    ledgerRepo
    && typeof ledgerRepo.find === 'function'
    && typeof ledgerRepo.create === 'function'
    && pkiRepo
    && typeof pkiRepo.find === 'function'
    && typeof pkiRepo.create === 'function',
  );
}

function logLedgerError(db, scope, err) {
  const logger = db?.logger || db?.log;
  if (typeof logger?.error === 'function') {
    logger.error(`[${scope}] Ledger append failed`, err);
    return;
  }
  console.error(`[${scope}] Ledger append failed:`, err?.message || err);
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? 'null'
        : canonicalJson(item)
    )).join(',')}]`;
  }
  if (typeof value === 'object') {
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    if (plain !== value) return canonicalJson(plain);
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const pairs = [];
    for (const key of keys) {
      const entry = value[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      pairs.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${pairs.join(',')}}`;
  }
  return 'null';
}

function computeMerkleRoot(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return ZERO_HASH;
  let level = hashes.map((h) => String(h || ''));
  if (level.length === 1) return level[0];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0];
}

function resolvePkiMasterKey(env = process.env) {
  const secret = String(env?.ENCRYPTION_FIELD_KEY || env?.APP_KEY || '').trim();
  if (!secret) {
    if (String(env?.NODE_ENV || '').trim().toLowerCase() === 'production') {
      throw failPki('PKI_MASTER_KEY_MISSING', 500, 'ENCRYPTION_FIELD_KEY or APP_KEY must be set in production.');
    }
    return createHash('sha256').update('latticedx-dev-fallback-key', 'utf8').digest();
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptPrivateKeyPem(privateKeyPem, env = process.env) {
  const masterKey = resolvePkiMasterKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(privateKeyPem), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptPrivateKeyPem(ciphertext, env = process.env) {
  const parts = String(ciphertext || '').split(':');
  if (parts.length !== 3 || parts.some((p) => !/^[0-9a-f]+$/i.test(p))) {
    throw failPki('PKI_CIPHERTEXT_INVALID', 500, 'Encrypted PKI private key payload is malformed.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const masterKey = resolvePkiMasterKey(env);
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    if (err?.code === 'PKI_MASTER_KEY_MISSING') throw err;
    throw failPki('PKI_CIPHERTEXT_INVALID', 500, 'Encrypted PKI private key payload is invalid or tampered.');
  }
}

function assertValidOrgId(organizationId) {
  const org = String(organizationId || '').trim();
  if (!ORG_ID_RE.test(org)) {
    throw failPki('LEDGER_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  return org;
}

function serializePublicKeyRow(row) {
  if (!row) return null;
  const active = val(row, 'active') !== false;
  const rawStatus = val(row, 'status');
  const status = rawStatus ? String(rawStatus) : (active ? 'active' : 'retired');
  const retiredAt = val(row, 'retiredAt');
  return {
    organizationId: val(row, 'organizationId'),
    keyId: val(row, 'keyId'),
    algorithm: val(row, 'algorithm') || 'Ed25519',
    publicKeyPem: val(row, 'publicKeyPem'),
    fingerprintSha256: val(row, 'fingerprintSha256'),
    active,
    status,
    retiredAt: retiredAt instanceof Date ? retiredAt.toISOString() : (retiredAt || null),
  };
}

function serializeLedgerEntry(row) {
  if (!row) return null;
  const recAt = val(row, 'recordedAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    seq: Number(val(row, 'seq')),
    eventType: val(row, 'eventType'),
    targetCollection: val(row, 'targetCollection'),
    targetRecordId: String(val(row, 'targetRecordId')),
    actorUserId: val(row, 'actorUserId') ?? null,
    actorName: val(row, 'actorName') ?? null,
    payloadHash: val(row, 'payloadHash'),
    prevHash: val(row, 'prevHash'),
    entryHash: val(row, 'entryHash'),
    merkleRoot: val(row, 'merkleRoot'),
    signatureBase64: val(row, 'signatureBase64'),
    keyId: val(row, 'keyId'),
    metadataJson: val(row, 'metadataJson') || null,
    recordedAt: recAt instanceof Date ? recAt.toISOString() : String(recAt || ''),
  };
}

async function ensureOrgSigningKey(db, organizationId, options = {}) {
  const orgId = assertValidOrgId(organizationId);
  if (!options.transaction && !getActiveRlsContext()?.transaction && canUsePgRlsSession(db)) {
    return withTenantRlsContext(db, orgId, (transaction) => ensureOrgSigningKey(db, orgId, { ...options, transaction }));
  }
  const env = options.env || process.env;
  const effectiveTx = options.transaction || getActiveRlsContext()?.transaction || null;
  const txOpt = effectiveTx ? { transaction: effectiveTx } : {};
  const repo = getRepo(db, 'latticePkiKeys');
  if (!repo || typeof repo.create !== 'function' || (typeof repo.findOne !== 'function' && typeof repo.find !== 'function')) {
    throw failPki('PKI_REPO_UNAVAILABLE', 503, 'latticePkiKeys repository is unavailable.');
  }

  const findOrgKeys = async () => {
    if (typeof repo.find === 'function') {
      return (await repo.find({ filter: { organizationId: orgId }, sort: ['-id'], limit: 100, ...txOpt })) || [];
    }
    const one = await repo.findOne({ filter: { organizationId: orgId }, ...txOpt });
    return one ? [one] : [];
  };

  const existingRows = await findOrgKeys();
  const activeKey = existingRows.find(
    (k) => val(k, 'active') !== false && String(val(k, 'status') || 'active').toLowerCase() === 'active',
  );
  if (activeKey) {
    return toPlain(activeKey);
  }
  if (existingRows.length > 0) {
    throw failPki('PKI_KEY_INACTIVE', 403, 'Organization PKI signing key is inactive.');
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprintSha256 = sha256Hex(spkiDer);
  const keyId = `ed25519-${fingerprintSha256.slice(0, 16)}`;
  const encryptedPrivateKey = encryptPrivateKeyPem(privateKeyPem, env);

  try {
    const created = await repo.create({
      values: {
        organizationId: orgId,
        keyId,
        algorithm: 'Ed25519',
        publicKeyPem,
        encryptedPrivateKey,
        fingerprintSha256,
        active: true,
        status: 'active',
        retiredAt: null,
      },
      ...txOpt,
    });
    return toPlain(created);
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError' || /unique/i.test(String(err?.message || ''))) {
      const rows = await findOrgKeys();
      const winner = rows.find((k) => val(k, 'active') !== false) || rows[0];
      if (winner) return toPlain(winner);
    }
    throw err;
  }
}

async function signCanonicalPayload(db, organizationId, payload, options = {}) {
  const keyRow = await ensureOrgSigningKey(db, organizationId, options);
  const env = options.env || process.env;
  const privatePem = decryptPrivateKeyPem(keyRow.encryptedPrivateKey, env);
  const privateKey = createPrivateKey(privatePem);
  const canonical = canonicalJson(payload ?? {});
  const payloadHash = sha256Hex(canonical);
  const signatureBase64 = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

  return {
    organizationId: keyRow.organizationId,
    keyId: keyRow.keyId,
    algorithm: keyRow.algorithm || 'Ed25519',
    fingerprintSha256: keyRow.fingerprintSha256,
    payloadHash,
    signatureBase64,
  };
}

async function verifyPayloadSignature(db, organizationId, payload, signatureBase64, expectedKeyId = null, options = {}) {
  const orgId = assertValidOrgId(organizationId);
  const canonical = canonicalJson(payload ?? {});
  const payloadHash = sha256Hex(canonical);

  if (typeof signatureBase64 !== 'string' || !signatureBase64.trim()) {
    return { valid: false, reason: 'SIGNATURE_REQUIRED', keyId: null, fingerprintSha256: null, payloadHash };
  }

  const repo = getRepo(db, 'latticePkiKeys');
  if (!repo) {
    return { valid: false, reason: 'PKI_REPO_UNAVAILABLE', keyId: null, fingerprintSha256: null, payloadHash };
  }
  const cleanExpectedKeyId = expectedKeyId != null && String(expectedKeyId).trim()
    ? String(expectedKeyId).trim()
    : null;
  const activeTx = options.transaction || getActiveRlsContext()?.transaction || null;
  const findKey = async (tx) => {
    const txOpt = tx ? { transaction: tx } : {};
    if (cleanExpectedKeyId) {
      if (typeof repo.findOne === 'function') {
        return repo.findOne({ filter: { organizationId: orgId, keyId: cleanExpectedKeyId }, ...txOpt });
      }
      const list = (await repo.find({ filter: { organizationId: orgId, keyId: cleanExpectedKeyId }, limit: 1, ...txOpt })) || [];
      return list[0] || null;
    }
    if (typeof repo.find === 'function') {
      const list = (await repo.find({ filter: { organizationId: orgId }, sort: ['-id'], limit: 50, ...txOpt })) || [];
      return list.find((k) => val(k, 'active') !== false && String(val(k, 'status') || 'active').toLowerCase() === 'active') || list[0] || null;
    }
    return repo.findOne({ filter: { organizationId: orgId }, ...txOpt });
  };
  const keyRow = !activeTx && canUsePgRlsSession(db)
    ? await withTenantRlsContext(db, orgId, findKey)
    : await findKey(activeTx);
  if (!keyRow) {
    return { valid: false, reason: 'KEY_NOT_FOUND', keyId: null, fingerprintSha256: null, payloadHash };
  }
  const keyStatus = String(val(keyRow, 'status') || (val(keyRow, 'active') === false ? 'inactive' : 'active')).toLowerCase();
  if (keyStatus === 'revoked') {
    return {
      valid: false,
      reason: 'KEY_REVOKED',
      keyId: val(keyRow, 'keyId') || null,
      fingerprintSha256: val(keyRow, 'fingerprintSha256') || null,
      payloadHash,
    };
  }
  if (val(keyRow, 'active') === false && !(cleanExpectedKeyId && keyStatus === 'retired')) {
    return { valid: false, reason: 'KEY_NOT_FOUND', keyId: null, fingerprintSha256: null, payloadHash };
  }

  const keyId = val(keyRow, 'keyId');
  if (cleanExpectedKeyId && cleanExpectedKeyId !== keyId) {
    return { valid: false, reason: 'KEY_ID_MISMATCH', keyId, fingerprintSha256: val(keyRow, 'fingerprintSha256'), payloadHash };
  }

  let valid = false;
  try {
    const publicKey = createPublicKey(val(keyRow, 'publicKeyPem'));
    valid = verify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(signatureBase64.trim(), 'base64'));
  } catch {
    valid = false;
  }

  return {
    valid,
    reason: valid ? null : 'SIGNATURE_INVALID',
    keyId,
    fingerprintSha256: val(keyRow, 'fingerprintSha256'),
    payloadHash,
  };
}

function runWithOrgMutex(organizationId, task) {
  const prev = orgWriteQueues.get(organizationId) || Promise.resolve();
  const next = prev.then(task, task);
  const clear = () => {
    if (orgWriteQueues.get(organizationId) === cleanup) {
      orgWriteQueues.delete(organizationId);
    }
  };
  const cleanup = next.then(clear, clear);
  orgWriteQueues.set(organizationId, cleanup);
  return next;
}

async function fetchAllOrgEntries(repo, organizationId, transaction) {
  const entries = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = (await repo.find({
      filter: { organizationId },
      sort: ['seq'],
      offset,
      limit: pageSize,
      ...(transaction ? { transaction } : {}),
    })) || [];
    entries.push(...batch);
    if (batch.length < pageSize) break;
    offset += batch.length;
  }
  return entries;
}

async function appendLedgerEntry(
  db,
  { organizationId, eventType, targetCollection, targetRecordId, actor = {}, payload = {}, metadata = null },
  options = {},
) {
  const orgId = assertValidOrgId(organizationId);
  const cleanEvent = String(eventType || '').trim().slice(0, 128);
  const cleanCol = String(targetCollection || '').trim().slice(0, 255);
  const cleanRecId = String(targetRecordId ?? '').trim().slice(0, 255);
  if (!cleanEvent || !cleanCol || !cleanRecId) {
    throw failPki('LEDGER_ENTRY_INVALID', 400, 'eventType, targetCollection, and targetRecordId are required.');
  }

  const ledgerRepo = getRepo(db, 'latticeCryptoLedger');
  if (!ledgerRepo || typeof ledgerRepo.find !== 'function' || typeof ledgerRepo.create !== 'function') {
    throw failPki('LEDGER_REPO_UNAVAILABLE', 503, 'latticeCryptoLedger repository is unavailable.');
  }

  const execute = async (transaction) => {
    if (
      transaction
      && db?.sequelize?.getDialect?.() === 'postgres'
      && typeof db.sequelize.query === 'function'
    ) {
      await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:lockKey))', {
        replacements: { lockKey: `latticedx:ledger:${orgId}` },
        transaction,
      });
    }

    const keyRow = await ensureOrgSigningKey(db, orgId, { ...options, transaction });
    const privatePem = decryptPrivateKeyPem(keyRow.encryptedPrivateKey, options.env || process.env);
    const privateKey = createPrivateKey(privatePem);

    const existing = await fetchAllOrgEntries(ledgerRepo, orgId, transaction);
    const lastRow = existing.length ? existing[existing.length - 1] : null;
    const seq = lastRow ? Number(val(lastRow, 'seq')) + 1 : 1;
    const prevHash = lastRow ? String(val(lastRow, 'entryHash')) : ZERO_HASH;

    const recordedAtDate = new Date();
    const recordedAtIso = recordedAtDate.toISOString();
    const payloadHash = sha256Hex(canonicalJson(payload ?? {}));
    const entryHash = sha256Hex(
      `${orgId}|${seq}|${cleanEvent}|${cleanCol}|${cleanRecId}|${payloadHash}|${prevHash}|${recordedAtIso}`,
    );
    const signatureBase64 = sign(
      null,
      Buffer.from(`${orgId}|${seq}|${entryHash}`, 'utf8'),
      privateKey,
    ).toString('base64');
    const priorHashes = existing.map((row) => String(val(row, 'entryHash')));
    const merkleRoot = computeMerkleRoot([...priorHashes, entryHash]);

    const created = await ledgerRepo.create({
      values: {
        organizationId: orgId,
        seq,
        eventType: cleanEvent,
        targetCollection: cleanCol,
        targetRecordId: cleanRecId,
        actorUserId: actor?.userId != null ? String(actor.userId).slice(0, 128) : null,
        actorName: String(actor?.username || (actor?.employeeId ? `employee-${actor.employeeId}` : 'system')).slice(0, 255),
        payloadHash,
        prevHash,
        entryHash,
        merkleRoot,
        signatureBase64,
        keyId: keyRow.keyId,
        metadataJson: metadata && typeof metadata === 'object' ? metadata : null,
        recordedAt: recordedAtDate,
      },
      ...(transaction ? { transaction } : {}),
    });

    return serializeLedgerEntry(created);
  };

  const runAppend = async () => {
    const activeTx = options.transaction || getActiveRlsContext()?.transaction || null;
    if (activeTx) {
      return execute(activeTx);
    }
    if (canUsePgRlsSession(db)) {
      return withTenantRlsContext(db, orgId, execute);
    }
    if (typeof db?.sequelize?.transaction === 'function') {
      return db.sequelize.transaction(execute);
    }
    return execute(null);
  };
  if (options._skipOrgMutex) {
    return runAppend();
  }
  return runWithOrgMutex(orgId, runAppend);
}

async function rotateOrgSigningKey(db, organizationId, options = {}) {
  const orgId = assertValidOrgId(organizationId);
  const env = options.env || process.env;
  const actor = options.actor || {};
  const repo = getRepo(db, 'latticePkiKeys');
  if (!repo || typeof repo.create !== 'function' || typeof repo.update !== 'function') {
    throw failPki('PKI_REPO_UNAVAILABLE', 503, 'latticePkiKeys repository is unavailable.');
  }

  const execute = async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    if (
      transaction
      && db?.sequelize?.getDialect?.() === 'postgres'
      && typeof db.sequelize.query === 'function'
    ) {
      await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:lockKey))', {
        replacements: { lockKey: `latticedx:ledger:${orgId}` },
        transaction,
      });
    }

    const existingRows = typeof repo.find === 'function'
      ? ((await repo.find({ filter: { organizationId: orgId }, sort: ['-id'], limit: 100, ...txOpt })) || [])
      : ([await repo.findOne({ filter: { organizationId: orgId }, ...txOpt })].filter(Boolean));

    const prevActive = existingRows.find(
      (k) => val(k, 'active') !== false && String(val(k, 'status') || 'active').toLowerCase() === 'active',
    ) || null;
    const retiredKeyId = prevActive ? val(prevActive, 'keyId') : null;
    const retiredAt = new Date();

    for (const row of existingRows) {
      if (val(row, 'active') !== false || String(val(row, 'status') || 'active').toLowerCase() === 'active') {
        const rowId = val(row, 'id');
        if (rowId != null) {
          await repo.update({
            filterByTk: rowId,
            values: { active: false, status: 'retired', retiredAt },
            ...txOpt,
          });
        } else {
          await repo.update({
            filter: { organizationId: orgId, keyId: val(row, 'keyId') },
            values: { active: false, status: 'retired', retiredAt },
            ...txOpt,
          });
        }
      }
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const fingerprintSha256 = sha256Hex(spkiDer);
    const newKeyId = `ed25519-${fingerprintSha256.slice(0, 16)}`;
    const encryptedPrivateKey = encryptPrivateKeyPem(privateKeyPem, env);

    await repo.create({
      values: {
        organizationId: orgId,
        keyId: newKeyId,
        algorithm: 'Ed25519',
        publicKeyPem,
        encryptedPrivateKey,
        fingerprintSha256,
        active: true,
        status: 'active',
        retiredAt: null,
      },
      ...txOpt,
    });

    let rotationEntry = null;
    if (hasLedgerRepositories(db)) {
      rotationEntry = await appendLedgerEntry(db, {
        organizationId: orgId,
        eventType: 'pki.key_rotated',
        targetCollection: 'latticePkiKeys',
        targetRecordId: newKeyId,
        actor,
        payload: {
          organizationId: orgId,
          retiredKeyId,
          newKeyId,
          fingerprintSha256,
        },
        metadata: { retiredKeyId, newKeyId },
      }, { ...options, transaction, _skipOrgMutex: true });
    }

    return {
      organizationId: orgId,
      newKeyId,
      retiredKeyId,
      publicKeyPem,
      fingerprintSha256,
      active: true,
      status: 'active',
      retiredAt: retiredKeyId ? retiredAt.toISOString() : null,
      ledgerSeq: rotationEntry?.seq ?? null,
    };
  };

  return runWithOrgMutex(orgId, async () => {
    const activeTx = options.transaction || getActiveRlsContext()?.transaction || null;
    if (activeTx) return execute(activeTx);
    if (canUsePgRlsSession(db)) return withTenantRlsContext(db, orgId, execute);
    if (typeof db?.sequelize?.transaction === 'function') return db.sequelize.transaction(execute);
    return execute(null);
  });
}

async function appendLedgerEntrySafely(db, entryArgs, options = {}) {
  if (!hasLedgerRepositories(db)) return null;
  const { transaction, scope = 'lattice:ledger', ...appendOpts } = options;
  const isPg = db?.sequelize?.getDialect?.() === 'postgres' && typeof db?.sequelize?.query === 'function';

  if (transaction && isPg) {
    savepointSeq += 1;
    const spName = `sp_dxos_ledger_${savepointSeq}`;
    await db.sequelize.query(`SAVEPOINT ${spName}`, { transaction });
    try {
      const entry = await appendLedgerEntry(db, entryArgs, { ...appendOpts, transaction });
      await db.sequelize.query(`RELEASE SAVEPOINT ${spName}`, { transaction });
      return entry;
    } catch (err) {
      try {
        await db.sequelize.query(`ROLLBACK TO SAVEPOINT ${spName}`, { transaction });
      } catch (rbErr) {
        logLedgerError(db, scope, rbErr);
      }
      if (isLedgerSecurityInvariant(err)) throw err;
      logLedgerError(db, scope, err);
      return null;
    }
  }

  try {
    return await appendLedgerEntry(db, entryArgs, appendOpts);
  } catch (err) {
    if (isLedgerSecurityInvariant(err)) throw err;
    logLedgerError(db, scope, err);
    return null;
  }
}

async function verifyLedgerChain(db, organizationId, options = {}) {
  const orgId = assertValidOrgId(organizationId);
  const ledgerRepo = getRepo(db, 'latticeCryptoLedger');
  if (!ledgerRepo || typeof ledgerRepo.find !== 'function') {
    throw failPki('LEDGER_REPO_UNAVAILABLE', 503, 'latticeCryptoLedger repository is unavailable.');
  }

  const readChain = async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const foundEntries = await fetchAllOrgEntries(ledgerRepo, orgId, transaction || null);
    const pkiRepo = getRepo(db, 'latticePkiKeys');
    const foundKeyRows = pkiRepo
      ? ((typeof pkiRepo.find === 'function'
        ? await pkiRepo.find({ filter: { organizationId: orgId }, limit: 50, ...txOpt })
        : [await pkiRepo.findOne({ filter: { organizationId: orgId }, ...txOpt })].filter(Boolean)) || [])
      : [];
    return { entries: foundEntries, keyRows: foundKeyRows };
  };
  const activeTx = options.transaction || getActiveRlsContext()?.transaction || null;
  const { entries, keyRows } = !activeTx && canUsePgRlsSession(db)
    ? await withTenantRlsContext(db, orgId, readChain)
    : await readChain(activeTx);

  if (entries.length === 0) {
    return {
      valid: true,
      checkedCount: 0,
      brokenAtSeq: null,
      reason: null,
      merkleRoot: ZERO_HASH,
      headHash: ZERO_HASH,
    };
  }

  const keysById = new Map();
  for (const kr of keyRows) {
    if (val(kr, 'organizationId') !== orgId) continue;
    try {
      keysById.set(val(kr, 'keyId'), createPublicKey(val(kr, 'publicKeyPem')));
    } catch {
      // Malformed public key will fail verification below
    }
  }

  let expectedSeq = 1;
  let expectedPrevHash = ZERO_HASH;
  let verifiedMerkle = ZERO_HASH;
  const verifiedHashes = [];
  let checkedCount = 0;

  const failAt = (seqVal, reason) => ({
    valid: false,
    checkedCount,
    brokenAtSeq: seqVal,
    reason,
    merkleRoot: verifiedMerkle,
    headHash: expectedPrevHash,
  });

  for (const row of entries) {
    const seq = Number(val(row, 'seq'));
    if (!Number.isInteger(seq) || seq !== expectedSeq) {
      return failAt(Number.isInteger(seq) ? seq : expectedSeq, 'SEQ_CONTINUITY_BROKEN');
    }
    if (String(val(row, 'organizationId') || '') !== orgId) {
      return failAt(seq, 'ORG_MISMATCH');
    }
    const prevHash = String(val(row, 'prevHash') || '');
    if (prevHash !== expectedPrevHash) {
      return failAt(seq, 'PREV_HASH_MISMATCH');
    }

    const recordedRaw = val(row, 'recordedAt');
    const recordedMs = recordedRaw ? new Date(recordedRaw).getTime() : NaN;
    if (!Number.isFinite(recordedMs)) {
      return failAt(seq, 'RECORDED_AT_INVALID');
    }
    const recordedAtIso = new Date(recordedMs).toISOString();

    const eventType = String(val(row, 'eventType') || '');
    const targetCollection = String(val(row, 'targetCollection') || '');
    const targetRecordId = String(val(row, 'targetRecordId') ?? '');
    const payloadHash = String(val(row, 'payloadHash') || '');
    const storedEntryHash = String(val(row, 'entryHash') || '');

    const recomputedEntryHash = sha256Hex(
      `${orgId}|${seq}|${eventType}|${targetCollection}|${targetRecordId}|${payloadHash}|${prevHash}|${recordedAtIso}`,
    );
    if (storedEntryHash !== recomputedEntryHash) {
      return failAt(seq, 'ENTRY_HASH_MISMATCH');
    }

    const keyId = String(val(row, 'keyId') || '');
    const pubKey = keysById.get(keyId);
    if (!pubKey) {
      return failAt(seq, 'SIGNING_KEY_MISSING');
    }
    let sigValid = false;
    try {
      const sigBuf = Buffer.from(String(val(row, 'signatureBase64') || ''), 'base64');
      sigValid = verify(null, Buffer.from(`${orgId}|${seq}|${recomputedEntryHash}`, 'utf8'), pubKey, sigBuf);
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      return failAt(seq, 'SIGNATURE_INVALID');
    }

    verifiedHashes.push(recomputedEntryHash);
    const expectedMerkle = computeMerkleRoot(verifiedHashes);
    if (String(val(row, 'merkleRoot') || '') !== expectedMerkle) {
      return failAt(seq, 'MERKLE_ROOT_MISMATCH');
    }

    verifiedMerkle = expectedMerkle;
    expectedPrevHash = recomputedEntryHash;
    checkedCount += 1;
    expectedSeq += 1;
  }

  return {
    valid: true,
    checkedCount,
    brokenAtSeq: null,
    reason: null,
    merkleRoot: verifiedMerkle,
    headHash: expectedPrevHash,
  };
}

function registerLedgerHooks(db) {
  if (typeof db?.on !== 'function') return;
  const throwImmutable = () => {
    throw failPki('LEDGER_IMMUTABLE', 403, 'Crypto ledger entries are append-only and immutable.');
  };
  for (const event of ['beforeUpdate', 'beforeDestroy', 'beforeBulkUpdate', 'beforeBulkDestroy']) {
    db.on(`latticeCryptoLedger.${event}`, throwImmutable);
  }
}

async function resolveLedgerCallerOrg(db, ctx, requestedOrgId = null) {
  if (!ctx?.state?.currentUser) {
    throw failPki('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const isRoot = ctx.state.currentRole === 'root';
  if (isRoot) {
    const cleanReq = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (cleanReq) {
      return { isRoot: true, actor: { userId: String(val(ctx.state.currentUser, 'id') || ''), employeeId: null, username: val(ctx.state.currentUser, 'username') || 'root' }, organizationId: assertValidOrgId(cleanReq) };
    }
    try {
      const actor = await resolveNativeActor(db, ctx.state.currentUser);
      return { isRoot: true, actor: { ...actor, username: val(ctx.state.currentUser, 'username') || 'root' }, organizationId: actor.organizationId };
    } catch {
      throw failPki('LEDGER_ORG_REQUIRED', 400, 'organizationId is required for root ledger queries.');
    }
  }
  const actor = await resolveNativeActor(db, ctx.state.currentUser);
  if (requestedOrgId != null && String(requestedOrgId).trim() && String(requestedOrgId).trim() !== actor.organizationId) {
    throw failPki('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization ledger access is forbidden.');
  }
  return {
    isRoot: false,
    actor: {
      ...actor,
      username: val(ctx.state.currentUser, 'username') || `employee-${actor.employeeId}`,
    },
    organizationId: actor.organizationId,
  };
}

function registerPkiLedger(app) {
  const db = app.db;
  registerLedgerHooks(db);

  const runOrgLedgerDb = (organizationId, fn) => {
    const activeTx = getActiveRlsContext()?.transaction || null;
    if (canUsePgRlsSession(db) && !activeTx && organizationId) {
      return withTenantRlsContext(db, organizationId, fn);
    }
    return fn(activeTx || undefined);
  };

  app.resourceManager.define({
    name: 'dxosLedger',
    actions: {
      publicKey: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const keyRow = await runOrgLedgerDb(organizationId, (transaction) => ensureOrgSigningKey(db, organizationId, { transaction }));
        ctx.body = serializePublicKeyRow(keyRow);
        if (next) return next();
      },

      entries: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const page = Math.max(1, Math.min(10000, Math.floor(Number(params.page) || 1)));
        const pageSize = Math.max(1, Math.min(200, Math.floor(Number(params.pageSize ?? params.limit) || 20)));
        const filter = { organizationId };
        if (typeof params.targetCollection === 'string' && params.targetCollection.trim()) {
          filter.targetCollection = params.targetCollection.trim();
        }
        if (params.targetRecordId != null && String(params.targetRecordId).trim()) {
          filter.targetRecordId = String(params.targetRecordId).trim();
        }
        if (typeof params.eventType === 'string' && params.eventType.trim()) {
          filter.eventType = params.eventType.trim();
        }

        const repo = getRepo(db, 'latticeCryptoLedger');
        if (!repo) {
          ctx.body = { organizationId, total: 0, page, pageSize, items: [] };
          if (next) return next();
          return;
        }
        const { rows, total } = await runOrgLedgerDb(organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const foundRows = (await repo.find({
            filter,
            sort: params.sort === 'seq' ? ['seq'] : ['-seq'],
            offset: (page - 1) * pageSize,
            limit: pageSize,
            ...txOpt,
          })) || [];
          const foundTotal = typeof repo.count === 'function' ? await repo.count({ filter, ...txOpt }) : foundRows.length;
          return { rows: foundRows, total: foundTotal };
        });
        ctx.body = {
          organizationId,
          total,
          page,
          pageSize,
          items: rows.map(serializeLedgerEntry),
        };
        if (next) return next();
      },

      status: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const repo = getRepo(db, 'latticeCryptoLedger');
        const pkiRepo = getRepo(db, 'latticePkiKeys');
        const statusBody = await runOrgLedgerDb(organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const keyRows = pkiRepo
            ? (typeof pkiRepo.find === 'function'
              ? ((await pkiRepo.find({ filter: { organizationId }, sort: ['-id'], limit: 50, ...txOpt })) || [])
              : ([await pkiRepo.findOne({ filter: { organizationId }, ...txOpt })].filter(Boolean)))
            : [];
          const keyRow = keyRows.find(
            (k) => val(k, 'active') !== false && String(val(k, 'status') || 'active').toLowerCase() === 'active',
          ) || keyRows[0] || null;
          if (!repo) {
            return {
              organizationId,
              latestSeq: 0,
              merkleRoot: ZERO_HASH,
              headHash: ZERO_HASH,
              entryCount: 0,
              keyId: val(keyRow, 'keyId') || null,
            };
          }
          const [latest] = (await repo.find({ filter: { organizationId }, sort: ['-seq'], limit: 1, ...txOpt })) || [];
          const entryCount = typeof repo.count === 'function'
            ? await repo.count({ filter: { organizationId }, ...txOpt })
            : (latest ? Number(val(latest, 'seq')) : 0);
          return {
            organizationId,
            latestSeq: latest ? Number(val(latest, 'seq')) : 0,
            merkleRoot: latest ? String(val(latest, 'merkleRoot')) : ZERO_HASH,
            headHash: latest ? String(val(latest, 'entryHash')) : ZERO_HASH,
            entryCount,
            keyId: val(keyRow, 'keyId') || val(latest, 'keyId') || null,
          };
        });
        ctx.body = statusBody;
        if (next) return next();
      },

      verify: async (ctx, next) => {
        if (ctx.method && !['GET', 'POST'].includes(ctx.method)) ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const report = await runOrgLedgerDb(organizationId, (transaction) => verifyLedgerChain(db, organizationId, { transaction }));
        ctx.body = { organizationId, ...report };
        if (next) return next();
      },

      signDocument: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write', 'ledger']);
        const params = readParams(ctx);
        const { isRoot, actor, organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);

        const targetCollection = String(params.targetCollection || params.collection || '').trim();
        if (!SIGNABLE_COLLECTIONS.has(targetCollection)) {
          throw failPki('LEDGER_COLLECTION_INVALID', 400, 'Unsupported collection for cryptographic signing.');
        }
        const targetRecordId = Number(params.targetRecordId ?? params.id);
        if (!Number.isInteger(targetRecordId) || targetRecordId <= 0) {
          throw failPki('LEDGER_RECORD_ID_REQUIRED', 400, 'Valid positive targetRecordId is required.');
        }

        const repo = getRepo(db, targetCollection);
        if (!repo || typeof repo.findOne !== 'function') {
          throw failPki('LEDGER_COLLECTION_UNAVAILABLE', 503, 'Target collection repository unavailable.');
        }
        const adminOk = isRoot || (await isPortalAdmin(ctx, db));
        const { entry, docSig, snapshot } = await runOrgLedgerDb(organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const record = await repo.findOne({ filter: { id: targetRecordId, organizationId }, ...txOpt });
          if (!record || val(record, 'organizationId') !== organizationId) {
            throw failPki('LEDGER_RECORD_NOT_FOUND', 404, 'Target document not found in organization scope.');
          }

          if (!adminOk) {
            const empId = actor.employeeId != null ? Number(actor.employeeId) : null;
            const isOwner = empId != null && [
              val(record, 'requesterId'),
              val(record, 'assigneeId'),
              val(record, 'ownerId'),
              val(record, 'custodianId'),
              val(record, 'handlerId'),
            ].some((ownerRef) => ownerRef != null && Number(ownerRef) === empId);
            if (!isOwner) {
              throw failPki('LEDGER_SIGN_FORBIDDEN', 403, 'Only an administrator or document owner may sign this record.');
            }
          }

          const docSnapshot = toPlain(record);
          const ledgerEntry = await appendLedgerEntry(db, {
            organizationId,
            eventType: 'document.signed',
            targetCollection,
            targetRecordId: String(targetRecordId),
            actor,
            payload: docSnapshot,
            metadata: params.reason ? { reason: String(params.reason).trim().slice(0, 255) } : null,
          }, { transaction });
          const signedDoc = await signCanonicalPayload(db, organizationId, docSnapshot, { transaction });
          return { entry: ledgerEntry, docSig: signedDoc, snapshot: docSnapshot };
        });

        ctx.body = {
          signed: true,
          entry: { ...entry, payload: snapshot },
          signatureBase64: docSig.signatureBase64,
          ledgerSignatureBase64: entry.signatureBase64,
          keyId: docSig.keyId,
          merkleRoot: entry.merkleRoot,
        };
        if (next) return next();
      },

      verifySignature: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        let payload = params.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            throw failPki('LEDGER_PAYLOAD_INVALID', 400, 'Malformed JSON payload.');
          }
        }
        if (payload === undefined || payload === null) {
          throw failPki('LEDGER_PAYLOAD_REQUIRED', 400, 'payload is required.');
        }
        const signatureBase64 = params.signatureBase64;
        const expectedKeyId = params.keyId ? String(params.keyId).trim() : null;
        const result = await runOrgLedgerDb(organizationId, (transaction) => (
          verifyPayloadSignature(db, organizationId, payload, signatureBase64, expectedKeyId, { transaction })
        ));
        ctx.body = { organizationId, ...result };
        if (next) return next();
      },

      rotateKey: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write', 'ledger']);
        const params = readParams(ctx);
        const { isRoot, actor, organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const adminOk = isRoot || (await isPortalAdmin(ctx, db));
        if (!adminOk) {
          throw failPki('LEDGER_ADMIN_REQUIRED', 403, 'Administrator role is required to rotate PKI keys.');
        }
        ctx.body = await rotateOrgSigningKey(db, organizationId, { actor });
        if (next) return next();
      },

      exportProof: async (ctx, next) => {
        if (ctx.method && !['GET', 'POST'].includes(ctx.method)) ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 100)));
        const targetEntryHash = params.entryHash ? String(params.entryHash).trim() : null;
        const targetSeq = params.seq != null && String(params.seq).trim() !== '' ? Number(params.seq) : null;

        const ledgerRepo = getRepo(db, 'latticeCryptoLedger');
        const pkiRepo = getRepo(db, 'latticePkiKeys');
        const proofData = await runOrgLedgerDb(organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const keyRows = pkiRepo
            ? (typeof pkiRepo.find === 'function'
              ? ((await pkiRepo.find({ filter: { organizationId }, sort: ['-id'], limit: 100, ...txOpt })) || [])
              : ([await pkiRepo.findOne({ filter: { organizationId }, ...txOpt })].filter(Boolean)))
            : [];
          const activeKey = keyRows.find(
            (k) => val(k, 'active') !== false && String(val(k, 'status') || 'active').toLowerCase() === 'active',
          ) || keyRows[0] || null;

          const report = ledgerRepo
            ? await verifyLedgerChain(db, organizationId, { transaction })
            : { valid: true, checkedCount: 0, brokenAtSeq: null, reason: null, merkleRoot: ZERO_HASH, headHash: ZERO_HASH };

          const allEntries = ledgerRepo ? await fetchAllOrgEntries(ledgerRepo, organizationId, transaction) : [];
          const serialized = allEntries.map(serializeLedgerEntry);
          const matchedEntry = serialized.find((e) => (
            (targetEntryHash && e.entryHash === targetEntryHash)
            || (targetSeq != null && Number.isFinite(targetSeq) && Number(e.seq) === targetSeq)
          )) || serialized[serialized.length - 1] || null;

          return {
            organizationId,
            exportedAt: new Date().toISOString(),
            keyId: activeKey ? val(activeKey, 'keyId') : null,
            publicKeyPem: activeKey ? val(activeKey, 'publicKeyPem') : null,
            fingerprintSha256: activeKey ? val(activeKey, 'fingerprintSha256') : null,
            publicKeys: keyRows.map(serializePublicKeyRow),
            chainValid: Boolean(report.valid),
            checkedCount: Number(report.checkedCount || 0),
            rootHash: report.merkleRoot || ZERO_HASH,
            merkleRoot: report.merkleRoot || ZERO_HASH,
            headHash: report.headHash || ZERO_HASH,
            entries: serialized.slice(-limit),
            proof: matchedEntry ? {
              seq: matchedEntry.seq,
              leafHash: matchedEntry.entryHash,
              prevHash: matchedEntry.prevHash,
              entryHash: matchedEntry.entryHash,
              merkleRoot: matchedEntry.merkleRoot,
              keyId: matchedEntry.keyId,
              signatureBase64: matchedEntry.signatureBase64,
            } : null,
          };
        });
        ctx.body = proofData;
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.(
    'dxosLedger',
    ['publicKey', 'entries', 'status', 'verify', 'signDocument', 'verifySignature', 'rotateKey', 'exportProof'],
    'loggedIn',
  );
}

module.exports = {
  SIGNABLE_COLLECTIONS,
  LEDGER_SECURITY_INVARIANTS,
  ZERO_HASH,
  canonicalJson,
  computeMerkleRoot,
  encryptPrivateKeyPem,
  decryptPrivateKeyPem,
  isLedgerSecurityInvariant,
  hasLedgerRepositories,
  ensureOrgSigningKey,
  rotateOrgSigningKey,
  signCanonicalPayload,
  verifyPayloadSignature,
  appendLedgerEntry,
  appendLedgerEntrySafely,
  verifyLedgerChain,
  registerLedgerHooks,
  registerPkiLedger,
};

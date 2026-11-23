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
const { assertApiKeyScope } = require('./paas-api-keys');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SIGNABLE_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
  'latticeAssets',
  'latticeParaDocuments',
  'latticeIncidentCases',
]);
const ZERO_HASH = '0'.repeat(64);
const orgWriteQueues = new Map();

function failPki(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const b = ctx.request?.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
    ? ctx.request.body
    : {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values)
    ? p.values
    : {};
  return { ...b, ...p, ...v };
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
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return plain.toString('utf8');
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
  return {
    organizationId: val(row, 'organizationId'),
    keyId: val(row, 'keyId'),
    algorithm: val(row, 'algorithm') || 'Ed25519',
    publicKeyPem: val(row, 'publicKeyPem'),
    fingerprintSha256: val(row, 'fingerprintSha256'),
    active: val(row, 'active') !== false,
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
  const env = options.env || process.env;
  const txOpt = options.transaction ? { transaction: options.transaction } : {};
  const repo = getRepo(db, 'latticePkiKeys');
  if (!repo) {
    throw failPki('PKI_REPO_UNAVAILABLE', 503, 'latticePkiKeys repository is unavailable.');
  }

  const existing = await repo.findOne({ filter: { organizationId: orgId }, ...txOpt });
  if (existing) {
    if (val(existing, 'active') === false) {
      throw failPki('PKI_KEY_INACTIVE', 403, 'Organization PKI signing key is inactive.');
    }
    return toPlain(existing);
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
      },
      ...txOpt,
    });
    return toPlain(created);
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError' || /unique/i.test(String(err?.message || ''))) {
      const winner = await repo.findOne({ filter: { organizationId: orgId }, ...txOpt });
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

async function verifyPayloadSignature(db, organizationId, payload, signatureBase64, expectedKeyId = null) {
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
  const keyRow = await repo.findOne({ filter: { organizationId: orgId } });
  if (!keyRow || val(keyRow, 'active') === false) {
    return { valid: false, reason: 'KEY_NOT_FOUND', keyId: null, fingerprintSha256: null, payloadHash };
  }

  const keyId = val(keyRow, 'keyId');
  if (expectedKeyId && String(expectedKeyId).trim() !== keyId) {
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
  const cleanup = next.finally(() => {
    if (orgWriteQueues.get(organizationId) === cleanup) {
      orgWriteQueues.delete(organizationId);
    }
  });
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
  if (!ledgerRepo || typeof ledgerRepo.create !== 'function') {
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

  return runWithOrgMutex(orgId, async () => {
    if (options.transaction) {
      return execute(options.transaction);
    }
    if (typeof db?.sequelize?.transaction === 'function') {
      return db.sequelize.transaction(execute);
    }
    return execute(null);
  });
}

async function verifyLedgerChain(db, organizationId) {
  const orgId = assertValidOrgId(organizationId);
  const ledgerRepo = getRepo(db, 'latticeCryptoLedger');
  if (!ledgerRepo || typeof ledgerRepo.find !== 'function') {
    throw failPki('LEDGER_REPO_UNAVAILABLE', 503, 'latticeCryptoLedger repository is unavailable.');
  }

  const entries = await fetchAllOrgEntries(ledgerRepo, orgId, null);
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

  const pkiRepo = getRepo(db, 'latticePkiKeys');
  const keyRows = pkiRepo
    ? ((typeof pkiRepo.find === 'function'
      ? await pkiRepo.find({ filter: { organizationId: orgId }, limit: 50 })
      : [await pkiRepo.findOne({ filter: { organizationId: orgId } })].filter(Boolean)) || [])
    : [];
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

  app.resourceManager.define({
    name: 'dxosLedger',
    actions: {
      publicKey: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const keyRow = await ensureOrgSigningKey(db, organizationId);
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
        const rows = (await repo.find({
          filter,
          sort: params.sort === 'seq' ? ['seq'] : ['-seq'],
          offset: (page - 1) * pageSize,
          limit: pageSize,
        })) || [];
        const total = typeof repo.count === 'function' ? await repo.count({ filter }) : rows.length;
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
        const keyRow = pkiRepo ? await pkiRepo.findOne({ filter: { organizationId } }) : null;
        if (!repo) {
          ctx.body = {
            organizationId,
            latestSeq: 0,
            merkleRoot: ZERO_HASH,
            headHash: ZERO_HASH,
            entryCount: 0,
            keyId: val(keyRow, 'keyId') || null,
          };
          if (next) return next();
          return;
        }
        const [latest] = (await repo.find({ filter: { organizationId }, sort: ['-seq'], limit: 1 })) || [];
        const entryCount = typeof repo.count === 'function'
          ? await repo.count({ filter: { organizationId } })
          : (latest ? Number(val(latest, 'seq')) : 0);
        ctx.body = {
          organizationId,
          latestSeq: latest ? Number(val(latest, 'seq')) : 0,
          merkleRoot: latest ? String(val(latest, 'merkleRoot')) : ZERO_HASH,
          headHash: latest ? String(val(latest, 'entryHash')) : ZERO_HASH,
          entryCount,
          keyId: val(keyRow, 'keyId') || val(latest, 'keyId') || null,
        };
        if (next) return next();
      },

      verify: async (ctx, next) => {
        if (ctx.method && !['GET', 'POST'].includes(ctx.method)) ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveLedgerCallerOrg(db, ctx, params.organizationId);
        const report = await verifyLedgerChain(db, organizationId);
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
        const record = await repo.findOne({ filter: { id: targetRecordId, organizationId } });
        if (!record || val(record, 'organizationId') !== organizationId) {
          throw failPki('LEDGER_RECORD_NOT_FOUND', 404, 'Target document not found in organization scope.');
        }

        const adminOk = isRoot || (await isPortalAdmin(ctx, db));
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

        const snapshot = toPlain(record);
        const entry = await appendLedgerEntry(db, {
          organizationId,
          eventType: 'document.signed',
          targetCollection,
          targetRecordId: String(targetRecordId),
          actor,
          payload: snapshot,
          metadata: params.reason ? { reason: String(params.reason).trim().slice(0, 255) } : null,
        });

        ctx.body = {
          signed: true,
          entry,
          signatureBase64: entry.signatureBase64,
          keyId: entry.keyId,
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
        const result = await verifyPayloadSignature(db, organizationId, payload, signatureBase64, expectedKeyId);
        ctx.body = { organizationId, ...result };
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.(
    'dxosLedger',
    ['publicKey', 'entries', 'status', 'verify', 'signDocument', 'verifySignature'],
    'loggedIn',
  );
}

module.exports = {
  SIGNABLE_COLLECTIONS,
  ZERO_HASH,
  canonicalJson,
  computeMerkleRoot,
  encryptPrivateKeyPem,
  decryptPrivateKeyPem,
  ensureOrgSigningKey,
  signCanonicalPayload,
  verifyPayloadSignature,
  appendLedgerEntry,
  verifyLedgerChain,
  registerLedgerHooks,
  registerPkiLedger,
};

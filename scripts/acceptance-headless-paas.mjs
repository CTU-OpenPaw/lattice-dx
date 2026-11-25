#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeLabOrigin } from './setup-native-multi-portal-demo.mjs';

const DEFAULT_ORG = 'native-ui-lab';
const DEMO_PASS = process.env.NATIVE_DEMO_PASSWORD ?? 'NativeLab-2026!';
const SAMPLE_EVIDENCE_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function enforceDelegations(callActor, okActor, { organizationId, suffix, cleanupIds }) {
  const delegOrderRes = await okActor('root', 'latticeOrders:create', {
    method: 'POST',
    values: {
      code: `ORD-DLG-${suffix}`,
      name: `Đơn kiểm chứng Ủy quyền ${suffix}`,
      organizationId,
      customer: 'Mekong Delegation Audit',
      origin: 'Kho lạnh Cần Thơ',
      destination: 'Kho lạnh TP.HCM',
      quantity: 2,
      category: 'cold-chain',
      status: 'draft',
    },
  });
  const delegOrder = delegOrderRes.data || {};
  assert.ok(delegOrder.id, 'Failed to create temporary delegation order');
  cleanupIds.delegOrderId = delegOrder.id;

  const preSubmitBlocked = await callActor('employee', 'latticeVoucher:submit', {
    method: 'POST',
    values: { collection: 'latticeOrders', id: delegOrder.id },
  });
  assert.equal(
    preSubmitBlocked.status,
    403,
    `Expected 403 before delegation for employee latticeVoucher:submit, got ${preSubmitBlocked.status}`,
  );

  const escalatedDelegation = await callActor('employee', 'dxosDelegations:create', {
    method: 'POST',
    values: {
      organizationId,
      delegateUserId: 1,
      roleName: 'ldx_admin',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3600_000).toISOString(),
      reason: 'Blocked admin escalation',
    },
  });
  assert.equal(
    escalatedDelegation.status,
    403,
    `Expected 403 on ldx_admin delegation escalation, got ${escalatedDelegation.status}`,
  );

  const empCheckRes = await callActor('employee', 'auth:check');
  const delegateUserId = Number(empCheckRes.data?.id);
  const empListRes = await okActor(
    'root',
    `latticeEmployees:list?filter=${encodeURIComponent(JSON.stringify({ organizationId, active: true }))}&pageSize=50`,
  );
  const empRows = Array.isArray(empListRes.data)
    ? empListRes.data
    : (Array.isArray(empListRes.data?.items) ? empListRes.data.items : []);
  const delegatorEmp = empRows.find(
    (e) => Number(e?.userId) > 0 && Number(e?.userId) !== delegateUserId,
  );
  const delegatorUserId = Number(delegatorEmp?.userId);
  assert.ok(
    Number.isInteger(delegateUserId) && delegateUserId > 0 && Number.isInteger(delegatorUserId) && delegatorUserId > 0,
    'Unable to resolve active delegatorUserId and delegateUserId for enforceDelegations',
  );

  const createDlgRes = await okActor('root', 'dxosDelegations:create', {
    method: 'POST',
    values: {
      organizationId,
      delegatorUserId,
      delegateUserId,
      roleName: 'ldx_manager',
      scopeCollection: 'latticeOrders',
      reason: `Headless PaaS active delegation enforcement ${suffix}`,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  const delegation = createDlgRes.data?.delegation || {};
  assert.ok(delegation.id && delegation.delegationUid, 'dxosDelegations:create missing delegation id/uid');
  cleanupIds.delegationId = delegation.id;

  const activeDlgRes = await okActor(
    'employee',
    `dxosDelegations:activeForUser?organizationId=${encodeURIComponent(organizationId)}`,
  );
  assert.ok(
    Array.isArray(activeDlgRes.data?.roles) && activeDlgRes.data.roles.includes('ldx_manager'),
    'dxosDelegations:activeForUser missing active ldx_manager role',
  );
  assert.ok(
    Array.isArray(activeDlgRes.data?.items)
      && activeDlgRes.data.items.some((d) => d.delegationUid === delegation.delegationUid && d.scopeCollection === 'latticeOrders'),
    'dxosDelegations:activeForUser missing scoped delegation record',
  );

  const delegatedSubmitRes = await okActor('employee', 'latticeVoucher:submit', {
    method: 'POST',
    values: { collection: 'latticeOrders', id: delegOrder.id },
  });
  assert.equal(delegatedSubmitRes.data?.status, 'submitted', 'Delegated employee could not submit order voucher');

  const revokeDlgRes = await okActor('root', 'dxosDelegations:revoke', {
    method: 'POST',
    values: { organizationId, id: delegation.id },
  });
  assert.equal(revokeDlgRes.data?.delegation?.status, 'revoked');

  const afterRevokeRes = await okActor(
    'employee',
    `dxosDelegations:activeForUser?organizationId=${encodeURIComponent(organizationId)}`,
  );
  assert.equal(
    (afterRevokeRes.data?.items || []).some((d) => d.delegationUid === delegation.delegationUid),
    false,
    'Revoked delegation still active in activeForUser',
  );

  return {
    delegationUid: delegation.delegationUid,
    delegOrderId: delegOrder.id,
  };
}

export function parseHeadlessAcceptanceArgs(argv) {
  let origin = null;
  let reportPath = null;
  let organizationId = DEFAULT_ORG;

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length);
    else if (arg.startsWith('--org=')) organizationId = arg.slice('--org='.length).trim() || DEFAULT_ORG;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (reportPath === null) reportPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!origin && !reportPath) {
    throw new Error('Usage: node scripts/acceptance-headless-paas.mjs <clean-install report.json> | --origin=http://localhost:13014 [--org=native-ui-lab]');
  }
  if (origin !== null) {
    origin = assertSafeLabOrigin(origin);
  }
  return { origin, reportPath, organizationId };
}

export const parseHeadlessPaasArgs = parseHeadlessAcceptanceArgs;

export async function createHeadlessPaaSCallers(origin) {
  const safeOrigin = assertSafeLabOrigin(origin);
  const tokens = {};

  async function signIn(email, password) {
    const res = await fetch(new URL('/api/auth:signIn', safeOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    assert.ok(res.ok && json?.data?.token, `Sign-in failed for ${email}: HTTP ${res.status}`);
    return json.data.token;
  }

  tokens.root = await signIn(
    process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com',
    process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123',
  );
  tokens.employee = await signIn(
    process.env.NATIVE_DEMO_EMPLOYEE_EMAIL || 'native.lab.employee@example.invalid',
    DEMO_PASS,
  );

  return async function callActor(actorRole, path, { method = 'GET', values, bearerToken } = {}) {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    const urlPath = cleanPath.startsWith('api/') ? `/${cleanPath}` : `/api/${cleanPath}`;
    const headers = { 'content-type': 'application/json' };
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    } else if (actorRole !== 'anon') {
      const tok = tokens[actorRole];
      if (!tok) throw new Error(`Unknown actor role: ${actorRole}`);
      headers.authorization = `Bearer ${tok}`;
      if (actorRole === 'root') headers['X-Role'] = 'root';
    }

    const response = await fetch(new URL(urlPath, safeOrigin), {
      method,
      headers,
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      rawText: text,
      data: payload.data !== undefined ? payload.data : payload,
    };
  };
}

export const createHeadlessPaasCaller = createHeadlessPaaSCallers;

export async function runHeadlessPaaSAcceptance(callActor, { organizationId = DEFAULT_ORG } = {}) {
  const okActor = async (actorRole, path, opts) => {
    const res = await callActor(actorRole, path, opts);
    assert.ok(
      res.ok && res.status < 300,
      `${actorRole} ${path.split('?')[0]} failed (${res.status}): ${JSON.stringify(res.data)}`,
    );
    return res;
  };

  const suffix = Date.now().toString(36).slice(-6).toUpperCase();
  const cleanupIds = {
    apiKeyId: null,
    apiKeyRevoked: false,
    frozenSnapshotId: null,
    frozenSnapshotUid: null,
    orderId: null,
    delegOrderId: null,
    delegationId: null,
    orderLineId: null,
    lotIds: [],
    mktLotCode: null,
    epodId: null,
    dmnTableId: null,
    approvalId: null,
    twinShadowId: null,
    assetId: null,
  };

  const checks = {
    observabilityAndPwaOk: false,
    apiKeysLifecycleAndNegativeOk: false,
    pkiLedgerVerifyOk: false,
    dataGovernanceColdSnapshotAndLineageOk: false,
    wmsTmsEpodAndPublicTrackOk: false,
    dmnAndDelegationOk: false,
    delegationEnforcementOk: false,
    digitalTwinHitlGateOk: false,
    autofillTriageAndBundleOk: false,
  };

  try {
    // 1. Observability & Field PWA (public endpoints)
    const healthRes = await okActor('anon', 'dxos:health');
    assert.equal(healthRes.data?.status, 'ok');
    assert.equal(healthRes.data?.version, '0.4.0');

    const openapiRes = await okActor('anon', 'dxos:openapi');
    assert.equal(openapiRes.data?.openapi, '3.1.0');
    assert.equal(openapiRes.data?.info?.version, '0.4.0');
    assert.ok(openapiRes.data?.paths && typeof openapiRes.data.paths === 'object');

    const asyncapiRes = await okActor('anon', 'dxos:asyncapi');
    assert.equal(asyncapiRes.data?.asyncapi, '3.0.0');
    assert.equal(asyncapiRes.data?.info?.version, '0.4.0');
    assert.ok(asyncapiRes.data?.channels && typeof asyncapiRes.data.channels === 'object');

    const manifestRes = await okActor('anon', 'dxos:manifest');
    assert.equal(manifestRes.data?.start_url, '/v/mobile');
    assert.ok(typeof manifestRes.data?.name === 'string' && manifestRes.data.name.length > 0);

    const swRes = await okActor('anon', 'dxos:sw.js');
    assert.ok((swRes.rawText || '').includes('CACHE_NAME'), 'Service worker missing CACHE_NAME');
    assert.ok((swRes.rawText || '').includes('/api/dxos:manifest'), 'Service worker missing manifest precache');
    checks.observabilityAndPwaOk = true;

    // 2. Headless PAT API Keys + Negative RBAC & Revocation checks
    const escalatedPat = await callActor('employee', 'dxosApiKeys:issue', {
      method: 'POST',
      values: {
        name: `Blocked Escalation ${suffix}`,
        roleName: 'root',
        scopes: ['read'],
        organizationId,
      },
    });
    assert.equal(escalatedPat.status, 403, `Expected 403 on employee root PAT escalation, got ${escalatedPat.status}`);

    const issuedPatRes = await okActor('employee', 'dxosApiKeys:issue', {
      method: 'POST',
      values: {
        name: `PaaS E2E Scoped PAT ${suffix}`,
        scopes: ['read', 'ledger'],
        organizationId,
        expiresInDays: 7,
      },
    });
    const issuedPat = issuedPatRes.data || {};
    assert.ok(issuedPat.id, 'Issued PAT missing id');
    assert.match(String(issuedPat.token || ''), /^ldx_pat_[0-9a-f]{8}_[0-9a-f]{32}$/);
    cleanupIds.apiKeyId = issuedPat.id;

    const patPubKeyRes = await callActor('anon', `dxosLedger:publicKey?organizationId=${encodeURIComponent(organizationId)}`, {
      bearerToken: issuedPat.token,
    });
    assert.equal(patPubKeyRes.status, 200, `Expected Bearer PAT access 200, got ${patPubKeyRes.status}`);

    const listKeysRes = await okActor('employee', `dxosApiKeys:list?organizationId=${encodeURIComponent(organizationId)}`);
    const listedKeys = Array.isArray(listKeysRes.data?.items) ? listKeysRes.data.items : [];
    const foundKey = listedKeys.find((k) => Number(k.id) === Number(issuedPat.id));
    assert.ok(foundKey, 'Issued PAT missing from dxosApiKeys:list');
    assert.equal(foundKey.token, undefined, 'dxosApiKeys:list must never leak secret PAT token');
    assert.equal(foundKey.keyHash, undefined, 'dxosApiKeys:list must never leak keyHash');

    const revokeRes = await okActor('employee', 'dxosApiKeys:revoke', {
      method: 'POST',
      values: { id: issuedPat.id },
    });
    assert.equal(revokeRes.data?.active, false);
    cleanupIds.apiKeyRevoked = true;

    const revokedUse = await callActor('anon', `dxosLedger:publicKey?organizationId=${encodeURIComponent(organizationId)}`, {
      bearerToken: issuedPat.token,
    });
    assert.equal(revokedUse.status, 401, `Expected 401 for revoked Bearer PAT, got ${revokedUse.status}`);
    checks.apiKeysLifecycleAndNegativeOk = true;

    // 3. Ed25519 PKI + Merkle Ledger + Freeze Cold Snapshot + Signature Verify + Lineage
    const pubKeyRes = await okActor('root', `dxosLedger:publicKey?organizationId=${encodeURIComponent(organizationId)}`);
    assert.equal(pubKeyRes.data?.algorithm, 'Ed25519');
    assert.equal(pubKeyRes.data?.active, true);
    assert.ok(String(pubKeyRes.data?.publicKeyPem || '').includes('BEGIN PUBLIC KEY'));

    const tempOrderRes = await okActor('root', 'latticeOrders:create', {
      method: 'POST',
      values: {
        code: `ORD-PAAS-${suffix}`,
        name: `Đơn Headless PaaS ${suffix}`,
        organizationId,
        customer: 'Mekong MedTech Cần Thơ',
        origin: 'Kho lạnh Cần Thơ',
        destination: 'Kho lạnh TP.HCM',
        quantity: 10,
        category: 'cold-chain',
      },
    });
    const tempOrder = tempOrderRes.data || {};
    assert.ok(tempOrder.id, 'Failed to create temporary latticeOrders record');
    cleanupIds.orderId = tempOrder.id;

    const signDocRes = await okActor('root', 'dxosLedger:signDocument', {
      method: 'POST',
      values: {
        organizationId,
        targetCollection: 'latticeOrders',
        targetRecordId: tempOrder.id,
        reason: `Headless PaaS E2E seal ${suffix}`,
      },
    });
    assert.equal(signDocRes.data?.signed, true);
    assert.ok(typeof signDocRes.data?.signatureBase64 === 'string' && signDocRes.data.signatureBase64.length > 0);
    assert.ok(typeof signDocRes.data?.merkleRoot === 'string' && signDocRes.data.merkleRoot.length > 0);

    const verifyLedgerRes = await okActor('root', 'dxosLedger:verify', {
      method: 'POST',
      values: { organizationId },
    });
    assert.equal(verifyLedgerRes.data?.valid, true);
    assert.equal(verifyLedgerRes.data?.brokenAtSeq, null);
    assert.ok(Number(verifyLedgerRes.data?.checkedCount || 0) >= 1);
    checks.pkiLedgerVerifyOk = true;

    // 4. Data Governance (tierSummary, freezeSnapshot, getSnapshot, verifySignature, lineage, quarantine)
    const tierRes = await okActor('root', `dxosDataGov:tierSummary?organizationId=${encodeURIComponent(organizationId)}`);
    assert.equal(tierRes.data?.organizationId, organizationId);
    assert.equal(typeof tierRes.data?.hotOrders, 'number');

    const freezeRes = await okActor('root', 'dxosDataGov:freezeSnapshot', {
      method: 'POST',
      values: {
        organizationId,
        sourceCollection: 'latticeOrders',
        tier: 'cold',
        retentionDays: 1825,
      },
    });
    const frozen = freezeRes.data || {};
    assert.equal(frozen.status, 'sealed');
    assert.ok(frozen.snapshotUid, 'freezeSnapshot missing snapshotUid');
    assert.ok(frozen.signatureBase64, 'freezeSnapshot missing signatureBase64');
    cleanupIds.frozenSnapshotUid = frozen.snapshotUid;
    if (frozen.id != null) {
      cleanupIds.frozenSnapshotId = frozen.id;
    }

    const getSnapRes = await okActor(
      'root',
      `dxosDataGov:getSnapshot?organizationId=${encodeURIComponent(organizationId)}&snapshotUid=${encodeURIComponent(frozen.snapshotUid)}`,
    );
    if (!cleanupIds.frozenSnapshotId && getSnapRes.data?.id != null) {
      cleanupIds.frozenSnapshotId = getSnapRes.data.id;
    }
    assert.equal(getSnapRes.data?.hashVerified, true);
    assert.equal(getSnapRes.data?.signatureVerified, true);

    const verifySigRes = await okActor('root', 'dxosLedger:verifySignature', {
      method: 'POST',
      values: {
        organizationId,
        payload: getSnapRes.data?.payloadJson,
        signatureBase64: frozen.signatureBase64,
        keyId: frozen.keyId,
      },
    });
    assert.equal(verifySigRes.data?.valid, true, 'dxosLedger:verifySignature rejected frozen snapshot signature');

    const lineageRes = await okActor(
      'root',
      `dxosDataGov:lineage?organizationId=${encodeURIComponent(organizationId)}&collection=latticeOrders&recordId=${encodeURIComponent(tempOrder.id)}`,
    );
    assert.ok(Number(lineageRes.data?.nodeCount || 0) >= 1);
    assert.ok(Array.isArray(lineageRes.data?.nodes));
    assert.ok(Array.isArray(lineageRes.data?.edges));

    const quarantineRes = await okActor('root', `dxosDataGov:listQuarantine?organizationId=${encodeURIComponent(organizationId)}`);
    assert.ok(Array.isArray(quarantineRes.data?.items));
    checks.dataGovernanceColdSnapshotAndLineageOk = true;

    // 5. OMS + WMS + TMS + e-POD + Voucher + Public Tracking (negative + zero-PII)
    const skuCode = `SKU-PAAS-${suffix}`;
    const orderLineRes = await okActor('root', 'dxosWms:saveOrderLine', {
      method: 'POST',
      values: {
        organizationId,
        orderId: tempOrder.id,
        orderCode: tempOrder.code,
        lineNo: 1,
        sku: skuCode,
        productName: 'Vaccine Sinh phẩm Lạnh 2-8C',
        requestedQty: 10,
        targetTempMinC: 2,
        targetTempMaxC: 8,
      },
    });
    cleanupIds.orderLineId = orderLineRes.data?.orderLine?.id || null;

    const expiryIso = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const fefoLotCode = `LOT-FEFO-${suffix}`;
    const mktLotCode = `LOT-MKT-${suffix}`;
    cleanupIds.mktLotCode = mktLotCode;

    const fefoLotRes = await okActor('root', 'dxosWms:receiveStock', {
      method: 'POST',
      values: {
        organizationId,
        lotCode: fefoLotCode,
        sku: skuCode,
        productName: 'Vaccine Sinh phẩm Lạnh 2-8C',
        qtyOnHand: 20,
        expiryDate: expiryIso,
        targetTempMinC: 2,
        targetTempMaxC: 8,
      },
    });
    if (fefoLotRes.data?.lot?.id) cleanupIds.lotIds.push(fefoLotRes.data.lot.id);

    const mktLotRes = await okActor('root', 'dxosWms:receiveStock', {
      method: 'POST',
      values: {
        organizationId,
        lotCode: mktLotCode,
        sku: `${skuCode}-MKT`,
        productName: 'Mẫu Kiểm MKT Lệch Nhiệt',
        qtyOnHand: 5,
        expiryDate: expiryIso,
        targetTempMinC: 2,
        targetTempMaxC: 8,
      },
    });
    if (mktLotRes.data?.lot?.id) cleanupIds.lotIds.push(mktLotRes.data.lot.id);

    const allocRes = await okActor('root', 'dxosWms:allocateFefo', {
      method: 'POST',
      values: {
        organizationId,
        sku: skuCode,
        quantity: 10,
        orderId: tempOrder.id,
        orderCode: tempOrder.code,
        lineNo: 1,
        minTempC: 2,
        maxTempC: 8,
      },
    });
    assert.equal(allocRes.data?.allocatedTotal, 10);
    assert.equal(allocRes.data?.shortfall, 0);

    const holdRes = await okActor('root', 'dxosWms:holdLotByMkt', {
      method: 'POST',
      values: {
        organizationId,
        lotCode: mktLotCode,
        samplesC: [12.5, 13.0, 14.2],
        maxAllowedC: 8,
        reason: 'Headless PaaS MKT excursion test',
      },
    });
    assert.equal(holdRes.data?.held, true);
    assert.equal(holdRes.data?.lotStatus, 'hold_mkt');
    assert.ok(Number(holdRes.data?.mktCelsius) > 8);

    const epodRes = await okActor('root', 'dxosWms:epodCapture', {
      method: 'POST',
      values: {
        organizationId,
        orderId: tempOrder.id,
        orderCode: tempOrder.code,
        recipientName: 'Nguyen Van Test PII',
        recipientPhone: '0912345678',
        deliveredQty: 10,
        gpsLat: 10.0452,
        gpsLng: 105.7469,
        signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        evidencePhotoDataUrl: SAMPLE_EVIDENCE_PHOTO,
        tempSummary: { mktCelsius: 4.1, inRange: true },
      },
    });
    const epodData = epodRes.data || {};
    cleanupIds.epodId = epodData.epod?.id || null;
    assert.ok(epodData.trackingCode && epodData.trackingToken, 'epodCapture missing trackingCode/trackingToken');

    const voucherRes = await okActor('root', 'dxosWms:printVoucher', {
      method: 'POST',
      values: {
        organizationId,
        documentType: 'epod',
        epodUid: epodData.epod?.epodUid,
        orderCode: tempOrder.code,
        trackingToken: epodData.trackingToken,
      },
    });
    assert.ok(typeof voucherRes.data?.html === 'string' && voucherRes.data.html.length > 0);
    assert.ok(voucherRes.data.html.includes('<svg'), 'printVoucher HTML missing ISO/IEC 18004 QR <svg>');
    assert.ok(
      voucherRes.data.html.includes('epod-photo-img') && voucherRes.data.html.includes(SAMPLE_EVIDENCE_PHOTO),
      'printVoucher HTML missing embedded evidencePhotoDataUrl',
    );
    assert.ok(typeof voucherRes.data?.qrVerificationHash === 'string' && voucherRes.data.qrVerificationHash.length > 0);

    const badTrack = await callActor('anon', `dxosWms:publicTrack?trackingCode=MISSING-${suffix}&token=invalid`);
    assert.ok(
      [400, 401, 404].includes(badTrack.status),
      `Expected fail-closed 400/401/404 on invalid publicTrack, got ${badTrack.status}`,
    );

    const goodTrack = await okActor(
      'anon',
      `dxosWms:publicTrack?trackingCode=${encodeURIComponent(epodData.trackingCode)}&token=${encodeURIComponent(epodData.trackingToken)}`,
    );
    assert.equal(goodTrack.data?.trackingCode, epodData.trackingCode);
    const serializedTrack = JSON.stringify(goodTrack.data);
    assert.ok(!serializedTrack.includes('Nguyen Van Test PII'), 'publicTrack leaked recipientName PII');
    assert.ok(!serializedTrack.includes('0912345678'), 'publicTrack leaked phone PII');
    assert.equal(goodTrack.data?.signatureDataUrl, undefined, 'publicTrack leaked signatureDataUrl');
    assert.equal(goodTrack.data?.trackingTokenHash, undefined, 'publicTrack leaked trackingTokenHash');

    const badVerifyTrack = await callActor('anon', `dxosWms:verifyTrackSignature?trackingCode=MISSING-${suffix}&token=invalid`);
    assert.ok(
      [400, 401, 404].includes(badVerifyTrack.status),
      `Expected fail-closed 400/401/404 on invalid verifyTrackSignature, got ${badVerifyTrack.status}`,
    );

    const goodVerifyTrack = await okActor(
      'anon',
      `dxosWms:verifyTrackSignature?trackingCode=${encodeURIComponent(epodData.trackingCode)}&token=${encodeURIComponent(epodData.trackingToken)}`,
    );
    assert.equal(goodVerifyTrack.data?.verified, true, 'verifyTrackSignature expected verified=true');
    assert.ok(goodVerifyTrack.data?.seq != null, 'verifyTrackSignature missing ledger seq');
    assert.ok(typeof goodVerifyTrack.data?.keyId === 'string' && goodVerifyTrack.data.keyId.length > 0, 'verifyTrackSignature missing keyId');
    assert.ok(typeof goodVerifyTrack.data?.entryHash === 'string' && goodVerifyTrack.data.entryHash.length > 0, 'verifyTrackSignature missing entryHash');
    assert.ok(typeof goodVerifyTrack.data?.publicKeyFingerprint === 'string' && goodVerifyTrack.data.publicKeyFingerprint.length > 0, 'verifyTrackSignature missing publicKeyFingerprint');
    const serializedVerify = JSON.stringify(goodVerifyTrack.data);
    assert.ok(!serializedVerify.includes('Nguyen Van Test PII'), 'verifyTrackSignature leaked recipientName PII');
    assert.ok(!serializedVerify.includes('0912345678'), 'verifyTrackSignature leaked phone PII');
    checks.wmsTmsEpodAndPublicTrackOk = true;

    // 6. DMN Decision Table + Delegations
    const dmnTableKey = `cold_route_dmn_${suffix.toLowerCase()}`;
    const saveDmnRes = await okActor('root', 'dxosDmn:saveTable', {
      method: 'POST',
      values: {
        organizationId,
        tableKey: dmnTableKey,
        name: `PaaS DMN Routing ${suffix}`,
        hitPolicy: 'FIRST',
        inputsJson: [{ name: 'amount', type: 'number' }],
        outputsJson: [{ name: 'tier', type: 'string' }],
        rulesJson: [
          { when: { amount: { op: 'gt', value: 50 } }, then: { tier: 'director_approval' } },
          { when: { amount: '*' }, then: { tier: 'manager_approval' } },
        ],
      },
    });
    cleanupIds.dmnTableId = saveDmnRes.data?.table?.id || null;

    const evalDmnRes = await okActor('root', 'dxosDmn:evaluate', {
      method: 'POST',
      values: {
        organizationId,
        tableKey: dmnTableKey,
        context: { amount: 120 },
      },
    });
    assert.equal(evalDmnRes.data?.matched, true);
    assert.equal(evalDmnRes.data?.result?.tier, 'director_approval');

    const listDmnRes = await okActor('root', `dxosDmn:listTables?organizationId=${encodeURIComponent(organizationId)}`);
    assert.ok(Array.isArray(listDmnRes.data?.items));
    assert.ok(listDmnRes.data.items.some((t) => t.tableKey === dmnTableKey));

    const delegationsRes = await okActor('root', `dxosDelegations:list?organizationId=${encodeURIComponent(organizationId)}`);
    assert.ok(Array.isArray(delegationsRes.data?.items));
    checks.dmnAndDelegationOk = true;

    const delegationEnforcement = await enforceDelegations(callActor, okActor, {
      organizationId,
      suffix,
      cleanupIds,
    });
    assert.ok(delegationEnforcement.delegationUid, 'enforceDelegations did not return delegationUid');
    checks.delegationEnforcementOk = true;

    // 7. Two-way Digital Twin HITL delta > 2.0C gate
    const tempAssetRes = await okActor('root', 'latticeAssets:create', {
      method: 'POST',
      values: {
        code: `REEFER-PAAS-${suffix}`,
        name: `Kho Lạnh IoT Test ${suffix} Cần Thơ`,
        kind: 'reefer',
        status: 'active',
        organizationId,
      },
    });
    const tempAsset = tempAssetRes.data || {};
    assert.ok(tempAsset.id, 'Failed to create temp IoT asset');
    cleanupIds.assetId = tempAsset.id;

    const shadowRes = await okActor(
      'root',
      `dxosBlocks:twinShadow?organizationId=${encodeURIComponent(organizationId)}&assetId=${encodeURIComponent(tempAsset.id)}`,
    );
    cleanupIds.twinShadowId = shadowRes.data?.shadow?.id || null;

    const baseDesired = await okActor('root', 'dxosBlocks:twinSetDesired', {
      method: 'POST',
      values: {
        organizationId,
        assetId: tempAsset.id,
        desiredPatch: { targetTempC: 4.0, doorLock: 'locked' },
      },
    });
    assert.equal(baseDesired.data?.gatedByHitl, false);
    if (!cleanupIds.twinShadowId && baseDesired.data?.shadow?.id) {
      cleanupIds.twinShadowId = baseDesired.data.shadow.id;
    }

    const gatedDesired = await okActor('root', 'dxosBlocks:twinSetDesired', {
      method: 'POST',
      values: {
        organizationId,
        assetId: tempAsset.id,
        desiredPatch: { targetTempC: 10.0 },
      },
    });
    assert.equal(gatedDesired.data?.gatedByHitl, true, 'Expected HITL gate when setpoint delta exceeds 2.0C');
    assert.ok(Number(gatedDesired.data?.deltaTempC || 0) > 2);
    assert.ok(gatedDesired.data?.approvalId, 'HITL gate missing approvalId');
    cleanupIds.approvalId = gatedDesired.data.approvalId;
    checks.digitalTwinHitlGateOk = true;

    // 8. Document AI Autofill + Proactive AI Triage + GitOps Solution Bundle
    const sampleDoc = [
      `Order Code: ORD-OCR-${suffix}`,
      'Customer: Mekong Cold MedTech',
      'Origin: Kho lạnh Cần Thơ',
      'Destination: Trung tâm Phân phối TP.HCM',
      `SKU: ${skuCode}`,
      'Qty: 12',
      'Target Temp: 2-8C',
    ].join('\n');

    const extractRes = await okActor('root', 'latticePara:extractFormFields', {
      method: 'POST',
      values: {
        organizationId,
        targetCollection: 'latticeOrders',
        filename: `paas-autofill-${suffix}.txt`,
        mimeType: 'text/plain',
        contentBase64: Buffer.from(sampleDoc, 'utf8').toString('base64'),
      },
    });
    assert.equal(extractRes.data?.targetCollection, 'latticeOrders');
    assert.equal(extractRes.data?.suggestedValues?.code, `ORD-OCR-${suffix}`);
    assert.ok(typeof extractRes.data?.confidence === 'number' && extractRes.data.confidence > 0);

    const triageRes = await okActor('root', 'dxosAi:triageScan', {
      method: 'POST',
      values: { organizationId, dryRun: true },
    });
    assert.equal(typeof triageRes.data?.scannedCount, 'number');
    assert.ok(Array.isArray(triageRes.data?.proposals));

    const bundleRes = await okActor('root', `dxosStudio:solutionBundleExport?organizationId=${encodeURIComponent(organizationId)}`);
    const bundle = bundleRes.data || {};
    assert.equal(bundle.metadata?.organizationId, organizationId);
    assert.equal(bundle.metadata?.schemaVersion, 'latticedx.solution-bundle/v3');
    assert.ok(typeof bundle.metadata?.contentSha256 === 'string' && bundle.metadata.contentSha256.length >= 32);
    assert.ok(Array.isArray(bundle.roles) && Array.isArray(bundle.portals));
    checks.autofillTriageAndBundleOk = true;

    return {
      result: 'PASS',
      organizationId,
      checks,
      snapshotUid: frozen.snapshotUid,
      trackingCode: epodData.trackingCode,
      dmnTableKey,
      bundleSchemaVersion: bundle.metadata?.schemaVersion,
    };
  } finally {
    if (cleanupIds.apiKeyId) {
      if (!cleanupIds.apiKeyRevoked) {
        await callActor('root', 'dxosApiKeys:revoke', {
          method: 'POST',
          values: { id: cleanupIds.apiKeyId },
        }).catch(() => {});
      }
      await callActor('root', `latticeApiKeys:destroy?filterByTk=${cleanupIds.apiKeyId}`, { method: 'POST' }).catch(() => {});
    }
    if (!cleanupIds.frozenSnapshotId && cleanupIds.frozenSnapshotUid) {
      for (let page = 1; page <= 20; page += 1) {
        const snapListRes = await callActor(
          'root',
          `dxosDataGov:listSnapshots?organizationId=${encodeURIComponent(organizationId)}&sourceCollection=latticeOrders&page=${page}&pageSize=100`,
        ).catch(() => null);
        const items = Array.isArray(snapListRes?.data?.items) ? snapListRes.data.items : [];
        const matched = items.find((s) => s?.snapshotUid === cleanupIds.frozenSnapshotUid);
        if (matched?.id != null) {
          cleanupIds.frozenSnapshotId = matched.id;
          break;
        }
        const total = typeof snapListRes?.data?.total === 'number' ? snapListRes.data.total : null;
        if (!items.length || items.length < 100 || (total !== null && page * 100 >= total)) break;
      }
    }
    if (cleanupIds.frozenSnapshotId) {
      await callActor('root', `latticeFrozenSnapshots:destroy?filterByTk=${cleanupIds.frozenSnapshotId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.approvalId) {
      await callActor('root', `latticeAiApprovalQueue:destroy?filterByTk=${cleanupIds.approvalId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.twinShadowId) {
      await callActor('root', `latticeTwinShadows:destroy?filterByTk=${cleanupIds.twinShadowId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.assetId) {
      await callActor('root', `latticeAssets:destroy?filterByTk=${cleanupIds.assetId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.dmnTableId) {
      await callActor('root', `latticeDecisionTables:destroy?filterByTk=${cleanupIds.dmnTableId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.epodId) {
      await callActor('root', `latticeEpodRecords:destroy?filterByTk=${cleanupIds.epodId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.orderLineId) {
      await callActor('root', `latticeOrderLines:destroy?filterByTk=${cleanupIds.orderLineId}`, { method: 'POST' }).catch(() => {});
    }
    for (const lotId of cleanupIds.lotIds) {
      await callActor('root', `latticeStockLots:destroy?filterByTk=${lotId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.mktLotCode) {
      const targetEntity = `lot:${cleanupIds.mktLotCode}`;
      const incFilter = encodeURIComponent(JSON.stringify({ organizationId, assetEntityId: targetEntity }));
      const incListRes = await callActor('root', `latticeIncidentCases:list?pageSize=50&filter=${incFilter}`).catch(() => null);
      const incRows = Array.isArray(incListRes?.data)
        ? incListRes.data
        : (Array.isArray(incListRes?.data?.items) ? incListRes.data.items : []);
      for (const row of incRows) {
        if (row?.id != null && String(row?.assetEntityId || '') === targetEntity) {
          await callActor('root', `latticeIncidentCases:destroy?filterByTk=${row.id}`, { method: 'POST' }).catch(() => {});
        }
      }

      const runFilter = encodeURIComponent(JSON.stringify({ organizationId, ruleKey: 'auto_mkt_quarantine_response' }));
      const runListRes = await callActor('root', `latticeAutomationRuns:list?pageSize=50&sort=-id&filter=${runFilter}`).catch(() => null);
      const runRows = Array.isArray(runListRes?.data)
        ? runListRes.data
        : (Array.isArray(runListRes?.data?.items) ? runListRes.data.items : []);
      for (const row of runRows) {
        if (row?.id != null && JSON.stringify(row).includes(cleanupIds.mktLotCode)) {
          await callActor('root', `latticeAutomationRuns:destroy?filterByTk=${row.id}`, { method: 'POST' }).catch(() => {});
        }
      }
    }
    if (cleanupIds.delegationId) {
      await callActor('root', `latticeDelegations:destroy?filterByTk=${cleanupIds.delegationId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.delegOrderId) {
      await callActor('root', `latticeOrders:destroy?filterByTk=${cleanupIds.delegOrderId}`, { method: 'POST' }).catch(() => {});
    }
    if (cleanupIds.orderId) {
      await callActor('root', `latticeOrders:destroy?filterByTk=${cleanupIds.orderId}`, { method: 'POST' }).catch(() => {});
    }
  }
}

export const runHeadlessPaasAcceptance = runHeadlessPaaSAcceptance;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const opts = parseHeadlessAcceptanceArgs(process.argv.slice(2));
    let origin = opts.origin;
    if (opts.reportPath) {
      const report = JSON.parse(await readFile(resolve(opts.reportPath), 'utf8'));
      origin = report.origin;
    }
    const callActor = await createHeadlessPaaSCallers(origin);
    const result = await runHeadlessPaaSAcceptance(callActor, { organizationId: opts.organizationId });
    console.log(JSON.stringify(result, null, 2));
  })().catch((err) => {
    console.error(JSON.stringify({ result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  });
}

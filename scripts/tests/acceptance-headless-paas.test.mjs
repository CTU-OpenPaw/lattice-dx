/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeadlessAcceptanceArgs,
  createHeadlessPaaSCallers,
  runHeadlessPaaSAcceptance,
  parseHeadlessPaasArgs,
  createHeadlessPaasCaller,
  runHeadlessPaasAcceptance,
} from '../acceptance-headless-paas.mjs';

const ALLOWED_DESIRED_KEYS = new Set([
  'targetTempC',
  'maxTempC',
  'minTempC',
  'defrostMode',
  'fanMode',
  'doorLock',
  'reportingIntervalSec',
]);
const ALLOWED_DEFROST_MODES = new Set(['auto', 'manual', 'off']);
const ALLOWED_FAN_MODES = new Set(['auto', 'high', 'low', 'eco']);
const ALLOWED_DOOR_LOCKS = new Set(['locked', 'unlocked']);

function validateMockDesiredPatch(desiredPatch) {
  if (!desiredPatch || typeof desiredPatch !== 'object' || Array.isArray(desiredPatch) || Object.keys(desiredPatch).length === 0) {
    return { ok: false, status: 400, data: { code: 'TWIN_DESIRED_INVALID' } };
  }
  for (const [key, rawVal] of Object.entries(desiredPatch)) {
    if (!ALLOWED_DESIRED_KEYS.has(key)) {
      return { ok: false, status: 400, data: { code: 'TWIN_FIELD_FORBIDDEN', field: key } };
    }
    if (key === 'doorLock' && (typeof rawVal !== 'string' || !ALLOWED_DOOR_LOCKS.has(rawVal))) {
      return { ok: false, status: 400, data: { code: 'TWIN_FIELD_FORBIDDEN', field: key } };
    }
    if (key === 'fanMode' && (typeof rawVal !== 'string' || !ALLOWED_FAN_MODES.has(rawVal))) {
      return { ok: false, status: 400, data: { code: 'TWIN_FIELD_FORBIDDEN', field: key } };
    }
    if (key === 'defrostMode' && (typeof rawVal !== 'string' || !ALLOWED_DEFROST_MODES.has(rawVal))) {
      return { ok: false, status: 400, data: { code: 'TWIN_FIELD_FORBIDDEN', field: key } };
    }
    if ((key === 'targetTempC' || key === 'maxTempC' || key === 'minTempC') && (typeof rawVal !== 'number' || !Number.isFinite(rawVal))) {
      return { ok: false, status: 400, data: { code: 'TWIN_DESIRED_INVALID', field: key } };
    }
  }
  return null;
}

function createMockHeadlessCaller({
  freezeReturnsId = true,
  bundleSchemaVersion = 'latticedx.solution-bundle/v3',
} = {}) {
  const calls = [];
  const destroyed = [];
  const revokedPatTokens = new Set();
  const issuedPatToken = 'ldx_pat_a1b2c3d4_0123456789abcdef0123456789abcdef';
  let lastEvidencePhoto = '';
  let nextOrderId = 500;
  let activeDelegation = null;

  const callActor = async (actorRole, path, opts = {}) => {
    calls.push({ actorRole, path, opts });
    const [resourceAction, query = ''] = String(path).split('?');

    if (resourceAction === 'dxos:health') {
      return { ok: true, status: 200, data: { status: 'ok', version: '0.4.2', dbHealthy: true } };
    }
    if (resourceAction === 'dxos:openapi') {
      return { ok: true, status: 200, data: { openapi: '3.1.0', info: { version: '0.4.2' }, paths: { '/api/dxos:health': {} } } };
    }
    if (resourceAction === 'dxos:asyncapi') {
      return { ok: true, status: 200, data: { asyncapi: '3.0.0', info: { version: '0.4.2' }, channels: { telemetry: {} } } };
    }
    if (resourceAction === 'dxos:manifest') {
      return { ok: true, status: 200, data: { name: 'LatticeDX Field PWA', start_url: '/v/mobile' } };
    }
    if (resourceAction === 'dxos:sw.js') {
      return { ok: true, status: 200, rawText: 'const CACHE_NAME = "latticedx-v1"; const urls = ["/api/dxos:manifest"];', data: {} };
    }

    if (resourceAction === 'dxosApiKeys:issue') {
      if (actorRole === 'employee' && opts.values?.roleName === 'root') {
        return { ok: false, status: 403, data: { code: 'API_KEY_ROLE_ESCALATION' } };
      }
      return {
        ok: true,
        status: 200,
        data: { id: 91, name: opts.values?.name, token: issuedPatToken, active: true },
      };
    }
    if (resourceAction === 'dxosApiKeys:list') {
      return { ok: true, status: 200, data: { organizationId: 'native-ui-lab', items: [{ id: 91, name: 'Mock PAT', active: true }] } };
    }
    if (resourceAction === 'dxosApiKeys:revoke') {
      revokedPatTokens.add(issuedPatToken);
      return { ok: true, status: 200, data: { id: opts.values?.id, active: false } };
    }

    if (resourceAction === 'dxosLedger:publicKey') {
      if (opts.bearerToken && revokedPatTokens.has(opts.bearerToken)) {
        return { ok: false, status: 401, data: { code: 'API_KEY_REVOKED' } };
      }
      return {
        ok: true,
        status: 200,
        data: { algorithm: 'Ed25519', active: true, keyId: 'key-1', publicKeyPem: 'BEGIN PUBLIC KEY MOCK' },
      };
    }

    if (resourceAction === 'latticeOrders:create') {
      nextOrderId += 1;
      return { ok: true, status: 200, data: { id: nextOrderId, code: opts.values?.code, status: opts.values?.status || 'draft' } };
    }
    if (resourceAction === 'auth:check') {
      return { ok: true, status: 200, data: { id: actorRole === 'employee' ? 202 : 101, username: actorRole } };
    }
    if (resourceAction === 'latticeEmployees:list') {
      return {
        ok: true,
        status: 200,
        data: [
          { id: 1, userId: 101, organizationId: 'native-ui-lab', active: true },
          { id: 2, userId: 202, organizationId: 'native-ui-lab', active: true },
        ],
      };
    }
    if (resourceAction === 'dxosLedger:signDocument') {
      return { ok: true, status: 200, data: { signed: true, signatureBase64: 'sig==', merkleRoot: 'root123' } };
    }
    if (resourceAction === 'dxosLedger:verify') {
      return { ok: true, status: 200, data: { valid: true, brokenAtSeq: null, checkedCount: 3 } };
    }

    if (resourceAction === 'dxosDataGov:tierSummary') {
      return { ok: true, status: 200, data: { organizationId: 'native-ui-lab', hotOrders: 2, coldSnapshots: 1 } };
    }
    if (resourceAction === 'dxosDataGov:freezeSnapshot') {
      return {
        ok: true,
        status: 200,
        data: {
          ...(freezeReturnsId ? { id: 1401 } : {}),
          status: 'sealed',
          snapshotUid: 'SNAP-001',
          payloadHash: 'abc',
          signatureBase64: 'snap-sig',
          keyId: 'key-1',
        },
      };
    }
    if (resourceAction === 'dxosDataGov:getSnapshot') {
      return {
        ok: true,
        status: 200,
        data: {
          ...(freezeReturnsId ? { id: 1401 } : {}),
          snapshotUid: 'SNAP-001',
          hashVerified: true,
          signatureVerified: true,
          payloadJson: [{ id: 501 }],
        },
      };
    }
    if (resourceAction === 'dxosDataGov:listSnapshots') {
      return {
        ok: true,
        status: 200,
        data: {
          total: 1,
          page: 1,
          pageSize: 100,
          items: [{ id: 1401, snapshotUid: 'SNAP-001', sourceCollection: 'latticeOrders' }],
        },
      };
    }
    if (resourceAction === 'dxosLedger:verifySignature') {
      return { ok: true, status: 200, data: { valid: true } };
    }
    if (resourceAction === 'dxosDataGov:lineage') {
      return { ok: true, status: 200, data: { nodeCount: 2, nodes: [{ id: '1' }, { id: '2' }], edges: [{ id: 'e1' }] } };
    }
    if (resourceAction === 'dxosDataGov:listQuarantine') {
      return { ok: true, status: 200, data: { items: [] } };
    }

    if (resourceAction === 'dxosWms:saveOrderLine') {
      return { ok: true, status: 200, data: { orderLine: { id: 601, lineNo: 1 } } };
    }
    if (resourceAction === 'dxosWms:receiveStock') {
      const lotId = opts.values?.lotCode?.includes('MKT') ? 702 : 701;
      return { ok: true, status: 200, data: { lot: { id: lotId, lotCode: opts.values?.lotCode } } };
    }
    if (resourceAction === 'dxosWms:allocateFefo') {
      return { ok: true, status: 200, data: { allocatedTotal: 10, shortfall: 0, allocations: [{ id: 801 }] } };
    }
    if (resourceAction === 'dxosWms:holdLotByMkt') {
      return { ok: true, status: 200, data: { held: true, lotStatus: 'hold_mkt', mktCelsius: 13.3 } };
    }
    if (resourceAction === 'dxosWms:epodCapture') {
      lastEvidencePhoto = String(opts.values?.evidencePhotoDataUrl || '');
      return {
        ok: true,
        status: 200,
        data: { epod: { id: 901, epodUid: 'EPOD-901' }, trackingCode: 'TRK-901', trackingToken: 'tok-secret-1' },
      };
    }
    if (resourceAction === 'dxosWms:printVoucher') {
      const photoHtml = lastEvidencePhoto ? `<img class="epod-photo-img" src="${lastEvidencePhoto}" />` : '';
      return {
        ok: true,
        status: 200,
        data: { html: `<html><svg viewBox="0 0 29 29"></svg>EPOD${photoHtml}</html>`, qrVerificationHash: 'qr-hash' },
      };
    }
    if (resourceAction === 'dxosWms:publicTrack') {
      if (query.includes('MISSING-')) {
        return { ok: false, status: 401, data: { code: 'TRACKING_UNAUTHORIZED' } };
      }
      return {
        ok: true,
        status: 200,
        data: { trackingCode: 'TRK-901', status: 'delivered', orderCode: 'ORD-PAAS-1' },
      };
    }
    if (resourceAction === 'dxosWms:verifyTrackSignature') {
      if (query.includes('MISSING-')) {
        return { ok: false, status: 401, data: { code: 'TRACKING_UNAUTHORIZED' } };
      }
      return {
        ok: true,
        status: 200,
        data: {
          verified: true,
          seq: 1,
          ledgerSeq: 1,
          entryHash: 'a'.repeat(64),
          keyId: 'ed25519-key-1',
          publicKeyFingerprint: 'b'.repeat(64),
          reason: '',
        },
      };
    }

    if (resourceAction === 'dxosDmn:saveTable') {
      return { ok: true, status: 200, data: { table: { id: 1001, tableKey: opts.values?.tableKey } } };
    }
    if (resourceAction === 'dxosDmn:evaluate') {
      return { ok: true, status: 200, data: { matched: true, result: { tier: 'director_approval' } } };
    }
    if (resourceAction === 'dxosDmn:listTables') {
      const created = calls.find((c) => c.path === 'dxosDmn:saveTable')?.opts?.values?.tableKey;
      return { ok: true, status: 200, data: { items: [{ id: 1001, tableKey: created }] } };
    }
    if (resourceAction === 'dxosDelegations:list') {
      return { ok: true, status: 200, data: { items: activeDelegation ? [activeDelegation] : [] } };
    }
    if (resourceAction === 'dxosDelegations:create') {
      if (actorRole === 'employee' && opts.values?.roleName === 'ldx_admin') {
        return { ok: false, status: 403, data: { code: 'DELEGATION_ESCALATION_FORBIDDEN' } };
      }
      activeDelegation = {
        id: 1701,
        delegationUid: 'DLG-MOCK-1701',
        organizationId: opts.values?.organizationId,
        delegatorUserId: opts.values?.delegatorUserId,
        delegateUserId: opts.values?.delegateUserId,
        roleName: opts.values?.roleName,
        scopeCollection: opts.values?.scopeCollection || null,
        status: 'active',
        active: true,
      };
      return { ok: true, status: 200, data: { delegation: activeDelegation } };
    }
    if (resourceAction === 'dxosDelegations:activeForUser') {
      const activeItems = activeDelegation && activeDelegation.status === 'active' ? [activeDelegation] : [];
      return {
        ok: true,
        status: 200,
        data: { items: activeItems, roles: activeItems.map((d) => d.roleName) },
      };
    }
    if (resourceAction === 'dxosDelegations:revoke') {
      if (activeDelegation) {
        activeDelegation = { ...activeDelegation, status: 'revoked', active: false };
      }
      return { ok: true, status: 200, data: { delegation: activeDelegation } };
    }
    if (resourceAction === 'latticeVoucher:submit') {
      if (actorRole === 'employee' && !(activeDelegation && activeDelegation.status === 'active')) {
        return { ok: false, status: 403, data: { code: 'VOUCHER_FORBIDDEN' } };
      }
      return { ok: true, status: 200, data: { id: opts.values?.id, status: 'submitted', version: 2 } };
    }

    if (resourceAction === 'latticeAssets:create') {
      return { ok: true, status: 200, data: { id: 1101, code: opts.values?.code } };
    }
    if (resourceAction === 'dxosBlocks:twinShadow') {
      return { ok: true, status: 200, data: { shadow: { id: 1201, desiredJson: {}, reportedJson: {} } } };
    }
    if (resourceAction === 'dxosBlocks:twinSetDesired') {
      const invalid = validateMockDesiredPatch(opts.values?.desiredPatch);
      if (invalid) return invalid;
      if (opts.values?.desiredPatch?.targetTempC === 4.0) {
        return { ok: true, status: 200, data: { gatedByHitl: false, shadow: { id: 1201 } } };
      }
      return { ok: true, status: 200, data: { gatedByHitl: true, deltaTempC: 6, approvalId: 1301 } };
    }

    if (resourceAction === 'latticePara:extractFormFields') {
      const m = Buffer.from(opts.values?.contentBase64 || '', 'base64').toString('utf8').match(/ORD-OCR-[A-Z0-9]+/);
      return {
        ok: true,
        status: 200,
        data: {
          targetCollection: 'latticeOrders',
          suggestedValues: { code: m ? m[0] : '' },
          lineItems: [],
          confidence: 0.9,
          warnings: [],
        },
      };
    }
    if (resourceAction === 'dxosAi:triageScan') {
      return { ok: true, status: 200, data: { scannedCount: 4, matchedAlarms: 1, proposals: [] } };
    }
    if (resourceAction === 'dxosStudio:solutionBundleExport') {
      return {
        ok: true,
        status: 200,
        data: {
          metadata: { schemaVersion: bundleSchemaVersion, platformVersion: '0.4.2', organizationId: 'native-ui-lab', contentSha256: 'a'.repeat(64) },
          roles: [{ name: 'ldx_employee' }],
          portals: [{ path: '/v/my-work' }],
        },
      };
    }

    if (resourceAction === 'latticeIncidentCases:list') {
      const mktLotCode = calls.find((c) => c.path === 'dxosWms:holdLotByMkt')?.opts?.values?.lotCode;
      return {
        ok: true,
        status: 200,
        data: mktLotCode ? [{ id: 1501, organizationId: 'native-ui-lab', assetEntityId: `lot:${mktLotCode}` }] : [],
      };
    }
    if (resourceAction === 'latticeAutomationRuns:list') {
      const mktLotCode = calls.find((c) => c.path === 'dxosWms:holdLotByMkt')?.opts?.values?.lotCode;
      return {
        ok: true,
        status: 200,
        data: mktLotCode
          ? [{ id: 1601, organizationId: 'native-ui-lab', ruleKey: 'auto_mkt_quarantine_response', eventPayloadJson: { lotCode: mktLotCode } }]
          : [],
      };
    }

    if (resourceAction.endsWith(':destroy')) {
      destroyed.push(path);
      return { ok: true, status: 200, data: { ok: true } };
    }

    throw new Error(`Unexpected mock API call: ${resourceAction}`);
  };

  return { callActor, calls, destroyed };
}

test('parseHeadlessAcceptanceArgs validates origins and exports brief + alias names', () => {
  assert.equal(parseHeadlessPaasArgs, parseHeadlessAcceptanceArgs);
  assert.equal(createHeadlessPaasCaller, createHeadlessPaaSCallers);
  assert.equal(runHeadlessPaasAcceptance, runHeadlessPaaSAcceptance);
  assert.equal(typeof createHeadlessPaaSCallers, 'function');

  assert.throws(() => parseHeadlessAcceptanceArgs([]), /Usage:/);
  assert.throws(() => parseHeadlessAcceptanceArgs(['--origin=https://evil.example.com']), /Unsafe origin/);

  const parsed = parseHeadlessAcceptanceArgs(['--origin=http://localhost:13014', '--org=custom-org']);
  assert.equal(parsed.origin, 'http://localhost:13014');
  assert.equal(parsed.organizationId, 'custom-org');
});

test('mock dxosBlocks:twinSetDesired rejects forbidden keys and invalid enums with HTTP 400 TWIN_FIELD_FORBIDDEN', async () => {
  const { callActor } = createMockHeadlessCaller();
  const badKey = await callActor('root', 'dxosBlocks:twinSetDesired', {
    method: 'POST',
    values: { organizationId: 'native-ui-lab', assetId: 1101, desiredPatch: { targetTempC: 4.0, doorLocked: true } },
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.data?.code, 'TWIN_FIELD_FORBIDDEN');

  const badEnum = await callActor('root', 'dxosBlocks:twinSetDesired', {
    method: 'POST',
    values: { organizationId: 'native-ui-lab', assetId: 1101, desiredPatch: { doorLock: 'yes', fanMode: 'turbo' } },
  });
  assert.equal(badEnum.status, 400);
  assert.equal(badEnum.data?.code, 'TWIN_FIELD_FORBIDDEN');
});

test('runHeadlessPaaSAcceptance verifies all 8 PaaS checks and cleans up temporary records including frozen snapshots', async () => {
  const { callActor, calls, destroyed } = createMockHeadlessCaller({ freezeReturnsId: true });

  const result = await runHeadlessPaaSAcceptance(callActor, { organizationId: 'native-ui-lab' });
  assert.equal(result.result, 'PASS');
  assert.equal(result.bundleSchemaVersion, 'latticedx.solution-bundle/v3');
  for (const [key, passed] of Object.entries(result.checks)) {
    assert.equal(passed, true, `Check ${key} failed`);
  }
  assert.equal(calls.some((c) => c.path.includes('latticeStockAllocations')), false);
  assert.ok(destroyed.some((p) => p.includes('latticeFrozenSnapshots:destroy?filterByTk=1401')));
  assert.ok(destroyed.some((p) => p.includes('latticeOrders:destroy?filterByTk=501')));
  assert.ok(destroyed.some((p) => p.includes('latticeOrders:destroy?filterByTk=502')));
  assert.ok(destroyed.some((p) => p.includes('latticeDelegations:destroy?filterByTk=1701')));
  assert.ok(destroyed.some((p) => p.includes('latticeAssets:destroy?filterByTk=1101')));
  assert.ok(destroyed.some((p) => p.includes('latticeAiApprovalQueue:destroy?filterByTk=1301')));
  assert.ok(destroyed.some((p) => p.includes('latticeIncidentCases:destroy?filterByTk=1501')));
  assert.ok(destroyed.some((p) => p.includes('latticeAutomationRuns:destroy?filterByTk=1601')));
  assert.ok(destroyed.some((p) => p.includes('latticeApiKeys:destroy?filterByTk=91')));
});

test('runHeadlessPaaSAcceptance looks up frozen snapshot id via listSnapshots when freezeSnapshot omits id and rejects v2 bundle', async () => {
  const noIdMock = createMockHeadlessCaller({ freezeReturnsId: false });
  const passRes = await runHeadlessPaasAcceptance(noIdMock.callActor, { organizationId: 'native-ui-lab' });
  assert.equal(passRes.result, 'PASS');
  assert.ok(noIdMock.destroyed.some((p) => p.includes('latticeFrozenSnapshots:destroy?filterByTk=1401')));

  const v2Mock = createMockHeadlessCaller({ bundleSchemaVersion: 'latticedx.solution-bundle/v2' });
  await assert.rejects(
    () => runHeadlessPaaSAcceptance(v2Mock.callActor, { organizationId: 'native-ui-lab' }),
    (err) => {
      const rawMessage = String(err?.message || '');
      const plainMessage = rawMessage.replace(/\x1b\[[0-9;]*m/g, '');
      assert.match(plainMessage, /Expected bundle schemaVersion latticedx\.solution-bundle\/v3/);
      assert.match(rawMessage, /latticedx\.solution-bundle\/v3/);
      return true;
    },
  );
  assert.ok(v2Mock.destroyed.some((p) => p.includes('latticeFrozenSnapshots:destroy?filterByTk=1401')));
});

test('runHeadlessPaaSAcceptance runs cleanup even when an intermediate step fails', async () => {
  const destroyed = [];
  const callActor = async (actorRole, path, opts = {}) => {
    const [resourceAction] = String(path).split('?');
    if (resourceAction === 'dxos:health') return { ok: true, status: 200, data: { status: 'ok', version: '0.4.2' } };
    if (resourceAction === 'dxos:openapi') return { ok: true, status: 200, data: { openapi: '3.1.0', info: { version: '0.4.2' }, paths: {} } };
    if (resourceAction === 'dxos:asyncapi') return { ok: true, status: 200, data: { asyncapi: '3.0.0', info: { version: '0.4.2' }, channels: {} } };
    if (resourceAction === 'dxos:manifest') return { ok: true, status: 200, data: { name: 'PWA', start_url: '/v/mobile' } };
    if (resourceAction === 'dxos:sw.js') return { ok: true, status: 200, rawText: 'CACHE_NAME /api/dxos:manifest', data: {} };
    if (resourceAction === 'dxosApiKeys:issue') {
      if (actorRole === 'employee' && opts.values?.roleName === 'root') return { ok: false, status: 403, data: {} };
      return { ok: true, status: 200, data: { id: 77, token: 'ldx_pat_11223344_0123456789abcdef0123456789abcdef' } };
    }
    if (resourceAction === 'dxosLedger:publicKey') return { ok: false, status: 500, data: { error: 'boom' } };
    if (resourceAction === 'dxosApiKeys:revoke') return { ok: true, status: 200, data: { active: false } };
    if (resourceAction === 'latticeIncidentCases:list') {
      const mktLotCode = calls.find((c) => c.path === 'dxosWms:holdLotByMkt')?.opts?.values?.lotCode;
      return {
        ok: true,
        status: 200,
        data: mktLotCode ? [{ id: 1501, organizationId: 'native-ui-lab', assetEntityId: `lot:${mktLotCode}` }] : [],
      };
    }
    if (resourceAction === 'latticeAutomationRuns:list') {
      const mktLotCode = calls.find((c) => c.path === 'dxosWms:holdLotByMkt')?.opts?.values?.lotCode;
      return {
        ok: true,
        status: 200,
        data: mktLotCode
          ? [{ id: 1601, organizationId: 'native-ui-lab', ruleKey: 'auto_mkt_quarantine_response', eventPayloadJson: { lotCode: mktLotCode } }]
          : [],
      };
    }

    if (resourceAction.endsWith(':destroy')) {
      destroyed.push(path);
      return { ok: true, status: 200, data: {} };
    }
    throw new Error(`Unexpected call: ${resourceAction}`);
  };

  await assert.rejects(() => runHeadlessPaaSAcceptance(callActor), /Bearer PAT access 200/);
  assert.ok(destroyed.includes('latticeApiKeys:destroy?filterByTk=77'));
});

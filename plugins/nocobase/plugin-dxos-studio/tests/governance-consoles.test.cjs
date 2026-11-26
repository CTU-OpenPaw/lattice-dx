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
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) collectNodes(node.children, pred, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children);
  return '';
}

function expandElement(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expandElement);
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props || {});
    return expandElement(rendered);
  }
  if (Array.isArray(node.children)) {
    return { ...node, children: node.children.map(expandElement) };
  }
  return node;
}

function createReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) {
      arr = [];
      map.set(comp, arr);
    }
    return arr;
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) {
        bucket[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        bucket[idx] = typeof next === 'function' ? next(bucket[idx]) : next;
      };
      return [bucket[idx], setState];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null };
        pendingEffects.push(fn);
      }
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, value: fn() };
      }
      return bucket[idx].value;
    },
  };

  function renderNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const prevComp = currentComponent;
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
      }
      return renderNode(out);
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: node.children.map(renderNode) };
    }
    return node;
  }

  async function mountAndFlush(ComponentFn, props = {}) {
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 4 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      tree = renderNode(React.createElement(ComponentFn, props));
    }
    return tree;
  }

  return {
    React,
    render: (ComponentFn, props = {}) => renderNode(React.createElement(ComponentFn, props)),
    mountAndFlush,
  };
}

function createApiMock(handlers) {
  const requests = [];
  const client = {
    useAPIClient: () => ({
      async request(req) {
        requests.push({
          url: req.url,
          method: (req.method || 'get').toLowerCase(),
          params: req.params || null,
          data: req.data || null,
        });
        const key = `${(req.method || 'get').toLowerCase()} ${req.url}`;
        const fn = handlers[key] || handlers[req.url];
        if (!fn) return { data: { data: {} } };
        const payload = await fn(req);
        return { data: { data: payload } };
      },
    }),
  };
  return { client, requests };
}

test('governance-consoles exports createDxosGovernanceConsoles & GOVERNANCE_SECTIONS and obeys bundler/security rules', () => {
  const govPath = path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js');
  const studioPath = path.join(PLUGIN_ROOT, 'src/client/studio-settings.js');
  const { createDxosGovernanceConsoles, GOVERNANCE_SECTIONS } = require(govPath);

  assert.equal(typeof createDxosGovernanceConsoles, 'function');
  assert.ok(Array.isArray(GOVERNANCE_SECTIONS));
  assert.deepEqual(
    GOVERNANCE_SECTIONS.map((s) => s.id),
    ['api-keys', 'ledger', 'data-gov', 'wms-epod', 'dmn', 'delegations'],
  );

  for (const filePath of [govPath, studioPath]) {
    const src = readFileSync(filePath, 'utf8');
    assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'), `Missing SPDX header in ${filePath}`);
    assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/, `Forbidden host require() in ${filePath}`);
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/, `Must not touch browser storage in ${filePath}`);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/, `Must never use dangerouslySetInnerHTML in ${filePath}`);
  }
});

test('Module 1 (api-keys): lists masked keys, issues ephemeral PAT once with dismiss, and revokes keys', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  let keyList = [
    {
      id: 11,
      organizationId: 'org-a',
      name: 'MES Edge Poller',
      keyPrefix: 'ldx_pat_a1b2c3d4',
      roleName: 'ldx_operator',
      scopes: ['read', 'iot'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      lastUsedAt: '2026-11-22T09:00:00.000Z',
      active: true,
    },
  ];
  const { client, requests } = createApiMock({
    'dxosApiKeys:list': async () => ({ organizationId: 'org-a', items: keyList }),
    'dxosApiKeys:issue': async (req) => {
      const issued = {
        id: 12,
        organizationId: 'org-a',
        name: req.data.name,
        keyPrefix: 'ldx_pat_deadbeef',
        roleName: req.data.roleName,
        scopes: req.data.scopes,
        expiresAt: '2026-12-23T00:00:00.000Z',
        active: true,
      };
      keyList = [issued, ...keyList];
      return { ...issued, token: 'ldx_pat_deadbeef_0123456789abcdef0123456789abcdef' };
    },
    'dxosApiKeys:revoke': async (req) => {
      keyList = keyList.map((k) => (k.id === req.data.id ? { ...k, active: false, revokedAt: '2026-11-23T05:00:00.000Z' } : k));
      return { id: req.data.id, active: false };
    },
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  let dump = JSON.stringify(tree);
  assert.ok(dump.includes('ldx_pat_a1b2c3d4...'), 'Key prefix must be masked with ellipsis');
  assert.ok(dump.includes('MES Edge Poller'));

  // Fill issue form & submit
  const nameInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-name-input')[0];
  const roleInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-role-input')[0];
  const daysInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-days-input')[0];
  assert.ok(nameInput && roleInput && daysInput);
  nameInput.props.onChange({ target: { value: 'CI Pipeline Key' } });
  roleInput.props.onChange({ target: { value: 'ldx_warehouse' } });
  daysInput.props.onChange({ target: { value: '45' } });
  const wmsScope = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-scope-wms')[0];
  assert.ok(wmsScope);
  wmsScope.props.onChange({ target: { checked: true } });

  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  const issueForm = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-issue-form')[0];
  await issueForm.props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });

  const issueReq = requests.find((r) => r.url === 'dxosApiKeys:issue');
  assert.ok(issueReq);
  assert.equal(issueReq.data.name, 'CI Pipeline Key');
  assert.equal(issueReq.data.roleName, 'ldx_warehouse');
  assert.equal(issueReq.data.expiresInDays, 45);
  assert.ok(issueReq.data.scopes.includes('wms'));

  const tokenBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-pat-token-once')[0];
  assert.ok(tokenBanner, 'Issued plaintext token banner must appear once');
  assert.ok(textOf(tokenBanner).includes('ldx_pat_deadbeef_0123456789abcdef0123456789abcdef'));

  // Dismiss button clears ephemeral plaintext token
  const dismissBtn = collectNodes(tokenBanner, (n) => n.type === 'button')[0];
  assert.ok(dismissBtn);
  dismissBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-pat-token-once').length, 0);
  assert.equal(JSON.stringify(tree).includes('0123456789abcdef0123456789abcdef'), false);

  // Revoke key
  const revokeBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-revoke-11')[0];
  assert.ok(revokeBtn);
  await revokeBtn.props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosApiKeys:revoke' && r.data.id === 11));
});

test('Module 2 (ledger): renders Ed25519 PKI key, Merkle status, hash-chain entries, and verifies chain pass/tamper', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  let verifyPass = true;
  const { client, requests } = createApiMock({
    'dxosLedger:publicKey': async () => ({
      organizationId: 'org-a',
      keyId: 'ed25519-aabbccdd11223344',
      algorithm: 'Ed25519',
      fingerprintSha256: 'fp_9988776655443322',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtest\n-----END PUBLIC KEY-----',
      active: true,
    }),
    'dxosLedger:status': async () => ({
      organizationId: 'org-a',
      latestSeq: 2,
      entryCount: 2,
      headHash: 'headhash_002',
      merkleRoot: 'merkleroot_002',
      keyId: 'ed25519-aabbccdd11223344',
    }),
    'dxosLedger:entries': async () => ({
      organizationId: 'org-a',
      total: 2,
      page: 1,
      pageSize: 20,
      items: [
        {
          seq: 2,
          eventType: 'wms.epod_captured',
          targetCollection: 'latticeEpodRecords',
          targetRecordId: 'EPOD-2',
          entryHash: 'hash_002',
          merkleRoot: 'merkleroot_002',
          recordedAt: '2026-11-23T03:00:00.000Z',
        },
        {
          seq: 1,
          eventType: 'document.signed',
          targetCollection: 'latticeOrders',
          targetRecordId: '101',
          entryHash: 'hash_001',
          merkleRoot: 'merkleroot_001',
          recordedAt: '2026-11-23T02:00:00.000Z',
        },
      ],
    }),
    'dxosLedger:verify': async () => (verifyPass
      ? { organizationId: 'org-a', valid: true, checkedCount: 2, brokenAtSeq: null, reason: null, merkleRoot: 'merkleroot_002', headHash: 'headhash_002' }
      : { organizationId: 'org-a', valid: false, checkedCount: 1, brokenAtSeq: 2, reason: 'ENTRY_HASH_MISMATCH', merkleRoot: 'merkleroot_001', headHash: 'hash_001' }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('ed25519-aabbccdd11223344'));
  assert.ok(dump.includes('fp_9988776655443322'));
  assert.ok(dump.includes('merkleroot_002'));
  assert.ok(dump.includes('wms.epod_captured'));

  const verifyBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-verify-btn')[0];
  assert.ok(verifyBtn);
  await verifyBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  let resultBox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-verify-result')[0];
  assert.ok(resultBox);
  assert.ok(textOf(resultBox).includes('2'));

  verifyPass = false;
  await verifyBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  resultBox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-verify-result')[0];
  assert.ok(textOf(resultBox).includes('ENTRY_HASH_MISMATCH'));
  assert.ok(requests.some((r) => r.url === 'dxosLedger:verify'));
});

test('Module 3 (data-gov): tier summary, freeze snapshot, Cold Reading Room, quarantine resolve, and Arrhenius MKT', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  let snapshots = [
    {
      id: 1,
      snapshotUid: 'SNP-001',
      tier: 'cold',
      sourceCollection: 'latticeOrders',
      recordCount: 12,
      payloadHash: 'sha256_snp_001',
      frozenAt: '2026-11-22T00:00:00.000Z',
      retentionDays: 1825,
      status: 'sealed',
    },
  ];
  let quarantine = [
    {
      id: 50,
      quarantineUid: 'QRN-50',
      sourceSystem: 'iiot',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: -18.5,
      unit: 'CEL',
      reasonCode: 'BAD_TELEMETRY_QUALITY',
      severity: 'medium',
      status: 'quarantined',
    },
    {
      id: 51,
      quarantineUid: 'QRN-51',
      sourceSystem: 'iiot',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: 999,
      unit: 'CEL',
      reasonCode: 'SENSOR_OUT_OF_RANGE',
      severity: 'high',
      status: 'quarantined',
    },
  ];
  const { client, requests } = createApiMock({
    'dxosDataGov:tierSummary': async () => ({
      organizationId: 'org-a',
      hotOrders: 14,
      warmOrders: 29,
      hotTickets: 3,
      coldSnapshots: snapshots.length,
      coldTotalRecords: 12,
      lineageEdges: 42,
      quarantineOpen: quarantine.filter((q) => q.status === 'quarantined').length,
      quarantineResolved: quarantine.filter((q) => q.status !== 'quarantined').length,
    }),
    'dxosDataGov:listSnapshots': async () => ({ organizationId: 'org-a', total: snapshots.length, items: snapshots }),
    'dxosDataGov:freezeSnapshot': async (req) => {
      const created = {
        id: 2,
        snapshotUid: 'SNP-002',
        tier: req.data.tier || 'cold',
        sourceCollection: req.data.sourceCollection,
        recordCount: 5,
        payloadHash: 'sha256_snp_002',
        frozenAt: '2026-11-23T04:00:00.000Z',
        retentionDays: req.data.retentionDays,
        status: 'sealed',
      };
      snapshots = [created, ...snapshots];
      return created;
    },
    'dxosDataGov:getSnapshot': async () => ({
      ...snapshots[0],
      recomputedHash: snapshots[0].payloadHash,
      hashVerified: true,
      signatureVerified: true,
      payloadJson: [{ id: 1, code: 'ORD-01', total: 200 }],
    }),
    'dxosDataGov:quarantineList': async () => ({ organizationId: 'org-a', total: quarantine.length, items: quarantine }),
    'dxosDataGov:quarantineResolve': async (req) => {
      quarantine = quarantine.map((q) => (q.quarantineUid === req.data.quarantineUid ? { ...q, status: req.data.status } : q));
      return { quarantine: quarantine.find((q) => q.quarantineUid === req.data.quarantineUid), releasedPoint: null };
    },
    'dxosDataGov:computeMkt': async () => ({
      organizationId: 'org-a',
      mktCelsius: 6.412,
      minTempCelsius: 2.1,
      maxTempCelsius: 9.2,
      avgTempCelsius: 5.1,
      sampleCount: 3,
      excursionCount: 1,
      thresholdCelsius: 8,
      breached: false,
    }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'data-gov', selectedOrg: 'org-a' });
  let dump = JSON.stringify(tree);
  assert.ok(dump.includes('SNP-001'));
  assert.ok(dump.includes('QRN-50'));
  assert.ok(dump.includes('42'));

  // Freeze snapshot
  const freezeForm = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-datagov-freeze-form')[0];
  await freezeForm.props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'data-gov', selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosDataGov:freezeSnapshot'));

  // Inspect Cold Reading Room
  const inspectBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-datagov-inspect-SNP-001')[0];
  assert.ok(inspectBtn);
  await inspectBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'data-gov', selectedOrg: 'org-a' });
  const readingRoom = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-cold-reading-room')[0];
  assert.ok(readingRoom);
  assert.ok(textOf(readingRoom).includes('ORD-01'));

  // Approve & Reject quarantine items
  const approveBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-quarantine-approve-QRN-50')[0];
  const rejectBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-quarantine-reject-QRN-51')[0];
  assert.ok(approveBtn && rejectBtn);
  await approveBtn.props.onClick();
  await rejectBtn.props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosDataGov:quarantineResolve' && r.data.quarantineUid === 'QRN-50' && r.data.status === 'approved_release'));
  assert.ok(requests.some((r) => r.url === 'dxosDataGov:quarantineResolve' && r.data.quarantineUid === 'QRN-51' && r.data.status === 'rejected'));

  // Compute Arrhenius MKT
  const mktForm = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-datagov-mkt-form')[0];
  assert.ok(mktForm);
  await mktForm.props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'data-gov', selectedOrg: 'org-a' });
  const mktResult = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-datagov-mkt-result')[0];
  assert.ok(mktResult);
  assert.ok(textOf(mktResult).includes('6.412'));
});

test('Module 4 (wms-epod): stock lots grid, receive stock, allocate FEFO, MKT hold, and sandboxed voucher iframe', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  let lots = [
    {
      id: 1,
      lotCode: 'LOT-VAC-01',
      sku: 'VAC-01',
      productName: 'Cold Vaccine A',
      qtyOnHand: 40,
      qtyReserved: 10,
      unit: 'VIAL',
      expiryDate: '2027-03-01T00:00:00.000Z',
      mktCelsius: 4.1,
      status: 'available',
    },
    {
      id: 2,
      lotCode: 'LOT-HOLD-02',
      sku: 'VAC-02',
      productName: 'Cold Vaccine B',
      qtyOnHand: 20,
      qtyReserved: 0,
      unit: 'VIAL',
      expiryDate: '2027-04-01T00:00:00.000Z',
      mktCelsius: 14.8,
      status: 'hold_mkt',
    },
    {
      id: 3,
      lotCode: 'LOT-DEP-03',
      sku: 'VAC-03',
      productName: 'Cold Vaccine C',
      qtyOnHand: 0,
      qtyReserved: 0,
      unit: 'VIAL',
      expiryDate: '2027-05-01T00:00:00.000Z',
      mktCelsius: 3.5,
      status: 'depleted',
    },
  ];
  const { client, requests } = createApiMock({
    'dxosWms:lots': async () => ({ organizationId: 'org-a', items: lots }),
    'dxosWms:receiveStock': async (req) => ({
      lot: { id: 4, ...req.data, status: 'available', qtyReserved: 0 },
    }),
    'dxosWms:allocateFefo': async () => ({
      allocatedTotal: 5,
      shortfall: 0,
      allocations: [{ lotCode: 'LOT-VAC-01', qtyAllocated: 5 }],
    }),
    'dxosWms:holdLotByMkt': async (req) => ({
      held: true,
      lotCode: req.data.lotCode,
      mktCelsius: 11.2,
      thresholdCelsius: 8,
      lotStatus: 'hold_mkt',
    }),
    'dxosWms:printVoucher': async () => ({
      documentType: 'delivery_note',
      organizationId: 'org-a',
      html: '<html><body><h1>Delivery Note ORD-001</h1></body></html>',
      htmlSha256: 'voucher_sha256_abc',
      qrVerificationHash: 'qr_hash_xyz',
      ledgerSeq: 12,
      keyId: 'ed25519-key',
    }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('LOT-VAC-01'));
  assert.ok(dump.includes('hold_mkt'));
  assert.ok(dump.includes('depleted'));

  // Receive Stock
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-receive-lotcode')[0].props.onChange({ target: { value: 'LOT-NEW-04' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-receive-sku')[0].props.onChange({ target: { value: 'VAC-01' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-receive-name')[0].props.onChange({ target: { value: 'Vaccine New' } });
  tree = harness.render(Consoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-receive-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosWms:receiveStock' && r.data.lotCode === 'LOT-NEW-04'));

  // Allocate FEFO
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-fefo-sku')[0].props.onChange({ target: { value: 'VAC-01' } });
  tree = harness.render(Consoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-fefo-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosWms:allocateFefo' && r.data.sku === 'VAC-01'));

  // MKT Hold Check
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-mkthold-lotcode')[0].props.onChange({ target: { value: 'LOT-VAC-01' } });
  tree = harness.render(Consoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-mkthold-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosWms:holdLotByMkt' && r.data.lotCode === 'LOT-VAC-01'));

  // Printable Voucher Preview in sandboxed iframe
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-voucher-ordercode')[0].props.onChange({ target: { value: 'ORD-001' } });
  tree = harness.render(Consoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-wms-voucher-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });

  const iframe = collectNodes(tree, (n) => n.type === 'iframe')[0];
  assert.ok(iframe, 'Voucher HTML preview must render inside an <iframe>');
  assert.equal(iframe.props.sandbox, '', 'Voucher iframe MUST enforce strict sandbox=""');
  assert.ok(String(iframe.props.srcDoc).includes('Delivery Note ORD-001'));
});

test('Module 5 (dmn): lists tables, saves FIRST/COLLECT table JSON, and evaluates rule simulator', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  const tables = [
    {
      id: 1,
      tableKey: 'cold-chain-rule',
      name: 'Cold Chain Policy',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'temperature', type: 'number' }],
      outputsJson: [{ name: 'action', type: 'string' }],
      rulesJson: [{ when: { temperature: { op: 'gt', value: 8 } }, then: { action: 'hold_mkt' } }],
      version: 1,
    },
  ];
  const { client, requests } = createApiMock({
    'dxosDmn:listTables': async () => ({ organizationId: 'org-a', items: tables }),
    'dxosDmn:saveTable': async (req) => ({ table: { ...req.data, version: 2 } }),
    'dxosDmn:evaluate': async () => ({
      tableKey: 'cold-chain-rule',
      version: 2,
      hitPolicy: 'FIRST',
      matched: true,
      matchedRuleIndex: 0,
      result: { action: 'hold_mkt' },
      outputs: { action: 'hold_mkt' },
      matchedRules: [{ ruleIndex: 0, outputs: { action: 'hold_mkt' } }],
    }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });
  assert.ok(JSON.stringify(tree).includes('cold-chain-rule'));

  const hitPolicySelect = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-dmn-hitpolicy-select')[0];
  assert.ok(hitPolicySelect);
  hitPolicySelect.props.onChange({ target: { value: 'COLLECT' } });
  tree = harness.render(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-dmn-save-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosDmn:saveTable' && r.data.hitPolicy === 'COLLECT'));

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-dmn-eval-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });
  const evalResult = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-dmn-eval-result')[0];
  assert.ok(evalResult);
  assert.ok(textOf(evalResult).includes('hold_mkt'));
});

test('Module 6 (delegations): lists delegations, creates scoped delegation, and revokes delegation', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  let delegations = [
    {
      id: 7,
      delegationUid: 'DLG-0007',
      delegatorUserId: 10,
      delegateUserId: 20,
      roleName: 'ldx_operator',
      scopeCollection: 'latticeOrders',
      reason: 'Annual leave coverage',
      startsAt: '2026-11-23T00:00:00.000Z',
      endsAt: '2026-11-30T00:00:00.000Z',
      status: 'active',
    },
  ];
  const { client, requests } = createApiMock({
    'dxosDelegations:list': async () => ({ organizationId: 'org-a', items: delegations }),
    'dxosDelegations:create': async (req) => {
      const created = { id: 8, delegationUid: 'DLG-0008', ...req.data, status: 'active' };
      delegations = [created, ...delegations];
      return { delegation: created };
    },
    'dxosDelegations:revoke': async (req) => {
      delegations = delegations.map((d) => (d.delegationUid === req.data.delegationUid ? { ...d, status: 'revoked' } : d));
      return { delegation: delegations.find((d) => d.delegationUid === req.data.delegationUid) };
    },
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'delegations', selectedOrg: 'org-a' });
  assert.ok(JSON.stringify(tree).includes('DLG-0007'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-delegation-user-input')[0].props.onChange({ target: { value: '25' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-delegation-role-input')[0].props.onChange({ target: { value: 'ldx_warehouse' } });
  tree = harness.render(Consoles, { initialSection: 'delegations', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-delegation-create-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosDelegations:create' && r.data.delegateUserId === 25 && r.data.roleName === 'ldx_warehouse'));

  const revokeBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-delegation-revoke-DLG-0007')[0];
  assert.ok(revokeBtn);
  await revokeBtn.props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosDelegations:revoke' && r.data.delegationUid === 'DLG-0007'));
});

test('studio-settings integrates 6 governance tabs alongside preserved 6 studio tabs', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const harness = createReactHarness();
  const { client } = createApiMock({
    'dxosStudio:listTemplates': async () => ({ items: [] }),
    'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-a'], organizationCounts: { 'org-a': 2 } }),
    'dxosStudio:readiness': async () => ({ plugins: [] }),
    'dxosApiKeys:list': async () => ({ organizationId: 'org-a', items: [] }),
    'dxosLedger:publicKey': async () => ({ organizationId: 'org-a', keyId: 'ed25519-test' }),
    'dxosLedger:status': async () => ({ organizationId: 'org-a', entryCount: 0 }),
    'dxosLedger:entries': async () => ({ organizationId: 'org-a', total: 0, items: [] }),
  });

  const Page = createDxosStudioSettingsPage(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Page);

  // All 12 studio tabs preserved inside single role="tablist" (including Notify tab)
  const tablists = collectNodes(tree, (n) => n.props?.role === 'tablist');
  assert.equal(tablists.length, 1);
  assert.equal(collectNodes(tablists[0], (n) => n.props?.role === 'tab').length, 12);

  // All 6 governance sub-tabs exposed 1 click away via data-testid="dxos-studio-tab-<id>"
  for (const id of ['api-keys', 'ledger', 'data-gov', 'wms-epod', 'dmn', 'delegations']) {
    const btn = collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-studio-tab-${id}`)[0];
    assert.ok(btn, `Missing studio tab button dxos-studio-tab-${id}`);
  }

  // Click Ledger governance pill -> mounts Ledger console inside studio
  const ledgerBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-ledger')[0];
  ledgerBtn.props.onClick();
  tree = await harness.mountAndFlush(Page);
  const expanded = expandElement(tree);
  assert.ok(collectNodes(expanded, (n) => n.props?.['data-testid'] === 'dxos-governance-console-ledger').length >= 1);
});

test('DMN rejects malformed JSON safely without calling API and bundled dist/client/index.js loads cleanly', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'dxosDmn:listTables': async () => ({ organizationId: 'org-a', items: [] }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });
  const textareas = collectNodes(tree, (n) => n.type === 'textarea');
  assert.ok(textareas.length >= 4);
  // Corrupt rulesJson textarea (index 2)
  textareas[2].props.onChange({ target: { value: '{broken json' } });
  tree = harness.render(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-dmn-save-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });
  assert.equal(requests.some((r) => r.url === 'dxosDmn:saveTable'), false);
  assert.ok(JSON.stringify(tree).includes('không phải JSON hợp lệ'));

  // Verify bundled dist/client/index.js loads and mounts Studio + GovernanceConsoles
  const Module = require('node:module');
  const origLoad = Module._load;
  const distClientPath = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  let registered = null;
  class MockPlugin {
    constructor(app) { this.app = app; }
  }
  Module._load = function mockedHost(request, parent, isMain) {
    if (request === '@nocobase/client') return { Plugin: MockPlugin, useAPIClient: client.useAPIClient };
    if (request === 'react') return harness.React;
    if (request === 'antd') return {};
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(distClientPath)];
    const mod = require(distClientPath);
    const PluginCls = mod.default;
    const instance = new PluginCls({
      pluginSettingsManager: {
        add(key, opts) { registered = { key, opts }; },
      },
    });
    await instance.load();
    assert.equal(registered.key, 'dxos-studio');
    const bundledTree = await harness.mountAndFlush(registered.opts.Component);
    assert.ok(collectNodes(bundledTree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-wms-epod').length === 1);
  } finally {
    Module._load = origLoad;
  }
});

test('Minor 1 (ledger): filter typing fires zero requests, Apply/Pagination fetch once, and stale responses are ignored', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  let entriesResolverQueue = [];
  let manualQueueMode = false;

  const { client, requests } = createApiMock({
    'dxosLedger:publicKey': async () => ({ organizationId: 'org-a', keyId: 'ed25519-test' }),
    'dxosLedger:status': async () => ({ organizationId: 'org-a', entryCount: 45, latestSeq: 45 }),
    'dxosLedger:entries': async (req) => {
      if (manualQueueMode) {
        return new Promise((resolve) => {
          entriesResolverQueue.push({ req, resolve });
        });
      }
      return {
        organizationId: 'org-a',
        total: 45,
        page: req.params?.page || 1,
        pageSize: 20,
        items: [
          {
            seq: req.params?.page === 2 ? 25 : 45,
            eventType: req.params?.eventType || 'document.signed',
            targetCollection: req.params?.targetCollection || 'latticeOrders',
            targetRecordId: 'REC-1',
            entryHash: 'hash_1',
            merkleRoot: 'root_1',
            recordedAt: '2026-11-23T04:00:00.000Z',
          },
        ],
      };
    },
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  assert.equal(requests.filter((r) => r.url === 'dxosLedger:entries').length, 1);

  const countBeforeTyping = requests.length;
  const eventInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-filter-eventtype')[0];
  const colInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-filter-collection')[0];
  assert.ok(eventInput && colInput);

  // Typing several characters must NOT trigger API requests
  for (const ch of ['d', 'do', 'doc', 'document.signed']) {
    eventInput.props.onChange({ target: { value: ch } });
    tree = await harness.mountAndFlush(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  }
  colInput.props.onChange({ target: { value: 'latticeOrders' } });
  tree = await harness.mountAndFlush(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  assert.equal(requests.length, countBeforeTyping, 'Typing in ledger filter inputs must not fire API requests');

  // Clicking "Áp dụng lọc" triggers 1 fetch batch with applied filters
  const applyBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-apply-filter-btn')[0];
  assert.ok(applyBtn);
  await applyBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });

  const entryReqs = requests.filter((r) => r.url === 'dxosLedger:entries');
  assert.equal(entryReqs.length, 2);
  assert.equal(entryReqs[1].params.eventType, 'document.signed');
  assert.equal(entryReqs[1].params.targetCollection, 'latticeOrders');
  assert.equal(entryReqs[1].params.page, 1);

  // Clicking "Trang sau" fetches page 2 preserving applied filters
  const nextBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-next-page-btn')[0];
  assert.ok(nextBtn && !nextBtn.props.disabled);
  await nextBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });

  const afterPageReqs = requests.filter((r) => r.url === 'dxosLedger:entries');
  assert.equal(afterPageReqs.length, 3);
  assert.equal(afterPageReqs[2].params.page, 2);
  assert.equal(afterPageReqs[2].params.eventType, 'document.signed');

  // Stale-response sequence guard: request #1 resolves AFTER request #2
  manualQueueMode = true;
  const eventInput2 = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-filter-eventtype')[0];
  eventInput2.props.onChange({ target: { value: 'stale.event' } });
  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  const pStale = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-apply-filter-btn')[0].props.onClick();

  eventInput2.props.onChange({ target: { value: 'fresh.event' } });
  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  const pFresh = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-apply-filter-btn')[0].props.onClick();

  assert.equal(entriesResolverQueue.length, 2);
  // Resolve #2 (fresh) first, then #1 (stale) second
  entriesResolverQueue[1].resolve({
    organizationId: 'org-a',
    total: 1,
    page: 1,
    items: [{ seq: 202, eventType: 'fresh.event', targetCollection: 'latticeOrders', targetRecordId: 'NEW', entryHash: 'h2', merkleRoot: 'r2', recordedAt: '2026-11-23T05:00:00.000Z' }],
  });
  await pFresh;
  entriesResolverQueue[0].resolve({
    organizationId: 'org-a',
    total: 1,
    page: 1,
    items: [{ seq: 101, eventType: 'stale.event', targetCollection: 'latticeOrders', targetRecordId: 'OLD', entryHash: 'h1', merkleRoot: 'r1', recordedAt: '2026-11-23T01:00:00.000Z' }],
  });
  await pStale;

  tree = harness.render(Consoles, { initialSection: 'ledger', selectedOrg: 'org-a' });
  const tableDump = JSON.stringify(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-entries-table')[0]);
  assert.ok(tableDump.includes('fresh.event'));
  assert.ok(!tableDump.includes('stale.event'), 'Stale out-of-order ledger response must not overwrite newer results');
});

test('Minor 2 (multi-org): orgOverride clears to empty without snapping back and filters full employee datalist dynamically', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const harness = createReactHarness();
  const allEmployees = [
    { id: 1, userId: 101, name: 'Alice OrgA', code: 'EMP-A1', organizationId: 'org-a', roles: ['ldx_operator'] },
    { id: 2, userId: 202, name: 'Bob OrgB', code: 'EMP-B1', organizationId: 'org-b', roles: ['ldx_operator'] },
  ];

  // Verify studio-settings passes full employees list (not pre-filtered orgEmployees) to GovernanceConsoles
  const studioApi = createApiMock({
    'dxosStudio:listTemplates': async () => ({ items: [] }),
    'dxosStudio:listEmployees': async () => ({ items: allEmployees, organizations: ['org-a', 'org-b'], organizationCounts: { 'org-a': 1, 'org-b': 1 } }),
    'dxosStudio:readiness': async () => ({ plugins: [] }),
    'dxosApiKeys:list': async () => ({ items: [] }),
  });
  const Page = createDxosStudioSettingsPage(studioApi.client, harness.React, {}, {});
  let studioTree = await harness.mountAndFlush(Page);
  collectNodes(studioTree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-api-keys')[0].props.onClick();
  studioTree = await harness.mountAndFlush(Page);
  const expandedStudio = expandElement(studioTree);
  const studioOrgInput = collectNodes(expandedStudio, (n) => n.props?.['data-testid'] === 'dxos-gov-org-override-input')[0];
  assert.ok(studioOrgInput);
  assert.equal(studioOrgInput.props.value, 'org-a');

  // Direct GovernanceConsoles test for clearing to '' and switching to 'org-b'
  const { client, requests } = createApiMock({
    'dxosApiKeys:list': async () => ({ items: [] }),
  });
  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  const baseProps = {
    initialSection: 'api-keys',
    selectedOrg: 'org-a',
    organizations: ['org-a', 'org-b'],
    employees: allEmployees,
  };
  let tree = await harness.mountAndFlush(Consoles, baseProps);

  let orgInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-gov-org-override-input')[0];
  assert.equal(orgInput.props.value, 'org-a');
  let dl = collectNodes(tree, (n) => n.type === 'datalist' && n.props?.id === 'dxos-gov-emp-users')[0];
  assert.ok(JSON.stringify(dl).includes('Alice OrgA'));
  assert.equal(JSON.stringify(dl).includes('Bob OrgB'), false);

  // Explicit clear to '' must NOT snap back to props.selectedOrg ('org-a')
  orgInput.props.onChange({ target: { value: '' } });
  tree = await harness.mountAndFlush(Consoles, baseProps);
  orgInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-gov-org-override-input')[0];
  assert.equal(orgInput.props.value, '', 'Cleared orgOverride must remain empty instead of snapping back');
  dl = collectNodes(tree, (n) => n.type === 'datalist' && n.props?.id === 'dxos-gov-emp-users')[0];
  assert.ok(JSON.stringify(dl).includes('Alice OrgA'));
  assert.ok(JSON.stringify(dl).includes('Bob OrgB'));

  // Override to 'org-b' filters datalist to org-b employees and reloads with organizationId='org-b'
  orgInput.props.onChange({ target: { value: 'org-b' } });
  tree = await harness.mountAndFlush(Consoles, baseProps);
  dl = collectNodes(tree, (n) => n.type === 'datalist' && n.props?.id === 'dxos-gov-emp-users')[0];
  assert.equal(JSON.stringify(dl).includes('Alice OrgA'), false);
  assert.ok(JSON.stringify(dl).includes('Bob OrgB'));
  assert.ok(requests.some((r) => r.url === 'dxosApiKeys:list' && r.params?.organizationId === 'org-b'));
});

test('Minor 3 (input/timezone): local datetime-local default, trimmed userId in issueApiKey, and strict sample parsing in holdLotByMkt', async () => {
  const { createDxosGovernanceConsoles, defaultEndsAtIso, parseSamplesInput } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));

  // 1. defaultEndsAtIso uses local timezone components rather than UTC slice
  const sampleMs = new Date(2026, 10, 23, 22, 15, 0).getTime();
  const expectedDt = new Date(sampleMs + 7 * 86_400_000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const expectedLocal = `${expectedDt.getFullYear()}-${pad2(expectedDt.getMonth() + 1)}-${pad2(expectedDt.getDate())}T${pad2(expectedDt.getHours())}:${pad2(expectedDt.getMinutes())}`;
  assert.equal(defaultEndsAtIso(sampleMs), expectedLocal);

  // 2. parseSamplesInput rejects non-numeric tokens cleanly
  assert.deepEqual(parseSamplesInput('2.5, 4.0; 9.5'), { ok: true, samples: [2.5, 4, 9.5], invalidTokens: [], error: null });
  assert.deepEqual(parseSamplesInput('   '), { ok: true, samples: [], invalidTokens: [], error: null });
  const badParsed = parseSamplesInput('2.5, abc, xyz');
  assert.equal(badParsed.ok, false);
  assert.deepEqual(badParsed.invalidTokens, ['abc', 'xyz']);

  // 3. issueApiKey with whitespace-only userId submits cleanly without userId: 0
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'dxosApiKeys:list': async () => ({ items: [] }),
    'dxosApiKeys:issue': async (req) => ({ id: 99, name: req.data.name, token: 'ldx_pat_test_token' }),
    'dxosWms:lots': async () => ({ items: [] }),
  });
  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-name-input')[0].props.onChange({ target: { value: 'Trim Test Key' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-userid-input')[0].props.onChange({ target: { value: '   ' } });
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-issue-form')[0].props.onSubmit({ preventDefault() {} });

  const issueReq = requests.find((r) => r.url === 'dxosApiKeys:issue');
  assert.ok(issueReq);
  assert.equal('userId' in issueReq.data, false, 'Whitespace-only userId must be omitted instead of coerced to 0');

  // Invalid non-numeric userId blocks submission with inline error
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-userid-input')[0].props.onChange({ target: { value: 'abc' } });
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  const issueCountBefore = requests.filter((r) => r.url === 'dxosApiKeys:issue').length;
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-issue-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  assert.equal(requests.filter((r) => r.url === 'dxosApiKeys:issue').length, issueCountBefore);
  assert.ok(JSON.stringify(tree).includes('userId không hợp lệ'));

  // 4. holdLotByMkt rejects malformed non-numeric sample input instead of falling back to telemetry
  const wmsHarness = createReactHarness();
  const wmsMock = createApiMock({
    'dxosWms:lots': async () => ({ items: [] }),
    'dxosWms:holdLotByMkt': async () => ({ held: false, lotCode: 'LOT-1' }),
  });
  const WmsConsoles = createDxosGovernanceConsoles(wmsMock.client, wmsHarness.React, {}, {});
  let wmsTree = await wmsHarness.mountAndFlush(WmsConsoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  collectNodes(wmsTree, (n) => n.props?.['data-testid'] === 'dxos-wms-mkthold-lotcode')[0].props.onChange({ target: { value: 'LOT-1' } });
  collectNodes(wmsTree, (n) => n.props?.['data-testid'] === 'dxos-wms-mkthold-samples')[0].props.onChange({ target: { value: 'bad-temp, NaN' } });
  wmsTree = wmsHarness.render(WmsConsoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });
  await collectNodes(wmsTree, (n) => n.props?.['data-testid'] === 'dxos-wms-mkthold-form')[0].props.onSubmit({ preventDefault() {} });
  wmsTree = wmsHarness.render(WmsConsoles, { initialSection: 'wms-epod', selectedOrg: 'org-a' });

  assert.equal(wmsMock.requests.some((r) => r.url === 'dxosWms:holdLotByMkt'), false, 'Malformed samplesC must fail explicitly without falling back to telemetry');
  const errBanner = collectNodes(wmsTree, (n) => n.props?.role === 'status')[0];
  assert.ok(errBanner && textOf(errBanner).includes('bad-temp'));
});

test('Task 3: DMN console collapses raw JSON forms inside closed <details> and regenerates simContextText on table selection', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  const tables = [
    {
      id: 1,
      tableKey: 'cold-chain-rule',
      name: 'Cold Chain Policy',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'temperature', type: 'number' }],
      outputsJson: [{ name: 'action', type: 'string' }],
      rulesJson: [{ when: { temperature: { op: 'gt', value: 8 } }, then: { action: 'hold_mkt' } }],
      version: 1,
    },
    {
      id: 2,
      tableKey: 'shipping-tier-rule',
      name: 'Shipping Tier Policy',
      hitPolicy: 'FIRST',
      inputsJson: [
        { name: 'weightKg', type: 'number' },
        { name: 'express', type: 'boolean' },
        { name: 'region', type: 'string' },
      ],
      outputsJson: [{ name: 'carrier', type: 'string' }],
      rulesJson: [{ when: { weightKg: { op: 'gt', value: 10 } }, then: { carrier: 'freight' } }],
      version: 1,
    },
  ];
  const { client } = createApiMock({
    'dxosDmn:listTables': async () => ({ organizationId: 'org-a', items: tables }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });

  const details = collectNodes(tree, (n) => n.type === 'details' && n.props?.['data-testid'] === 'dxos-dmn-raw-json-details')[0];
  assert.ok(details, 'Legacy raw JSON DMN forms must be wrapped in <details data-testid="dxos-dmn-raw-json-details">');
  assert.equal(Boolean(details.props.open), false, 'Legacy raw JSON <details> must be closed by default');
  assert.equal(collectNodes(details, (n) => n.props?.['data-testid'] === 'dxos-dmn-save-form').length, 1);
  assert.equal(collectNodes(details, (n) => n.props?.['data-testid'] === 'dxos-dmn-eval-form').length, 1);

  const evalFormInitial = collectNodes(details, (n) => n.props?.['data-testid'] === 'dxos-dmn-eval-form')[0];
  const initialEvalCtx = JSON.parse(collectNodes(evalFormInitial, (n) => n.type === 'textarea')[0].props.value);
  assert.deepEqual(initialEvalCtx, { temperature: 0 }, 'Initial simContextText must be built from DEFAULT_DMN_INPUTS with numeric 0');

  // Switch to shipping-tier-rule via "Nạp vào Editor"
  const loadButtons = collectNodes(tree, (n) => n.type === 'button' && textOf(n) === 'Nạp vào Editor');
  assert.equal(loadButtons.length, 2);
  loadButtons[1].props.onClick();
  tree = harness.render(Consoles, { initialSection: 'dmn', selectedOrg: 'org-a' });

  const evalFormAfter = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-dmn-eval-form')[0];
  const nextEvalCtx = JSON.parse(collectNodes(evalFormAfter, (n) => n.type === 'textarea')[0].props.value);
  assert.deepEqual(nextEvalCtx, { weightKg: 0, express: false, region: '' }, 'Selecting a DMN table must regenerate simContextText from tbl.inputsJson');
});

test('P1-05 & P2-07: API Key Copy PAT + <select> role, and PKI 2-step Key Rotation + Merkle Proof export', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'dxosApiKeys:list': async () => ({ organizationId: 'org-a', items: [] }),
    'dxosApiKeys:issue': async (req) => ({ id: 99, name: req.data.name, roleName: req.data.roleName, keyPrefix: 'ldx_pat_copy99', token: 'ldx_pat_copy99_secret' }),
    'dxosLedger:publicKey': async () => ({ organizationId: 'org-a', keyId: 'ed25519-old-1', fingerprintSha256: 'fp-old' }),
    'dxosLedger:status': async () => ({ organizationId: 'org-a', keyId: 'ed25519-old-1', entryCount: 1, merkleRoot: 'root-1' }),
    'dxosLedger:entries': async () => ({ organizationId: 'org-a', total: 1, items: [{ seq: 1, eventType: 'wms.epod_captured', targetCollection: 'latticeOrders', targetRecordId: '1', entryHash: 'h1', merkleRoot: 'root-1' }] }),
    'dxosLedger:rotateKey': async () => ({
      organizationId: 'org-a',
      newKeyId: 'ed25519-new-2',
      retiredKeyId: 'ed25519-old-1',
      fingerprintSha256: 'fp-new',
      active: true,
      status: 'active',
    }),
    'dxosLedger:exportProof': async () => ({ organizationId: 'org-a', entryCount: 1, merkleRoot: 'root-1', publicKey: { keyId: 'ed25519-new-2' }, entries: [{ seq: 1 }] }),
  });

  const Consoles = createDxosGovernanceConsoles(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  const roleSelect = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-role-input')[0];
  assert.equal(roleSelect.type, 'select');
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-name-input')[0].props.onChange({ target: { value: 'CI Key' } });
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-issue-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });

  const copyBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-copy-token-btn')[0];
  assert.ok(copyBtn);
  await copyBtn.props.onClick();
  tree = harness.render(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-apikey-copy-token-btn')[0]).includes('Đã sao chép'));

  // Ledger rotateKey (2-step) + exportProof
  tree = await harness.mountAndFlush(Consoles, { activeSection: 'ledger', selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-rotate-key-btn')[0].props.onClick();
  tree = harness.render(Consoles, { activeSection: 'ledger', selectedOrg: 'org-a' });
  const confirmRotateBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-rotate-confirm-btn')[0];
  assert.ok(confirmRotateBtn);
  await confirmRotateBtn.props.onClick();
  tree = harness.render(Consoles, { activeSection: 'ledger', selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosLedger:rotateKey' && r.method === 'post'));
  const rotateBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-rotate-result')[0];
  assert.ok(rotateBanner, 'dxos-ledger-rotate-result banner must render after key rotation');
  assert.ok(textOf(rotateBanner).includes('ed25519-new-2'));
  assert.ok(textOf(rotateBanner).includes('ed25519-old-1'));
  const statusFeedback = collectNodes(tree, (n) => n.props?.role === 'status' && textOf(n).includes('ed25519-new-2'));
  assert.ok(statusFeedback.length >= 1);

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-export-proof-btn')[0].props.onClick();
  tree = harness.render(Consoles, { activeSection: 'ledger', selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosLedger:exportProof' && r.method === 'get'));
  const proofPreview = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-ledger-proof-preview')[0];
  assert.ok(proofPreview && textOf(proofPreview).includes('root-1'));
});

test('T4-RW-03 regression: DataGovConsole and LedgerConsole skip org-required queries while organizationId is empty and auto-fetch once resolved', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));

  // 1. Direct DataGovConsole mount with empty/whitespace selectedOrg fires ZERO dxosDataGov:* requests
  const dgHarness = createReactHarness();
  const dgMock = createApiMock({
    'dxosDataGov:tierSummary': async (req) => {
      assert.ok(req.params?.organizationId, 'tierSummary must receive non-empty organizationId');
      return { organizationId: req.params.organizationId, hotOrders: 3, warmOrders: 1, hotTickets: 0, coldSnapshots: 1, coldTotalRecords: 5, lineageEdges: 2, quarantineOpen: 1, quarantineResolved: 0 };
    },
    'dxosDataGov:listSnapshots': async (req) => {
      assert.ok(req.params?.organizationId, 'listSnapshots must receive non-empty organizationId');
      return { organizationId: req.params.organizationId, total: 1, items: [{ snapshotUid: 'SNP-RW03-1', sourceCollection: 'latticeOrders', tier: 'cold', recordCount: 5, payloadHash: 'hash1', frozenAt: '2026-11-26T00:00:00.000Z' }] };
    },
    'dxosDataGov:quarantineList': async (req) => {
      assert.ok(req.params?.organizationId, 'quarantineList must receive non-empty organizationId');
      return { organizationId: req.params.organizationId, total: 1, items: [{ quarantineUid: 'QRN-RW03-1', sourceSystem: 'mqtt', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1', metricName: 'temperature', numericValue: 18, unit: 'CEL', reasonCode: 'TEMP_HIGH', status: 'quarantined' }] };
    },
  });
  const ConsolesDG = createDxosGovernanceConsoles(dgMock.client, dgHarness.React, {}, {});
  let dgTree = await dgHarness.mountAndFlush(ConsolesDG, { initialSection: 'data-gov', selectedOrg: '' });
  assert.equal(dgMock.requests.length, 0, 'DataGovConsole must not call dxosDataGov:* when selectedOrg is empty');

  dgTree = await dgHarness.mountAndFlush(ConsolesDG, { initialSection: 'data-gov', selectedOrg: '   ' });
  assert.equal(dgMock.requests.length, 0, 'DataGovConsole must not call dxosDataGov:* when selectedOrg is whitespace');

  // Refresh button is disabled while organizationId is unset and clicking/submitting triggers zero API calls
  const dgRefreshBtn = collectNodes(dgTree, (n) => n.type === 'button' && textOf(n) === 'Làm mới dữ liệu')[0];
  assert.ok(dgRefreshBtn && dgRefreshBtn.props.disabled === true);
  await dgRefreshBtn.props.onClick();
  await collectNodes(dgTree, (n) => n.props?.['data-testid'] === 'dxos-datagov-freeze-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(dgMock.requests.length, 0);

  // Once selectedOrg resolves to 'org-a', tierSummary, listSnapshots, and quarantineList are called with organizationId='org-a'
  dgTree = await dgHarness.mountAndFlush(ConsolesDG, { initialSection: 'data-gov', selectedOrg: 'org-a' });
  assert.equal(dgMock.requests.filter((r) => r.url === 'dxosDataGov:tierSummary' && r.params?.organizationId === 'org-a').length, 1);
  assert.equal(dgMock.requests.filter((r) => r.url === 'dxosDataGov:listSnapshots' && r.params?.organizationId === 'org-a').length, 1);
  assert.equal(dgMock.requests.filter((r) => r.url === 'dxosDataGov:quarantineList' && r.params?.organizationId === 'org-a').length, 1);
  const dgDump = JSON.stringify(dgTree);
  assert.ok(dgDump.includes('SNP-RW03-1'));
  assert.ok(dgDump.includes('QRN-RW03-1'));

  // 2. Direct LedgerConsole mount with empty selectedOrg skips dxosLedger:* until organizationId resolves
  const ledgerHarness = createReactHarness();
  const ledgerMock = createApiMock({
    'dxosLedger:publicKey': async (req) => {
      assert.ok(req.params?.organizationId);
      return { organizationId: req.params.organizationId, keyId: 'ed25519-rw03' };
    },
    'dxosLedger:status': async (req) => {
      assert.ok(req.params?.organizationId);
      return { organizationId: req.params.organizationId, entryCount: 1, latestSeq: 1, merkleRoot: 'root-rw03' };
    },
    'dxosLedger:entries': async (req) => {
      assert.ok(req.params?.organizationId);
      return { organizationId: req.params.organizationId, total: 1, items: [{ seq: 1, eventType: 'audit.test', targetCollection: 'latticeOrders', targetRecordId: '1', entryHash: 'h1', merkleRoot: 'root-rw03' }] };
    },
  });
  const ConsolesLedger = createDxosGovernanceConsoles(ledgerMock.client, ledgerHarness.React, {}, {});
  await ledgerHarness.mountAndFlush(ConsolesLedger, { initialSection: 'ledger', selectedOrg: '' });
  assert.equal(ledgerMock.requests.length, 0, 'LedgerConsole must not call dxosLedger:* when selectedOrg is empty');
  const ledgerTree = await ledgerHarness.mountAndFlush(ConsolesLedger, { initialSection: 'ledger', selectedOrg: 'org-a' });
  assert.equal(ledgerMock.requests.filter((r) => r.url === 'dxosLedger:entries' && r.params?.organizationId === 'org-a').length, 1);
  assert.ok(JSON.stringify(ledgerTree).includes('ed25519-rw03'));

  // 3. Full DxosStudioSettingsPage ?tab=data-gov repro: backend rejects any missing organizationId with 400 DATA_GOV_ORG_REQUIRED
  const prevWindow = globalThis.window;
  globalThis.window = { location: { search: '?tab=data-gov' } };
  try {
    const studioHarness = createReactHarness();
    const studioMock = createApiMock({
      'dxosStudio:listTemplates': async () => ({ items: [] }),
      'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['native-ui-lab'], organizationCounts: { 'native-ui-lab': 4 } }),
      'dxosStudio:readiness': async () => ({ plugins: [] }),
      'dxosDataGov:tierSummary': async (req) => {
        if (!req.params?.organizationId) {
          const err = new Error('Valid organizationId is required for root data governance queries.');
          err.response = { status: 400, data: { errors: [{ code: 'DATA_GOV_ORG_REQUIRED', message: err.message }] } };
          throw err;
        }
        return { organizationId: req.params.organizationId, hotOrders: 2, warmOrders: 0, hotTickets: 1, coldSnapshots: 1, coldTotalRecords: 2, lineageEdges: 1, quarantineOpen: 0, quarantineResolved: 0 };
      },
      'dxosDataGov:listSnapshots': async (req) => {
        if (!req.params?.organizationId) {
          const err = new Error('Valid organizationId is required for root data governance queries.');
          err.response = { status: 400, data: { errors: [{ code: 'DATA_GOV_ORG_REQUIRED', message: err.message }] } };
          throw err;
        }
        return { organizationId: req.params.organizationId, total: 1, items: [{ snapshotUid: 'SNP-LAB-1', sourceCollection: 'latticeOrders', tier: 'cold', recordCount: 2, payloadHash: 'h-lab' }] };
      },
      'dxosDataGov:quarantineList': async (req) => {
        if (!req.params?.organizationId) {
          const err = new Error('Valid organizationId is required for root data governance queries.');
          err.response = { status: 400, data: { errors: [{ code: 'DATA_GOV_ORG_REQUIRED', message: err.message }] } };
          throw err;
        }
        return { organizationId: req.params.organizationId, total: 0, items: [] };
      },
    });
    const Page = createDxosStudioSettingsPage(studioMock.client, studioHarness.React, {}, {});
    const studioTree = await studioHarness.mountAndFlush(Page);
    assert.equal(collectNodes(studioTree, (n) => n.props?.['data-testid'] === 'dxos-governance-console-data-gov').length, 1);

    const govReqs = studioMock.requests.filter((r) => r.url.startsWith('dxosDataGov:'));
    assert.ok(govReqs.some((r) => r.url === 'dxosDataGov:listSnapshots'));
    assert.ok(govReqs.some((r) => r.url === 'dxosDataGov:quarantineList'));
    assert.ok(govReqs.every((r) => r.params?.organizationId === 'native-ui-lab'), 'Every dxosDataGov:* request must carry resolved organizationId');
    assert.equal(collectNodes(studioTree, (n) => n.props?.role === 'status').length, 0, 'No error banner may appear on ?tab=data-gov mount');
    assert.ok(JSON.stringify(studioTree).includes('SNP-LAB-1'));
  } finally {
    globalThis.window = prevWindow;
  }
});


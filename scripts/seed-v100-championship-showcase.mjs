#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLoopbackOrigin,
  createSeederClient,
  parseSeedArgs,
  seedStudioShowcaseSamples,
} from './seed-v030-demo-showcase.mjs';

export { assertLoopbackOrigin, parseSeedArgs, createSeederClient };

const CHILLER_TELEMETRY_SERIES_C = [2.4, 2.7, 3.1, 3.8, 4.4, 8.9];
const REEFER_TELEMETRY_SERIES_C = [3.2, 3.5, 3.9, 4.1];

function unwrapList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.rows)) return res.rows;
  if (Array.isArray(res?.items)) return res.items;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.entries)) return res.entries;
  return [];
}

async function findByCode(api, collection, organizationId, code) {
  const filter = encodeURIComponent(JSON.stringify({ organizationId, code }));
  const rows = unwrapList(await api(`${collection}:list?filter=${filter}&pageSize=5`));
  return rows[0] || null;
}

async function ensureShowcaseContext(api, organizationId) {
  const filter = encodeURIComponent(JSON.stringify({ organizationId }));
  const depts = unwrapList(await api(`latticeDepartments:list?filter=${filter}&pageSize=10`));
  const emps = unwrapList(await api(`latticeEmployees:list?filter=${filter}&pageSize=50`));
  const activeEmps = emps.filter((e) => e?.active !== false);

  const distinctUserEmps = [];
  const seenUserIds = new Set();
  for (const emp of activeEmps) {
    const uid = Number(emp?.userId);
    if (Number.isInteger(uid) && uid > 0 && !seenUserIds.has(uid)) {
      seenUserIds.add(uid);
      distinctUserEmps.push(emp);
    }
  }

  return {
    departmentId: depts[0]?.id ?? null,
    employees: activeEmps,
    distinctUserEmps,
    requesterId: activeEmps[0]?.id ?? null,
  };
}

async function seedColdChainLocations(api, organizationId, ctx) {
  const specs = [
    {
      code: 'LOC-CT-COLD-01',
      name: 'Kho Lạnh Trung Tâm Cần Thơ',
      kind: 'warehouse',
      address: 'KCN Trà Nóc II, Quận Bình Thủy, Cần Thơ',
    },
    {
      code: 'LOC-HCM-HUB-02',
      name: 'Trung Tâm Phân Phối TP.HCM',
      kind: 'depot',
      address: 'Khu Công Nghệ Cao, TP. Thủ Đức, TP.HCM',
    },
    {
      code: 'LOC-DN-HUB-03',
      name: 'Trạm Trung Chuyển Đà Nẵng',
      kind: 'hub',
      address: 'KCN Hòa Khánh, Liên Chiểu, Đà Nẵng',
    },
  ];

  const byCode = {};
  let created = 0;
  let reused = 0;
  for (const spec of specs) {
    let row = await findByCode(api, 'latticeLocations', organizationId, spec.code);
    if (!row) {
      row = await api('latticeLocations:create', {
        method: 'POST',
        values: {
          ...spec,
          organizationId,
          active: true,
          ...(ctx.departmentId ? { departmentId: ctx.departmentId } : {}),
        },
      });
      created += 1;
    } else {
      reused += 1;
    }
    byCode[spec.code] = row;
  }
  return { byCode, created, reused };
}

async function ingestSeriesIdempotent(api, organizationId, assetId, seriesC) {
  const assetEntityId = `urn:ngsi-ld:Asset:${organizationId}:native:${assetId}`;
  const existing = await api(
    `dxosBlocks:telemetrySeries?organizationId=${encodeURIComponent(organizationId)}&assetEntityId=${encodeURIComponent(assetEntityId)}&attribute=temperature&windowHours=24&limit=100`,
  ).catch(() => ({ points: [] }));
  const existingPoints = Array.isArray(existing?.points) ? existing.points : [];
  if (existingPoints.length >= seriesC.length) {
    return { assetId, assetEntityId, ingested: 0, skipped: seriesC.length };
  }

  const existingTimestamps = existingPoints
    .map((p) => Date.parse(String(p?.timestamp || p?.observedAt || '')))
    .filter((ts) => Number.isFinite(ts));

  const nowMs = Date.now();
  const intervalMs = 60 * 60 * 1000;
  let ingested = 0;
  let skipped = 0;

  for (let i = 0; i < seriesC.length; i += 1) {
    const slotMs = nowMs - (seriesC.length - 1 - i) * intervalMs;
    if (existingTimestamps.some((ts) => Math.abs(ts - slotMs) <= 25 * 60 * 1000)) {
      skipped += 1;
      continue;
    }
    const numericValue = seriesC[i];
    await api('dxosBlocks:telemetryIngest', {
      method: 'POST',
      values: {
        organizationId,
        assetId,
        assetEntityId,
        metricName: 'temperature',
        numericValue,
        unit: 'Cel',
        quality: numericValue > 8.0 ? 'suspect' : 'good',
        sourceProtocol: 'mqtt-showcase',
        observedAt: new Date(slotMs).toISOString(),
      },
    });
    ingested += 1;
  }

  return { assetId, assetEntityId, ingested, skipped };
}

async function seedColdChainAssetsAndTelemetry(api, organizationId, ctx, locationsByCode) {
  const specs = [
    {
      code: 'COLD-CHILLER-CT-01',
      name: 'Kho Lạnh Vắc-xin Cần Thơ 01',
      kind: 'cold-chiller',
      status: 'active',
      locationId: locationsByCode['LOC-CT-COLD-01']?.id ?? null,
      series: CHILLER_TELEMETRY_SERIES_C,
    },
    {
      code: 'REEFER-TRUCK-HCM-02',
      name: 'Xe Tải Lạnh 65C-102.88 TP.HCM',
      kind: 'reefer-truck',
      status: 'active',
      locationId: locationsByCode['LOC-HCM-HUB-02']?.id ?? null,
      series: REEFER_TELEMETRY_SERIES_C,
    },
    {
      code: 'COLD-HUB-DN-03',
      name: 'Buồng Lạnh Trung Chuyển Đà Nẵng 03',
      kind: 'cold-hub',
      status: 'active',
      locationId: locationsByCode['LOC-DN-HUB-03']?.id ?? null,
      series: null,
    },
  ];

  const assetsByCode = {};
  const telemetrySummaries = [];
  let created = 0;
  let reused = 0;

  for (const spec of specs) {
    let asset = await findByCode(api, 'latticeAssets', organizationId, spec.code);
    if (!asset) {
      asset = await api('latticeAssets:create', {
        method: 'POST',
        values: {
          code: spec.code,
          name: spec.name,
          kind: spec.kind,
          status: spec.status,
          organizationId,
          active: true,
          ...(spec.locationId ? { locationId: spec.locationId } : {}),
          ...(ctx.departmentId ? { departmentId: ctx.departmentId } : {}),
        },
      });
      created += 1;
    } else {
      reused += 1;
    }
    assetsByCode[spec.code] = asset;
    if (asset?.id && Array.isArray(spec.series)) {
      telemetrySummaries.push(await ingestSeriesIdempotent(api, organizationId, asset.id, spec.series));
    }
  }

  return { assetsByCode, created, reused, telemetrySummaries };
}

async function seedDigitalTwinShadow(api, organizationId, chillerAsset) {
  if (!chillerAsset?.id) return { seeded: false, reason: 'missing_chiller_asset' };
  const current = await api(
    `dxosBlocks:twinShadow?organizationId=${encodeURIComponent(organizationId)}&assetId=${encodeURIComponent(chillerAsset.id)}`,
  ).catch(() => ({ shadow: null }));

  const desiredTarget = current?.shadow?.desiredJson?.targetTempC;
  if (desiredTarget !== undefined && desiredTarget !== null) {
    return { seeded: false, assetId: chillerAsset.id, existingTargetTempC: desiredTarget };
  }

  const res = await api('dxosBlocks:twinSetDesired', {
    method: 'POST',
    values: {
      organizationId,
      assetId: chillerAsset.id,
      desiredPatch: {
        targetTempC: 4.0,
        fanMode: 'eco',
        doorLock: 'locked',
      },
    },
  });
  return { seeded: true, assetId: chillerAsset.id, targetTempC: 4.0, gatedByHitl: Boolean(res?.gatedByHitl) };
}

async function seedWmsShowcase(api, organizationId, ctx) {
  let order = await findByCode(api, 'latticeOrders', organizationId, 'ORD-V100-001');
  let orderCreated = false;
  if (!order) {
    order = await api('latticeOrders:create', {
      method: 'POST',
      values: {
        code: 'ORD-V100-001',
        name: 'Lô Vắc-xin Cold-Chain Cần Thơ -> TP.HCM (v0.4.0)',
        organizationId,
        customer: 'Hệ thống Tiêm chủng Mekong',
        origin: 'Kho Lạnh Trung Tâm Cần Thơ',
        destination: 'Trung Tâm Phân Phối TP.HCM',
        quantity: 50,
        category: 'cold-chain',
        active: true,
        ...(ctx.departmentId ? { departmentId: ctx.departmentId } : {}),
        ...(ctx.requesterId ? { requesterId: ctx.requesterId } : {}),
      },
    });
    orderCreated = true;
  }

  const existingLines = unwrapList(
    await api(`dxosWms:orderLines?organizationId=${encodeURIComponent(organizationId)}&orderCode=ORD-V100-001`).catch(() => []),
  );
  const linesByNo = new Map(existingLines.map((l) => [Number(l.lineNo), l]));

  const desiredLines = [
    {
      lineNo: 1,
      sku: 'SKU-VAX-MKT-28',
      productName: 'Vắc-xin Phối hợp 2-8C (MKT Chuẩn)',
      requestedQty: 30,
      targetTempMinC: 2,
      targetTempMaxC: 8,
    },
    {
      lineNo: 2,
      sku: 'SKU-BIO-CRYO-15',
      productName: 'Sinh phẩm Huyết thanh Bảo quản Lạnh',
      requestedQty: 20,
      targetTempMinC: 2,
      targetTempMaxC: 8,
    },
  ];

  let linesCreated = 0;
  for (const line of desiredLines) {
    if (!linesByNo.has(line.lineNo)) {
      const saved = await api('dxosWms:saveOrderLine', {
        method: 'POST',
        values: {
          organizationId,
          orderId: order.id,
          orderCode: order.code,
          ...line,
        },
      });
      linesByNo.set(line.lineNo, saved?.orderLine || line);
      linesCreated += 1;
    }
  }

  const existingLots = unwrapList(
    await api(`dxosWms:lots?organizationId=${encodeURIComponent(organizationId)}`).catch(() => []),
  );
  const lotsByCode = new Map(existingLots.map((l) => [l.lotCode, l]));

  const dayMs = 86_400_000;
  const lotSpecs = [
    {
      lotCode: 'LOT-V100-FEFO-A',
      sku: 'SKU-VAX-MKT-28',
      productName: 'Vắc-xin Phối hợp 2-8C (MKT Chuẩn)',
      qtyOnHand: 40,
      expiryDate: new Date(Date.now() + 45 * dayMs).toISOString(),
      targetTempMinC: 2,
      targetTempMaxC: 8,
    },
    {
      lotCode: 'LOT-V100-FEFO-B',
      sku: 'SKU-VAX-MKT-28',
      productName: 'Vắc-xin Phối hợp 2-8C (MKT Chuẩn)',
      qtyOnHand: 60,
      expiryDate: new Date(Date.now() + 180 * dayMs).toISOString(),
      targetTempMinC: 2,
      targetTempMaxC: 8,
    },
    {
      lotCode: 'LOT-V100-BIO-A',
      sku: 'SKU-BIO-CRYO-15',
      productName: 'Sinh phẩm Huyết thanh Bảo quản Lạnh',
      qtyOnHand: 30,
      expiryDate: new Date(Date.now() + 90 * dayMs).toISOString(),
      targetTempMinC: 2,
      targetTempMaxC: 8,
    },
    {
      lotCode: 'LOT-V100-MKT-HOLD',
      sku: 'SKU-VAX-MKT-28',
      productName: 'Vắc-xin Phối hợp 2-8C (Lô Cảnh báo MKT)',
      qtyOnHand: 10,
      expiryDate: new Date(Date.now() + 120 * dayMs).toISOString(),
      targetTempMinC: 2,
      targetTempMaxC: 8,
    },
  ];

  let lotsCreated = 0;
  for (const spec of lotSpecs) {
    if (!lotsByCode.has(spec.lotCode)) {
      const received = await api('dxosWms:receiveStock', {
        method: 'POST',
        values: { organizationId, ...spec },
      });
      lotsByCode.set(spec.lotCode, received?.lot || spec);
      lotsCreated += 1;
    }
  }

  let heldMkt = false;
  const holdTarget = lotsByCode.get('LOT-V100-MKT-HOLD');
  if (holdTarget && holdTarget.status !== 'hold_mkt') {
    await api('dxosWms:holdLotByMkt', {
      method: 'POST',
      values: {
        organizationId,
        lotCode: 'LOT-V100-MKT-HOLD',
        samplesC: [9.4, 10.2, 11.1],
        maxAllowedC: 8,
        reason: 'Showcase v0.4.0 MKT quarantine example',
      },
    });
    heldMkt = true;
  }

  const line1 = linesByNo.get(1);
  let allocatedQty = Number(line1?.allocatedQty || 0);
  if (allocatedQty < 30 && order?.id) {
    const allocRes = await api('dxosWms:allocateFefo', {
      method: 'POST',
      values: {
        organizationId,
        sku: 'SKU-VAX-MKT-28',
        quantity: 30 - allocatedQty,
        orderId: order.id,
        orderCode: order.code,
        lineNo: 1,
        minTempC: 2,
        maxTempC: 8,
      },
    });
    allocatedQty += Number(allocRes?.allocatedTotal || 0);
  }

  return {
    orderId: order?.id ?? null,
    orderCode: order?.code || 'ORD-V100-001',
    orderCreated,
    linesCreated,
    lotsCreated,
    heldMkt,
    line1AllocatedQty: allocatedQty,
  };
}

async function seedDmnTable(api, organizationId) {
  const listed = unwrapList(
    await api(`dxosDmn:listTables?organizationId=${encodeURIComponent(organizationId)}`).catch(() => []),
  );
  const existing = listed.find((t) => t.tableKey === 'cold_chain_approval_v1');
  if (existing) {
    return { seeded: false, tableKey: 'cold_chain_approval_v1', id: existing.id };
  }

  const saved = await api('dxosDmn:saveTable', {
    method: 'POST',
    values: {
      organizationId,
      tableKey: 'cold_chain_approval_v1',
      name: 'Ma trận Phê duyệt Chuỗi lạnh & Vượt ngưỡng MKT',
      hitPolicy: 'FIRST',
      inputsJson: [
        { name: 'totalAmountM', type: 'number' },
        { name: 'maxTempC', type: 'number' },
      ],
      outputsJson: [
        { name: 'approvalTier', type: 'string' },
        { name: 'slaMinutes', type: 'number' },
      ],
      rulesJson: [
        {
          when: { maxTempC: { op: 'gt', value: 8 } },
          then: { approvalTier: 'quality_hold_director', slaMinutes: 15 },
        },
        {
          when: { totalAmountM: { op: 'gt', value: 500 } },
          then: { approvalTier: 'director_approval', slaMinutes: 45 },
        },
        {
          when: { totalAmountM: '*', maxTempC: '*' },
          then: { approvalTier: 'manager_approval', slaMinutes: 120 },
        },
      ],
    },
  });
  return { seeded: true, tableKey: 'cold_chain_approval_v1', id: saved?.table?.id ?? null };
}

const EXPECTED_DELEGATION_SKIP_RE = /\b(DELEGATION_TARGET_INACTIVE|DELEGATION_USER_INVALID|DELEGATION_SELF_FORBIDDEN|NATIVE_MEMBERSHIP_REQUIRED)\b/i;

async function fetchPaginatedItems(api, buildPath, { pageSize = 100, getItemKey, maxPages = 50 } = {}) {
  const collected = [];
  const seenKeys = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await api(buildPath(page, pageSize));
    const items = unwrapList(res);
    if (!items.length) break;
    let addedOnPage = 0;
    for (const item of items) {
      const key = typeof getItemKey === 'function' ? getItemKey(item) : null;
      if (key != null) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      collected.push(item);
      addedOnPage += 1;
    }
    if (addedOnPage === 0 || items.length < pageSize) break;
    if (typeof res?.total === 'number' && page * pageSize >= res.total) break;
  }
  return collected;
}

async function seedDelegationSample(api, organizationId, ctx) {
  const existing = unwrapList(
    await api(`dxosDelegations:list?organizationId=${encodeURIComponent(organizationId)}`),
  );
  if (existing.some((d) => d.status === 'active' || String(d.reason || '').includes('[v0.4.0]') || String(d.reason || '').includes('[v1.0.0]'))) {
    return { seeded: false, existingCount: existing.length };
  }
  if (ctx.distinctUserEmps.length < 2) {
    return { seeded: false, skippedReason: 'fewer_than_two_active_users' };
  }

  const delegator = ctx.distinctUserEmps[0];
  const delegate = ctx.distinctUserEmps[1];
  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();

  try {
    const created = await api('dxosDelegations:create', {
      method: 'POST',
      values: {
        organizationId,
        delegatorUserId: Number(delegator.userId),
        delegateUserId: Number(delegate.userId),
        roleName: 'ldx_manager',
        scopeCollection: 'latticeOrders',
        reason: '[v0.4.0] Ủy quyền điều phối ca trực chuỗi lạnh Cần Thơ - TP.HCM',
        startsAt,
        endsAt,
      },
    });
    return { seeded: true, delegationUid: created?.delegationUid || created?.delegation?.delegationUid || null };
  } catch (err) {
    const message = String(err?.message || '');
    if (EXPECTED_DELEGATION_SKIP_RE.test(message)) {
      return { seeded: false, skippedReason: message };
    }
    throw err;
  }
}

async function seedPkiAndColdSnapshot(api, organizationId, orderId) {
  const pubKey = await api(`dxosLedger:publicKey?organizationId=${encodeURIComponent(organizationId)}`);

  const ledgerEntries = orderId != null
    ? await fetchPaginatedItems(
      api,
      (page, pageSize) => (
        `dxosLedger:entries?organizationId=${encodeURIComponent(organizationId)}`
        + `&targetCollection=latticeOrders&targetRecordId=${encodeURIComponent(String(orderId))}`
        + `&page=${page}&pageSize=${pageSize}`
      ),
      {
        pageSize: 100,
        getItemKey: (e) => (e?.id != null ? `id:${e.id}` : (e?.seq != null ? `seq:${e.seq}` : null)),
      },
    )
    : [];
  const alreadySigned = orderId != null && ledgerEntries.some(
    (e) => e.targetCollection === 'latticeOrders' && String(e.targetRecordId) === String(orderId),
  );

  let signedResult = null;
  if (!alreadySigned && orderId != null) {
    signedResult = await api('dxosLedger:signDocument', {
      method: 'POST',
      values: {
        organizationId,
        targetCollection: 'latticeOrders',
        targetRecordId: orderId,
        reason: 'Niêm phong chứng từ vận đơn Vắc-xin Cold-Chain v0.4.0',
      },
    });
  }

  const existingSnapshots = await fetchPaginatedItems(
    api,
    (page, pageSize) => (
      `dxosDataGov:listSnapshots?organizationId=${encodeURIComponent(organizationId)}`
      + `&sourceCollection=latticeOrders&page=${page}&pageSize=${pageSize}`
    ),
    {
      pageSize: 100,
      getItemKey: (s) => (s?.snapshotUid ? `uid:${s.snapshotUid}` : (s?.id != null ? `id:${s.id}` : null)),
    },
  );
  const matchingOrderSnapshot = existingSnapshots.find((s) => s.sourceCollection === 'latticeOrders') || null;
  const hasOrderSnapshot = Boolean(matchingOrderSnapshot);
  let frozenSnapshot = null;
  if (!hasOrderSnapshot) {
    frozenSnapshot = await api('dxosDataGov:freezeSnapshot', {
      method: 'POST',
      values: {
        organizationId,
        sourceCollection: 'latticeOrders',
        tier: 'cold',
        retentionDays: 1825,
      },
    });
  }

  return {
    keyId: pubKey?.keyId || null,
    signedNow: Boolean(signedResult?.signed),
    alreadySigned,
    frozenNow: Boolean(frozenSnapshot?.snapshotUid),
    snapshotUid: frozenSnapshot?.snapshotUid || matchingOrderSnapshot?.snapshotUid || null,
  };
}

const DEFAULT_SHOWCASE_WEBHOOK_SECRET = 'demo-showcase-webhook-secret-2026';

async function seedCmmsBusinessPack(api, organizationId) {
  const packs = unwrapList(
    await api(`dxosBuilder:listBusinessPacks?organizationId=${encodeURIComponent(organizationId)}`),
  );
  const cmmsPack = packs.find((p) => p?.packKey === 'cmms-maintenance');

  const domains = unwrapList(await api('dxosBuilder:listDomains'));
  const workOrdersDomain = domains.find((d) => d?.collectionName === 'latticeCustomWorkOrders');
  const hasCmmsPortal = Boolean(
    workOrdersDomain
    && Array.isArray(workOrdersDomain.portalPages)
    && workOrdersDomain.portalPages.some((p) => p?.path === '/p/cmms'),
  );

  if (cmmsPack?.installed === true && hasCmmsPortal) {
    return {
      seeded: false,
      alreadyInstalled: true,
      packKey: 'cmms-maintenance',
      collectionName: 'latticeCustomWorkOrders',
      dmnTableKey: 'cmms_priority_routing_v1',
      automationRuleKey: 'auto_cmms_on_coldchain_fault',
      portalPath: '/p/cmms',
    };
  }

  const installed = await api('dxosBuilder:installBusinessPack', {
    method: 'POST',
    values: {
      organizationId,
      packKey: 'cmms-maintenance',
    },
  });

  if (
    installed?.installed !== true
    || installed?.domain?.collectionName !== 'latticeCustomWorkOrders'
    || installed?.dmnTable?.tableKey !== 'cmms_priority_routing_v1'
    || installed?.automationRule?.ruleKey !== 'auto_cmms_on_coldchain_fault'
    || installed?.domain?.portalPage?.path !== '/p/cmms'
  ) {
    throw new Error('dxosBuilder:installBusinessPack(cmms-maintenance) returned incomplete pack state');
  }

  return {
    seeded: true,
    alreadyInstalled: false,
    packKey: 'cmms-maintenance',
    collectionName: installed.domain.collectionName,
    dmnTableKey: installed.dmnTable.tableKey,
    automationRuleKey: installed.automationRule.ruleKey,
    portalPath: installed.domain.portalPage.path,
  };
}

async function seedPartnerSettlementBusinessPack(api, organizationId, { seedSamples = false } = {}) {
  const packs = unwrapList(
    await api(`dxosBuilder:listBusinessPacks?organizationId=${encodeURIComponent(organizationId)}`),
  );
  const settlementPack = packs.find((p) => p?.packKey === 'coldchain-partner-settlement');

  const domains = unwrapList(await api('dxosBuilder:listDomains'));
  const claimsDomain = domains.find((d) => d?.collectionName === 'latticeCustomPartnerClaims');
  const hasPartnerClaimsPortal = Boolean(
    claimsDomain
    && Array.isArray(claimsDomain.portalPages)
    && claimsDomain.portalPages.some((p) => p?.path === '/p/partner-claims'),
  );

  if (settlementPack?.installed === true && hasPartnerClaimsPortal) {
    return {
      seeded: false,
      alreadyInstalled: true,
      packKey: 'coldchain-partner-settlement',
      collectionName: 'latticeCustomPartnerClaims',
      dmnTableKey: 'coldchain_settlement_policy_v1',
      automationRuleKey: 'auto_coldchain_partner_settlement',
      portalPath: '/p/partner-claims',
    };
  }

  const installed = await api('dxosBuilder:installBusinessPack', {
    method: 'POST',
    values: {
      organizationId,
      packKey: 'coldchain-partner-settlement',
      ...(seedSamples ? { seedSamples: true } : {}),
    },
  });

  if (
    installed?.installed !== true
    || installed?.domain?.collectionName !== 'latticeCustomPartnerClaims'
    || installed?.dmnTable?.tableKey !== 'coldchain_settlement_policy_v1'
    || installed?.automationRule?.ruleKey !== 'auto_coldchain_partner_settlement'
    || installed?.domain?.portalPage?.path !== '/p/partner-claims'
  ) {
    throw new Error('dxosBuilder:installBusinessPack(coldchain-partner-settlement) returned incomplete pack state');
  }

  return {
    seeded: true,
    alreadyInstalled: false,
    packKey: 'coldchain-partner-settlement',
    collectionName: installed.domain.collectionName,
    dmnTableKey: installed.dmnTable.tableKey,
    automationRuleKey: installed.automationRule.ruleKey,
    portalPath: installed.domain.portalPage.path,
  };
}

async function seedPartnerSettlementClaim(api, organizationId, assets) {
  const claimCode = 'CLM-V100-001';
  const filter = encodeURIComponent(JSON.stringify({ organizationId, claimCode }));
  const existing = unwrapList(
    await api(`latticeCustomPartnerClaims:list?filter=${filter}&pageSize=5`),
  );
  if (existing.length > 0) {
    return {
      seeded: false,
      id: existing[0]?.id ?? null,
      claimCode,
      status: existing[0]?.status || 'open',
      settlementStatus: existing[0]?.settlementStatus || 'pending',
    };
  }

  const chillerAsset = assets?.assetsByCode?.['COLD-CHILLER-CT-01'] || null;
  const created = await api('latticeCustomPartnerClaims:create', {
    method: 'POST',
    values: {
      organizationId,
      claimCode,
      partnerCode: 'vnpost-cold',
      partnerEmail: 'claims@vnpost-cold.example.com',
      lotCode: 'LOT-V100-MKT-HOLD',
      ...(chillerAsset?.id != null ? { assetId: chillerAsset.id } : {}),
      severity: 'critical',
      riskScore: 100,
      settlementTier: 'critical',
      settlementRatePct: 85,
      claimAmountVnd: 125000000,
      settlementAmountVnd: 106250000,
      status: 'open',
      settlementStatus: 'pending',
      resolutionNote: '[v0.4.0] Hồ sơ bồi hoàn chuỗi lạnh chờ phản hồi 2 chiều từ n8n External Apps.',
    },
  });

  return {
    seeded: true,
    id: created?.id ?? null,
    claimCode: created?.claimCode || claimCode,
    status: created?.status || 'open',
    settlementStatus: created?.settlementStatus || 'pending',
  };
}

const BLUEPRINTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../plugins/nocobase/plugin-dxos-studio/src/server/flow/blueprints',
);
const FLAGSHIP_BLUEPRINT_FILES = [
  'coldchain-emergency.json',
  'mkt-quarantine.json',
  'sla-escalation.json',
  'procurement-hitl-approval.json',
  'scheduled-ai-digest.json',
  'partner-webhook-sync.json',
  'enterprise-n8n-compliance.json',
];

function loadFlagshipGraphV2Blueprints() {
  return FLAGSHIP_BLUEPRINT_FILES.map((file) =>
    JSON.parse(readFileSync(join(BLUEPRINTS_DIR, file), 'utf8')),
  );
}

const FLAGSHIP_GRAPH_V2_BLUEPRINTS = loadFlagshipGraphV2Blueprints();

function isRuleMatchingGraphV2Blueprint(existing, blueprint) {
  if (!existing || Number(existing.schemaVersion) !== 2 || existing.active === false) {
    return false;
  }
  if (String(existing.triggerEventType || '').trim() !== String(blueprint.triggerEventType || '').trim()) {
    return false;
  }
  if ((existing.dmnTableKey || null) !== (blueprint.dmnTableKey || null)) {
    return false;
  }
  if (Number(existing.cooldownSec ?? 0) !== Number(blueprint.cooldownSec ?? 0)) {
    return false;
  }
  if (Number(existing.maxDepth ?? 8) !== Number(blueprint.maxDepth ?? 8)) {
    return false;
  }

  const g = existing.graphJson;
  const bpG = blueprint.graphJson;
  if (!g || Number(g.version) !== 2 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return false;
  }
  if (g.nodes.length !== bpG.nodes.length || g.edges.length !== bpG.edges.length) {
    return false;
  }

  const existingNodesSig = g.nodes.map((n) => `${n?.id}:${n?.type}`).join('|');
  const bpNodesSig = bpG.nodes.map((n) => `${n?.id}:${n?.type}`).join('|');
  if (existingNodesSig !== bpNodesSig) {
    return false;
  }

  const existingEdgeSet = new Set(
    g.edges.map((e) => `${e?.source}|${e?.sourceHandle || 'main'}|${e?.target}|${e?.targetHandle || 'in'}`),
  );
  for (const e of bpG.edges) {
    const key = `${e.source}|${e.sourceHandle || 'main'}|${e.target}|${e.targetHandle || 'in'}`;
    if (!existingEdgeSet.has(key)) return false;
  }

  const gSet = g.settings || {};
  const bpSet = bpG.settings || {};
  if (gSet.errorPolicy && bpSet.errorPolicy && gSet.errorPolicy !== bpSet.errorPolicy) {
    return false;
  }
  if (gSet.cooldownSec !== undefined && Number(gSet.cooldownSec) !== Number(bpSet.cooldownSec ?? 0)) {
    return false;
  }
  if (gSet.maxDepth !== undefined && Number(gSet.maxDepth) !== Number(bpSet.maxDepth ?? 8)) {
    return false;
  }
  return true;
}

function buildGraphV2RulePayload(organizationId, blueprint) {
  return {
    organizationId,
    schemaVersion: 2,
    ruleKey: blueprint.ruleKey,
    name: blueprint.name,
    description: blueprint.description ?? null,
    triggerEventType: blueprint.triggerEventType,
    filterJson: blueprint.filterJson ?? null,
    dmnTableKey: blueprint.dmnTableKey ?? null,
    cooldownSec: blueprint.cooldownSec ?? 0,
    maxDepth: blueprint.maxDepth ?? 8,
    active: blueprint.active !== false,
    graphJson: structuredClone(blueprint.graphJson),
  };
}

async function seedFlagshipAutomationRules(api, organizationId, assets) {
  const existingRules = unwrapList(
    await api(`dxosAutomations:listRules?organizationId=${encodeURIComponent(organizationId)}&limit=200`),
  );
  const byKey = new Map(existingRules.map((r) => [r?.ruleKey, r]));

  const createdRules = [];
  const upgradedRules = [];
  const reusedRules = [];

  for (const blueprint of FLAGSHIP_GRAPH_V2_BLUEPRINTS) {
    const existing = byKey.get(blueprint.ruleKey);
    if (!existing) {
      await api('dxosAutomations:saveRule', {
        method: 'POST',
        values: buildGraphV2RulePayload(organizationId, blueprint),
      });
      createdRules.push(blueprint.ruleKey);
    } else if (!isRuleMatchingGraphV2Blueprint(existing, blueprint)) {
      await api('dxosAutomations:saveRule', {
        method: 'POST',
        values: buildGraphV2RulePayload(organizationId, blueprint),
      });
      upgradedRules.push(blueprint.ruleKey);
    } else {
      reusedRules.push(blueprint.ruleKey);
    }
  }

  const chillerAsset = assets?.assetsByCode?.['COLD-CHILLER-CT-01'] || assets?.['COLD-CHILLER-CT-01'] || null;
  let existingWorkOrders = [];
  let workOrdersCheckSucceeded = false;
  let workOrdersListError = null;
  try {
    const woFilter = encodeURIComponent(JSON.stringify({ organizationId }));
    existingWorkOrders = unwrapList(
      await api(`latticeCustomWorkOrders:list?filter=${woFilter}&pageSize=5`),
    );
    workOrdersCheckSucceeded = true;
  } catch (err) {
    workOrdersListError = err?.message || String(err);
  }

  let existingRuns = [];
  try {
    existingRuns = unwrapList(
      await api(
        `dxosAutomations:listRuns?organizationId=${encodeURIComponent(organizationId)}&ruleKey=auto_cmms_on_coldchain_fault&limit=5`,
      ),
    );
  } catch {
    existingRuns = [];
  }

  let initialRun = null;
  if (workOrdersCheckSucceeded && existingWorkOrders.length === 0 && existingRuns.length === 0) {
    const faultData = {
      severity: 'high',
      deviceKey: 'cold-truck-ct-01',
      assetId: chillerAsset?.id ?? null,
      ...(chillerAsset?.id != null
        ? { assetEntityId: `urn:ngsi-ld:Asset:${organizationId}:native:${chillerAsset.id}` }
        : {}),
      temperature: 9.4,
      message: 'Cảnh báo nhiệt độ kho lạnh Cần Thơ vượt ngưỡng 8°C (9.4°C)',
    };
    const runRes = await api('dxosAutomations:runNow', {
      method: 'POST',
      values: {
        organizationId,
        ruleKey: 'auto_cmms_on_coldchain_fault',
        eventType: 'alarm.triggered',
        subject: 'cold-truck-ct-01',
        event: {
          type: 'alarm.triggered',
          subject: 'cold-truck-ct-01',
          data: faultData,
        },
        data: faultData,
      },
    });
    initialRun = runRes?.run || null;
  }

  const stepTraces = Array.isArray(initialRun?.stepTracesJson) ? initialRun.stepTracesJson : [];
  const nodeStates = initialRun?.nodeStatesJson && typeof initialRun.nodeStatesJson === 'object'
    ? Object.values(initialRun.nodeStatesJson)
    : [];
  const skippedFromTraces = stepTraces.filter((s) => s?.status === 'skipped').length;
  const skippedFromNodes = nodeStates.filter((s) => s?.status === 'skipped').length;

  return {
    schemaVersion: 2,
    ruleKeys: FLAGSHIP_GRAPH_V2_BLUEPRINTS.map((b) => b.ruleKey),
    createdRules,
    upgradedRules,
    reusedRules,
    existingWorkOrdersCount: existingWorkOrders.length,
    existingRunsCount: existingRuns.length,
    ...(workOrdersListError ? { workOrdersListError } : {}),
    initialRunTriggered: Boolean(initialRun),
    initialRunUid: initialRun?.runUid ?? null,
    initialRunStatus: initialRun?.status ?? null,
    initialRunStepsCompleted: stepTraces.filter((s) => s?.status === 'completed').length,
    initialRunStepsSkipped: skippedFromTraces > 0 ? skippedFromTraces : skippedFromNodes,
  };
}

async function seedConnectorVault(api, organizationId) {
  const connectorKey = 'n8n-coldchain-orchestrator';
  const listed = unwrapList(
    await api(`dxosVault:list?organizationId=${encodeURIComponent(organizationId)}&limit=200`),
  );
  const existing = listed.find((c) => c?.connectorKey === connectorKey);
  if (existing) {
    return {
      seeded: false,
      id: existing.id ?? null,
      connectorKey,
      connectorType: existing.connectorType || 'n8n',
      authType: existing.authType || 'hmac',
      hasSecrets: Boolean(existing.hasSecrets),
    };
  }

  const webhookSecret = process.env.DX_WEBHOOK_SECRET || DEFAULT_SHOWCASE_WEBHOOK_SECRET;
  const saved = await api('dxosVault:save', {
    method: 'POST',
    values: {
      organizationId,
      connectorKey,
      name: 'n8n Cold-Chain Alert Orchestrator',
      connectorType: 'n8n',
      baseUrl: 'http://n8n:5678/webhook/latticedx/v1/coldchain-alert',
      authType: 'hmac',
      secrets: {
        secret: webhookSecret,
      },
    },
  });

  return {
    seeded: true,
    id: saved?.id ?? null,
    connectorKey: saved?.connectorKey || connectorKey,
    connectorType: saved?.connectorType || 'n8n',
    authType: saved?.authType || 'hmac',
    hasSecrets: Boolean(saved?.hasSecrets ?? true),
  };
}

async function seedEnterpriseConnectorVault(api, organizationId) {
  const connectorKey = 'n8n-enterprise-orchestrator';
  const listed = unwrapList(
    await api(`dxosVault:list?organizationId=${encodeURIComponent(organizationId)}&limit=200`),
  );
  const existing = listed.find((c) => c?.connectorKey === connectorKey);
  if (existing) {
    return {
      seeded: false,
      id: existing.id ?? null,
      connectorKey,
      connectorType: existing.connectorType || 'n8n',
      authType: existing.authType || 'hmac',
      hasSecrets: Boolean(existing.hasSecrets),
    };
  }

  const webhookSecret = process.env.DX_WEBHOOK_SECRET || DEFAULT_SHOWCASE_WEBHOOK_SECRET;
  const saved = await api('dxosVault:save', {
    method: 'POST',
    values: {
      organizationId,
      connectorKey,
      name: 'n8n Enterprise 26-Node Compliance & Settlement Orchestrator',
      connectorType: 'n8n',
      baseUrl: 'http://n8n:5678',
      authType: 'hmac',
      secrets: {
        secret: webhookSecret,
      },
    },
  });

  return {
    seeded: true,
    id: saved?.id ?? null,
    connectorKey: saved?.connectorKey || connectorKey,
    connectorType: saved?.connectorType || 'n8n',
    authType: saved?.authType || 'hmac',
    hasSecrets: Boolean(saved?.hasSecrets ?? true),
  };
}

async function seedMqttDevice(api, organizationId, linkedAsset) {
  const deviceKey = 'cold-truck-ct-01';
  const listed = unwrapList(
    await api(`dxosBroker:listDevices?organizationId=${encodeURIComponent(organizationId)}&limit=200`),
  );
  const existing = listed.find((d) => d?.deviceKey === deviceKey);
  if (existing) {
    return {
      seeded: false,
      id: existing.id ?? null,
      deviceKey,
      assetId: existing.assetId ?? null,
      mqttUsername: existing.mqttUsername || null,
      mqttClientId: existing.mqttClientId || null,
      topicPrefix: existing.topicPrefix || null,
      brokerSynced: Boolean(existing?.metadataJson?.brokerSynced),
      mqttPasswordProvisioned: false,
    };
  }

  const assetId = linkedAsset?.id ?? null;
  const provisioned = await api('dxosBroker:provisionDevice', {
    method: 'POST',
    values: {
      organizationId,
      deviceKey,
      name: 'Xe Tải Lạnh Cần Thơ 01 (Sensor)',
      ...(assetId != null ? { assetId } : {}),
    },
  });
  const dev = provisioned?.device || {};

  // Never include or log the one-time mqttPassword in seed summaries.
  return {
    seeded: true,
    id: dev.id ?? null,
    deviceKey: dev.deviceKey || deviceKey,
    assetId: dev.assetId ?? assetId,
    mqttUsername: dev.mqttUsername || null,
    mqttClientId: dev.mqttClientId || null,
    topicPrefix: dev.topicPrefix || null,
    brokerSynced: Boolean(provisioned?.brokerSynced),
    mqttPasswordProvisioned: Boolean(provisioned?.mqttPassword),
  };
}

async function seedWebhookSubscription(api, organizationId) {
  const subscriptionKey = 'n8n-coldchain-alerts';
  const listed = unwrapList(
    await api(`dxosEvents:listSubscriptions?organizationId=${encodeURIComponent(organizationId)}&limit=200`),
  );
  const existing = listed.find((s) => s?.subscriptionKey === subscriptionKey);
  if (existing) {
    return {
      seeded: false,
      id: existing.id ?? null,
      subscriptionKey,
      eventPattern: existing.eventPattern || 'alarm.*',
      hasSigningSecret: Boolean(existing.hasSigningSecret),
      active: existing.active !== false,
    };
  }

  const signingSecret = process.env.DX_WEBHOOK_SECRET || DEFAULT_SHOWCASE_WEBHOOK_SECRET;
  const saved = await api('dxosEvents:saveSubscription', {
    method: 'POST',
    values: {
      organizationId,
      subscriptionKey,
      name: 'Gửi cảnh báo Cold-Chain sang n8n',
      targetUrl: 'http://n8n:5678/webhook/latticedx/v1/coldchain-alert',
      eventPattern: 'alarm.*',
      signingSecret,
      active: true,
    },
  });

  return {
    seeded: true,
    id: saved?.id ?? null,
    subscriptionKey: saved?.subscriptionKey || subscriptionKey,
    eventPattern: saved?.eventPattern || 'alarm.*',
    hasSigningSecret: Boolean(saved?.hasSigningSecret ?? true),
    active: saved?.active !== false,
  };
}

async function seedEnterpriseWebhookSubscription(api, organizationId) {
  const subscriptionKey = 'n8n-enterprise-compliance';
  const listed = unwrapList(
    await api(`dxosEvents:listSubscriptions?organizationId=${encodeURIComponent(organizationId)}&limit=200`),
  );
  const existing = listed.find((s) => s?.subscriptionKey === subscriptionKey);
  if (existing) {
    return {
      seeded: false,
      id: existing.id ?? null,
      subscriptionKey,
      eventPattern: existing.eventPattern || 'coldchain.settlement_requested',
      hasSigningSecret: Boolean(existing.hasSigningSecret),
      active: existing.active !== false,
    };
  }

  const signingSecret = process.env.DX_WEBHOOK_SECRET || DEFAULT_SHOWCASE_WEBHOOK_SECRET;
  const saved = await api('dxosEvents:saveSubscription', {
    method: 'POST',
    values: {
      organizationId,
      subscriptionKey,
      name: 'Điều phối 26-Node Settlement & External Apps qua n8n',
      targetUrl: 'http://n8n:5678/webhook/latticedx/v1/enterprise-compliance-orchestrator',
      eventPattern: 'coldchain.settlement_requested',
      signingSecret,
      active: true,
    },
  });

  return {
    seeded: true,
    id: saved?.id ?? null,
    subscriptionKey: saved?.subscriptionKey || subscriptionKey,
    eventPattern: saved?.eventPattern || 'coldchain.settlement_requested',
    hasSigningSecret: Boolean(saved?.hasSigningSecret ?? true),
    active: saved?.active !== false,
  };
}

export async function runV100ChampionshipShowcaseSeed(options, fetchImpl = fetch) {
  const api = await createSeederClient(options, fetchImpl);
  const { organizationId } = options;

  const ctx = await ensureShowcaseContext(api, organizationId);
  const locations = await seedColdChainLocations(api, organizationId, ctx);
  const assets = await seedColdChainAssetsAndTelemetry(api, organizationId, ctx, locations.byCode);
  const digitalTwin = await seedDigitalTwinShadow(api, organizationId, assets.assetsByCode['COLD-CHILLER-CT-01']);
  const wms = await seedWmsShowcase(api, organizationId, ctx);
  const dmn = await seedDmnTable(api, organizationId);
  const delegation = await seedDelegationSample(api, organizationId, ctx);
  const pkiSnapshot = await seedPkiAndColdSnapshot(api, organizationId, wms.orderId);
  const cmmsPack = await seedCmmsBusinessPack(api, organizationId);
  const settlementPack = await seedPartnerSettlementBusinessPack(api, organizationId, {
    seedSamples: options?.seedSamples === true,
  });
  const settlementClaim = await seedPartnerSettlementClaim(api, organizationId, assets);
  const connectorVault = await seedConnectorVault(api, organizationId);
  const enterpriseConnectorVault = await seedEnterpriseConnectorVault(api, organizationId);
  const mqttDevice = await seedMqttDevice(
    api,
    organizationId,
    assets.assetsByCode['REEFER-TRUCK-HCM-02'] || assets.assetsByCode['COLD-CHILLER-CT-01'],
  );
  const automationShowcase = await seedFlagshipAutomationRules(api, organizationId, assets);
  const webhookSubscription = await seedWebhookSubscription(api, organizationId);
  const enterpriseWebhookSubscription = await seedEnterpriseWebhookSubscription(api, organizationId);
  const studioShowcase = options?.seedSamples === true
    ? await seedStudioShowcaseSamples(api, organizationId)
    : undefined;

  const paraReindex = await api('latticePara:reindex', {
    method: 'POST',
    values: { organizationId },
  });
  const triage = await api('dxosAi:triageScan', {
    method: 'POST',
    values: { organizationId },
  });
  const portals = await api('dxosStudio:composePortals', {
    method: 'POST',
    values: {},
  });

  return {
    result: 'PASS',
    origin: options.origin,
    organizationId,
    locations: { created: locations.created, reused: locations.reused },
    assets: { created: assets.created, reused: assets.reused, telemetry: assets.telemetrySummaries },
    digitalTwin,
    wms,
    dmn,
    delegation,
    pkiSnapshot,
    cmmsPack,
    settlementPack,
    settlementClaim,
    automationShowcase,
    connectorVault,
    enterpriseConnectorVault,
    mqttDevice,
    webhookSubscription,
    enterpriseWebhookSubscription,
    ...(studioShowcase !== undefined ? { studioShowcase } : {}),
    paraReindex,
    triage,
    portals,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseSeedArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(
        'Usage: node scripts/seed-v100-championship-showcase.mjs [--origin=http://localhost:13014] [--org=native-ui-lab] [--admin-email=admin@nocobase.com] [--admin-password=...] [--token=...] [--seed-samples]',
      );
      process.exit(0);
    }
    const summary = await runV100ChampionshipShowcaseSeed(parsed);
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  }
}

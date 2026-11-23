#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLoopbackOrigin,
  createSeederClient,
  parseSeedArgs,
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
        compressorMode: 'eco-auto',
        doorLocked: true,
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
        name: 'Lô Vắc-xin Cold-Chain Cần Thơ -> TP.HCM (v1.0.0)',
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
        reason: 'Showcase v1.0.0 MKT quarantine example',
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

async function seedDelegationSample(api, organizationId, ctx) {
  const existing = unwrapList(
    await api(`dxosDelegations:list?organizationId=${encodeURIComponent(organizationId)}`).catch(() => []),
  );
  if (existing.some((d) => d.status === 'active' || String(d.reason || '').includes('[v1.0.0]'))) {
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
        reason: '[v1.0.0] Ủy quyền điều phối ca trực chuỗi lạnh Cần Thơ - TP.HCM',
        startsAt,
        endsAt,
      },
    });
    return { seeded: true, delegationUid: created?.delegationUid || created?.delegation?.delegationUid || null };
  } catch (err) {
    return { seeded: false, skippedReason: err.message };
  }
}

async function seedPkiAndColdSnapshot(api, organizationId, orderId) {
  const pubKey = await api(`dxosLedger:publicKey?organizationId=${encodeURIComponent(organizationId)}`);

  const ledgerEntries = unwrapList(
    await api(`dxosLedger:entries?organizationId=${encodeURIComponent(organizationId)}&limit=100`).catch(() => []),
  );
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
        reason: 'Niêm phong chứng từ vận đơn Vắc-xin Cold-Chain v1.0.0',
      },
    });
  }

  const existingSnapshots = unwrapList(
    await api(`dxosDataGov:listSnapshots?organizationId=${encodeURIComponent(organizationId)}&limit=50`).catch(() => []),
  );
  const hasOrderSnapshot = existingSnapshots.some((s) => s.sourceCollection === 'latticeOrders');
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
    snapshotUid: frozenSnapshot?.snapshotUid || existingSnapshots[0]?.snapshotUid || null,
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
        'Usage: node scripts/seed-v100-championship-showcase.mjs [--origin=http://localhost:13014] [--org=native-ui-lab] [--admin-email=admin@nocobase.com] [--admin-password=...] [--token=...]',
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

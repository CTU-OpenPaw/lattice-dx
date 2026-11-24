/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createPublicKey, randomBytes, verify } = require('node:crypto');
const {
  ORG_ID_RE,
  val,
  toPlain,
  fail,
  loadFoundationSet,
  sha256Hex,
  timingSafeEqualHex,
  readParams,
  parseFinite,
  parseStrictPositiveInt,
  parseOptionalDate,
  parseTempBand,
  escapeHtml,
  maskPhone,
  assertPatScope,
  hasCollectionPermission,
  isOrgAdmin,
  resolveTenantActor,
  appendAuditLedger,
  runWithOptionalRls,
  runWithSystemRlsBypass,
  runInTx,
  saveRow,
} = require('./wms-dmn-shared');
const {
  WMS_DMN_COLLECTIONS,
  stripEpodSecretsFromBody,
  createWmsDmnDirectGuardMiddleware: createDirectGuardWithFoundation,
  validateTenantCollectionRecord,
} = require('./wms-direct-guard');
const { renderQrSvg } = require('./qr-svg');

const foundation = loadFoundationSet();

const URN_ORG_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const BLOCKED_LOT_STATUSES = new Set(['hold_mkt', 'expired', 'quarantined']);
const DUMMY_HASH_HEX = '0'.repeat(64);
const R_KJ_MOL_K = 0.008314472;
const MAX_EPOD_PHOTO_BYTES = 512 * 1024;
const SAFE_RASTER_DATA_URL_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=_-]+$/i;

function isSafeRasterImageDataUrl(value, maxBytes = MAX_EPOD_PHOTO_BYTES) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maxBytes) return false;
  if (/^data:image\/svg\+xml/i.test(trimmed)) return false;
  return SAFE_RASTER_DATA_URL_RE.test(trimmed);
}

function computeMeanKineticTemperature(samplesC, { deltaH_kJ_mol = 83.14472, maxAllowedC = null } = {}) {
  if (typeof foundation?.dataGovernance?.computeMeanKineticTemperature === 'function') {
    return foundation.dataGovernance.computeMeanKineticTemperature(samplesC, { deltaH_kJ_mol, maxAllowedC });
  }
  if (!Array.isArray(samplesC) || samplesC.length === 0) {
    throw fail('MKT_INVALID_SAMPLE', 400, 'Cần ít nhất một mẫu nhiệt độ hợp lệ để tính MKT.');
  }
  const deltaH = parseFinite(deltaH_kJ_mol);
  if (deltaH === null || deltaH <= 0) {
    throw fail('MKT_INVALID_SAMPLE', 400, 'Năng lượng hoạt hóa deltaH phải dương.');
  }
  const parsedSamples = [];
  const kelvins = [];
  for (const raw of samplesC) {
    const tempC = parseFinite(raw);
    if (tempC === null || tempC <= -273.15) {
      throw fail('MKT_INVALID_SAMPLE', 400, 'Mẫu nhiệt độ phải là số hữu hạn > -273.15°C.');
    }
    parsedSamples.push(tempC);
    kelvins.push(tempC + 273.15);
  }
  const threshold = maxAllowedC === null || maxAllowedC === undefined ? null : parseFinite(maxAllowedC);
  if (maxAllowedC !== null && maxAllowedC !== undefined && threshold === null) {
    throw fail('MKT_INVALID_SAMPLE', 400, 'Ngưỡng nhiệt độ maxAllowedC không hợp lệ.');
  }
  const a = deltaH / R_KJ_MOL_K;
  const exps = kelvins.map((tk) => -a / tk);
  const maxExp = Math.max(...exps);
  const meanExp = exps.reduce((sum, e) => sum + Math.exp(e - maxExp), 0) / exps.length;
  const lnMean = maxExp + Math.log(meanExp);
  const mktKelvin = a / (-lnMean);
  const mktCelsius = Number((mktKelvin - 273.15).toFixed(3));
  const minTempCelsius = Number(Math.min(...parsedSamples).toFixed(3));
  const maxTempCelsius = Number(Math.max(...parsedSamples).toFixed(3));
  const avgTempCelsius = Number((parsedSamples.reduce((s, x) => s + x, 0) / parsedSamples.length).toFixed(3));
  const excursionCount = threshold !== null ? parsedSamples.filter((t) => t > threshold).length : 0;
  return {
    mktCelsius,
    minTempCelsius,
    maxTempCelsius,
    avgTempCelsius,
    sampleCount: parsedSamples.length,
    excursionCount,
    thresholdCelsius: threshold,
    breached: threshold !== null ? mktCelsius > threshold : false,
  };
}

async function recordLineageSafely(db, edgeArgs) {
  if (typeof foundation?.dataGovernance?.recordLineageEdge === 'function') {
    return foundation.dataGovernance.recordLineageEdge(db, edgeArgs);
  }
  const repo = db?.getRepository?.('latticeDataLineage');
  if (!repo || typeof repo.create !== 'function') return null;
  const org = String(edgeArgs?.organizationId || '').trim();
  if (!ORG_ID_RE.test(org)) return null;
  const txOpt = edgeArgs?.transaction ? { transaction: edgeArgs.transaction } : {};
  const edgeUid = `edge-${sha256Hex([
    org,
    edgeArgs.sourceCollection,
    edgeArgs.sourceRecordId,
    edgeArgs.targetCollection,
    edgeArgs.targetRecordId,
    edgeArgs.relationType,
  ].join('|')).slice(0, 24)}`;
  if (typeof repo.findOne === 'function') {
    const existing = await repo.findOne({ filter: { organizationId: org, edgeUid }, ...txOpt });
    if (existing) return toPlain(existing);
  }
  return toPlain(await repo.create({
    values: {
      organizationId: org,
      edgeUid,
      sourceCollection: String(edgeArgs.sourceCollection),
      sourceRecordId: String(edgeArgs.sourceRecordId),
      targetCollection: String(edgeArgs.targetCollection),
      targetRecordId: String(edgeArgs.targetRecordId),
      relationType: String(edgeArgs.relationType),
      actorName: edgeArgs.actorName ? String(edgeArgs.actorName) : 'system',
      metadataJson: edgeArgs.metadataJson && typeof edgeArgs.metadataJson === 'object' ? edgeArgs.metadataJson : null,
      observedAt: edgeArgs.observedAt || new Date(),
    },
    ...txOpt,
  }));
}

async function captureQuarantineSafely(db, args) {
  if (typeof foundation?.dataGovernance?.captureQuarantineRecord === 'function') {
    return foundation.dataGovernance.captureQuarantineRecord(db, args);
  }
  const repo = db?.getRepository?.('latticeDataQuarantine');
  if (!repo || typeof repo.create !== 'function') return null;
  const quarantineUid = `qtn-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const txOpt = args.transaction ? { transaction: args.transaction } : {};
  const created = await repo.create({
    values: {
      organizationId: args.organizationId,
      quarantineUid,
      sourceSystem: args.sourceSystem || 'wms_mkt',
      assetEntityId: args.assetEntityId || null,
      metricName: args.metricName || 'mkt_celsius',
      numericValue: args.numericValue ?? null,
      unit: args.unit || 'CEL',
      reasonCode: args.reasonCode || 'MKT_THRESHOLD_EXCEEDED',
      severity: args.severity || 'high',
      rawPayload: args.rawPayload || {},
      status: 'quarantined',
      active: true,
    },
    ...txOpt,
  });
  await appendAuditLedger(db, {
    organizationId: args.organizationId,
    eventType: 'data.quarantined',
    targetCollection: 'latticeDataQuarantine',
    targetRecordId: String(val(created, 'id') || quarantineUid),
    actor: args.actor || { username: 'wms-mkt-guard' },
    payload: { quarantineUid, reasonCode: args.reasonCode, numericValue: args.numericValue },
    transaction: args.transaction || null,
    scope: 'dxos:wms-quarantine',
    foundation,
  });
  return toPlain(created);
}

async function findLockedLot(db, lotRepo, filter, transaction) {
  const lockOpt = transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {};
  const model = transaction?.LOCK?.UPDATE ? db?.getModel?.('latticeStockLots') : null;
  if (model && typeof model.findOne === 'function') {
    return model.findOne({
      where: filter,
      transaction,
      ...lockOpt,
    });
  }
  const txOpt = transaction ? { transaction, ...lockOpt } : {};
  return lotRepo.findOne({ filter, ...txOpt });
}

async function findLockedLots(db, lotRepo, { filter, sort = ['expiryDate', 'id'], limit = 500, transaction = null } = {}) {
  const lockOpt = transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {};
  const model = transaction?.LOCK?.UPDATE ? db?.getModel?.('latticeStockLots') : null;
  if (model && typeof model.findAll === 'function') {
    const order = Array.isArray(sort)
      ? sort.map((field) => {
          const desc = String(field).startsWith('-');
          const name = desc ? String(field).slice(1) : String(field);
          return [name, desc ? 'DESC' : 'ASC'];
        })
      : undefined;
    return model.findAll({
      where: filter,
      ...(order ? { order } : {}),
      ...(limit ? { limit } : {}),
      transaction,
      ...lockOpt,
    });
  }
  const txOpt = transaction ? { transaction, ...lockOpt } : {};
  return lotRepo.find({ filter, sort, limit, ...txOpt });
}

async function resolveOrderRef(db, organizationId, params, { requireOrder = false, lookupByCode = true, transaction = null } = {}) {
  let orderId = params.orderId != null && /^[1-9]\d*$/.test(String(params.orderId)) ? Number(params.orderId) : null;
  let orderCode = typeof params.orderCode === 'string' ? params.orderCode.trim() : '';
  const ordersRepo = db.getRepository?.('latticeOrders');
  const txOpt = transaction ? { transaction } : {};
  let matchedOrder = null;

  if (orderId != null && ordersRepo?.findOne) {
    matchedOrder = await ordersRepo.findOne({ filter: { id: orderId, organizationId }, ...txOpt });
    if (!matchedOrder || val(matchedOrder, 'organizationId') !== organizationId) {
      throw fail('WMS_ORDER_NOT_FOUND', 404, 'Không tìm thấy đơn hàng trong phạm vi tổ chức.');
    }
    if (!orderCode) orderCode = val(matchedOrder, 'code') || String(orderId);
  } else if (lookupByCode && orderCode && ordersRepo?.findOne) {
    matchedOrder = await ordersRepo.findOne({ filter: { code: orderCode, organizationId }, ...txOpt });
    if (matchedOrder && val(matchedOrder, 'organizationId') === organizationId) {
      orderId = val(matchedOrder, 'id') ?? orderId;
    } else {
      matchedOrder = null;
    }
  }

  if (requireOrder && !orderCode && orderId == null) {
    throw fail('WMS_ORDER_REQUIRED', 400, 'Cần orderCode hoặc orderId.');
  }
  if (requireOrder && !orderCode) orderCode = String(orderId);

  return { orderId, orderCode, matchedOrder, ordersRepo };
}

function serializeOrderLine(row) {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    orderId: val(row, 'orderId') ?? null,
    orderCode: val(row, 'orderCode') || null,
    lineNo: Number(val(row, 'lineNo')) || 1,
    sku: val(row, 'sku'),
    productName: val(row, 'productName'),
    lotId: val(row, 'lotId') ?? null,
    lotCode: val(row, 'lotCode') || null,
    requestedQty: Number(val(row, 'requestedQty')) || 0,
    allocatedQty: Number(val(row, 'allocatedQty')) || 0,
    unit: val(row, 'unit') || 'UNIT',
    targetTempMinC: val(row, 'targetTempMinC') ?? null,
    targetTempMaxC: val(row, 'targetTempMaxC') ?? null,
    status: val(row, 'status') || 'pending',
    notes: val(row, 'notes') || null,
  };
}

function serializeLot(row) {
  if (!row) return null;
  const qtyOnHand = Number(val(row, 'qtyOnHand')) || 0;
  const qtyReserved = Number(val(row, 'qtyReserved')) || 0;
  const exp = val(row, 'expiryDate');
  const mfg = val(row, 'manufacturedAt');
  const heldAt = val(row, 'heldAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    lotCode: val(row, 'lotCode'),
    sku: val(row, 'sku'),
    productName: val(row, 'productName'),
    warehouseLocationId: val(row, 'warehouseLocationId') ?? null,
    warehouseCode: val(row, 'warehouseCode') || null,
    assetEntityId: val(row, 'assetEntityId') || null,
    qtyOnHand,
    qtyReserved,
    qtyAvailable: Number(Math.max(0, qtyOnHand - qtyReserved).toFixed(6)),
    unit: val(row, 'unit') || 'UNIT',
    expiryDate: exp instanceof Date ? exp.toISOString() : String(exp || ''),
    manufacturedAt: mfg ? (mfg instanceof Date ? mfg.toISOString() : String(mfg)) : null,
    targetTempMinC: val(row, 'targetTempMinC') ?? null,
    targetTempMaxC: val(row, 'targetTempMaxC') ?? null,
    mktCelsius: val(row, 'mktCelsius') ?? null,
    status: val(row, 'status') || 'available',
    holdReason: val(row, 'holdReason') || null,
    heldAt: heldAt ? (heldAt instanceof Date ? heldAt.toISOString() : String(heldAt)) : null,
    heldBy: val(row, 'heldBy') || null,
    active: val(row, 'active') !== false,
  };
}

function serializeEpod(row) {
  if (!row) return null;
  const deliveredAt = val(row, 'deliveredAt');
  const rawTemp = val(row, 'tempSummaryJson');
  const hasMktFields = rawTemp && typeof rawTemp === 'object' && !Array.isArray(rawTemp)
    && (rawTemp.mktCelsius !== undefined || rawTemp.inRange !== undefined);
  const cleanTempSummary = hasMktFields
    ? {
        mktCelsius: rawTemp.mktCelsius ?? null,
        inRange: typeof rawTemp.inRange === 'boolean' ? rawTemp.inRange : null,
      }
    : null;
  const rawPhoto = val(row, 'evidencePhotoDataUrl') || rawTemp?.evidencePhotoDataUrl || null;
  const evidencePhotoDataUrl = typeof rawPhoto === 'string' && isSafeRasterImageDataUrl(rawPhoto, MAX_EPOD_PHOTO_BYTES)
    ? rawPhoto.trim()
    : null;
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    epodUid: val(row, 'epodUid'),
    trackingCode: val(row, 'trackingCode'),
    orderId: val(row, 'orderId') ?? null,
    orderCode: val(row, 'orderCode') || null,
    driverUserId: val(row, 'driverUserId') ?? null,
    driverEmployeeId: val(row, 'driverEmployeeId') ?? null,
    recipientName: val(row, 'recipientName'),
    recipientPhoneMasked: val(row, 'recipientPhoneMasked') || null,
    deliveredQty: Number(val(row, 'deliveredQty')) || 0,
    signatureSha256: val(row, 'signatureSha256'),
    gpsLat: val(row, 'gpsLat') ?? null,
    gpsLng: val(row, 'gpsLng') ?? null,
    gpsAccuracyM: val(row, 'gpsAccuracyM') ?? null,
    photoHashesJson: val(row, 'photoHashesJson') || [],
    evidencePhotoDataUrl,
    tempSummaryJson: cleanTempSummary,
    ledgerSeq: val(row, 'ledgerSeq') != null ? Number(val(row, 'ledgerSeq')) : null,
    ledgerSignatureBase64: val(row, 'ledgerSignatureBase64') || null,
    keyId: val(row, 'keyId') || null,
    status: val(row, 'status') || 'delivered',
    deliveredAt: deliveredAt instanceof Date ? deliveredAt.toISOString() : String(deliveredAt || ''),
    notes: val(row, 'notes') || null,
  };
}

function isLotCompatibleForFefo(lot, { organizationId, sku, nowMs, minTempC, maxTempC }) {
  if (!lot || val(lot, 'organizationId') !== organizationId) return false;
  if (val(lot, 'sku') !== sku) return false;
  if (val(lot, 'active') === false) return false;
  if (val(lot, 'status') !== 'available') return false;
  const expMs = new Date(val(lot, 'expiryDate')).getTime();
  if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
  const available = (Number(val(lot, 'qtyOnHand')) || 0) - (Number(val(lot, 'qtyReserved')) || 0);
  if (available <= 0) return false;

  const lotMin = parseFinite(val(lot, 'targetTempMinC'));
  const lotMax = parseFinite(val(lot, 'targetTempMaxC'));
  const lotMkt = parseFinite(val(lot, 'mktCelsius'));
  if (minTempC !== null && lotMin !== null && lotMin < minTempC) return false;
  if (maxTempC !== null && lotMin !== null && lotMin > maxTempC) return false;
  if (maxTempC !== null && lotMax !== null && lotMax > maxTempC) return false;
  if (minTempC !== null && lotMax !== null && lotMax < minTempC) return false;
  if (minTempC !== null && lotMkt !== null && lotMkt < minTempC) return false;
  if (maxTempC !== null && lotMkt !== null && lotMkt > maxTempC) return false;
  return true;
}

function buildPrintableVoucherHtml({ documentType, organizationId, order, orderLines, epod, ledgerSeq, keyId, qrVerificationHash, qrTrackPath }) {
  const docTitleMap = {
    order: 'Đơn hàng Logistics (OMS)',
    delivery_note: 'Phiếu xuất kho & Giao hàng (Delivery Note)',
    epod: 'Biên bản Giao nhận Điện tử (ePOD)',
  };
  const title = docTitleMap[documentType] || 'Chứng từ Vận hành LatticeDX';
  const orderCode = val(order, 'code') || val(epod, 'orderCode') || val(orderLines?.[0], 'orderCode') || '-';
  const trackUrl = qrTrackPath || `/v/track/${encodeURIComponent(val(epod, 'trackingCode') || orderCode)}?verify=${encodeURIComponent(String(qrVerificationHash || '').slice(0, 16))}`;
  let qrSvgHtml = '';
  try {
    qrSvgHtml = renderQrSvg(trackUrl, { size: 132, margin: 2 });
  } catch {
    qrSvgHtml = '';
  }

  const linesHtml = (Array.isArray(orderLines) ? orderLines : []).map((line, idx) => `
    <tr>
      <td>${escapeHtml(val(line, 'lineNo') ?? idx + 1)}</td>
      <td>${escapeHtml(val(line, 'sku') || '')}</td>
      <td>${escapeHtml(val(line, 'productName') || '')}</td>
      <td>${escapeHtml(val(line, 'lotCode') || '-')}</td>
      <td>${escapeHtml(val(line, 'requestedQty') ?? 0)}</td>
      <td>${escapeHtml(val(line, 'allocatedQty') ?? 0)}</td>
      <td>${escapeHtml(val(line, 'unit') || 'UNIT')}</td>
      <td>${escapeHtml(val(line, 'status') || 'pending')}</td>
    </tr>
  `).join('');

  const deliveredRaw = epod ? val(epod, 'deliveredAt') : null;
  const deliveredStr = deliveredRaw instanceof Date ? deliveredRaw.toISOString() : String(deliveredRaw || '');
  const rawSigUrl = epod ? String(val(epod, 'signatureDataUrl') || '').trim() : '';
  const sigImgHtml = rawSigUrl && isSafeRasterImageDataUrl(rawSigUrl, 256 * 1024)
    ? `<div class="epod-media"><div><strong>Chữ ký người nhận (ePOD):</strong></div><img src="${escapeHtml(rawSigUrl)}" alt="Chữ ký ePOD" class="epod-sig-img" /></div>`
    : '';
  const rawPhotoUrl = epod ? String(val(epod, 'evidencePhotoDataUrl') || val(epod, 'tempSummaryJson')?.evidencePhotoDataUrl || '').trim() : '';
  const photoImgHtml = rawPhotoUrl && isSafeRasterImageDataUrl(rawPhotoUrl, MAX_EPOD_PHOTO_BYTES)
    ? `<div class="epod-media"><div><strong>Ảnh minh chứng giao nhận:</strong></div><img src="${escapeHtml(rawPhotoUrl)}" alt="Ảnh minh chứng ePOD" class="epod-photo-img" /></div>`
    : '';
  const epodBlock = epod ? `
    <section class="epod">
      <h2>Xác nhận Giao nhận (ePOD)</h2>
      <p><strong>Mã ePOD:</strong> ${escapeHtml(val(epod, 'epodUid'))} | <strong>Tracking:</strong> ${escapeHtml(val(epod, 'trackingCode'))}</p>
      <p><strong>Người nhận:</strong> ${escapeHtml(val(epod, 'recipientName'))} (${escapeHtml(val(epod, 'recipientPhoneMasked') || '***')})</p>
      <p><strong>Số lượng giao:</strong> ${escapeHtml(val(epod, 'deliveredQty') ?? 0)} | <strong>Thời điểm:</strong> ${escapeHtml(deliveredStr)}</p>
      <p><strong>SHA-256 chữ ký:</strong> <code>${escapeHtml(val(epod, 'signatureSha256') || '')}</code></p>
      ${(sigImgHtml || photoImgHtml) ? `<div class="epod-media-row">${sigImgHtml}${photoImgHtml}</div>` : ''}
    </section>
  ` : '';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — ${escapeHtml(orderCode)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; margin: 24px; }
    .hdr { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; }
    .org-badge { background: #e2e8f0; padding: 4px 10px; border-radius: 4px; font-weight: 600; font-size: 12px; display: inline-block; margin-bottom: 8px; }
    .qr-box { text-align: right; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; font-size: 13px; }
    th { background: #f8fafc; }
    .epod-media-row { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; }
    .epod-media { font-size: 12px; }
    .epod-sig-img { max-width: 260px; max-height: 110px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; margin-top: 4px; }
    .epod-photo-img { max-width: 260px; max-height: 160px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; margin-top: 4px; }
    .stamp { margin-top: 18px; padding: 10px; border: 1px dashed #64748b; background: #f8fafc; font-size: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <header class="hdr">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p><strong>Mã chứng từ:</strong> ${escapeHtml(orderCode)} | <strong>Trạng thái:</strong> ${escapeHtml(val(order, 'status') || val(epod, 'status') || 'active')}</p>
    </div>
    <div class="qr-box">
      <span class="org-badge">ORG: ${escapeHtml(organizationId)}</span>
      ${qrSvgHtml ? `<div class="qr-svg">${qrSvgHtml}</div>` : ''}
    </div>
  </header>
  ${order ? `<section class="meta">
    <p><strong>Tiêu đề:</strong> ${escapeHtml(val(order, 'name') || '')}</p>
    <p><strong>Khách hàng:</strong> ${escapeHtml(val(order, 'customer') || '-')} | <strong>Tuyến:</strong> ${escapeHtml(val(order, 'origin') || '-')} -&gt; ${escapeHtml(val(order, 'destination') || '-')}</p>
  </section>` : ''}
  <table>
    <thead>
      <tr><th>#</th><th>SKU</th><th>Sản phẩm</th><th>Mã lô</th><th>Yêu cầu</th><th>Đã phân bổ</th><th>ĐVT</th><th>Trạng thái</th></tr>
    </thead>
    <tbody>${linesHtml || '<tr><td colspan="8">Không có dòng hàng hóa.</td></tr>'}</tbody>
  </table>
  ${epodBlock}
  <footer class="stamp">
    <div>
      <div><strong>Xác thực mật mã Ed25519:</strong> Ledger Seq #${escapeHtml(ledgerSeq ?? 'N/A')} | Key ID: <code>${escapeHtml(keyId || 'N/A')}</code></div>
      <div><strong>Tra cứu Công khai:</strong> <code>${escapeHtml(trackUrl)}</code></div>
      <div><strong>QR Verification Link Hash:</strong> <code>#verify=${escapeHtml(qrVerificationHash)}</code></div>
    </div>
  </footer>
</body>
</html>`;
}

async function loadPublicTrackRecord(db, trackingCode, providedHash) {
  const epodRepo = db.getRepository?.('latticeEpodRecords');
  return runWithSystemRlsBypass(db, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const row = epodRepo?.findOne ? await epodRepo.findOne({ filter: { trackingCode }, ...txOpt }) : null;
    const expectedHash = row ? String(val(row, 'trackingTokenHash') || '') : DUMMY_HASH_HEX;
    const validToken = Boolean(row) && timingSafeEqualHex(expectedHash, providedHash);
    if (!validToken) {
      return { row: null, validToken: false, ledgerEntry: null, pkiKeyRow: null };
    }
    const orgId = val(row, 'organizationId');
    const seqVal = val(row, 'ledgerSeq');
    const epodUid = val(row, 'epodUid');
    const ledgerRepo = db.getRepository?.('latticeCryptoLedger');
    let ledgerEntry = null;
    if (ledgerRepo && orgId) {
      if (seqVal != null) {
        if (typeof ledgerRepo.findOne === 'function') {
          ledgerEntry = await ledgerRepo.findOne({ filter: { organizationId: orgId, seq: Number(seqVal) }, ...txOpt });
        } else if (typeof ledgerRepo.find === 'function') {
          ledgerEntry = ((await ledgerRepo.find({ filter: { organizationId: orgId, seq: Number(seqVal) }, limit: 1, ...txOpt })) || [])[0] || null;
        }
      }
      if (!ledgerEntry && epodUid) {
        const fallbackFilter = { organizationId: orgId, targetCollection: 'latticeEpodRecords', targetRecordId: String(epodUid) };
        if (typeof ledgerRepo.findOne === 'function') {
          ledgerEntry = await ledgerRepo.findOne({ filter: fallbackFilter, ...txOpt });
        } else if (typeof ledgerRepo.find === 'function') {
          ledgerEntry = ((await ledgerRepo.find({ filter: fallbackFilter, limit: 1, ...txOpt })) || [])[0] || null;
        }
      }
    }
    const effectiveKeyId = val(ledgerEntry, 'keyId') || val(row, 'keyId');
    const pkiRepo = db.getRepository?.('latticePkiKeys');
    let pkiKeyRow = null;
    if (pkiRepo && orgId && effectiveKeyId) {
      if (typeof pkiRepo.findOne === 'function') {
        pkiKeyRow = await pkiRepo.findOne({ filter: { organizationId: orgId, keyId: effectiveKeyId }, ...txOpt });
      } else if (typeof pkiRepo.find === 'function') {
        pkiKeyRow = ((await pkiRepo.find({ filter: { organizationId: orgId, keyId: effectiveKeyId }, limit: 1, ...txOpt })) || [])[0] || null;
      }
    }
    return { row, validToken: true, ledgerEntry, pkiKeyRow };
  }, foundation);
}

function verifyEpodLedgerSignature({ epodRow, ledgerEntry, pkiKeyRow }) {
  const orgId = String(val(epodRow, 'organizationId') || '').trim();
  const rawSeq = val(epodRow, 'ledgerSeq') ?? val(ledgerEntry, 'seq');
  const seq = rawSeq != null && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : null;
  const epodKeyId = val(epodRow, 'keyId') || null;
  const ledgerKeyId = val(ledgerEntry, 'keyId') || null;
  const keyId = ledgerKeyId || epodKeyId || null;
  const entryHash = ledgerEntry && val(ledgerEntry, 'entryHash') ? String(val(ledgerEntry, 'entryHash')) : null;
  const merkleRoot = ledgerEntry && val(ledgerEntry, 'merkleRoot') ? String(val(ledgerEntry, 'merkleRoot')) : null;
  const publicKeyFingerprint = pkiKeyRow && val(pkiKeyRow, 'fingerprintSha256')
    ? String(val(pkiKeyRow, 'fingerprintSha256'))
    : null;
  const publicKeyPem = pkiKeyRow && val(pkiKeyRow, 'publicKeyPem') ? String(val(pkiKeyRow, 'publicKeyPem')) : null;
  const ledgerSig = ledgerEntry && val(ledgerEntry, 'signatureBase64') ? String(val(ledgerEntry, 'signatureBase64')).trim() : '';
  const epodSig = epodRow && val(epodRow, 'ledgerSignatureBase64') ? String(val(epodRow, 'ledgerSignatureBase64')).trim() : '';

  let verified = false;
  let reason = '';
  if (!orgId || seq == null || !Number.isInteger(seq)) {
    reason = 'LEDGER_SEQ_MISSING';
  } else if (!ledgerEntry) {
    reason = 'LEDGER_ENTRY_MISSING';
  } else if (!pkiKeyRow) {
    reason = 'PKI_KEY_MISSING';
  } else if (val(pkiKeyRow, 'active') === false) {
    reason = 'PKI_KEY_INACTIVE';
  } else if (
    String(val(ledgerEntry, 'organizationId') || '').trim() !== orgId
    || String(val(pkiKeyRow, 'organizationId') || '').trim() !== orgId
  ) {
    reason = 'LEDGER_ORG_MISMATCH';
  } else if (epodKeyId && ledgerKeyId && epodKeyId !== ledgerKeyId) {
    reason = 'LEDGER_KEY_MISMATCH';
  } else if (epodSig && ledgerSig && epodSig !== ledgerSig) {
    reason = 'EPOD_SIGNATURE_MISMATCH';
  } else if (!entryHash) {
    reason = 'LEDGER_ENTRY_HASH_MISSING';
  } else if (!ledgerSig) {
    reason = 'LEDGER_SIGNATURE_MISSING';
  } else if (!publicKeyPem) {
    reason = 'PKI_PUBLIC_KEY_MISSING';
  } else {
    let entryIntegrityOk = true;
    const eventType = val(ledgerEntry, 'eventType');
    const targetCollection = val(ledgerEntry, 'targetCollection');
    const targetRecordId = val(ledgerEntry, 'targetRecordId');
    const payloadHash = val(ledgerEntry, 'payloadHash');
    const prevHash = val(ledgerEntry, 'prevHash');
    const recordedRaw = val(ledgerEntry, 'recordedAt');
    if (eventType && targetCollection && targetRecordId != null && payloadHash && prevHash && recordedRaw) {
      const recordedMs = new Date(recordedRaw).getTime();
      if (!Number.isFinite(recordedMs)) {
        entryIntegrityOk = false;
        reason = 'LEDGER_ENTRY_TIMESTAMP_INVALID';
      } else {
        const recomputedEntryHash = sha256Hex(
          `${orgId}|${seq}|${String(eventType)}|${String(targetCollection)}|${String(targetRecordId)}|${String(payloadHash)}|${String(prevHash)}|${new Date(recordedMs).toISOString()}`,
        );
        if (recomputedEntryHash !== entryHash) {
          entryIntegrityOk = false;
          reason = 'LEDGER_ENTRY_HASH_MISMATCH';
        }
      }
    }
    if (entryIntegrityOk) {
      try {
        const canonicalPayload = `${orgId}|${seq}|${entryHash}`;
        const pubKey = createPublicKey(publicKeyPem);
        verified = verify(
          null,
          Buffer.from(canonicalPayload, 'utf8'),
          pubKey,
          Buffer.from(ledgerSig, 'base64'),
        );
        if (!verified) reason = 'LEDGER_SIGNATURE_MISMATCH';
      } catch {
        verified = false;
        reason = 'LEDGER_SIGNATURE_MISMATCH';
      }
    }
  }

  return {
    verified,
    seq,
    entryHash,
    keyId,
    publicKeyFingerprint,
    merkleRoot,
    reason,
  };
}

function createDxosWmsActions(db) {
  if (typeof foundation?.pgRls?.installRlsTransactionBridge === 'function') {
    foundation.pgRls.installRlsTransactionBridge(db);
  }

  return {
    orderLines: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId } = await resolveTenantActor(db, ctx, {
        requireOrg: false,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeOrderLines'],
        aclAction: 'view',
        patScopes: ['read', 'write', 'wms'],
      }, foundation);
      const repo = db.getRepository?.('latticeOrderLines');
      if (!repo) {
        ctx.body = { organizationId, items: [] };
        return next();
      }
      const filter = {
        ...(organizationId ? { organizationId } : {}),
        ...(params.orderId != null && /^[1-9]\d*$/.test(String(params.orderId)) ? { orderId: Number(params.orderId) } : {}),
        ...(typeof params.orderCode === 'string' && params.orderCode.trim() ? { orderCode: params.orderCode.trim() } : {}),
        ...(typeof params.sku === 'string' && params.sku.trim() ? { sku: params.sku.trim() } : {}),
        ...(typeof params.status === 'string' && params.status.trim() ? { status: params.status.trim() } : {}),
      };
      const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
      const rows = await runWithOptionalRls(db, organizationId, (transaction) => (
        repo.find({ filter, sort: ['lineNo', 'id'], limit, ...(transaction ? { transaction } : {}) })
      ), foundation) || [];
      ctx.body = { organizationId, items: rows.map(serializeOrderLine) };
      return next();
    },

    saveOrderLine: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeOrderLines'],
        aclAction: 'update',
        patScopes: ['write', 'wms'],
      }, foundation);
      const sku = typeof params.sku === 'string' ? params.sku.trim().slice(0, 128) : '';
      const productName = typeof params.productName === 'string' ? params.productName.trim().slice(0, 255) : '';
      const requestedQty = parseFinite(params.requestedQty);
      if (!sku) throw fail('WMS_SKU_REQUIRED', 400, 'Cần mã SKU hợp lệ.');
      if (!productName) throw fail('WMS_PRODUCT_REQUIRED', 400, 'Cần tên sản phẩm.');
      if (requestedQty === null || requestedQty <= 0) throw fail('WMS_QTY_INVALID', 400, 'requestedQty phải > 0.');

      const lineNo = parseStrictPositiveInt(params.lineNo, 1, 'WMS_LINE_NO_INVALID', 'lineNo phải là số nguyên dương.');
      const { minTempC: targetTempMinC, maxTempC: targetTempMaxC } = parseTempBand(params.targetTempMinC, params.targetTempMaxC);

      const lineRepo = db.getRepository?.('latticeOrderLines');
      if (!lineRepo) throw fail('WMS_REPO_UNAVAILABLE', 503);

      const saved = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const { orderId, orderCode } = await resolveOrderRef(db, organizationId, params, { requireOrder: true, transaction });
        const existing = await lineRepo.findOne({ filter: { organizationId, orderCode, lineNo }, ...txOpt });
        const values = {
          organizationId,
          orderId,
          orderCode,
          lineNo,
          sku,
          productName,
          requestedQty,
          unit: typeof params.unit === 'string' && params.unit.trim() ? params.unit.trim().slice(0, 64) : 'UNIT',
          targetTempMinC,
          targetTempMaxC,
          notes: typeof params.notes === 'string' ? params.notes.trim().slice(0, 1000) : null,
        };
        if (existing) {
          return saveRow(lineRepo, existing, values, { organizationId }, transaction);
        }
        return lineRepo.create({ values: { ...values, allocatedQty: 0, status: 'pending' }, ...txOpt });
      }, foundation);

      ctx.body = { orderLine: serializeOrderLine(saved) };
      return next();
    },

    receiveStock: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeAssets', 'latticeStockLots'],
        aclAction: 'create',
        patScopes: ['write', 'wms'],
      }, foundation);

      const lotCode = typeof params.lotCode === 'string' ? params.lotCode.trim().slice(0, 128) : '';
      const sku = typeof params.sku === 'string' ? params.sku.trim().slice(0, 128) : '';
      const productName = typeof params.productName === 'string' ? params.productName.trim().slice(0, 255) : '';
      const qtyAdded = parseFinite(params.qtyOnHand ?? params.quantity);
      const expiryDate = parseOptionalDate(params.expiryDate, 'WMS_EXPIRY_REQUIRED');
      if (!lotCode) throw fail('WMS_LOT_CODE_REQUIRED', 400, 'Cần mã lô lotCode.');
      if (!sku) throw fail('WMS_SKU_REQUIRED', 400, 'Cần mã SKU.');
      if (!productName) throw fail('WMS_PRODUCT_REQUIRED', 400, 'Cần tên hàng hóa.');
      if (qtyAdded === null || qtyAdded <= 0) throw fail('WMS_QTY_INVALID', 400, 'Số lượng nhập kho phải > 0.');
      if (!expiryDate) throw fail('WMS_EXPIRY_REQUIRED', 400, 'Cần ngày hết hạn expiryDate hợp lệ.');

      const manufacturedAt = parseOptionalDate(params.manufacturedAt, 'WMS_DATE_INVALID');
      if (manufacturedAt && expiryDate.getTime() <= manufacturedAt.getTime()) {
        throw fail('WMS_EXPIRY_INVALID', 400, 'expiryDate phải sau manufacturedAt.');
      }

      const { minTempC: targetTempMinC, maxTempC: targetTempMaxC } = parseTempBand(params.targetTempMinC, params.targetTempMaxC);

      const assetEntityId = typeof params.assetEntityId === 'string' ? params.assetEntityId.trim().slice(0, 255) : null;
      if (assetEntityId) {
        const urnMatch = URN_ORG_RE.exec(assetEntityId);
        if (urnMatch && urnMatch[1] !== organizationId) {
          throw fail('NATIVE_ORGANIZATION_MISMATCH', 403, 'assetEntityId không thuộc tổ chức hiện tại.');
        }
      }

      const warehouseLocationId = params.warehouseLocationId != null && /^[1-9]\d*$/.test(String(params.warehouseLocationId))
        ? Number(params.warehouseLocationId)
        : null;
      const lotRepo = db.getRepository?.('latticeStockLots');
      if (!lotRepo) throw fail('WMS_REPO_UNAVAILABLE', 503);

      const saved = await runWithOptionalRls(db, organizationId, () => runInTx(db, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const locRepo = db.getRepository?.('latticeLocations');
        if (warehouseLocationId != null && locRepo?.findOne) {
          const loc = await locRepo.findOne({ filter: { id: warehouseLocationId, organizationId, active: true }, ...txOpt });
          if (!loc || val(loc, 'organizationId') !== organizationId) {
            throw fail('WMS_LOCATION_NOT_FOUND', 404, 'Không tìm thấy kho hợp lệ trong tổ chức.');
          }
        }

        const existing = await findLockedLot(db, lotRepo, { organizationId, lotCode }, transaction);
        let row;
        if (existing) {
          if (val(existing, 'sku') !== sku) {
            throw fail('WMS_LOT_SKU_MISMATCH', 409, 'Mã lô đã tồn tại với SKU khác.');
          }
          if (val(existing, 'status') === 'hold_mkt') {
            throw fail('WMS_LOT_ON_HOLD', 409, 'Không thể nhập thêm vào lô đang bị tạm giữ MKT.');
          }
          const nextQty = Number(((Number(val(existing, 'qtyOnHand')) || 0) + qtyAdded).toFixed(6));
          const patch = {
            qtyOnHand: nextQty,
            productName,
            expiryDate,
            ...(val(existing, 'status') === 'depleted' ? { status: 'available' } : {}),
            ...(assetEntityId ? { assetEntityId } : {}),
            ...(targetTempMinC !== null ? { targetTempMinC } : {}),
            ...(targetTempMaxC !== null ? { targetTempMaxC } : {}),
          };
          row = await saveRow(lotRepo, existing, patch, { organizationId }, transaction);
        } else {
          row = await lotRepo.create({
            values: {
              organizationId,
              lotCode,
              sku,
              productName,
              warehouseLocationId,
              warehouseCode: typeof params.warehouseCode === 'string' ? params.warehouseCode.trim().slice(0, 128) : null,
              assetEntityId,
              qtyOnHand: qtyAdded,
              qtyReserved: 0,
              unit: typeof params.unit === 'string' && params.unit.trim() ? params.unit.trim().slice(0, 64) : 'UNIT',
              expiryDate,
              manufacturedAt,
              targetTempMinC,
              targetTempMaxC,
              mktCelsius: null,
              status: 'available',
              active: true,
            },
            ...txOpt,
          });
        }
        const serialized = serializeLot(row);
        await appendAuditLedger(db, {
          organizationId,
          eventType: 'wms.stock_received',
          targetCollection: 'latticeStockLots',
          targetRecordId: String(serialized.id ?? lotCode),
          actor,
          payload: serialized,
          transaction,
          scope: 'dxos:wms',
          foundation,
        });
        return serialized;
      }, { organizationId, foundation }), foundation);

      ctx.body = { lot: saved };
      return next();
    },

    lots: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId } = await resolveTenantActor(db, ctx, {
        requireOrg: false,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeAssets', 'latticeStockLots'],
        aclAction: 'view',
        patScopes: ['read', 'write', 'wms'],
      }, foundation);
      const lotRepo = db.getRepository?.('latticeStockLots');
      if (!lotRepo) {
        ctx.body = { organizationId, items: [] };
        return next();
      }
      const filter = {
        ...(organizationId ? { organizationId } : {}),
        ...(typeof params.sku === 'string' && params.sku.trim() ? { sku: params.sku.trim() } : {}),
        ...(typeof params.status === 'string' && params.status.trim() ? { status: params.status.trim() } : {}),
        ...(typeof params.lotCode === 'string' && params.lotCode.trim() ? { lotCode: params.lotCode.trim() } : {}),
      };
      const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
      const rows = await runWithOptionalRls(db, organizationId, (transaction) => (
        lotRepo.find({ filter, sort: ['expiryDate', 'id'], limit, ...(transaction ? { transaction } : {}) })
      ), foundation) || [];
      ctx.body = { organizationId, items: rows.map(serializeLot) };
      return next();
    },

    allocateFefo: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeAssets', 'latticeStockLots'],
        aclAction: 'update',
        patScopes: ['write', 'wms'],
      }, foundation);

      const sku = typeof params.sku === 'string' ? params.sku.trim().slice(0, 128) : '';
      const quantity = parseFinite(params.quantity);
      if (!sku) throw fail('WMS_SKU_REQUIRED', 400, 'Cần mã SKU để phân bổ FEFO.');
      if (quantity === null || quantity <= 0) throw fail('WMS_QTY_INVALID', 400, 'Số lượng phân bổ phải > 0.');

      const { minTempC, maxTempC } = parseTempBand(params.minTempC, params.maxTempC);
      const nowDate = parseOptionalDate(params.now, 'WMS_DATE_INVALID') || new Date();
      const nowMs = nowDate.getTime();
      const lineNo = parseStrictPositiveInt(params.lineNo, 1, 'WMS_LINE_NO_INVALID', 'lineNo phải là số nguyên dương.');

      const lotRepo = db.getRepository?.('latticeStockLots');
      if (!lotRepo) throw fail('WMS_REPO_UNAVAILABLE', 503);
      const lineRepo = db.getRepository?.('latticeOrderLines');

      const result = await runWithOptionalRls(db, organizationId, () => runInTx(db, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const { orderId, orderCode } = await resolveOrderRef(db, organizationId, params, {
          requireOrder: false,
          lookupByCode: false,
          transaction,
        });

        const resolvedCode = orderCode || (orderId != null ? String(orderId) : '');
        let existingLine = null;
        if (lineRepo && resolvedCode) {
          existingLine = await lineRepo.findOne({ filter: { organizationId, orderCode: resolvedCode, lineNo }, ...txOpt });
          if (existingLine && val(existingLine, 'sku') !== sku) {
            throw fail('WMS_ORDER_LINE_SKU_MISMATCH', 400, 'SKU của dòng đơn hàng không khớp với SKU phân bổ FEFO.');
          }
        }

        const rawLots = (await findLockedLots(db, lotRepo, {
          filter: { organizationId, sku, status: 'available', active: true },
          sort: ['expiryDate', 'id'],
          limit: 500,
          transaction,
        })) || [];

        const eligible = rawLots
          .filter((lot) => isLotCompatibleForFefo(lot, { organizationId, sku, nowMs, minTempC, maxTempC }))
          .sort((a, b) => {
            const diff = new Date(val(a, 'expiryDate')).getTime() - new Date(val(b, 'expiryDate')).getTime();
            return diff !== 0 ? diff : Number(val(a, 'id') || 0) - Number(val(b, 'id') || 0);
          });

        let remaining = quantity;
        const allocations = [];
        for (const lot of eligible) {
          if (remaining <= 0) break;
          const onHand = Number(val(lot, 'qtyOnHand')) || 0;
          const reserved = Number(val(lot, 'qtyReserved')) || 0;
          const available = Number((onHand - reserved).toFixed(6));
          if (available <= 0) continue;
          const take = Number(Math.min(remaining, available).toFixed(6));
          const nextReserved = Number((reserved + take).toFixed(6));
          await saveRow(lotRepo, lot, { qtyReserved: nextReserved }, { organizationId }, transaction);
          allocations.push({
            lotId: val(lot, 'id') ?? null,
            lotCode: val(lot, 'lotCode'),
            productName: val(lot, 'productName'),
            expiryDate: val(lot, 'expiryDate') instanceof Date ? val(lot, 'expiryDate').toISOString() : String(val(lot, 'expiryDate')),
            qtyAllocated: take,
          });
          remaining = Number((remaining - take).toFixed(6));
        }

        const allocatedTotal = Number((quantity - remaining).toFixed(6));
        const shortfall = Number(Math.max(0, remaining).toFixed(6));
        let orderLine = null;

        if (lineRepo && resolvedCode) {
          const primaryLot = allocations[0] || null;
          const nextStatus = allocatedTotal === 0 ? 'pending' : (shortfall === 0 ? 'allocated' : 'partial');
          if (existingLine) {
            const prevAlloc = Number(val(existingLine, 'allocatedQty')) || 0;
            const totalAlloc = Number((prevAlloc + allocatedTotal).toFixed(6));
            const reqQty = Number(val(existingLine, 'requestedQty')) || quantity;
            const lineStatus = totalAlloc === 0 ? 'pending' : (totalAlloc >= reqQty && shortfall === 0 ? 'allocated' : 'partial');
            const updatedLine = await saveRow(lineRepo, existingLine, {
              ...(primaryLot ? { lotId: primaryLot.lotId, lotCode: primaryLot.lotCode } : {}),
              allocatedQty: totalAlloc,
              status: lineStatus,
            }, { organizationId }, transaction);
            orderLine = serializeOrderLine(updatedLine);
          } else {
            const createdLine = await lineRepo.create({
              values: {
                organizationId,
                orderId,
                orderCode: resolvedCode,
                lineNo,
                sku,
                productName: typeof params.productName === 'string' && params.productName.trim() ? params.productName.trim() : (primaryLot?.productName || sku),
                lotId: primaryLot?.lotId ?? null,
                lotCode: primaryLot?.lotCode ?? null,
                requestedQty: quantity,
                allocatedQty: allocatedTotal,
                unit: typeof params.unit === 'string' && params.unit.trim() ? params.unit.trim() : 'UNIT',
                targetTempMinC: minTempC,
                targetTempMaxC: maxTempC,
                status: nextStatus,
              },
              ...txOpt,
            });
            orderLine = serializeOrderLine(createdLine);
          }
        }

        const targetCollection = orderLine ? 'latticeOrderLines' : 'latticeOrders';
        const targetRecordId = String(orderLine?.id || orderId || orderCode || sku);
        await appendAuditLedger(db, {
          organizationId,
          eventType: 'wms.fefo_allocated',
          targetCollection,
          targetRecordId,
          actor,
          payload: { sku, quantity, allocatedTotal, shortfall, allocations },
          transaction,
          scope: 'dxos:wms',
          foundation,
        });

        for (const alloc of allocations) {
          await recordLineageSafely(db, {
            organizationId,
            sourceCollection: 'latticeStockLots',
            sourceRecordId: String(alloc.lotId ?? alloc.lotCode),
            targetCollection,
            targetRecordId,
            relationType: 'allocated_to',
            actorName: actor.username,
            metadataJson: { sku, lotCode: alloc.lotCode, qtyAllocated: alloc.qtyAllocated, orderCode: orderCode || null },
            transaction,
          });
        }

        return {
          allocatedTotal,
          shortfall,
          allocations: allocations.map(({ productName: _p, ...rest }) => rest),
          orderLine,
        };
      }, { organizationId, foundation }), foundation);

      ctx.body = result;
      return next();
    },

    issueStock: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeAssets', 'latticeStockLots'],
        aclAction: 'update',
        patScopes: ['write', 'wms'],
      }, foundation);

      const quantity = parseFinite(params.quantity);
      if (quantity === null || quantity <= 0) throw fail('WMS_QTY_INVALID', 400, 'Số lượng xuất kho phải > 0.');
      const lotId = params.lotId != null && /^[1-9]\d*$/.test(String(params.lotId)) ? Number(params.lotId) : null;
      const lotCode = typeof params.lotCode === 'string' ? params.lotCode.trim() : '';
      if (lotId == null && !lotCode) throw fail('WMS_LOT_REQUIRED', 400, 'Cần lotId hoặc lotCode.');

      const orderLineId = params.orderLineId != null
        ? parseStrictPositiveInt(params.orderLineId, undefined, 'WMS_ORDER_LINE_ID_INVALID', 'orderLineId phải là số nguyên dương.')
        : null;
      const lineNo = parseStrictPositiveInt(params.lineNo, 1, 'WMS_LINE_NO_INVALID', 'lineNo phải là số nguyên dương.');
      const orderCode = typeof params.orderCode === 'string' ? params.orderCode.trim() : '';

      const lotRepo = db.getRepository?.('latticeStockLots');
      if (!lotRepo) throw fail('WMS_REPO_UNAVAILABLE', 503);
      const lineRepo = db.getRepository?.('latticeOrderLines');

      const result = await runWithOptionalRls(db, organizationId, () => runInTx(db, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const filter = lotId != null ? { organizationId, id: lotId } : { organizationId, lotCode };
        const lot = await findLockedLot(db, lotRepo, filter, transaction);
        if (!lot || val(lot, 'organizationId') !== organizationId) {
          throw fail('WMS_LOT_NOT_FOUND', 404, 'Không tìm thấy lô hàng trong phạm vi tổ chức.');
        }

        const status = String(val(lot, 'status') || 'available').toLowerCase();
        const expMs = new Date(val(lot, 'expiryDate')).getTime();
        if (BLOCKED_LOT_STATUSES.has(status) || (Number.isFinite(expMs) && expMs <= Date.now())) {
          throw fail('WMS_LOT_ON_HOLD', 409, `Lô ${val(lot, 'lotCode')} đang ở trạng thái ${status} hoặc đã hết hạn, không thể xuất kho.`);
        }

        const currentOnHand = Number(val(lot, 'qtyOnHand')) || 0;
        const currentReserved = Number(val(lot, 'qtyReserved')) || 0;
        if (currentOnHand < quantity) {
          throw fail('WMS_INSUFFICIENT_STOCK', 409, 'Tồn kho thực tế của lô không đủ để xuất.');
        }

        const nextOnHand = Number((currentOnHand - quantity).toFixed(6));
        const nextReserved = Number(Math.min(nextOnHand, Math.max(0, currentReserved - quantity)).toFixed(6));
        const nextStatus = nextOnHand === 0 ? 'depleted' : 'available';
        const updatedLot = await saveRow(
          lotRepo,
          lot,
          { qtyOnHand: nextOnHand, qtyReserved: nextReserved, status: nextStatus },
          { organizationId },
          transaction,
        );

        let orderLine = null;
        if (lineRepo && (orderLineId != null || orderCode)) {
          const lineFilter = orderLineId != null
            ? { organizationId, id: orderLineId }
            : { organizationId, orderCode, lineNo };
          const line = await lineRepo.findOne({ filter: lineFilter, ...txOpt });
          if (line && val(line, 'organizationId') === organizationId) {
            const updatedLine = await saveRow(lineRepo, line, { status: 'dispatched' }, { organizationId }, transaction);
            orderLine = serializeOrderLine(updatedLine);
          }
        }

        const serialized = serializeLot(updatedLot);
        await appendAuditLedger(db, {
          organizationId,
          eventType: 'wms.stock_issued',
          targetCollection: 'latticeStockLots',
          targetRecordId: String(serialized.id ?? serialized.lotCode),
          actor,
          payload: { lotCode: serialized.lotCode, issuedQty: quantity, qtyOnHand: nextOnHand, status: nextStatus },
          transaction,
          scope: 'dxos:wms',
          foundation,
        });

        return { lot: serialized, issuedQty: quantity, orderLine };
      }, { organizationId, foundation }), foundation);

      ctx.body = result;
      return next();
    },

    holdLotByMkt: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeAssets', 'latticeStockLots'],
        aclAction: 'update',
        patScopes: ['write', 'wms'],
      }, foundation);

      const lotId = params.lotId != null && /^[1-9]\d*$/.test(String(params.lotId)) ? Number(params.lotId) : null;
      const lotCode = typeof params.lotCode === 'string' ? params.lotCode.trim() : '';
      if (lotId == null && !lotCode) throw fail('WMS_LOT_REQUIRED', 400, 'Cần lotId hoặc lotCode.');

      const explicitMax = params.maxAllowedC != null ? parseFinite(params.maxAllowedC) : null;
      if (params.maxAllowedC != null && explicitMax === null) {
        throw fail('MKT_INVALID_SAMPLE', 400, 'maxAllowedC không hợp lệ.');
      }

      const lotRepo = db.getRepository?.('latticeStockLots');
      if (!lotRepo) throw fail('WMS_REPO_UNAVAILABLE', 503);

      const result = await runWithOptionalRls(db, organizationId, () => runInTx(db, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const lotFilter = lotId != null ? { organizationId, id: lotId } : { organizationId, lotCode };
        const lot = await findLockedLot(db, lotRepo, lotFilter, transaction);
        if (!lot || val(lot, 'organizationId') !== organizationId) {
          throw fail('WMS_LOT_NOT_FOUND', 404, 'Không tìm thấy lô hàng trong phạm vi tổ chức.');
        }

        let samples = Array.isArray(params.samplesC) ? params.samplesC : null;
        if (!samples || !samples.length) {
          const assetEntityId = val(lot, 'assetEntityId');
          const tsRepo = db.getRepository?.('latticeTelemetryPoints');
          if (assetEntityId && tsRepo?.find) {
            const pts = (await tsRepo.find({
              filter: { organizationId, assetEntityId, metricName: 'temperature' },
              sort: ['-observedAt', '-id'],
              limit: 500,
              ...txOpt,
            })) || [];
            samples = pts
              .filter((p) => val(p, 'organizationId') === organizationId && val(p, 'assetEntityId') === assetEntityId)
              .map((p) => parseFinite(val(p, 'numericValue')))
              .filter((v) => v !== null);
          }
        }

        const profile = String(params.coldChainProfile || '').trim().toLowerCase();
        const lotMaxTemp = parseFinite(val(lot, 'targetTempMaxC'));
        const lotMinTemp = parseFinite(val(lot, 'targetTempMinC'));
        const thresholdCelsius = explicitMax
          ?? lotMaxTemp
          ?? (profile === 'frozen' || (lotMinTemp !== null && lotMinTemp <= -15) ? -15 : 8);

        const forceHold = params.forceHold === true;
        if ((!samples || !samples.length) && !forceHold) {
          throw fail('WMS_MKT_SAMPLES_REQUIRED', 400, 'Cần chuỗi mẫu nhiệt độ hoặc telemetry thiết bị để tính MKT.');
        }

        const mktResult = samples && samples.length
          ? computeMeanKineticTemperature(samples, { maxAllowedC: thresholdCelsius })
          : {
              mktCelsius: val(lot, 'mktCelsius') ?? thresholdCelsius,
              minTempCelsius: null,
              maxTempCelsius: null,
              avgTempCelsius: null,
              sampleCount: 0,
              excursionCount: 0,
              thresholdCelsius,
              breached: false,
            };

        const held = forceHold || mktResult.mktCelsius > thresholdCelsius;
        const reason = String(
          params.reason || (forceHold ? 'Tạm giữ lô thủ công theo quy định QA' : `MKT ${mktResult.mktCelsius}°C vượt ngưỡng ${thresholdCelsius}°C`),
        ).slice(0, 255);

        const patch = {
          mktCelsius: mktResult.mktCelsius,
          ...(held ? {
            status: 'hold_mkt',
            holdReason: reason,
            heldAt: new Date(),
            heldBy: actor.username,
          } : {}),
        };
        const updated = await saveRow(lotRepo, lot, patch, { organizationId }, transaction);

        if (held) {
          await captureQuarantineSafely(db, {
            organizationId,
            sourceSystem: 'wms_mkt',
            assetEntityId: val(lot, 'assetEntityId') || `lot:${val(lot, 'lotCode')}`,
            metricName: 'mkt_celsius',
            numericValue: mktResult.mktCelsius,
            unit: 'CEL',
            reasonCode: 'MKT_THRESHOLD_EXCEEDED',
            severity: 'high',
            rawPayload: { lotCode: val(lot, 'lotCode'), sku: val(lot, 'sku'), thresholdCelsius, mktResult, holdReason: reason },
            actor,
            transaction,
          });
          await appendAuditLedger(db, {
            organizationId,
            eventType: 'wms.lot_mkt_hold',
            targetCollection: 'latticeStockLots',
            targetRecordId: String(val(updated, 'id') ?? val(lot, 'lotCode')),
            actor,
            payload: { lotCode: val(lot, 'lotCode'), mktCelsius: mktResult.mktCelsius, thresholdCelsius, holdReason: reason },
            transaction,
            scope: 'dxos:wms',
            foundation,
          });
        }

        return {
          held,
          lotCode: val(lot, 'lotCode'),
          mktCelsius: mktResult.mktCelsius,
          thresholdCelsius,
          lotStatus: val(updated, 'status') || (held ? 'hold_mkt' : 'available'),
          mktDetails: mktResult,
        };
      }, { organizationId, foundation }), foundation);

      if (result?.held) {
        const { emitDomainEventSafely } = require('./domain-events');
        await emitDomainEventSafely(db, ctx, {
          organizationId,
          type: 'lot.held_mkt',
          source: 'dxos-studio:wms',
          subject: result.lotCode || '',
          data: {
            lotCode: result.lotCode,
            mktCelsius: result.mktCelsius,
            thresholdCelsius: result.thresholdCelsius,
            lotStatus: result.lotStatus,
            severity: 'high',
          },
        });
      }

      ctx.body = result;
      return next();
    },

    epodCapture: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeEpodRecords'],
        aclAction: 'update',
        patScopes: ['write', 'wms'],
      }, foundation);

      const recipientName = typeof params.recipientName === 'string' ? params.recipientName.trim().slice(0, 128) : '';
      if (!recipientName) throw fail('EPOD_RECIPIENT_REQUIRED', 400, 'Cần tên người nhận hàng.');

      const deliveredQty = params.deliveredQty !== undefined ? parseFinite(params.deliveredQty) : 0;
      if (deliveredQty === null || deliveredQty < 0) throw fail('EPOD_QTY_INVALID', 400, 'deliveredQty phải >= 0.');

      const gpsLat = parseFinite(params.gpsLat ?? params.lat);
      const gpsLng = parseFinite(params.gpsLng ?? params.lng);
      if (gpsLat === null || gpsLat < -90 || gpsLat > 90 || gpsLng === null || gpsLng < -180 || gpsLng > 180) {
        throw fail('EPOD_GPS_INVALID', 400, 'Tọa độ GPS (lat in [-90,90], lng in [-180,180]) không hợp lệ.');
      }
      const gpsAccuracyM = params.gpsAccuracyM != null ? parseFinite(params.gpsAccuracyM) : null;
      if (params.gpsAccuracyM != null && (gpsAccuracyM === null || gpsAccuracyM < 0)) {
        throw fail('EPOD_GPS_INVALID', 400, 'gpsAccuracyM phải >= 0.');
      }

      const signatureDataUrl = typeof params.signatureDataUrl === 'string' ? params.signatureDataUrl.trim() : '';
      if (!signatureDataUrl || signatureDataUrl.length < 4 || Buffer.byteLength(signatureDataUrl, 'utf8') > 256 * 1024) {
        throw fail('EPOD_SIGNATURE_INVALID', 400, 'Chữ ký điện tử ePOD không hợp lệ hoặc vượt quá 256KB.');
      }

      const deliveredAt = parseOptionalDate(params.deliveredAt, 'EPOD_DATE_INVALID') || new Date();
      const recipientPhoneMasked = maskPhone(params.recipientPhone ?? params.recipientPhoneMasked);
      const signatureSha256 = sha256Hex(signatureDataUrl);
      const epodUid = `EPOD-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const trackingCode = `LDX-TRK-${randomBytes(5).toString('hex').toUpperCase()}`;
      const trackingToken = `ldx_trk_${randomBytes(16).toString('hex')}`;
      const trackingTokenHash = sha256Hex(trackingToken);

      const rawTemp = params.tempSummary ?? params.tempSummaryJson;
      const baseTempSummary = rawTemp && typeof rawTemp === 'object' && !Array.isArray(rawTemp)
        ? {
            mktCelsius: parseFinite(rawTemp.mktCelsius),
            inRange: typeof rawTemp.inRange === 'boolean' ? rawTemp.inRange : null,
          }
        : null;
      const rawEvidencePhoto = params.evidencePhotoDataUrl;
      let evidencePhotoDataUrl = null;
      let evidencePhotoSha256 = null;
      if (rawEvidencePhoto !== undefined && rawEvidencePhoto !== null && (typeof rawEvidencePhoto !== 'string' || rawEvidencePhoto.trim() !== '')) {
        if (!isSafeRasterImageDataUrl(rawEvidencePhoto, MAX_EPOD_PHOTO_BYTES)) {
          throw fail('EPOD_PHOTO_INVALID', 400, 'Ảnh minh chứng ePOD phải là ảnh PNG/JPEG/WebP/GIF base64 hợp lệ và tối đa 512KB.');
        }
        evidencePhotoDataUrl = rawEvidencePhoto.trim();
        evidencePhotoSha256 = sha256Hex(evidencePhotoDataUrl);
      }
      const rawHashes = Array.isArray(params.photoHashes ?? params.photoHashesJson)
        ? (params.photoHashes ?? params.photoHashesJson).map((h) => String(h).trim().slice(0, 128)).filter(Boolean)
        : [];
      if (evidencePhotoSha256 && !rawHashes.includes(evidencePhotoSha256)) {
        rawHashes.push(evidencePhotoSha256);
      }
      const photoHashesJson = rawHashes.slice(0, 20);
      const tempSummaryJson = evidencePhotoDataUrl
        ? { ...(baseTempSummary || {}), evidencePhotoDataUrl, evidencePhotoSha256 }
        : baseTempSummary;

      const epodRepo = db.getRepository?.('latticeEpodRecords');
      if (!epodRepo) throw fail('WMS_REPO_UNAVAILABLE', 503);

      const createdEpod = await runWithOptionalRls(db, organizationId, () => runInTx(db, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const { orderId, orderCode, matchedOrder, ordersRepo } = await resolveOrderRef(db, organizationId, params, {
          requireOrder: false,
          lookupByCode: true,
          transaction,
        });

        const ledgerEntry = await appendAuditLedger(db, {
          organizationId,
          eventType: 'wms.epod_captured',
          targetCollection: 'latticeEpodRecords',
          targetRecordId: epodUid,
          actor,
          payload: {
            epodUid,
            trackingCode,
            orderId,
            orderCode: orderCode || null,
            deliveredQty,
            signatureSha256,
            ...(evidencePhotoSha256 ? { evidencePhotoSha256 } : {}),
            gpsLat,
            gpsLng,
            deliveredAt: deliveredAt.toISOString(),
          },
          transaction,
          scope: 'dxos:epod',
          foundation,
        });

        const row = await epodRepo.create({
          values: {
            organizationId,
            epodUid,
            trackingCode,
            trackingTokenHash,
            orderId,
            orderCode: orderCode || null,
            driverUserId: actor.userId ? Number(actor.userId) : null,
            driverEmployeeId: actor.employeeId != null ? Number(actor.employeeId) : null,
            recipientName,
            recipientPhoneMasked,
            deliveredQty,
            signatureDataUrl,
            signatureSha256,
            gpsLat,
            gpsLng,
            gpsAccuracyM,
            photoHashesJson,
            tempSummaryJson,
            ledgerSeq: ledgerEntry?.seq ?? null,
            ledgerSignatureBase64: ledgerEntry?.signatureBase64 ?? null,
            keyId: ledgerEntry?.keyId ?? null,
            status: 'delivered',
            deliveredAt,
            notes: typeof params.notes === 'string' ? params.notes.trim().slice(0, 500) : null,
          },
          ...txOpt,
        });

        if (matchedOrder && ordersRepo) {
          await saveRow(ordersRepo, matchedOrder, { status: 'completed' }, { organizationId }, transaction);
        }
        const lineRepo = db.getRepository?.('latticeOrderLines');
        if (lineRepo && (orderId != null || orderCode)) {
          const lineFilter = orderId != null
            ? { organizationId, orderId }
            : { organizationId, orderCode };
          const matchingLines = (await lineRepo.find({ filter: lineFilter, limit: 200, ...txOpt })) || [];
          for (const ln of matchingLines) {
            if (val(ln, 'organizationId') === organizationId) {
              await saveRow(lineRepo, ln, { status: 'delivered' }, { organizationId }, transaction);
            }
          }
        }

        await recordLineageSafely(db, {
          organizationId,
          sourceCollection: matchedOrder ? 'latticeOrders' : 'latticeOrderLines',
          sourceRecordId: String(orderId || orderCode || epodUid),
          targetCollection: 'latticeEpodRecords',
          targetRecordId: String(val(row, 'id') ?? epodUid),
          relationType: 'delivered_by',
          actorName: actor.username,
          metadataJson: { epodUid, trackingCode, signatureSha256 },
          transaction,
        });

        return serializeEpod(row);
      }, { organizationId, foundation }), foundation);

      const { emitDomainEventSafely } = require('./domain-events');
      await emitDomainEventSafely(db, ctx, {
        organizationId,
        type: 'epod.captured',
        source: 'dxos-studio:wms',
        subject: createdEpod?.epodUid || trackingCode || '',
        data: {
          epodUid: createdEpod?.epodUid,
          trackingCode,
          orderId: createdEpod?.orderId,
          orderCode: createdEpod?.orderCode,
          recipientName: createdEpod?.recipientName,
          deliveredQty: createdEpod?.deliveredQty,
          signatureSha256: createdEpod?.signatureSha256,
          ledgerSeq: createdEpod?.ledgerSeq,
          keyId: createdEpod?.keyId,
          deliveredAt: createdEpod?.deliveredAt,
        },
      });

      ctx.body = { epod: createdEpod, trackingCode, trackingToken };
      return next();
    },

    publicTrack: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const rawCode = [params.trackingCode, params.code, params.filterByTk]
        .find((v) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v)));
      const trackingCode = rawCode !== undefined ? String(rawCode).trim() : '';
      const rawToken = params.token ?? params.trackingToken;
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';
      const providedHash = sha256Hex(token || 'missing');

      if (!trackingCode || !token) {
        timingSafeEqualHex(DUMMY_HASH_HEX, providedHash);
        throw fail('TRACKING_UNAUTHORIZED', 401, 'Mã vận đơn hoặc mã xác thực theo dõi không hợp lệ.');
      }

      const { row, validToken, ledgerEntry, pkiKeyRow } = await loadPublicTrackRecord(db, trackingCode, providedHash);
      if (!validToken) {
        throw fail('TRACKING_UNAUTHORIZED', 401, 'Mã vận đơn hoặc mã xác thực theo dõi không hợp lệ.');
      }

      const deliveredRaw = val(row, 'deliveredAt');
      const deliveredAt = deliveredRaw instanceof Date ? deliveredRaw.toISOString() : String(deliveredRaw || '');
      const tempRaw = val(row, 'tempSummaryJson');
      const sigSummary = verifyEpodLedgerSignature({ epodRow: row, ledgerEntry, pkiKeyRow });
      ctx.body = {
        trackingCode: val(row, 'trackingCode'),
        status: val(row, 'status') || 'delivered',
        deliveredAt,
        orderCode: val(row, 'orderCode') || null,
        tempSummary: {
          mktCelsius: parseFinite(tempRaw?.mktCelsius),
          inRange: typeof tempRaw?.inRange === 'boolean' ? tempRaw.inRange : null,
        },
        ledgerVerification: {
          seq: sigSummary.seq,
          keyId: sigSummary.keyId,
          verifiedFormat: Boolean(val(row, 'ledgerSeq') != null && val(row, 'keyId') && (val(row, 'ledgerSignatureBase64') || val(ledgerEntry, 'signatureBase64'))),
          verified: sigSummary.verified,
          merkleRoot: sigSummary.merkleRoot,
        },
      };
      return next();
    },

    verifyTrackSignature: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const rawCode = [params.trackingCode, params.code, params.filterByTk]
        .find((v) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v)));
      const trackingCode = rawCode !== undefined ? String(rawCode).trim() : '';
      const rawToken = params.token ?? params.trackingToken;
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';
      const providedHash = sha256Hex(token || 'missing');

      if (!trackingCode || !token) {
        timingSafeEqualHex(DUMMY_HASH_HEX, providedHash);
        throw fail('TRACKING_UNAUTHORIZED', 401, 'Mã vận đơn hoặc mã xác thực theo dõi không hợp lệ.');
      }

      const { row, validToken, ledgerEntry, pkiKeyRow } = await loadPublicTrackRecord(db, trackingCode, providedHash);
      if (!validToken) {
        throw fail('TRACKING_UNAUTHORIZED', 401, 'Mã vận đơn hoặc mã xác thực theo dõi không hợp lệ.');
      }

      const sigSummary = verifyEpodLedgerSignature({ epodRow: row, ledgerEntry, pkiKeyRow });
      ctx.body = {
        verified: sigSummary.verified,
        seq: sigSummary.seq,
        ledgerSeq: sigSummary.seq,
        entryHash: sigSummary.entryHash,
        keyId: sigSummary.keyId,
        publicKeyFingerprint: sigSummary.publicKeyFingerprint,
        reason: sigSummary.reason,
        verifiedAt: new Date().toISOString(),
      };
      return next();
    },

    printVoucher: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: ['latticeOrders', 'latticeOrderLines', 'latticeEpodRecords'],
        aclAction: 'view',
        patScopes: ['read', 'write', 'wms'],
      }, foundation);

      const documentType = String(params.documentType || '').trim();
      if (!['order', 'delivery_note', 'epod'].includes(documentType)) {
        throw fail('PRINT_DOCUMENT_TYPE_INVALID', 400, 'documentType phải là order, delivery_note hoặc epod.');
      }

      const orderId = params.orderId != null && /^[1-9]\d*$/.test(String(params.orderId)) ? Number(params.orderId) : null;
      let orderCode = typeof params.orderCode === 'string' ? params.orderCode.trim() : '';
      const epodUid = typeof params.epodUid === 'string' ? params.epodUid.trim() : '';
      if (orderId == null && !orderCode && !epodUid) {
        throw fail('PRINT_TARGET_REQUIRED', 400, 'Cần orderId, orderCode hoặc epodUid.');
      }

      const voucherData = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const ordersRepo = db.getRepository?.('latticeOrders');
        const lineRepo = db.getRepository?.('latticeOrderLines');
        const epodRepo = db.getRepository?.('latticeEpodRecords');

        let epod = null;
        if (epodRepo?.findOne) {
          if (epodUid) epod = await epodRepo.findOne({ filter: { organizationId, epodUid }, ...txOpt });
          else if (orderId != null) epod = await epodRepo.findOne({ filter: { organizationId, orderId }, ...txOpt });
          else if (orderCode) epod = await epodRepo.findOne({ filter: { organizationId, orderCode }, ...txOpt });
          if (epod && val(epod, 'organizationId') !== organizationId) epod = null;
        }
        if (!orderCode && epod) orderCode = val(epod, 'orderCode') || '';

        let order = null;
        if (ordersRepo?.findOne) {
          if (orderId != null) order = await ordersRepo.findOne({ filter: { organizationId, id: orderId }, ...txOpt });
          else if (orderCode) order = await ordersRepo.findOne({ filter: { organizationId, code: orderCode }, ...txOpt });
          else if (val(epod, 'orderId') != null) order = await ordersRepo.findOne({ filter: { organizationId, id: val(epod, 'orderId') }, ...txOpt });
          if (order && val(order, 'organizationId') !== organizationId) order = null;
        }
        if (!orderCode && order) orderCode = val(order, 'code') || '';

        let orderLines = [];
        if (lineRepo?.find) {
          const lineFilter = orderId != null
            ? { organizationId, orderId }
            : (orderCode ? { organizationId, orderCode } : null);
          if (lineFilter) {
            const rows = (await lineRepo.find({ filter: lineFilter, sort: ['lineNo', 'id'], limit: 200, ...txOpt })) || [];
            orderLines = rows.filter((r) => val(r, 'organizationId') === organizationId);
          }
        }

        if (!order && !orderLines.length && !epod) {
          throw fail('VOUCHER_NOT_FOUND', 404, 'Không tìm thấy chứng từ trong phạm vi tổ chức.');
        }

        let ledgerSeq = val(epod, 'ledgerSeq') ?? null;
        let keyId = val(epod, 'keyId') || null;
        if ((ledgerSeq == null || !keyId) && db.getRepository?.('latticeCryptoLedger')?.find) {
          const targetId = String(val(order, 'id') ?? val(epod, 'epodUid') ?? orderCode);
          const ledgerRows = (await db.getRepository('latticeCryptoLedger').find({
            filter: { organizationId, targetRecordId: targetId },
            sort: ['-seq'],
            limit: 1,
            ...txOpt,
          })) || [];
          if (ledgerRows[0] && val(ledgerRows[0], 'organizationId') === organizationId) {
            ledgerSeq = val(ledgerRows[0], 'seq') ?? ledgerSeq;
            keyId = val(ledgerRows[0], 'keyId') || keyId;
          }
        }

        return { order, orderLines, epod, ledgerSeq, keyId };
      }, foundation);

      const { order, orderLines, epod, ledgerSeq, keyId } = voucherData;
      const trackCodeForQr = val(epod, 'trackingCode') || orderCode || epodUid || String(orderId || 'DOC');
      const qrVerificationHash = sha256Hex(
        val(epod, 'trackingCode') || `${documentType}:${organizationId}:${orderCode || epodUid || orderId}`,
      );
      const passedToken = typeof (params.trackingToken ?? params.token) === 'string'
        ? String(params.trackingToken ?? params.token).trim()
        : '';
      const hasVerifiedToken = Boolean(
        epod
        && passedToken
        && val(epod, 'trackingTokenHash')
        && timingSafeEqualHex(String(val(epod, 'trackingTokenHash')), sha256Hex(passedToken)),
      );
      const qrTrackPath = hasVerifiedToken
        ? `/v/track/${encodeURIComponent(trackCodeForQr)}?token=${encodeURIComponent(passedToken)}`
        : `/v/track/${encodeURIComponent(trackCodeForQr)}?verify=${encodeURIComponent(qrVerificationHash.slice(0, 16))}`;
      const html = buildPrintableVoucherHtml({
        documentType,
        organizationId,
        order,
        orderLines,
        epod,
        ledgerSeq,
        keyId,
        qrVerificationHash,
        qrTrackPath,
      });
      const htmlSha256 = sha256Hex(html);

      ctx.body = { documentType, organizationId, html, htmlSha256, qrVerificationHash, qrTrackPath, ledgerSeq, keyId };
      return next();
    },
  };
}

function createWmsDmnDirectGuardMiddleware(db) {
  return createDirectGuardWithFoundation(db, foundation);
}

module.exports = {
  ORG_ID_RE,
  WMS_DMN_COLLECTIONS,
  fail,
  val,
  toPlain,
  sha256Hex,
  readParams,
  parseFinite,
  parseStrictPositiveInt,
  parseOptionalDate,
  escapeHtml,
  maskPhone,
  assertPatScope,
  hasCollectionPermission,
  isOrgAdmin,
  resolveTenantActor,
  appendAuditLedger,
  computeMeanKineticTemperature,
  stripEpodSecretsFromBody,
  createDxosWmsActions,
  createWmsDmnDirectGuardMiddleware,
  validateTenantCollectionRecord,
};

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
  isSafeAppPath,
  fetchCollectionsMeta,
  inferCollectionFieldsMeta,
} = require('./blocks-helpers');

const SVG_WIDTH = 640;
const SVG_HEIGHT = 360;
const SVG_PAD = 24;
const MAPLIBRE_CSS_ID = 'dxos-maplibre-css';
const HITL_DELTA_THRESHOLD_C = 2.0;
const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_WEBGIS_COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const SAFE_WEBGIS_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
const LIKELY_LAT_FIELD_RE = /^(?:[a-z0-9_]*_)?[lL]at(?:$|_|[A-Z0-9])|^[a-z][a-z0-9]*Lat(?:$|_|[A-Z0-9])|latitude|LATITUDE/;
const LIKELY_LNG_FIELD_RE = /^(?:[a-z0-9_]*_)?[lL](?:ng|on)(?:$|_|[A-Z0-9])|^[a-z][a-z0-9]*L(?:ng|on)(?:$|_|[A-Z0-9])|longitude|LONGITUDE/;

const DEFAULT_VIETNAM_BOUNDS = {
  minLat: 8.0,
  maxLat: 23.8,
  minLng: 102.0,
  maxLng: 110.2,
};

const TWIN_STATUS_LABELS = {
  synced: { label: 'synced', bg: '#d1fae5', color: '#065f46', border: '#6ee7b7' },
  pending_hitl: { label: 'pending_hitl', bg: '#fef3c7', color: '#92400e', border: '#fcd34d' },
  dispatched: { label: 'dispatched', bg: '#dbeafe', color: '#1d4ed8', border: '#93c5fd' },
  acked: { label: 'acked', bg: '#e0e7ff', color: '#3730a3', border: '#a5b4fc' },
  failed: { label: 'failed', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' },
};

const DEFAULT_VIETNAM_GEO_MARKERS = [
  {
    id: 'hub-can-tho',
    code: 'HUB-CT',
    name: 'Kho lạnh Trung tâm ĐBSCL (Cần Thơ)',
    kind: 'warehouse',
    lat: 10.0452,
    lng: 105.7469,
    temperatureC: -18.2,
    targetTempC: -18.0,
    twinStatus: 'synced',
    status: 'active',
  },
  {
    id: 'hub-hcm',
    code: 'HUB-HCM',
    name: 'Trung tâm Phân phối Lạnh TP.HCM (Cát Lái)',
    kind: 'warehouse',
    lat: 10.7769,
    lng: 106.7009,
    temperatureC: 4.1,
    targetTempC: 4.0,
    twinStatus: 'acked',
    status: 'active',
  },
  {
    id: 'hub-da-nang',
    code: 'HUB-DN',
    name: 'Trạm Trung chuyển Miền Trung (Đà Nẵng)',
    kind: 'warehouse',
    lat: 16.0544,
    lng: 108.2022,
    temperatureC: 4.4,
    targetTempC: 4.0,
    twinStatus: 'dispatched',
    status: 'active',
  },
  {
    id: 'hub-ha-noi',
    code: 'HUB-HN',
    name: 'Kho lạnh Miền Bắc (Hà Nội)',
    kind: 'warehouse',
    lat: 21.0278,
    lng: 105.8342,
    temperatureC: -19.8,
    targetTempC: -20.0,
    twinStatus: 'synced',
    status: 'active',
  },
];

const VIETNAM_CITY_COORDS = [
  { keys: ['can tho', 'cần thơ', 'dbscl', 'đbscl', 'mekong', 'ninh kieu', 'ninh kiều'], lat: 10.0452, lng: 105.7469 },
  { keys: ['hcm', 'ho chi minh', 'hồ chí minh', 'sai gon', 'sài gòn', 'cat lai', 'cát lái', 'thu duc'], lat: 10.7769, lng: 106.7009 },
  { keys: ['da nang', 'đà nẵng', 'mien trung', 'miền trung'], lat: 16.0544, lng: 108.2022 },
  { keys: ['ha noi', 'hà nội', 'noi bai', 'nội bài', 'mien bac', 'miền bắc'], lat: 21.0278, lng: 105.8342 },
  { keys: ['hai phong', 'hải phòng'], lat: 20.8449, lng: 106.6881 },
  { keys: ['nha trang', 'khanh hoa', 'khánh hòa'], lat: 12.2388, lng: 109.1967 },
];

// Simplified WGS84 mainland reference polygon for Vietnam offline vector fallback
const VIETNAM_OFFLINE_OUTLINE_COORDS = [
  [105.0, 8.6],
  [104.5, 10.4],
  [106.2, 10.9],
  [107.6, 11.2],
  [109.2, 12.2],
  [109.3, 13.8],
  [108.4, 15.9],
  [107.6, 16.8],
  [106.6, 17.5],
  [105.7, 19.8],
  [107.1, 21.5],
  [105.3, 22.8],
  [102.9, 22.4],
  [103.5, 20.5],
  [104.7, 18.6],
  [106.1, 16.5],
  [107.5, 14.3],
  [106.6, 11.7],
  [105.1, 10.1],
  [105.0, 8.6],
];

let cachedWorkerBlobUrl = null;

function parseFiniteGeo(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeBounds(bounds) {
  if (Array.isArray(bounds) && bounds.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = bounds.map(Number);
    if ([minLat, maxLat, minLng, maxLng].every(Number.isFinite) && maxLat > minLat && maxLng > minLng) {
      return { minLat, maxLat, minLng, maxLng };
    }
  }
  if (bounds && typeof bounds === 'object') {
    const minLat = Number(bounds.minLat);
    const maxLat = Number(bounds.maxLat);
    const minLng = Number(bounds.minLng);
    const maxLng = Number(bounds.maxLng);
    if ([minLat, maxLat, minLng, maxLng].every(Number.isFinite) && maxLat > minLat && maxLng > minLng) {
      return { minLat, maxLat, minLng, maxLng };
    }
  }
  return DEFAULT_VIETNAM_BOUNDS;
}

function projectGeoPoint(lat, lng, bounds) {
  const numLat = parseFiniteGeo(lat);
  const numLng = parseFiniteGeo(lng);
  if (numLat === null || numLng === null) return null;
  if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) return null;

  const b = normalizeBounds(bounds);
  const clampedLat = Math.max(b.minLat, Math.min(b.maxLat, numLat));
  const clampedLng = Math.max(b.minLng, Math.min(b.maxLng, numLng));
  const clamped = clampedLat !== numLat || clampedLng !== numLng;

  const normX = (clampedLng - b.minLng) / (b.maxLng - b.minLng);
  const normY = 1 - (clampedLat - b.minLat) / (b.maxLat - b.minLat);
  const x = Number((SVG_PAD + normX * (SVG_WIDTH - SVG_PAD * 2)).toFixed(1));
  const y = Number((SVG_PAD + normY * (SVG_HEIGHT - SVG_PAD * 2)).toFixed(1));

  return { x, y, lat: numLat, lng: numLng, clampedLat, clampedLng, clamped };
}

function classifyColdChainMarker(point = {}) {
  const severity = String(point.severity || '').trim().toLowerCase();
  const status = String(point.status || '').trim().toLowerCase();
  const rawTwin = String(point.commandStatus || point.twinStatus || 'synced').trim().toLowerCase();
  const twinStatus = Object.hasOwn(TWIN_STATUS_LABELS, rawTwin) ? rawTwin : 'synced';

  const tempVal = parseFiniteGeo(point.temperatureC ?? point.temperature ?? point.mktCelsius);
  const targetVal = parseFiniteGeo(point.targetTempC ?? point.setpointC);
  const maxVal = parseFiniteGeo(point.maxTempC);

  const tempBreachCritical = (
    (tempVal !== null && maxVal !== null && tempVal > maxVal + 2)
    || (tempVal !== null && targetVal !== null && Math.abs(tempVal - targetVal) > 4)
  );
  const tempBreachWarn = (
    (tempVal !== null && maxVal !== null && tempVal > maxVal)
    || (tempVal !== null && targetVal !== null && Math.abs(tempVal - targetVal) > 2)
  );

  let level = 'normal';
  if (
    severity === 'critical'
    || severity === 'high'
    || point.hasCriticalAlarm === true
    || status === 'critical'
    || status === 'failed'
    || twinStatus === 'failed'
    || tempBreachCritical
  ) {
    level = 'critical';
  } else if (
    severity === 'warning'
    || severity === 'medium'
    || point.hasWarningAlarm === true
    || status === 'warning'
    || status === 'hold_mkt'
    || status === 'alarm'
    || status === 'breached'
    || twinStatus === 'pending_hitl'
    || tempBreachWarn
  ) {
    level = 'warning';
  }

  const palette = level === 'critical'
    ? { color: '#dc2626', bg: '#fee2e2', border: '#fca5a5', label: 'Nguy cấp' }
    : level === 'warning'
      ? { color: '#d97706', bg: '#fef3c7', border: '#fcd34d', label: 'Cảnh báo / MKT Hold' }
      : { color: '#059669', bg: '#d1fae5', border: '#6ee7b7', label: 'Ổn định' };

  const tempText = tempVal !== null ? `${tempVal.toFixed(1)}°C` : '—';
  const targetText = targetVal !== null ? `${targetVal.toFixed(1)}°C` : '—';

  return {
    ...palette,
    level,
    twinStatus,
    twinMeta: TWIN_STATUS_LABELS[twinStatus],
    temperatureC: tempVal,
    targetTempC: targetVal,
    tempSummary: tempVal !== null || targetVal !== null
      ? `${tempText} / mục tiêu ${targetText}`
      : 'Chưa có dữ liệu cảm biến',
  };
}

function inferCoordsForRecord(record, locationById, index) {
  const directLat = parseFiniteGeo(record?.lat ?? record?.latitude);
  const directLng = parseFiniteGeo(record?.lng ?? record?.lon ?? record?.longitude);
  if (directLat !== null && directLng !== null && projectGeoPoint(directLat, directLng)) {
    return { lat: directLat, lng: directLng };
  }
  const loc = record?.locationId ? locationById.get(Number(record.locationId)) : null;
  const locLat = parseFiniteGeo(loc?.lat ?? loc?.latitude);
  const locLng = parseFiniteGeo(loc?.lng ?? loc?.lon ?? loc?.longitude);
  if (locLat !== null && locLng !== null && projectGeoPoint(locLat, locLng)) {
    return { lat: locLat, lng: locLng };
  }

  const haystack = `${record?.code || ''} ${record?.name || ''} ${record?.address || ''} ${loc?.name || ''} ${loc?.address || ''}`.toLowerCase();
  const safeIdx = Math.max(0, Number(index) || 0);
  for (const city of VIETNAM_CITY_COORDS) {
    if (city.keys.some((k) => haystack.includes(k))) {
      const ring = Math.floor(safeIdx / 4);
      const angle = (safeIdx % 4) * (Math.PI / 2) + ring * 0.55;
      const radius = 0.14 + ring * 0.14;
      return {
        lat: Number((city.lat + Math.sin(angle) * radius * 1.6).toFixed(4)),
        lng: Number((city.lng + Math.cos(angle) * radius).toFixed(4)),
      };
    }
  }
  const fallback = DEFAULT_VIETNAM_GEO_MARKERS[index % DEFAULT_VIETNAM_GEO_MARKERS.length];
  const spread = Math.floor(index / DEFAULT_VIETNAM_GEO_MARKERS.length) * 0.35;
  return {
    lat: Number((fallback.lat + spread * 0.5).toFixed(4)),
    lng: Number((fallback.lng + spread * 0.4).toFixed(4)),
  };
}

function normalizeWebGisCollection(raw) {
  const clean = String(raw ?? '').trim();
  if (!clean || BLOCKED_PROTO_KEYS.has(clean)) return '';
  return SAFE_WEBGIS_COLLECTION_RE.test(clean) ? clean : '';
}

function normalizeWebGisFieldName(raw) {
  const clean = String(raw ?? '').trim();
  if (!clean || BLOCKED_PROTO_KEYS.has(clean)) return '';
  return SAFE_WEBGIS_FIELD_RE.test(clean) ? clean : '';
}

function safeReadOwnField(record, fieldName) {
  if (!record || typeof record !== 'object') return undefined;
  const clean = normalizeWebGisFieldName(fieldName);
  if (!clean || !Object.hasOwn(record, clean)) return undefined;
  return record[clean];
}

function pickFirstOwnField(record, candidates) {
  for (const key of candidates) {
    const val = safeReadOwnField(record, key);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function buildCustomCollectionMarkers(records = [], collectionMeta = null, options = {}) {
  const inferred = inferCollectionFieldsMeta(collectionMeta);
  const explicitLatField = normalizeWebGisFieldName(options.latField);
  const explicitLngField = normalizeWebGisFieldName(options.lngField);
  const explicitLabelField = normalizeWebGisFieldName(options.labelField);
  const explicitStatusField = normalizeWebGisFieldName(options.statusField);

  const inferredLat = normalizeWebGisFieldName(inferred.latField);
  const inferredLng = normalizeWebGisFieldName(inferred.lngField);
  const safeInferredLat = inferredLat && LIKELY_LAT_FIELD_RE.test(inferredLat) ? inferredLat : '';
  const safeInferredLng = inferredLng && LIKELY_LNG_FIELD_RE.test(inferredLng) ? inferredLng : '';

  const effectiveLatField = explicitLatField || safeInferredLat;
  const effectiveLngField = explicitLngField || safeInferredLng;
  const effectiveLabelField = explicitLabelField || normalizeWebGisFieldName(inferred.titleField) || '';
  const effectiveStatusField = explicitStatusField || normalizeWebGisFieldName(inferred.statusField) || 'status';

  const markers = [];
  const rows = Array.isArray(records) ? records : [];
  rows.forEach((rec, idx) => {
    if (!rec || typeof rec !== 'object') return;
    const rawLat = explicitLatField
      ? safeReadOwnField(rec, explicitLatField)
      : effectiveLatField
        ? safeReadOwnField(rec, effectiveLatField)
        : pickFirstOwnField(rec, ['lat', 'latitude', 'geoLat', 'geo_lat']);
    const rawLng = explicitLngField
      ? safeReadOwnField(rec, explicitLngField)
      : effectiveLngField
        ? safeReadOwnField(rec, effectiveLngField)
        : pickFirstOwnField(rec, ['lng', 'lon', 'longitude', 'geoLng', 'geo_lng']);

    const pt = projectGeoPoint(rawLat, rawLng);
    if (!pt) return;

    const labelVal = effectiveLabelField ? safeReadOwnField(rec, effectiveLabelField) : undefined;
    const fallbackName = pickFirstOwnField(rec, ['name', 'title', 'subject', 'label', 'code', 'lotCode']);
    const name = String(
      (labelVal !== undefined && labelVal !== null && String(labelVal).trim() !== '' ? labelVal : fallbackName)
      ?? `#${rec.id ?? idx}`,
    ).trim();
    const rawCode = pickFirstOwnField(rec, ['code', 'lotCode']);
    const code = String(
      (rawCode !== undefined && rawCode !== null && String(rawCode).trim() !== '' ? rawCode : name)
      || `#${rec.id ?? idx}`,
    ).trim();
    const rawStatus = safeReadOwnField(rec, effectiveStatusField) ?? safeReadOwnField(rec, 'status');
    const status = rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== ''
      ? String(rawStatus).trim()
      : 'active';
    const rawSeverity = safeReadOwnField(rec, 'severity');
    const rawAssetId = safeReadOwnField(rec, 'assetId');

    markers.push({
      id: `custom-${rec.id ?? idx}`,
      recordId: rec.id ?? null,
      assetId: rawAssetId !== undefined && rawAssetId !== null ? rawAssetId : null,
      isCustom: true,
      collection: String(options.collection || ''),
      organizationId: String(options.orgId || safeReadOwnField(rec, 'organizationId') || '').trim(),
      code,
      name,
      kind: 'custom',
      address: String(safeReadOwnField(rec, 'address') ?? ''),
      lat: pt.lat,
      lng: pt.lng,
      severity: rawSeverity !== undefined && rawSeverity !== null ? String(rawSeverity).trim() : '',
      status,
      temperatureC: parseFiniteGeo(safeReadOwnField(rec, 'temperatureC')),
      targetTempC: parseFiniteGeo(safeReadOwnField(rec, 'targetTempC')),
      twinStatus: 'synced',
      alarmCount: 0,
    });
  });

  return markers;
}

function buildMarkersGeoJson(markers = []) {
  const features = [];
  for (const raw of Array.isArray(markers) ? markers : []) {
    if (!raw || typeof raw !== 'object') continue;
    const pt = projectGeoPoint(raw.lat, raw.lng);
    if (!pt) continue;
    const meta = raw.meta || classifyColdChainMarker(raw);
    features.push({
      type: 'Feature',
      id: String(raw.id || raw.code || features.length),
      geometry: {
        type: 'Point',
        coordinates: [pt.lng, pt.lat],
      },
      properties: {
        id: String(raw.id || raw.code || features.length),
        assetId: raw.assetId ?? null,
        assetEntityId: raw.assetEntityId || '',
        organizationId: raw.organizationId || '',
        code: String(raw.code || ''),
        name: String(raw.name || ''),
        kind: String(raw.kind || 'asset'),
        address: String(raw.address || ''),
        level: meta.level,
        color: meta.color,
        twinStatus: meta.twinStatus,
        temperatureC: meta.temperatureC,
        targetTempC: meta.targetTempC,
        alarmCount: Number(raw.alarmCount || 0),
        latestAlarm: String(raw.latestAlarm || ''),
        status: String(raw.status || 'active'),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function buildCorridorsGeoJson(markers = [], defaultMarkers = DEFAULT_VIETNAM_GEO_MARKERS) {
  const features = [];
  const backboneCoords = (Array.isArray(defaultMarkers) ? defaultMarkers : DEFAULT_VIETNAM_GEO_MARKERS)
    .map((m) => projectGeoPoint(m.lat, m.lng))
    .filter(Boolean)
    .map((pt) => [pt.lng, pt.lat]);

  if (backboneCoords.length >= 2) {
    features.push({
      type: 'Feature',
      id: 'corridor-vietnam-backbone',
      geometry: {
        type: 'LineString',
        coordinates: backboneCoords,
      },
      properties: {
        id: 'corridor-vietnam-backbone',
        name: 'Hành lang Chuỗi lạnh ĐBSCL – TP.HCM – Đà Nẵng – Hà Nội',
        corridorType: 'backbone',
      },
    });
  }

  const validMarkers = (Array.isArray(markers) ? markers : [])
    .map((m) => ({ m, pt: projectGeoPoint(m?.lat, m?.lng) }))
    .filter((entry) => Boolean(entry.pt))
    .sort((a, b) => a.pt.lat - b.pt.lat);

  if (validMarkers.length >= 2) {
    features.push({
      type: 'Feature',
      id: 'corridor-active-coldchain',
      geometry: {
        type: 'LineString',
        coordinates: validMarkers.map((entry) => [entry.pt.lng, entry.pt.lat]),
      },
      properties: {
        id: 'corridor-active-coldchain',
        name: 'Tuyến tài sản chuỗi lạnh đang hoạt động',
        corridorType: 'active',
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

function buildOfflineWgs84VectorStyle({ centerLng = 106.5, centerLat = 15.8, zoom = 5.2 } = {}) {
  const graticuleFeatures = [];
  for (let lat = 8; lat <= 24; lat += 2) {
    graticuleFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[100, lat], [112, lat]] },
      properties: { axis: 'lat', value: lat },
    });
  }
  for (let lng = 102; lng <= 110; lng += 2) {
    graticuleFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[lng, 6], [lng, 25]] },
      properties: { axis: 'lng', value: lng },
    });
  }

  const landFeatures = [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [VIETNAM_OFFLINE_OUTLINE_COORDS],
      },
      properties: { region: 'vietnam-wgs84-corridor' },
    },
  ];

  return {
    version: 8,
    name: 'latticedx-offline-wgs84',
    center: [Number(centerLng) || 106.5, Number(centerLat) || 15.8],
    zoom: Number(zoom) || 5.2,
    sources: {
      'offline-wgs84-graticule': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: graticuleFeatures },
      },
      'offline-wgs84-land': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: landFeatures },
      },
    },
    layers: [
      {
        id: 'offline-wgs84-bg',
        type: 'background',
        paint: { 'background-color': '#0f172a' },
      },
      {
        id: 'offline-wgs84-land-fill',
        type: 'fill',
        source: 'offline-wgs84-land',
        paint: { 'fill-color': '#172554', 'fill-opacity': 0.85 },
      },
      {
        id: 'offline-wgs84-land-outline',
        type: 'line',
        source: 'offline-wgs84-land',
        paint: { 'line-color': '#38bdf8', 'line-width': 1.2, 'line-opacity': 0.45 },
      },
      {
        id: 'offline-wgs84-graticule-line',
        type: 'line',
        source: 'offline-wgs84-graticule',
        paint: { 'line-color': '#334155', 'line-width': 0.8, 'line-dasharray': [2, 3] },
      },
    ],
  };
}

function buildOnlineOrHybridStyle({ tileUrlTemplate = '', centerLng = 106.5, centerLat = 15.8, zoom = 5.2 } = {}) {
  const baseStyle = buildOfflineWgs84VectorStyle({ centerLng, centerLat, zoom });
  const tpl = typeof tileUrlTemplate === 'string' ? tileUrlTemplate.trim() : '';
  if (!tpl || !/^https?:\/\//i.test(tpl)) {
    return baseStyle;
  }
  return {
    ...baseStyle,
    name: 'latticedx-hybrid-wgs84',
    sources: {
      ...baseStyle.sources,
      'osm-raster': {
        type: 'raster',
        tiles: [tpl],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      ...baseStyle.layers,
      {
        id: 'osm-raster-layer',
        type: 'raster',
        source: 'osm-raster',
        paint: { 'raster-opacity': 0.72 },
      },
    ],
  };
}

function canBrowserUseWebGL() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

function resolveMapLibre(liveConfig) {
  if (liveConfig?.maplibreOverride) return liveConfig.maplibreOverride;
  if (typeof globalThis !== 'undefined' && globalThis.__DXOS_TEST_MAPLIBRE__) {
    return globalThis.__DXOS_TEST_MAPLIBRE__;
  }
  if (!canBrowserUseWebGL()) return null;
  if (typeof globalThis !== 'undefined' && globalThis.__DXOS_MAPLIBRE_BUNDLE__?.maplibre?.Map) {
    return globalThis.__DXOS_MAPLIBRE_BUNDLE__.maplibre;
  }
  if (typeof globalThis !== 'undefined' && globalThis.maplibregl?.Map) {
    return globalThis.maplibregl;
  }
  return null;
}

function injectMapLibreCss() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return false;
  if (document.getElementById(MAPLIBRE_CSS_ID)) return true;
  const cssText = typeof globalThis !== 'undefined' ? globalThis.__DXOS_MAPLIBRE_BUNDLE__?.cssText : '';
  if (!cssText) return false;
  const target = document.head || document.documentElement || document.body;
  if (!target || typeof document.createElement !== 'function' || typeof target.appendChild !== 'function') return false;
  const el = document.createElement('style');
  el.id = MAPLIBRE_CSS_ID;
  el.textContent = cssText;
  target.appendChild(el);
  return true;
}

function ensureMapLibreWorker(maplibre) {
  if (!maplibre || typeof maplibre.setWorkerUrl !== 'function') return;
  if (cachedWorkerBlobUrl) {
    maplibre.setWorkerUrl(cachedWorkerBlobUrl);
    return;
  }
  const workerText = typeof globalThis !== 'undefined' ? globalThis.__DXOS_MAPLIBRE_BUNDLE__?.workerText : '';
  if (!workerText || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  try {
    cachedWorkerBlobUrl = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
    maplibre.setWorkerUrl(cachedWorkerBlobUrl);
  } catch {
    // Worker URL optional fallback
  }
}

function syncMapLibreLayers(map, markersGeoJson, corridorsGeoJson, selectedId) {
  if (!map) return;
  const corridorSource = map.getSource?.('dxos-corridors');
  if (corridorSource && typeof corridorSource.setData === 'function') {
    corridorSource.setData(corridorsGeoJson);
  } else if (typeof map.addSource === 'function') {
    map.addSource('dxos-corridors', { type: 'geojson', data: corridorsGeoJson });
  }
  if (!map.getLayer?.('dxos-corridors-line') && typeof map.addLayer === 'function') {
    map.addLayer({
      id: 'dxos-corridors-line',
      type: 'line',
      source: 'dxos-corridors',
      paint: {
        'line-color': '#38bdf8',
        'line-width': 2.5,
        'line-opacity': 0.72,
        'line-dasharray': [2, 2],
      },
    });
  }

  const assetsSource = map.getSource?.('dxos-assets');
  if (assetsSource && typeof assetsSource.setData === 'function') {
    assetsSource.setData(markersGeoJson);
  } else if (typeof map.addSource === 'function') {
    map.addSource('dxos-assets', {
      type: 'geojson',
      data: markersGeoJson,
      cluster: true,
      clusterMaxZoom: 12,
      clusterRadius: 48,
    });
  }

  if (!map.getLayer?.('dxos-clusters') && typeof map.addLayer === 'function') {
    map.addLayer({
      id: 'dxos-clusters',
      type: 'circle',
      source: 'dxos-assets',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#0284c7', 10, '#d97706', 25, '#dc2626'],
        'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 25, 28],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });
  }
  if (!map.getLayer?.('dxos-cluster-count') && typeof map.addLayer === 'function') {
    map.addLayer({
      id: 'dxos-cluster-count',
      type: 'symbol',
      source: 'dxos-assets',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 12,
      },
      paint: {
        'text-color': '#ffffff',
      },
    });
  }
  if (!map.getLayer?.('dxos-unclustered-point') && typeof map.addLayer === 'function') {
    map.addLayer({
      id: 'dxos-unclustered-point',
      type: 'circle',
      source: 'dxos-assets',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['coalesce', ['get', 'color'], '#059669'],
        'circle-radius': ['case', ['==', ['get', 'id'], selectedId || ''], 10, 7],
        'circle-stroke-width': ['case', ['==', ['get', 'id'], selectedId || ''], 3, 2],
        'circle-stroke-color': '#ffffff',
      },
    });
  } else if (typeof map.setPaintProperty === 'function') {
    try {
      map.setPaintProperty('dxos-unclustered-point', 'circle-radius', ['case', ['==', ['get', 'id'], selectedId || ''], 10, 7]);
      map.setPaintProperty('dxos-unclustered-point', 'circle-stroke-width', ['case', ['==', ['get', 'id'], selectedId || ''], 3, 2]);
    } catch {
      // Ignore on lightweight mock map instances
    }
  }
}

function safeGo(app, path) {
  if (!isSafeAppPath(path)) return;
  if (app?.router?.navigate) app.router.navigate(path);
  else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(path) || path);
}

function createWebGisBlockView(client, React, _antd, app, { subscribeModelConfig } = {}) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function DxosWebGisBlockView({ model, liveConfig }) {
    const api = useApi();
    const [, setTick] = React.useState(0);
    React.useEffect(
      () => (typeof subscribeModelConfig === 'function' ? subscribeModelConfig(model, () => setTick((t) => t + 1)) : undefined),
      [model],
    );

    const stepCfg = model?.getStepParams?.('dxosBlockSettings', 'config')
      || model?.stepParams?.dxosBlockSettings?.config
      || {};
    const cfg = {
      title: 'Bản đồ Giám sát Chuỗi lạnh WebGIS [D]',
      defaultOrganizationId: '',
      centerLat: 15.8,
      centerLng: 106.5,
      zoom: 5.2,
      tileUrlTemplate: '',
      offlineOnly: false,
      showTwinOverlay: true,
      collection: '',
      latField: '',
      lngField: '',
      labelField: '',
      statusField: '',
      ...(model?.props || {}),
      ...stepCfg,
      ...(liveConfig || {}),
    };

    const customCollection = normalizeWebGisCollection(cfg.collection);
    const explicitLatField = normalizeWebGisFieldName(cfg.latField);
    const explicitLngField = normalizeWebGisFieldName(cfg.lngField);
    const explicitLabelField = normalizeWebGisFieldName(cfg.labelField);
    const explicitStatusField = normalizeWebGisFieldName(cfg.statusField);

    const [filterMode, setFilterMode] = React.useState('all');
    const [selectedId, setSelectedId] = React.useState('');
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const [offlineStyleMode, setOfflineStyleMode] = React.useState(
      () => Boolean(cfg.offlineOnly) || (typeof navigator !== 'undefined' && navigator.onLine === false) || !cfg.tileUrlTemplate,
    );
    const [webglFailed, setWebglFailed] = React.useState(false);
    const [state, setState] = React.useState(() => ({
      loading: Boolean(customCollection && api?.request),
      markers: customCollection ? [] : DEFAULT_VIETNAM_GEO_MARKERS,
      usingFallback: !customCollection,
      totalRecords: 0,
      unmappedReason: customCollection && !api?.request
        ? `Collection ${customCollection} chưa có kết nối API để tải dữ liệu bản đồ.`
        : '',
      error: '',
    }));

    // Twin Control Drawer state
    const [twinForm, setTwinForm] = React.useState({
      targetTempInput: '-18.0',
      defrostMode: 'auto',
      fanMode: 'auto',
      doorLock: 'locked',
    });
    const [twinBusy, setTwinBusy] = React.useState(false);
    const [twinFeedback, setTwinFeedback] = React.useState({ type: '', text: '' });

    const [reqTracker] = React.useState(() => ({
      seq: 0,
      unmounted: false,
      collection: customCollection,
      collectionMeta: cfg.collectionMeta || null,
    }));
    reqTracker.collection = customCollection;
    reqTracker.collectionMeta = cfg.collectionMeta || null;
    const [mapHolder] = React.useState(() => ({
      containerEl: null,
      map: null,
      ready: false,
      offlineSwitched: false,
      latestGeo: { markersGeoJson: buildMarkersGeoJson([]), corridorsGeoJson: buildCorridorsGeoJson([], []), selectedId: '' },
      onSelectMarker: null,
    }));

    React.useEffect(() => {
      reqTracker.unmounted = false;
      return () => {
        reqTracker.unmounted = true;
        reqTracker.seq += 1;
        if (mapHolder.map && typeof mapHolder.map.remove === 'function') {
          try { mapHolder.map.remove(); } catch {}
          mapHolder.map = null;
          mapHolder.ready = false;
        }
      };
    }, [reqTracker, mapHolder]);

    React.useEffect(() => {
      setSelectedId('');
      setDrawerOpen(false);
      setFilterMode('all');
      setTwinFeedback({ type: '', text: '' });
      if (customCollection) {
        setState({
          loading: Boolean(api?.request),
          markers: [],
          usingFallback: false,
          totalRecords: 0,
          unmappedReason: api?.request ? '' : `Collection ${customCollection} chưa có kết nối API để tải dữ liệu bản đồ.`,
          error: '',
        });
      }
    }, [customCollection, api]);

    const loadGeoData = React.useCallback(async (isCancelled = null) => {
      if (!api?.request) return;
      reqTracker.seq += 1;
      const targetCollection = customCollection;
      reqTracker.collection = targetCollection;
      const mySeq = reqTracker.seq;
      const isStale = () => (
        reqTracker.unmounted
        || reqTracker.seq !== mySeq
        || reqTracker.collection !== targetCollection
        || (typeof isCancelled === 'function' && isCancelled())
      );

      setState((prev) => ({
        ...prev,
        loading: true,
        error: '',
        ...(targetCollection ? { markers: [], usingFallback: false, unmappedReason: '', totalRecords: 0 } : {}),
      }));

      const orgId = cfg.defaultOrganizationId ? String(cfg.defaultOrganizationId).trim() : '';
      const orgParams = orgId ? { organizationId: orgId } : {};
      const safeFetchList = async (url, extraFilter = null) => {
        const mergedFilter = orgId && extraFilter
          ? { organizationId: orgId, ...extraFilter }
          : orgId
            ? { organizationId: orgId }
            : extraFilter;
        const pageSize = 200;
        const allRows = [];
        try {
          for (let page = 1; page <= 10; page += 1) {
            const res = await api.request({
              url,
              method: 'get',
              params: {
                pageSize,
                ...(page > 1 ? { page } : {}),
                sort: ['-id'],
                ...(mergedFilter ? { filter: mergedFilter } : {}),
              },
              skipNotify: true,
            });
            const rows = res?.data?.data ?? res?.data?.items ?? [];
            if (!Array.isArray(rows) || !rows.length) break;
            allRows.push(...rows);
            if (rows.length < pageSize) break;
          }
          return allRows;
        } catch {
          return allRows.length ? allRows : null;
        }
      };

      if (targetCollection) {
        const propMeta = reqTracker.collectionMeta && typeof reqTracker.collectionMeta === 'object'
          && (!reqTracker.collectionMeta.name || reqTracker.collectionMeta.name === targetCollection)
          ? reqTracker.collectionMeta
          : null;
        const [rows, metaList] = await Promise.all([
          safeFetchList(`${targetCollection}:list`),
          propMeta ? Promise.resolve([propMeta]) : fetchCollectionsMeta(api),
        ]);
        if (isStale()) return;

        const collectionMeta = propMeta
          || (Array.isArray(metaList) ? metaList.find((c) => c?.name === targetCollection) : null)
          || null;
        if (rows === null) {
          setState({
            loading: false,
            markers: [],
            usingFallback: false,
            totalRecords: 0,
            unmappedReason: `Không tải được dữ liệu bản đồ cho collection ${targetCollection}.`,
            error: `Không tải được dữ liệu từ ${targetCollection}.`,
          });
          return;
        }

        const customMarkers = buildCustomCollectionMarkers(rows, collectionMeta, {
          collection: targetCollection,
          orgId,
          latField: explicitLatField,
          lngField: explicitLngField,
          labelField: explicitLabelField,
          statusField: explicitStatusField,
        });
        const unmappedReason = customMarkers.length
          ? ''
          : rows.length === 0
            ? `Collection ${targetCollection} chưa có bản ghi nào để hiển thị trên bản đồ.`
            : `Collection ${targetCollection} (${rows.length} bản ghi) chưa có trường tọa độ hợp lệ (lat/lng).`;
        setState({
          loading: false,
          markers: customMarkers,
          usingFallback: false,
          totalRecords: rows.length,
          unmappedReason,
          error: '',
        });
        return;
      }

      const [assets, locations, incidents] = await Promise.all([
        safeFetchList('latticeAssets:list'),
        safeFetchList('latticeLocations:list'),
        safeFetchList('latticeIncidentCases:list', { status: { $ne: 'closed' } }),
      ]);
      if (isStale()) return;

      const locationById = new Map();
      for (const loc of Array.isArray(locations) ? locations : []) {
        if (loc?.id != null) locationById.set(Number(loc.id), loc);
      }

      const incidentsByAssetId = new Map();
      for (const inc of Array.isArray(incidents) ? incidents : []) {
        const key = inc?.assetId != null ? Number(inc.assetId) : null;
        if (key != null) {
          const arr = incidentsByAssetId.get(key) || [];
          arr.push(inc);
          incidentsByAssetId.set(key, arr);
        }
      }

      const shadowsByAssetId = new Map();
      if (cfg.showTwinOverlay !== false && Array.isArray(assets) && assets.length) {
        const CONCURRENCY = 8;
        for (let i = 0; i < assets.length; i += CONCURRENCY) {
          if (isStale()) return;
          const batch = assets.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (asset) => {
            if (isStale() || asset?.id == null) return;
            const twinOrg = String(orgParams.organizationId || asset?.organizationId || '').trim();
            if (!twinOrg) return;
            try {
              const res = await api.request({
                url: 'dxosBlocks:twinShadow',
                method: 'post',
                data: { assetId: asset.id, organizationId: twinOrg },
                skipNotify: true,
              });
              const payload = res?.data?.data || res?.data || {};
              if (payload.shadow) shadowsByAssetId.set(Number(asset.id), payload.shadow);
            } catch {
              // Optional Digital Twin endpoint unavailable or forbidden -> degrade silently
            }
          }));
        }
      }
      if (isStale()) return;

      const markers = [];
      const seenLocIds = new Set();

      if (Array.isArray(assets)) {
        assets.forEach((asset, idx) => {
          const coords = inferCoordsForRecord(asset, locationById, idx);
          const assetIncidents = asset?.id != null ? (incidentsByAssetId.get(Number(asset.id)) || []) : [];
          const shadow = asset?.id != null ? shadowsByAssetId.get(Number(asset.id)) : null;
          if (asset?.locationId != null) seenLocIds.add(Number(asset.locationId));

          const highestSev = assetIncidents.some((i) => ['critical', 'high'].includes(String(i.severity || '').toLowerCase()))
            ? 'critical'
            : assetIncidents.length > 0
              ? 'warning'
              : '';

          const repTemp = parseFiniteGeo(shadow?.reportedJson?.targetTempC ?? shadow?.reportedJson?.temperatureC ?? asset?.temperatureC);
          const desTemp = parseFiniteGeo(shadow?.desiredJson?.targetTempC ?? asset?.targetTempC);
          const isWarehouse = String(asset?.kind || '').toLowerCase().includes('warehouse')
            || String(asset?.kind || '').toLowerCase().includes('cold')
            || asset?.locationId != null;
          const markerOrg = String(orgId || asset?.organizationId || shadow?.organizationId || '').trim();
          const markerEntityId = asset?.entityId
            || shadow?.assetEntityId
            || (asset?.id != null && markerOrg ? `urn:ngsi-ld:Asset:${markerOrg}:native:${asset.id}` : '');

          markers.push({
            id: `asset-${asset.id ?? idx}`,
            assetId: asset.id ?? null,
            assetEntityId: markerEntityId,
            organizationId: markerOrg,
            code: asset.code || `AST-${asset.id ?? idx}`,
            name: asset.name || asset.code || 'Tài sản chuỗi lạnh',
            kind: isWarehouse ? 'warehouse' : 'asset',
            lat: coords.lat,
            lng: coords.lng,
            severity: highestSev,
            status: asset.status || 'active',
            temperatureC: repTemp,
            targetTempC: desTemp,
            twinStatus: shadow?.commandStatus || 'synced',
            alarmCount: assetIncidents.length,
            latestAlarm: assetIncidents[0]?.name || assetIncidents[0]?.code || '',
            desiredJson: shadow?.desiredJson || null,
            reportedJson: shadow?.reportedJson || null,
          });
        });
      }

      if (Array.isArray(locations)) {
        locations.forEach((loc, idx) => {
          if (loc?.id != null && seenLocIds.has(Number(loc.id))) return;
          const coords = inferCoordsForRecord(loc, locationById, markers.length + idx);
          markers.push({
            id: `loc-${loc.id ?? idx}`,
            assetId: null,
            organizationId: String(orgId || loc?.organizationId || '').trim(),
            code: loc.code || `LOC-${loc.id ?? idx}`,
            name: loc.name || loc.code || 'Kho / Trạm',
            kind: 'warehouse',
            address: loc.address || '',
            lat: coords.lat,
            lng: coords.lng,
            status: loc.active === false ? 'inactive' : 'active',
            twinStatus: 'synced',
            alarmCount: 0,
          });
        });
      }

      if (isStale()) return;
      if (markers.length) {
        setState({ loading: false, markers, usingFallback: false, totalRecords: markers.length, unmappedReason: '', error: '' });
      } else {
        setState({
          loading: false,
          markers: DEFAULT_VIETNAM_GEO_MARKERS,
          usingFallback: true,
          totalRecords: 0,
          unmappedReason: '',
          error: assets === null && locations === null ? 'Đang hiển thị tuyến mặc định (chưa kết nối dữ liệu tài sản).' : '',
        });
      }
    }, [
      api,
      cfg.defaultOrganizationId,
      cfg.showTwinOverlay,
      customCollection,
      explicitLatField,
      explicitLngField,
      explicitLabelField,
      explicitStatusField,
      reqTracker,
    ]);

    React.useEffect(() => {
      let cancelled = false;
      loadGeoData(() => cancelled);
      return () => { cancelled = true; };
    }, [loadGeoData]);

    const classifiedMarkers = React.useMemo(
      () => state.markers.map((m) => ({
        ...m,
        geo: projectGeoPoint(m.lat, m.lng) || projectGeoPoint(15.8, 106.5),
        meta: classifyColdChainMarker(m),
      })),
      [state.markers],
    );

    const visibleMarkers = React.useMemo(() => {
      if (filterMode === 'alarms') {
        return classifiedMarkers.filter((m) => m.meta.level !== 'normal' || Number(m.alarmCount) > 0);
      }
      if (filterMode === 'warehouses') {
        return classifiedMarkers.filter((m) => m.kind === 'warehouse');
      }
      return classifiedMarkers;
    }, [classifiedMarkers, filterMode]);

    const selectedMarker = React.useMemo(() => {
      const explicit = visibleMarkers.find((m) => m.id === selectedId);
      if (explicit) return explicit;
      return visibleMarkers.find((m) => m.meta.level === 'critical')
        || visibleMarkers.find((m) => m.meta.level === 'warning')
        || visibleMarkers[0]
        || null;
    }, [visibleMarkers, selectedId]);

    const markersGeoJson = React.useMemo(() => buildMarkersGeoJson(visibleMarkers), [visibleMarkers]);
    const corridorsGeoJson = React.useMemo(
      () => buildCorridorsGeoJson(visibleMarkers, customCollection ? [] : DEFAULT_VIETNAM_GEO_MARKERS),
      [visibleMarkers, customCollection],
    );

    const handleSelectMarker = React.useCallback((marker) => {
      const id = typeof marker === 'string' ? marker : marker?.id;
      if (!id) return;
      setSelectedId(id);
      setTwinFeedback({ type: '', text: '' });
      const target = classifiedMarkers.find((m) => m.id === id);
      setDrawerOpen(Boolean(target && target.assetId != null && cfg.showTwinOverlay !== false));
      if (target && target.assetId != null) {
        const initTemp = target.desiredJson?.targetTempC ?? target.targetTempC ?? target.temperatureC ?? -18;
        setTwinForm({
          targetTempInput: String(initTemp),
          defrostMode: target.desiredJson?.defrostMode || 'auto',
          fanMode: target.desiredJson?.fanMode || 'auto',
          doorLock: target.desiredJson?.doorLock || 'locked',
        });
      }
    }, [classifiedMarkers, cfg.showTwinOverlay]);

    mapHolder.onSelectMarker = handleSelectMarker;
    mapHolder.latestGeo = { markersGeoJson, corridorsGeoJson, selectedId: selectedMarker?.id || '' };

    const maplibreLib = resolveMapLibre(cfg);
    const useMapLibreCanvas = Boolean(maplibreLib && !webglFailed);

    const mountMapLibre = React.useCallback((containerEl) => {
      mapHolder.containerEl = containerEl;
      if (!containerEl || !maplibreLib || mapHolder.map || webglFailed) return;
      try {
        injectMapLibreCss();
        ensureMapLibreWorker(maplibreLib);
        const startOffline = Boolean(cfg.offlineOnly)
          || (typeof navigator !== 'undefined' && navigator.onLine === false)
          || !cfg.tileUrlTemplate;
        const initialStyle = startOffline
          ? buildOfflineWgs84VectorStyle({ centerLng: cfg.centerLng, centerLat: cfg.centerLat, zoom: cfg.zoom })
          : buildOnlineOrHybridStyle({
              tileUrlTemplate: cfg.tileUrlTemplate,
              centerLng: cfg.centerLng,
              centerLat: cfg.centerLat,
              zoom: cfg.zoom,
            });

        const map = new maplibreLib.Map({
          container: containerEl,
          style: initialStyle,
          center: [Number(cfg.centerLng) || 106.5, Number(cfg.centerLat) || 15.8],
          zoom: Number(cfg.zoom) || 5.2,
          attributionControl: false,
        });
        mapHolder.map = map;
        if (typeof maplibreLib.NavigationControl === 'function' && typeof map.addControl === 'function') {
          try { map.addControl(new maplibreLib.NavigationControl({ showCompass: true }), 'top-right'); } catch {}
        }

        const applyLayers = () => {
          mapHolder.ready = true;
          const cur = mapHolder.latestGeo;
          syncMapLibreLayers(map, cur.markersGeoJson, cur.corridorsGeoJson, cur.selectedId);
        };

        map.on('load', applyLayers);
        map.on('style.load', applyLayers);
        map.on('click', 'dxos-clusters', (e) => {
          const cluster = e?.features?.[0];
          const clusterId = cluster?.properties?.cluster_id;
          const src = map.getSource?.('dxos-assets');
          if (clusterId != null && src && typeof src.getClusterExpansionZoom === 'function') {
            src.getClusterExpansionZoom(clusterId, (err, zoom) => {
              if (!err && typeof map.easeTo === 'function') {
                map.easeTo({ center: cluster.geometry.coordinates, zoom });
              }
            });
          }
        });
        map.on('click', 'dxos-unclustered-point', (e) => {
          const featId = e?.features?.[0]?.properties?.id;
          if (featId && typeof mapHolder.onSelectMarker === 'function') {
            mapHolder.onSelectMarker(String(featId));
          }
        });
        map.on('error', () => {
          if (!mapHolder.offlineSwitched) {
            mapHolder.offlineSwitched = true;
            setOfflineStyleMode(true);
            if (typeof map.setStyle === 'function') {
              try {
                map.setStyle(buildOfflineWgs84VectorStyle({ centerLng: cfg.centerLng, centerLat: cfg.centerLat, zoom: cfg.zoom }));
              } catch {}
            }
          }
        });
      } catch {
        setWebglFailed(true);
        setOfflineStyleMode(true);
      }
    }, [mapHolder, maplibreLib, webglFailed, cfg.offlineOnly, cfg.tileUrlTemplate, cfg.centerLng, cfg.centerLat, cfg.zoom]);

    React.useEffect(() => {
      if (mapHolder.map && mapHolder.ready) {
        syncMapLibreLayers(mapHolder.map, markersGeoJson, corridorsGeoJson, selectedMarker?.id || '');
      }
    }, [mapHolder, markersGeoJson, corridorsGeoJson, selectedMarker?.id]);

    const baselineTemp = React.useMemo(() => {
      if (!selectedMarker) return null;
      return parseFiniteGeo(selectedMarker.desiredJson?.targetTempC ?? selectedMarker.targetTempC ?? selectedMarker.temperatureC);
    }, [selectedMarker]);

    const parsedInputTemp = parseFiniteGeo(twinForm.targetTempInput);
    const previewDeltaTemp = baselineTemp !== null && parsedInputTemp !== null
      ? Number((parsedInputTemp - baselineTemp).toFixed(2))
      : null;
    const requiresHitl = previewDeltaTemp !== null && Math.abs(previewDeltaTemp) > HITL_DELTA_THRESHOLD_C;

    async function handleTwinSubmit(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (!api?.request || !selectedMarker || selectedMarker.assetId == null || twinBusy) return;
      if (parsedInputTemp === null || parsedInputTemp < -80 || parsedInputTemp > 120) {
        setTwinFeedback({ type: 'error', text: 'targetTempC phải là số hợp lệ trong [-80, 120]°C.' });
        return;
      }
      const twinOrg = String(selectedMarker.organizationId || cfg.defaultOrganizationId || '').trim();
      if (!twinOrg) {
        setTwinFeedback({ type: 'error', text: 'Thiếu organizationId để gửi lệnh Digital Twin.' });
        return;
      }

      setTwinBusy(true);
      setTwinFeedback({ type: '', text: '' });
      try {
        const desiredPatch = {
          targetTempC: Number(parsedInputTemp.toFixed(3)),
          ...(twinForm.defrostMode ? { defrostMode: twinForm.defrostMode } : {}),
          ...(twinForm.fanMode ? { fanMode: twinForm.fanMode } : {}),
          ...(twinForm.doorLock ? { doorLock: twinForm.doorLock } : {}),
        };
        const res = await api.request({
          url: 'dxosBlocks:twinSetDesired',
          method: 'post',
          data: {
            ...(selectedMarker.assetId != null ? { assetId: selectedMarker.assetId } : {}),
            ...(selectedMarker.assetEntityId ? { assetEntityId: selectedMarker.assetEntityId } : {}),
            organizationId: twinOrg,
            desiredPatch,
          },
          skipNotify: true,
        });
        const payload = res?.data?.data || res?.data || {};
        const nextShadow = payload.shadow || null;
        if (nextShadow) {
          setState((prev) => ({
            ...prev,
            markers: prev.markers.map((m) => (m.id === selectedMarker.id
              ? {
                  ...m,
                  twinStatus: nextShadow.commandStatus || m.twinStatus,
                  desiredJson: nextShadow.desiredJson || m.desiredJson,
                  reportedJson: nextShadow.reportedJson || m.reportedJson,
                  targetTempC: parseFiniteGeo(nextShadow.desiredJson?.targetTempC) ?? m.targetTempC,
                }
              : m)),
          }));
        }
        if (payload.gatedByHitl) {
          setTwinFeedback({
            type: 'warning',
            text: `Yêu cầu vượt ±2.0°C đã chuyển phê duyệt HITL (Mã #${payload.approvalId ?? '—'}, trạng thái: ${nextShadow?.commandStatus || 'pending_hitl'}, Δ = ${payload.deltaTempC ?? previewDeltaTemp}°C).`,
          });
        } else {
          setTwinFeedback({
            type: 'success',
            text: `Đã gửi lệnh Digital Twin (${payload.commandId || 'cmd'}, trạng thái: ${nextShadow?.commandStatus || 'dispatched'}).`,
          });
        }
      } catch (err) {
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không gửi được lệnh Digital Twin.';
        setTwinFeedback({ type: 'error', text: msg });
      } finally {
        setTwinBusy(false);
      }
    }

    const corridorPolylinePoints = React.useMemo(
      () => DEFAULT_VIETNAM_GEO_MARKERS
        .map((m) => projectGeoPoint(m.lat, m.lng))
        .filter(Boolean)
        .map((p) => `${p.x},${p.y}`)
        .join(' '),
      [],
    );

    const filterBtnStyle = (active) => ({
      padding: '4px 10px',
      borderRadius: 999,
      border: `1px solid ${active ? '#0ea5e9' : '#cbd5e1'}`,
      background: active ? '#0ea5e9' : '#ffffff',
      color: active ? '#ffffff' : '#334155',
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });

    const centerGeo = projectGeoPoint(cfg.centerLat, cfg.centerLng);
    const showUnmappedNotice = Boolean(customCollection && !state.loading && state.markers.length === 0);
    const hasTwinControls = Boolean(selectedMarker && selectedMarker.assetId != null && cfg.showTwinOverlay !== false);
    const unmappedSubsetCount = customCollection && state.totalRecords > state.markers.length
      ? state.totalRecords - state.markers.length
      : 0;

    return h('section', {
      'data-testid': 'dxos-webgis-block',
      style: {
        padding: 16,
        borderRadius: 12,
        border: '1px solid #cbd5e1',
        background: '#ffffff',
        color: '#0f172a',
        display: 'grid',
        gap: 12,
        minWidth: 0,
      },
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        h('div', null,
          h('strong', { style: { fontSize: 15, color: '#0f172a' } }, String(cfg.title || 'WebGIS Chuỗi lạnh [D]')),
          h('div', { style: { fontSize: 11, color: '#64748b' } },
            customCollection
              ? `${customCollection} · ${visibleMarkers.length} điểm hiển thị${unmappedSubsetCount > 0 ? ` (${unmappedSubsetCount} chưa có tọa độ)` : ''}${useMapLibreCanvas ? (offlineStyleMode ? ' · MapLibre WGS84 Offline' : ' · MapLibre GL') : ' · Vector WGS84 Fallback'}`
              : `Tuyến ĐBSCL – TP.HCM – Đà Nẵng – Hà Nội · ${visibleMarkers.length} điểm hiển thị${state.usingFallback ? ' (dữ liệu mẫu)' : ''}${useMapLibreCanvas ? (offlineStyleMode ? ' · MapLibre WGS84 Offline' : ' · MapLibre GL') : ' · Vector WGS84 Fallback'}`,
          ),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
          h('button', { type: 'button', 'data-testid': 'dxos-webgis-filter-all', onClick: () => setFilterMode('all'), style: filterBtnStyle(filterMode === 'all') }, 'Tất cả'),
          h('button', { type: 'button', 'data-testid': 'dxos-webgis-filter-alarms', onClick: () => setFilterMode('alarms'), style: filterBtnStyle(filterMode === 'alarms') }, 'Cảnh báo Chuỗi lạnh'),
          !customCollection ? h('button', { type: 'button', 'data-testid': 'dxos-webgis-filter-warehouses', onClick: () => setFilterMode('warehouses'), style: filterBtnStyle(filterMode === 'warehouses') }, 'Kho & Trạm') : null,
          h('button', {
            type: 'button',
            onClick: () => loadGeoData(),
            disabled: state.loading,
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
          }, state.loading ? 'Đang tải…' : 'Làm mới'),
        ),
      ),
      state.error ? h('div', { style: { fontSize: 11, color: '#b45309' } }, state.error) : null,
      showUnmappedNotice ? h('div', {
        'data-testid': 'dxos-webgis-unmapped-notice',
        style: {
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid #fcd34d',
          background: '#fffbeb',
          color: '#92400e',
          fontSize: 12,
          fontWeight: 600,
        },
      }, state.unmappedReason || `Collection ${customCollection} chưa có bản ghi có tọa độ hợp lệ (lat/lng).`) : null,
      h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
          alignItems: 'stretch',
        },
      },
        h('div', {
          style: {
            borderRadius: 10,
            overflow: 'hidden',
            border: '1px solid #1e293b',
            background: 'linear-gradient(160deg, #0f172a 0%, #172554 100%)',
            padding: 8,
            minWidth: 0,
          },
        },
          useMapLibreCanvas
            ? h('div', {
                'data-testid': 'dxos-webgis-maplibre-canvas',
                ref: mountMapLibre,
                style: { width: '100%', height: 340, borderRadius: 8, overflow: 'hidden' },
              })
            : h('svg', {
                'data-testid': 'dxos-webgis-svg-fallback',
                viewBox: `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`,
                role: 'img',
                'aria-label': customCollection ? `Bản đồ dữ liệu ${customCollection}` : 'Bản đồ hành lang chuỗi lạnh Việt Nam',
                style: { width: '100%', height: 'auto', display: 'block' },
              },
                [10, 14, 18, 22].map((latLine) => {
                  const pt = projectGeoPoint(latLine, 106);
                  return pt ? h('g', { key: `lat-${latLine}` },
                    h('line', { x1: 0, x2: SVG_WIDTH, y1: pt.y, y2: pt.y, stroke: '#334155', strokeDasharray: '3 4', strokeWidth: 0.8 }),
                    h('text', { x: 6, y: pt.y - 4, fill: '#64748b', fontSize: 9 }, `${latLine}°N`),
                  ) : null;
                }),
                [104, 106, 108].map((lngLine) => {
                  const pt = projectGeoPoint(15, lngLine);
                  return pt ? h('g', { key: `lng-${lngLine}` },
                    h('line', { x1: pt.x, x2: pt.x, y1: 0, y2: SVG_HEIGHT, stroke: '#334155', strokeDasharray: '3 4', strokeWidth: 0.8 }),
                    h('text', { x: pt.x + 3, y: 12, fill: '#64748b', fontSize: 9 }, `${lngLine}°E`),
                  ) : null;
                }),
                !customCollection ? h('polyline', {
                  fill: 'none',
                  stroke: '#38bdf8',
                  strokeOpacity: 0.55,
                  strokeWidth: 2.5,
                  strokeDasharray: '6 4',
                  points: corridorPolylinePoints,
                }) : null,
                centerGeo ? h('circle', {
                  cx: centerGeo.x,
                  cy: centerGeo.y,
                  r: 3,
                  fill: '#38bdf8',
                  fillOpacity: 0.35,
                }) : null,
                visibleMarkers.map((m) => {
                  const isSelected = selectedMarker && selectedMarker.id === m.id;
                  return h('g', {
                    key: m.id,
                    'data-testid': 'dxos-webgis-pin',
                    'data-severity': m.meta.level,
                    'data-twin-status': m.meta.twinStatus,
                    role: 'button',
                    'aria-label': `${m.code} ${m.name}`,
                    style: { cursor: 'pointer' },
                    onClick: () => handleSelectMarker(m),
                  },
                    isSelected ? h('circle', { cx: m.geo.x, cy: m.geo.y, r: 15, fill: m.meta.color, fillOpacity: 0.22, stroke: '#f8fafc', strokeWidth: 1.5 }) : null,
                    h('circle', { cx: m.geo.x, cy: m.geo.y, r: isSelected ? 8.5 : 7, fill: m.meta.color, stroke: '#ffffff', strokeWidth: 2 }),
                    h('text', {
                      x: Math.min(SVG_WIDTH - 64, m.geo.x + 11),
                      y: m.geo.y + 4,
                      fill: '#f8fafc',
                      fontSize: 10,
                      fontWeight: 700,
                    }, String(m.code)),
                  );
                }),
              ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6, fontSize: 11, color: '#cbd5e1' } },
            h('span', null, h('span', { style: { color: '#059669', fontWeight: 800 } }, '● '), 'Ổn định (#059669)'),
            h('span', null, h('span', { style: { color: '#d97706', fontWeight: 800 } }, '● '), 'Cảnh báo / MKT Hold (#d97706)'),
            h('span', null, h('span', { style: { color: '#dc2626', fontWeight: 800 } }, '● '), 'Nguy cấp (#dc2626)'),
          ),
        ),
        h('div', {
          'data-testid': 'dxos-webgis-detail-panel',
          style: {
            borderRadius: 10,
            border: '1px solid #e2e8f0',
            background: '#f8fafc',
            padding: 12,
            display: 'grid',
            gap: 8,
            alignContent: 'start',
          },
        },
          selectedMarker ? h(React.Fragment, null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: 14, color: '#0f172a' } },
                selectedMarker.code && selectedMarker.code !== selectedMarker.name
                  ? `${selectedMarker.code} — ${selectedMarker.name}`
                  : selectedMarker.name,
              ),
              h('span', {
                style: {
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: selectedMarker.meta.bg,
                  color: selectedMarker.meta.color,
                  border: `1px solid ${selectedMarker.meta.border}`,
                },
              }, selectedMarker.meta.label),
            ),
            h('div', { style: { fontSize: 12, color: '#475569' } },
              `Tọa độ: ${Number(selectedMarker.lat).toFixed(4)}°N, ${Number(selectedMarker.lng).toFixed(4)}°E`,
              selectedMarker.address ? ` · ${selectedMarker.address}` : '',
            ),
            (!selectedMarker.isCustom || selectedMarker.meta.temperatureC !== null || selectedMarker.meta.targetTempC !== null)
              ? h('div', { style: { padding: 8, borderRadius: 8, background: '#ffffff', border: '1px solid #e2e8f0', fontSize: 12 } },
                  h('div', { style: { color: '#64748b', fontSize: 11 } }, 'Nhiệt độ thực tế / Setpoint'),
                  h('strong', { style: { fontSize: 14, color: selectedMarker.meta.color } }, selectedMarker.meta.tempSummary),
                )
              : h('div', { style: { padding: 8, borderRadius: 8, background: '#ffffff', border: '1px solid #e2e8f0', fontSize: 12 } },
                  h('div', { style: { color: '#64748b', fontSize: 11 } }, `Trạng thái (${selectedMarker.collection || 'collection'})`),
                  h('strong', { style: { fontSize: 13, color: selectedMarker.meta.color } }, String(selectedMarker.status || selectedMarker.meta.label)),
                ),
            hasTwinControls ? h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 } },
              h('span', { style: { color: '#475569' } }, 'Trạng thái Digital Twin:'),
              h('span', {
                style: {
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: selectedMarker.meta.twinMeta.bg,
                  color: selectedMarker.meta.twinMeta.color,
                  border: `1px solid ${selectedMarker.meta.twinMeta.border}`,
                },
              }, selectedMarker.meta.twinStatus),
            ) : null,
            hasTwinControls ? h('button', {
              type: 'button',
              'data-testid': 'dxos-webgis-open-twin-drawer-btn',
              onClick: () => handleSelectMarker(selectedMarker),
              style: {
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid #0284c7',
                background: '#f0f9ff',
                color: '#0369a1',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              },
            }, 'Điều khiển Digital Twin') : null,
            selectedMarker.alarmCount > 0 ? h('div', { style: { fontSize: 12, color: '#991b1b', background: '#fee2e2', padding: '6px 8px', borderRadius: 6 } },
              `Sự cố đang mở (${selectedMarker.alarmCount}): ${selectedMarker.latestAlarm || 'Cảnh báo ngưỡng nhiệt'}`,
            ) : null,
            selectedMarker.meta.level !== 'normal' && (!selectedMarker.isCustom || selectedMarker.alarmCount > 0) ? h('button', {
              type: 'button',
              onClick: () => safeGo(app, '/p/incidents'),
              style: {
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid #dc2626',
                background: '#ffffff',
                color: '#dc2626',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              },
            }, 'Mở trang Xử lý Sự cố') : null,
          ) : h('div', { style: { fontSize: 13, color: '#64748b' } }, customCollection ? 'Chưa có điểm bản đồ hợp lệ để hiển thị.' : 'Không có điểm giám sát phù hợp với bộ lọc hiện tại.'),
        ),
      ),
      drawerOpen && hasTwinControls ? h('div', {
        'data-testid': 'dxos-webgis-twin-drawer',
        role: 'region',
        'aria-label': `Điều khiển Digital Twin ${selectedMarker.code}`,
        style: {
          borderRadius: 10,
          border: '1px solid #93c5fd',
          background: '#f8fafc',
          padding: 14,
          display: 'grid',
          gap: 10,
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
          h('strong', { style: { fontSize: 13, color: '#0f172a' } }, `Desktop Digital Twin Control — ${selectedMarker.code} (${selectedMarker.name})`),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-webgis-close-twin-drawer-btn',
            onClick: () => setDrawerOpen(false),
            style: { border: '1px solid #cbd5e1', background: '#ffffff', borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer' },
          }, 'Đóng'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } },
          h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: '#475569' } },
            'Nhiệt độ mục tiêu (°C)',
            h('input', {
              type: 'number',
              step: '0.5',
              'data-testid': 'dxos-twin-target-temp-input',
              value: twinForm.targetTempInput,
              onChange: (e) => setTwinForm((prev) => ({ ...prev, targetTempInput: e.target.value })),
              style: { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff' },
            }),
          ),
          h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: '#475569' } },
            'Chế độ xả đá (defrost)',
            h('select', {
              'data-testid': 'dxos-twin-defrost-select',
              value: twinForm.defrostMode,
              onChange: (e) => setTwinForm((prev) => ({ ...prev, defrostMode: e.target.value })),
              style: { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff' },
            },
              h('option', { value: 'auto' }, 'auto'),
              h('option', { value: 'manual' }, 'manual'),
              h('option', { value: 'off' }, 'off'),
            ),
          ),
          h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: '#475569' } },
            'Quạt dàn lạnh (fan)',
            h('select', {
              'data-testid': 'dxos-twin-fan-select',
              value: twinForm.fanMode,
              onChange: (e) => setTwinForm((prev) => ({ ...prev, fanMode: e.target.value })),
              style: { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff' },
            },
              h('option', { value: 'auto' }, 'auto'),
              h('option', { value: 'high' }, 'high'),
              h('option', { value: 'low' }, 'low'),
              h('option', { value: 'eco' }, 'eco'),
            ),
          ),
          h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: '#475569' } },
            'Khóa cửa kho (doorLock)',
            h('select', {
              'data-testid': 'dxos-twin-door-select',
              value: twinForm.doorLock,
              onChange: (e) => setTwinForm((prev) => ({ ...prev, doorLock: e.target.value })),
              style: { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff' },
            },
              h('option', { value: 'locked' }, 'locked'),
              h('option', { value: 'unlocked' }, 'unlocked'),
            ),
          ),
        ),
        requiresHitl ? h('div', {
          'data-testid': 'dxos-twin-hitl-warning',
          style: { fontSize: 12, color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 6, padding: '6px 10px' },
        }, `Cảnh báo HITL: Thay đổi ${previewDeltaTemp > 0 ? `+${previewDeltaTemp}` : previewDeltaTemp}°C vượt ngưỡng ±2.0°C — lệnh sẽ cần phê duyệt HITL.`) : null,
        twinFeedback.text ? h('div', {
          'data-testid': 'dxos-twin-feedback',
          style: {
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 6,
            background: twinFeedback.type === 'error' ? '#fee2e2' : twinFeedback.type === 'warning' ? '#fef3c7' : '#dcfce7',
            color: twinFeedback.type === 'error' ? '#991b1b' : twinFeedback.type === 'warning' ? '#92400e' : '#166534',
            border: `1px solid ${twinFeedback.type === 'error' ? '#fca5a5' : twinFeedback.type === 'warning' ? '#fcd34d' : '#86efac'}`,
          },
        }, twinFeedback.text) : null,
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            'data-testid': 'dxos-twin-submit-btn',
            disabled: twinBusy,
            onClick: handleTwinSubmit,
            style: {
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: requiresHitl ? '#d97706' : '#0284c7',
              color: '#ffffff',
              fontSize: 12,
              fontWeight: 700,
              cursor: twinBusy ? 'wait' : 'pointer',
            },
          }, twinBusy ? 'Đang gửi lệnh…' : (requiresHitl ? 'Gửi yêu cầu HITL' : 'Áp dụng Setpoint Digital Twin')),
        ),
      ) : null,
    );
  };
}

module.exports = {
  DEFAULT_VIETNAM_BOUNDS,
  DEFAULT_VIETNAM_GEO_MARKERS,
  normalizeWebGisCollection,
  normalizeWebGisFieldName,
  buildCustomCollectionMarkers,
  projectGeoPoint,
  classifyColdChainMarker,
  inferCoordsForRecord,
  buildMarkersGeoJson,
  buildCorridorsGeoJson,
  buildOfflineWgs84VectorStyle,
  buildOnlineOrHybridStyle,
  createWebGisBlockView,
};

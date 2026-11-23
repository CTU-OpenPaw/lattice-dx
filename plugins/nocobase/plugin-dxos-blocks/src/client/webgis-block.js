/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { isSafeAppPath } = require('./blocks-helpers');

const SVG_WIDTH = 640;
const SVG_HEIGHT = 360;
const SVG_PAD = 24;

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
  for (const city of VIETNAM_CITY_COORDS) {
    if (city.keys.some((k) => haystack.includes(k))) {
      const jitter = Math.floor(index / 4) * 0.22 * (index % 2 === 0 ? 1 : -1);
      return {
        lat: Number((city.lat + jitter * 0.5).toFixed(4)),
        lng: Number((city.lng + jitter * 0.5).toFixed(4)),
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
      showTwinOverlay: true,
      ...(model?.props || {}),
      ...stepCfg,
      ...(liveConfig || {}),
    };

    const [filterMode, setFilterMode] = React.useState('all');
    const [selectedId, setSelectedId] = React.useState('');
    const [state, setState] = React.useState({
      loading: false,
      markers: DEFAULT_VIETNAM_GEO_MARKERS,
      usingFallback: true,
      error: '',
    });

    const loadGeoData = React.useCallback(async () => {
      if (!api?.request) return;
      setState((prev) => ({ ...prev, loading: true, error: '' }));

      const orgParams = cfg.defaultOrganizationId ? { organizationId: String(cfg.defaultOrganizationId).trim() } : {};
      const safeFetchList = async (url, extraParams = {}) => {
        try {
          const res = await api.request({
            url,
            method: 'get',
            params: { pageSize: 50, sort: ['-id'], ...orgParams, ...extraParams },
            skipNotify: true,
          });
          const rows = res?.data?.data ?? res?.data?.items ?? [];
          return Array.isArray(rows) ? rows : [];
        } catch {
          return null;
        }
      };

      const [assets, locations, incidents] = await Promise.all([
        safeFetchList('latticeAssets:list'),
        safeFetchList('latticeLocations:list'),
        safeFetchList('latticeIncidentCases:list', { filter: { status: { $ne: 'closed' } } }),
      ]);

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
        await Promise.all(assets.slice(0, 6).map(async (asset) => {
          if (asset?.id == null) return;
          try {
            const res = await api.request({
              url: 'dxosBlocks:twinShadow',
              method: 'post',
              data: { assetId: asset.id, ...orgParams },
              skipNotify: true,
            });
            const payload = res?.data?.data || res?.data || {};
            if (payload.shadow) shadowsByAssetId.set(Number(asset.id), payload.shadow);
          } catch {
            // Optional Digital Twin endpoint unavailable or forbidden -> degrade silently
          }
        }));
      }

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

          markers.push({
            id: `asset-${asset.id ?? idx}`,
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

      if (markers.length) {
        setState({ loading: false, markers, usingFallback: false, error: '' });
      } else {
        setState({
          loading: false,
          markers: DEFAULT_VIETNAM_GEO_MARKERS,
          usingFallback: true,
          error: assets === null && locations === null ? 'Đang hiển thị tuyến mặc định (chưa kết nối dữ liệu tài sản).' : '',
        });
      }
    }, [api, cfg.defaultOrganizationId, cfg.showTwinOverlay]);

    React.useEffect(() => {
      loadGeoData();
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
            `Tuyến ĐBSCL – TP.HCM – Đà Nẵng – Hà Nội · ${visibleMarkers.length} điểm hiển thị${state.usingFallback ? ' (dữ liệu mẫu)' : ''}`,
          ),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
          h('button', { type: 'button', 'data-testid': 'dxos-webgis-filter-all', onClick: () => setFilterMode('all'), style: filterBtnStyle(filterMode === 'all') }, 'Tất cả'),
          h('button', { type: 'button', 'data-testid': 'dxos-webgis-filter-alarms', onClick: () => setFilterMode('alarms'), style: filterBtnStyle(filterMode === 'alarms') }, 'Cảnh báo Chuỗi lạnh'),
          h('button', { type: 'button', 'data-testid': 'dxos-webgis-filter-warehouses', onClick: () => setFilterMode('warehouses'), style: filterBtnStyle(filterMode === 'warehouses') }, 'Kho & Trạm'),
          h('button', {
            type: 'button',
            onClick: loadGeoData,
            disabled: state.loading,
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
          }, state.loading ? 'Đang tải…' : 'Làm mới'),
        ),
      ),
      state.error ? h('div', { style: { fontSize: 11, color: '#b45309' } }, state.error) : null,
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
          h('svg', {
            viewBox: `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`,
            role: 'img',
            'aria-label': 'Bản đồ hành lang chuỗi lạnh Việt Nam',
            style: { width: '100%', height: 'auto', display: 'block' },
          },
            // Lat/Lng grid lines
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
            // Vietnam corridor silhouette + cold-chain route
            h('polyline', {
              fill: 'none',
              stroke: '#38bdf8',
              strokeOpacity: 0.55,
              strokeWidth: 2.5,
              strokeDasharray: '6 4',
              points: corridorPolylinePoints,
            }),
            centerGeo ? h('circle', {
              cx: centerGeo.x,
              cy: centerGeo.y,
              r: 3,
              fill: '#38bdf8',
              fillOpacity: 0.35,
            }) : null,
            // Station / Asset pins
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
                onClick: () => setSelectedId(m.id),
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
        // Selected telemetry & Digital Twin detail panel
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
              h('strong', { style: { fontSize: 14, color: '#0f172a' } }, `${selectedMarker.code} — ${selectedMarker.name}`),
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
            h('div', { style: { padding: 8, borderRadius: 8, background: '#ffffff', border: '1px solid #e2e8f0', fontSize: 12 } },
              h('div', { style: { color: '#64748b', fontSize: 11 } }, 'Nhiệt độ thực tế / Setpoint'),
              h('strong', { style: { fontSize: 14, color: selectedMarker.meta.color } }, selectedMarker.meta.tempSummary),
            ),
            cfg.showTwinOverlay !== false ? h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 } },
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
            selectedMarker.alarmCount > 0 ? h('div', { style: { fontSize: 12, color: '#991b1b', background: '#fee2e2', padding: '6px 8px', borderRadius: 6 } },
              `Sự cố đang mở (${selectedMarker.alarmCount}): ${selectedMarker.latestAlarm || 'Cảnh báo ngưỡng nhiệt'}`,
            ) : null,
            selectedMarker.meta.level !== 'normal' ? h('button', {
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
          ) : h('div', { style: { fontSize: 13, color: '#64748b' } }, 'Không có điểm giám sát phù hợp với bộ lọc hiện tại.'),
        ),
      ),
    );
  };
}

module.exports = {
  DEFAULT_VIETNAM_BOUNDS,
  DEFAULT_VIETNAM_GEO_MARKERS,
  projectGeoPoint,
  classifyColdChainMarker,
  createWebGisBlockView,
};

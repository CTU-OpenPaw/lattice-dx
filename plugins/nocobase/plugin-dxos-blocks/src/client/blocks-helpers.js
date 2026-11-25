/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const SAFE_COLLECTION_RE = /^[a-zA-Z0-9_]{1,64}$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const SAFE_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const MAX_KPI_METRICS = 6;
const MAX_HERO_ACTIONS = 4;

function isSafeAppPath(path) {
  if (typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return false;
  if (/[\r\n\0\\]/.test(trimmed) || trimmed.includes('..')) return false;
  return true;
}

function safeJsonParse(raw, fallback) {
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function filterHeroActions(rawActions, permissions) {
  const list = safeJsonParse(rawActions, []);
  if (!Array.isArray(list)) return [];
  const allowAll = permissions?.allowAll === true;
  const grantedMap = permissions?.actions && typeof permissions.actions === 'object' ? permissions.actions : {};
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (!label || !isSafeAppPath(path)) continue;
    const req = typeof item.requiredAction === 'string' ? item.requiredAction.trim() : '';
    if (req && permissions && !allowAll && !grantedMap[req]) continue;
    result.push({
      label: label.slice(0, 48),
      path,
      primary: Boolean(item.primary),
    });
    if (result.length >= MAX_HERO_ACTIONS) break;
  }
  return result;
}

function parseKpiMetrics(rawMetrics) {
  const list = safeJsonParse(rawMetrics, []);
  if (!Array.isArray(list)) return [];
  const parsed = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const collection = typeof item.collection === 'string' ? item.collection.trim() : '';
    if (!label || !SAFE_COLLECTION_RE.test(collection)) continue;
    let filterObj = {};
    if (item.filter) {
      const candidate = safeJsonParse(item.filter, null);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) filterObj = candidate;
    }
    const color = typeof item.color === 'string' && SAFE_COLOR_RE.test(item.color.trim()) ? item.color.trim() : '#1677ff';
    const rawPath = typeof item.targetPath === 'string' ? item.targetPath.trim() : '';
    parsed.push({
      label: label.slice(0, 48),
      collection,
      filter: filterObj,
      color,
      targetPath: isSafeAppPath(rawPath) ? rawPath : null,
    });
    if (parsed.length >= MAX_KPI_METRICS) break;
  }
  return parsed;
}

async function fetchWorkflowTasks(api, { statusFilter = 'pending', pageSize = 8 } = {}) {
  if (!api?.request) return { items: [], total: 0 };
  const limit = Math.max(1, Math.min(25, Number(pageSize) || 8));
  const filter = statusFilter === 'pending' ? { status: 0 } : statusFilter === 'resolved' ? { status: { $ne: 0 } } : {};
  const res = await api.request({
    url: 'workflowManualTasks:listMine',
    method: 'get',
    params: {
      pageSize: limit,
      sort: ['-id'],
      appends: ['workflow', 'node', 'execution'],
      ...(Object.keys(filter).length ? { filter } : {}),
    },
  });
  const payload = res?.data;
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const total = Number(payload?.meta?.count ?? items.length);
  return { items, total };
}

async function fetchParaVault(api, { paraSpace = 'all', search = '', pageSize = 8 } = {}) {
  if (!api?.request) return { items: [], total: 0, pluginDisabled: false };
  const limit = Math.max(1, Math.min(25, Number(pageSize) || 8));
  const andFilters = [{ active: true }];
  if (paraSpace && paraSpace !== 'all') andFilters.push({ paraSpace });
  if (search && String(search).trim()) {
    const q = String(search).trim();
    andFilters.push({ $or: [{ title: { $includes: q } }, { summary: { $includes: q } }, { tags: { $includes: q } }] });
  }
  try {
    const res = await api.request({
      url: 'latticeParaDocuments:list',
      method: 'get',
      params: { pageSize: limit, sort: ['-id'], filter: { $and: andFilters } },
    });
    const payload = res?.data;
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const total = Number(payload?.meta?.count ?? items.length);
    return { items, total, pluginDisabled: false };
  } catch (err) {
    const status = Number(err?.response?.status ?? err?.status);
    if (status === 404 || status === 501) {
      return { items: [], total: 0, pluginDisabled: true };
    }
    throw err;
  }
}

async function fetchParaSummary(api) {
  if (!api?.request) return { organizationId: null, organizations: [] };
  try {
    const res = await api.request({ url: 'latticePara:summary', method: 'get' });
    const data = res?.data?.data || res?.data || {};
    return {
      organizationId: data.organizationId ?? null,
      organizations: Array.isArray(data.organizations) ? data.organizations : [],
    };
  } catch {
    return { organizationId: null, organizations: [] };
  }
}

function inferPortalSlugFromLocation(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0].trim().toLowerCase();
  if (!clean) return '';
  const portalMatch = clean.match(/\/p\/([a-z0-9_-]+)/);
  if (portalMatch && portalMatch[1]) return portalMatch[1];
  if (clean.includes('/admin/dxos-studio') || clean.includes('/admin/settings/dxos-')) return 'admin-studio';
  return '';
}

async function fetchPortalAgents(api, { portalSlug = '' } = {}) {
  if (!api?.request) return { pluginDisabled: true, employees: [] };
  try {
    const res = await api.request({
      url: 'dxosAi:portalAgents',
      method: 'get',
      params: portalSlug ? { portalSlug } : {},
    });
    const data = res?.data?.data || res?.data || {};
    return {
      pluginDisabled: false,
      employees: Array.isArray(data.employees) ? data.employees : [],
    };
  } catch {
    return { pluginDisabled: true, employees: [] };
  }
}

async function triggerDxosAgent(appOrFlowEngine, { aiEmployee, prompt, blockTitle = '', portalSlug = '' } = {}) {
  const aiCtx = appOrFlowEngine?.flowEngine?.context?.ai || appOrFlowEngine?.context?.ai;
  if (!aiCtx || typeof aiCtx.triggerTask !== 'function' || !aiEmployee || !prompt) {
    return { triggered: false, reason: 'ai_unavailable' };
  }
  const prefix = [blockTitle ? `Ngữ cảnh block: ${blockTitle}` : '', portalSlug ? `Portal: /p/${portalSlug}` : '']
    .filter(Boolean)
    .join(' · ');
  await aiCtx.triggerTask({
    aiEmployee,
    tasks: [{ type: 'text', text: prefix ? `[${prefix}]\n${prompt}` : String(prompt) }],
    open: true,
  });
  return { triggered: true, aiEmployee };
}

function createAgentStripElement(React, { employees = [], onRunPrompt } = {}) {
  if (!React?.createElement || !Array.isArray(employees) || !employees.length) return null;
  const h = React.createElement;
  const chips = [];
  for (const emp of employees) {
    const prompts = Array.isArray(emp.quickPrompts) && emp.quickPrompts.length
      ? emp.quickPrompts
      : [{ label: `Hỏi ${emp.nickname || emp.username}`, prompt: `Hỗ trợ tôi tại không gian làm việc hiện tại.` }];
    for (let idx = 0; idx < prompts.length; idx += 1) {
      const qp = prompts[idx];
      chips.push(h('button', {
        key: `${emp.username}:${idx}`,
        type: 'button',
        title: `${emp.nickname || emp.username}: ${qp.prompt}`,
        onClick: () => typeof onRunPrompt === 'function' && onRunPrompt(emp, qp),
        style: {
          padding: '4px 10px',
          borderRadius: 999,
          border: '1px solid #bae6fd',
          background: '#f0f9ff',
          color: '#0369a1',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        },
      }, `AI · ${qp.label}`));
    }
  }
  if (!chips.length) return null;
  return h('div', {
    'data-testid': 'dxos-block-agent-strip',
    style: { marginTop: 12, paddingTop: 10, borderTop: '1px dashed #cbd5e1', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  },
    h('span', { style: { fontSize: 11, fontWeight: 700, color: '#0369a1' } }, 'Trợ lý AI ngữ cảnh:'),
    ...chips,
  );
}

function triggerBase64Download(contentBase64, mimeType, filename) {
  if (
    typeof document === 'undefined'
    || typeof document.createElement !== 'function'
    || typeof Blob === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
    || typeof atob !== 'function'
  ) {
    return { downloaded: false, reason: 'browser_unavailable' };
  }
  const cleanB64 = String(contentBase64 || '').replace(/\s+/g, '');
  if (!cleanB64) {
    return { downloaded: false, reason: 'empty_content' };
  }
  const safeFilename = String(filename || 'export').replace(/[\\/:*?"<>|\r\n\0]/g, '_') || 'export';
  const binary = atob(cleanB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = objectUrl;
    anchor.download = safeFilename;
    if (anchor.style) anchor.style.display = 'none';
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(anchor);
    }
    if (typeof anchor.click === 'function') {
      anchor.click();
    }
  } finally {
    if (document.body && typeof document.body.removeChild === 'function') {
      try { document.body.removeChild(anchor); } catch {}
    }
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
  }
  return { downloaded: true, filename: safeFilename };
}

async function requestAndDownloadExport(api, { collection, format = 'csv', fields = null, filter = null } = {}) {
  if (!api?.request || !SAFE_COLLECTION_RE.test(String(collection || ''))) {
    return { ok: false, meta: null, download: { downloaded: false, reason: 'invalid_request' } };
  }
  const res = await api.request({
    url: 'dxosBlocks:exportReport',
    method: 'post',
    data: {
      collection,
      format,
      ...(Array.isArray(fields) && fields.length ? { fields } : {}),
      ...(filter && typeof filter === 'object' ? { filter } : {}),
    },
  });
  const meta = res?.data?.data || res?.data || {};
  let download = { downloaded: false, reason: 'no_content' };
  if (meta.contentBase64) {
    download = triggerBase64Download(
      meta.contentBase64,
      meta.mimeType,
      meta.filename || `${collection}.${format}`,
    );
  }
  return { ok: true, meta, download };
}

const collectionsMetaListeners = new Set();

function resolveClientAuthToken(api) {
  if (!api) return '';
  try {
    const t = typeof api.auth?.getToken === 'function' ? api.auth.getToken() : '';
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  try {
    const t = api.auth?.token;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  try {
    if (typeof window !== 'undefined' && window?.localStorage && typeof window.localStorage.getItem === 'function') {
      const t = window.localStorage.getItem('NOCOBASE_TOKEN');
      if (typeof t === 'string' && t.trim()) return t.trim();
    } else if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const t = localStorage.getItem('NOCOBASE_TOKEN');
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  } catch {}
  return '';
}

function subscribeCollectionsMeta(listener) {
  if (typeof listener !== 'function') return () => {};
  collectionsMetaListeners.add(listener);
  return () => {
    collectionsMetaListeners.delete(listener);
  };
}

async function fetchCollectionsMeta(api) {
  if (!api?.request) return [];
  try {
    const res = await api.request({
      url: 'dxosBlocks:collectionsMeta',
      method: 'get',
      skipNotify: true,
    });
    const list = res?.data?.data?.collections ?? res?.data?.collections ?? [];
    const cols = Array.isArray(list) ? list : [];
    for (const fn of [...collectionsMetaListeners]) {
      try { fn(cols); } catch {}
    }
    return cols;
  } catch {
    return [];
  }
}

function inferCollectionFieldsMeta(collectionMeta) {
  const fields = Array.isArray(collectionMeta?.fields) ? collectionMeta.fields : [];
  const byLower = new Map();
  for (const f of fields) {
    if (!f || !f.name) continue;
    byLower.set(String(f.name).toLowerCase(), f);
  }

  let statusFieldObj = null;
  for (const cand of ['status', 'stage', 'state', 'workflowstatus']) {
    if (byLower.has(cand)) {
      statusFieldObj = byLower.get(cand);
      break;
    }
  }
  if (!statusFieldObj) {
    statusFieldObj = fields.find((f) => Array.isArray(f?.enumValues) && f.enumValues.length > 0)
      || fields.find((f) => f?.interface === 'select' || f?.type === 'enum')
      || null;
  }
  const statusField = statusFieldObj?.name || 'status';

  const rawEnums = Array.isArray(statusFieldObj?.enumValues) ? statusFieldObj.enumValues : [];
  const stages = [];
  const seenStages = new Set();
  for (const item of rawEnums) {
    const value = item && typeof item === 'object' ? String(item.value ?? item.label ?? '').trim() : String(item ?? '').trim();
    const label = item && typeof item === 'object' ? String(item.label ?? item.value ?? '').trim() : value;
    if (!value || seenStages.has(value)) continue;
    seenStages.add(value);
    stages.push({ value, label: label || value });
  }

  const preferredBusinessDates = ['dueDate', 'scheduledAt', 'startDate', 'expiryDate', 'submittedAt'];
  const dateFields = [];
  const seenDates = new Set();
  for (const pref of preferredBusinessDates) {
    const hit = byLower.get(pref.toLowerCase());
    if (hit && !seenDates.has(hit.name)) {
      seenDates.add(hit.name);
      dateFields.push(hit.name);
    }
  }
  for (const f of fields) {
    if (!f?.name || seenDates.has(f.name) || f.name === 'createdAt' || f.name === 'updatedAt') continue;
    const t = String(f.type || '').toLowerCase();
    const iface = String(f.interface || '').toLowerCase();
    if (['date', 'datetime'].includes(t) || ['datetime', 'date'].includes(iface)) {
      seenDates.add(f.name);
      dateFields.push(f.name);
    }
  }
  const createdAtField = byLower.get('createdat');
  if (createdAtField && !seenDates.has(createdAtField.name)) {
    seenDates.add(createdAtField.name);
    dateFields.push(createdAtField.name);
  }
  for (const fallbackDate of [...preferredBusinessDates, 'createdAt']) {
    if (!seenDates.has(fallbackDate)) {
      seenDates.add(fallbackDate);
      dateFields.push(fallbackDate);
    }
  }

  let titleFieldObj = null;
  for (const cand of ['title', 'name', 'subject', 'summary', 'productname', 'label']) {
    if (byLower.has(cand)) {
      titleFieldObj = byLower.get(cand);
      break;
    }
  }
  if (!titleFieldObj) {
    titleFieldObj = fields.find((f) => {
      if (!f?.name) return false;
      const lower = String(f.name).toLowerCase();
      if (f.name === statusField || ['id', 'code', 'lotcode', 'organizationid'].includes(lower)) return false;
      const t = String(f.type || '').toLowerCase();
      return t === 'string' || t === 'text';
    }) || byLower.get('code') || byLower.get('lotcode') || null;
  }
  const titleField = titleFieldObj?.name || 'name';

  const latCand = ['lat', 'latitude', 'geolat', 'y'];
  const lngCand = ['lng', 'lon', 'longitude', 'geolng', 'x'];
  const latFieldObj = latCand.map((c) => byLower.get(c)).find(Boolean)
    || fields.find((f) => /(?:^|_)(?:lat|latitude)$|(?:geo|gps|coord|pos)lat$/i.test(String(f?.name || '')))
    || null;
  const lngFieldObj = lngCand.map((c) => byLower.get(c)).find(Boolean)
    || fields.find((f) => /(?:^|_)(?:lng|lon|longitude)$|(?:geo|gps|coord|pos)(?:lng|lon)$/i.test(String(f?.name || '')))
    || null;

  return {
    statusField,
    stages,
    dateFields,
    titleField,
    latField: latFieldObj?.name || null,
    lngField: lngFieldObj?.name || null,
  };
}

module.exports = {
  SAFE_COLLECTION_RE,
  CUSTOM_COLLECTION_RE,
  isSafeAppPath,
  safeJsonParse,
  filterHeroActions,
  parseKpiMetrics,
  fetchWorkflowTasks,
  fetchParaVault,
  fetchParaSummary,
  inferPortalSlugFromLocation,
  fetchPortalAgents,
  triggerDxosAgent,
  createAgentStripElement,
  triggerBase64Download,
  requestAndDownloadExport,
  resolveClientAuthToken,
  subscribeCollectionsMeta,
  fetchCollectionsMeta,
  inferCollectionFieldsMeta,
};

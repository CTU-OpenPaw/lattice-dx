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

module.exports = {
  isSafeAppPath,
  safeJsonParse,
  filterHeroActions,
  parseKpiMetrics,
  fetchWorkflowTasks,
  fetchParaVault,
};

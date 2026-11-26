/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function failPlan(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function assertNoPrototypePollution(value, pathPrefix = 'payload', depth = 0) {
  if (depth > 24) {
    throw failPlan('PAYLOAD_DEPTH_EXCEEDED', 400, 'Cấu trúc dữ liệu quá sâu.');
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoPrototypePollution(value[i], `${pathPrefix}[${i}]`, depth + 1);
    }
    return value;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) {
      throw failPlan('PROTOTYPE_POLLUTION_FORBIDDEN', 400, `Khóa không hợp lệ "${key}" tại ${pathPrefix}.`);
    }
    assertNoPrototypePollution(value[key], `${pathPrefix}.${key}`, depth + 1);
  }
  return value;
}

function cloneSafeDeep(value, depth = 0) {
  if (depth > 24) {
    throw failPlan('PAYLOAD_DEPTH_EXCEEDED', 400, 'Cấu trúc dữ liệu quá sâu.');
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneSafeDeep(item, depth + 1));
  const out = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) {
      throw failPlan('PROTOTYPE_POLLUTION_FORBIDDEN', 400, `Khóa không hợp lệ "${key}".`);
    }
    out[key] = cloneSafeDeep(value[key], depth + 1);
  }
  return out;
}

function stripDiacriticsSimple(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function extractCollectionsFromSpec(spec = {}) {
  if (Array.isArray(spec.collections) && spec.collections.length > 0) {
    return spec.collections.map((c) => ({
      ...c,
      collectionName: String(c?.collectionName || c?.name || '').trim(),
      collectionTitle: String(c?.collectionTitle || c?.title || c?.collectionName || c?.name || '').trim(),
      fields: Array.isArray(c?.fields) ? c.fields.map((f) => ({ ...f })) : [],
    }));
  }
  if (spec.collectionName) {
    return [{
      collectionName: String(spec.collectionName).trim(),
      collectionTitle: String(spec.collectionTitle || spec.pageTitle || spec.title || spec.name || spec.collectionName).trim(),
      fields: Array.isArray(spec.fields) ? spec.fields.map((f) => ({ ...f })) : [],
    }];
  }
  return [];
}

function extractPortalsFromSpec(spec = {}, defaultCollectionName = '') {
  if (Array.isArray(spec.portals) && spec.portals.length > 0) {
    return spec.portals.map((p) => ({
      portalSlug: String(p?.portalSlug || p?.slug || spec.portalSlug || 'services').trim().toLowerCase(),
      pageTitle: String(p?.pageTitle || p?.title || spec.pageTitle || spec.name || 'Phân hệ Mới').trim(),
      roleName: p?.roleName || p?.role || spec.roleName || null,
      roleTitle: p?.roleTitle || spec.roleTitle || null,
      collectionName: String(p?.collectionName || p?.collection || defaultCollectionName).trim(),
      creativeTheme: p?.creativeTheme || spec.creativeTheme || 'industrial-cockpit',
      blocks: Array.isArray(p?.blocks) ? p.blocks.map((b) => ({ ...b })) : [],
    }));
  }
  if (spec.portalSlug || spec.pageTitle || (Array.isArray(spec.blocks) && spec.blocks.length)) {
    return [{
      portalSlug: String(spec.portalSlug || 'services').trim().toLowerCase(),
      pageTitle: String(spec.pageTitle || spec.title || spec.name || 'Phân hệ Doanh nghiệp Mới').trim(),
      roleName: spec.roleName || null,
      roleTitle: spec.roleTitle || null,
      collectionName: defaultCollectionName,
      creativeTheme: spec.creativeTheme || 'industrial-cockpit',
      blocks: Array.isArray(spec.blocks) ? spec.blocks.map((b) => ({ ...b })) : [],
    }];
  }
  return [];
}

function parseNaturalAppPlanOrPatch(promptText, baseSpec = {}) {
  const raw = String(promptText || '').trim();
  if (!raw) return {};
  const n = stripDiacriticsSimple(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  const patch = {};

  const existingCols = extractCollectionsFromSpec(baseSpec);
  const matchedCol = raw.match(/\b(latticeCustom[A-Z][A-Za-z0-9]{1,40})\b/)?.[1]
    || existingCols[0]?.collectionName
    || null;

  // Detect "thêm trường <fieldName>" / "add field <fieldName>"
  const fieldMatches = [
    ...raw.matchAll(/(?:thêm|bổ\s+sung|add)\s+(?:trường|cột|field)\s+([a-z][a-zA-Z0-9_]{1,48})/gi),
  ];
  if (fieldMatches.length && matchedCol) {
    let fieldType = 'string';
    if (/\b(integer|so nguyen)\b/.test(n)) fieldType = 'integer';
    else if (/\b(float|so thuc|tien|amount|price|discount)\b/.test(n)) fieldType = 'float';
    else if (/\b(boolean|co\/khong|checkbox)\b/.test(n)) fieldType = 'boolean';
    else if (/\b(datetime|ngay gio)\b/.test(n)) fieldType = 'datetime';
    else if (/\b(date|ngay)\b/.test(n)) fieldType = 'date';
    else if (/\b(text|van ban|mo ta|ghi chu)\b/.test(n)) fieldType = 'text';
    else if (/\b(json)\b/.test(n)) fieldType = 'json';
    patch.addFields = fieldMatches.map((m) => ({
      collectionName: matchedCol,
      name: m[1].trim(),
      type: fieldType,
      title: m[1].trim(),
    }));
  } else if (/(?:them|bo\s+sung|add)\s+(?:truong|cot|field)\s+([a-z][a-zA-Z0-9_]{1,48})/i.test(n) && matchedCol) {
    const m = n.match(/(?:them|bo\s+sung|add)\s+(?:truong|cot|field)\s+([a-z][a-zA-Z0-9_]{1,48})/i);
    if (m?.[1]) {
      patch.addFields = [{ collectionName: matchedCol, name: m[1].trim(), type: 'string', title: m[1].trim() }];
    }
  }

  // Detect adding BI chart / Kanban / WebGIS block
  if (/(?:them|gan|bo\s+sung)\s+(?:khoi|block)?[^\n]{0,40}(?:bi\s+chart|bieu\s+do\s+bi|dxosbichartblockmodel)/i.test(n)) {
    const colForBlock = matchedCol || 'latticeOrders';
    patch.addBlocks = [{
      blockUse: 'DxosBiChartBlockModel',
      title: 'Phân tích BI',
      collection: colForBlock,
      chartType: n.includes('pie') || n.includes('tron') ? 'pie' : (n.includes('line') || n.includes('duong') ? 'line' : 'bar'),
      groupBy: 'status',
      metricOp: 'count',
    }];
  } else if (/(?:them|gan|bo\s+sung)\s+(?:khoi|block)?[^\n]{0,40}(?:kanban|dxoskanbanscheduleblockmodel)/i.test(n) && matchedCol) {
    patch.addBlocks = [{
      blockUse: 'DxosKanbanScheduleBlockModel',
      title: 'Bảng Kanban',
      collection: matchedCol,
      statusField: 'status',
    }];
  } else if (/(?:them|gan|bo\s+sung)\s+(?:khoi|block)?[^\n]{0,40}(?:webgis|ban\s+do|dxoswebgisblockmodel)/i.test(n) && matchedCol) {
    patch.addBlocks = [{
      blockUse: 'DxosWebGisBlockModel',
      title: 'Bản đồ WebGIS',
      collection: matchedCol,
    }];
  }

  return patch;
}

function getPatchBucketItemKey(bucketName, item, defaultColName = '') {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') {
    const raw = String(item).trim();
    if (bucketName === 'deprecateFields') return raw ? `${defaultColName}::${raw}` : '';
    return raw;
  }
  switch (bucketName) {
    case 'addCollections':
      return String(item.collectionName || item.name || '').trim();
    case 'addFields':
    case 'updateFields':
    case 'deprecateFields': {
      const col = String(item.collectionName || defaultColName || '').trim();
      const fn = String(item.name || item.fieldName || '').trim();
      return fn ? `${col}::${fn}` : '';
    }
    case 'addRelations': {
      const col = String(item.collectionName || item.sourceCollection || defaultColName || '').trim();
      const fn = String(item.name || '').trim();
      return fn ? `${col}::${fn}` : '';
    }
    case 'addBlocks': {
      const pSlug = String(item.portalSlug || '').trim().toLowerCase();
      const blkId = String(item.uid || item.title || item.blockUse || item.use || '').trim();
      return blkId ? `${pSlug}::${blkId}` : '';
    }
    case 'removeBlocks':
      return String(item.uid || item.title || item.blockUse || item.use || '').trim();
    case 'addRoles':
    case 'updateRoles':
      return String(item.roleName || item.name || '').trim();
    case 'addFlows':
    case 'updateFlows':
      return String(item.ruleKey || '').trim();
    case 'addDmnTables':
    case 'updateDmnTables':
      return String(item.tableKey || '').trim();
    default:
      return '';
  }
}

function mergeArrayPatchBucket(bucketName, nlArr, explicitArr, defaultColName = '') {
  const hasNl = Array.isArray(nlArr);
  const hasExp = Array.isArray(explicitArr);
  if (!hasNl && !hasExp) return undefined;
  const merged = [];
  const keyToIndex = new Map();
  const pushItem = (item, fromExplicit) => {
    if (item === null || item === undefined) return;
    const key = getPatchBucketItemKey(bucketName, item, defaultColName);
    if (!key) {
      merged.push(item);
      return;
    }
    if (keyToIndex.has(key)) {
      const idx = keyToIndex.get(key);
      if (fromExplicit) {
        const prev = merged[idx];
        merged[idx] = (prev && typeof prev === 'object' && typeof item === 'object' && !Array.isArray(prev) && !Array.isArray(item))
          ? { ...prev, ...item }
          : item;
      }
      return;
    }
    keyToIndex.set(key, merged.length);
    merged.push(item);
  };
  if (hasNl) {
    for (const item of nlArr) pushItem(item, false);
  }
  if (hasExp) {
    for (const item of explicitArr) pushItem(item, true);
  }
  return merged;
}

const ARRAY_PATCH_BUCKETS = [
  'addCollections',
  'addFields',
  'updateFields',
  'deprecateFields',
  'addRelations',
  'addBlocks',
  'removeBlocks',
  'addRoles',
  'updateRoles',
  'addFlows',
  'updateFlows',
  'addDmnTables',
  'updateDmnTables',
];

function applySpecPatch(baseSpec = {}, rawPatch = null, promptText = '') {
  const safeBase = cloneSafeDeep(baseSpec || {});
  const nlPatch = promptText ? parseNaturalAppPlanOrPatch(promptText, safeBase) : {};
  const explicitPatch = rawPatch && typeof rawPatch === 'object' ? cloneSafeDeep(rawPatch) : {};

  // Merge NL-derived patch with explicit patch (merge array buckets so NL additions are preserved alongside explicit items)
  const initialColName = extractCollectionsFromSpec(safeBase)[0]?.collectionName || '';
  const patch = {
    ...nlPatch,
    ...explicitPatch,
  };
  for (const bucket of ARRAY_PATCH_BUCKETS) {
    if (Array.isArray(nlPatch[bucket]) || Array.isArray(explicitPatch[bucket])) {
      patch[bucket] = mergeArrayPatchBucket(bucket, nlPatch[bucket], explicitPatch[bucket], initialColName);
    }
  }

  // Start working copies
  let collections = extractCollectionsFromSpec(safeBase);
  const ensureColEntry = (colName) => {
    let entry = collections.find((c) => c.collectionName === colName);
    if (!entry) {
      entry = { collectionName: colName, collectionTitle: colName, fields: [] };
      collections.push(entry);
    }
    return entry;
  };

  // Direct top-level overrides (legacy specPatch style)
  if (patch.name) safeBase.name = patch.name;
  if (patch.appName) safeBase.appName = patch.appName;
  if (patch.pageTitle) safeBase.pageTitle = patch.pageTitle;
  if (patch.creativeTheme) safeBase.creativeTheme = patch.creativeTheme;
  if (Array.isArray(patch.collections)) {
    collections = patch.collections.map((c) => ({
      ...c,
      collectionName: String(c?.collectionName || c?.name || '').trim(),
      collectionTitle: String(c?.collectionTitle || c?.title || c?.collectionName || c?.name || '').trim(),
      fields: Array.isArray(c?.fields) ? c.fields.map((f) => ({ ...f })) : [],
    }));
  }

  // Incremental addCollections
  if (Array.isArray(patch.addCollections)) {
    for (const ac of patch.addCollections) {
      const colName = String(ac?.collectionName || ac?.name || '').trim();
      if (!colName) continue;
      const idx = collections.findIndex((c) => c.collectionName === colName);
      const nextCol = {
        ...ac,
        collectionName: colName,
        collectionTitle: String(ac?.collectionTitle || ac?.title || colName).trim(),
        fields: Array.isArray(ac?.fields) ? ac.fields.map((f) => ({ ...f })) : [],
      };
      if (idx >= 0) {
        const existingFields = collections[idx].fields || [];
        const byName = new Map(existingFields.map((f) => [f.name, { ...f }]));
        for (const nf of nextCol.fields) byName.set(nf.name, { ...(byName.get(nf.name) || {}), ...nf });
        collections[idx] = { ...collections[idx], ...nextCol, fields: [...byName.values()] };
      } else {
        collections.push(nextCol);
      }
    }
  }

  // Incremental addFields / addRelations (re-adding an existing field clears deprecated unless explicitly set)
  const fieldAdditions = [
    ...(Array.isArray(patch.addFields) ? patch.addFields : []),
    ...(Array.isArray(patch.addRelations) ? patch.addRelations : []),
  ];
  for (const af of fieldAdditions) {
    const colName = String(af?.collectionName || af?.sourceCollection || collections[0]?.collectionName || '').trim();
    if (!colName) continue;
    const entry = ensureColEntry(colName);
    const { collectionName: _cn, sourceCollection: _sc, ...fieldSpec } = af;
    const fIdx = entry.fields.findIndex((f) => f.name === fieldSpec.name);
    if (fIdx >= 0) {
      const mergedField = { ...entry.fields[fIdx], ...fieldSpec };
      if (fieldSpec.deprecated !== true) {
        delete mergedField.deprecated;
        delete mergedField.deprecatedAt;
        delete mergedField.deprecatedReason;
        if (fieldSpec.readOnly !== true) delete mergedField.readOnly;
        if (mergedField.uiSchema && typeof mergedField.uiSchema === 'object') {
          const cleanUi = { ...mergedField.uiSchema };
          delete cleanUi.deprecated;
          delete cleanUi.deprecatedAt;
          delete cleanUi.deprecatedReason;
          delete cleanUi['x-hidden'];
          if (fieldSpec.readOnly !== true && fieldSpec.uiSchema?.readOnly !== true) delete cleanUi.readOnly;
          mergedField.uiSchema = cleanUi;
        }
        if (mergedField.options && typeof mergedField.options === 'object') {
          const cleanOpts = { ...mergedField.options };
          delete cleanOpts.deprecated;
          delete cleanOpts.deprecatedAt;
          delete cleanOpts.deprecatedReason;
          if (fieldSpec.readOnly !== true && fieldSpec.options?.readOnly !== true) delete cleanOpts.readOnly;
          mergedField.options = cleanOpts;
        }
      }
      entry.fields[fIdx] = mergedField;
    } else {
      entry.fields.push(fieldSpec);
    }
  }

  // Incremental updateFields
  if (Array.isArray(patch.updateFields)) {
    for (const uf of patch.updateFields) {
      const colName = String(uf?.collectionName || collections[0]?.collectionName || '').trim();
      const entry = collections.find((c) => c.collectionName === colName);
      if (!entry) continue;
      const fIdx = entry.fields.findIndex((f) => f.name === (uf.name || uf.fieldName));
      const { collectionName: _cn, fieldName: _fn, ...updates } = uf;
      if (fIdx >= 0) entry.fields[fIdx] = { ...entry.fields[fIdx], ...updates };
    }
  }

  // Incremental deprecateFields (non-destructive marker in spec)
  if (Array.isArray(patch.deprecateFields)) {
    for (const df of patch.deprecateFields) {
      const colName = String(df?.collectionName || collections[0]?.collectionName || '').trim();
      const fname = String(df?.name || df?.fieldName || df || '').trim();
      const entry = collections.find((c) => c.collectionName === colName);
      if (!entry || !fname) continue;
      const fIdx = entry.fields.findIndex((f) => f.name === fname);
      if (fIdx >= 0) {
        const depReason = df?.reason || df?.deprecatedReason || entry.fields[fIdx].deprecatedReason || null;
        const depAt = df?.deprecatedAt || entry.fields[fIdx].deprecatedAt || new Date().toISOString();
        entry.fields[fIdx] = {
          ...entry.fields[fIdx],
          deprecated: true,
          deprecatedAt: depAt,
          ...(depReason ? { deprecatedReason: depReason } : {}),
          readOnly: true,
          uiSchema: {
            ...(entry.fields[fIdx].uiSchema || {}),
            deprecated: true,
            deprecatedAt: depAt,
            ...(depReason ? { deprecatedReason: depReason } : {}),
            'x-hidden': true,
            readOnly: true,
          },
        };
      }
    }
  }

  // Persist normalized collections back into spec
  if (collections.length > 1 || Array.isArray(safeBase.collections) || Array.isArray(patch.addCollections)) {
    safeBase.collections = collections;
    delete safeBase.collectionName;
    delete safeBase.fields;
  } else if (collections.length === 1) {
    safeBase.collectionName = collections[0].collectionName;
    safeBase.collectionTitle = collections[0].collectionTitle;
    safeBase.fields = collections[0].fields;
  }

  // Portals & Blocks
  const defaultColName = collections[0]?.collectionName || safeBase.collectionName || '';
  let portals = extractPortalsFromSpec(safeBase, defaultColName);
  if (Array.isArray(patch.portals)) {
    portals = patch.portals.map((p) => ({ ...p }));
  }
  if (!portals.length) {
    portals = [{
      portalSlug: String(safeBase.portalSlug || 'services').trim().toLowerCase(),
      pageTitle: String(safeBase.pageTitle || safeBase.name || 'Phân hệ Doanh nghiệp').trim(),
      roleName: safeBase.roleName || null,
      roleTitle: safeBase.roleTitle || null,
      collectionName: defaultColName,
      creativeTheme: safeBase.creativeTheme || 'industrial-cockpit',
      blocks: Array.isArray(safeBase.blocks) ? [...safeBase.blocks] : [],
    }];
  }
  if (Array.isArray(patch.addBlocks) && patch.addBlocks.length) {
    for (const ab of patch.addBlocks) {
      const targetPortal = ab?.portalSlug
        ? (portals.find((p) => p.portalSlug === String(ab.portalSlug).trim().toLowerCase()) || portals[0])
        : portals[0];
      const { portalSlug: _ps, ...blkSpec } = ab;
      targetPortal.blocks = Array.isArray(targetPortal.blocks) ? [...targetPortal.blocks, blkSpec] : [blkSpec];
    }
  }
  if (Array.isArray(patch.removeBlocks) && patch.removeBlocks.length) {
    const rmSet = new Set(patch.removeBlocks.map((r) => String(typeof r === 'string' ? r : (r?.title || r?.blockUse || r?.use || '')).trim()).filter(Boolean));
    for (const p of portals) {
      p.blocks = (p.blocks || []).filter((b) => {
        const use = String(b?.blockUse || b?.use || '').trim();
        const title = String(b?.title || '').trim();
        return !rmSet.has(use) && !rmSet.has(title);
      });
    }
  }
  if (Array.isArray(safeBase.portals) || portals.length > 1) {
    safeBase.portals = portals;
    if (portals[0]?.blocks) safeBase.blocks = portals[0].blocks;
  } else if (portals[0]) {
    safeBase.portalSlug = portals[0].portalSlug;
    safeBase.pageTitle = portals[0].pageTitle;
    safeBase.blocks = portals[0].blocks;
  }

  // Roles
  let roles = Array.isArray(safeBase.roles) ? safeBase.roles.map((r) => ({ ...r })) : [];
  if (Array.isArray(patch.roles)) {
    roles = patch.roles.map((r) => ({ ...r }));
  }
  if (Array.isArray(patch.addRoles)) {
    for (const ar of patch.addRoles) {
      const rName = String(ar?.roleName || ar?.name || '').trim();
      const idx = roles.findIndex((r) => (r.roleName || r.name) === rName);
      if (idx >= 0) roles[idx] = { ...roles[idx], ...ar };
      else roles.push({ ...ar });
    }
  }
  if (Array.isArray(patch.updateRoles)) {
    for (const ur of patch.updateRoles) {
      const rName = String(ur?.roleName || ur?.name || '').trim();
      const idx = roles.findIndex((r) => (r.roleName || r.name) === rName);
      if (idx >= 0) roles[idx] = { ...roles[idx], ...ur };
    }
  }
  if (roles.length) safeBase.roles = roles;

  // DMN Tables
  let dmnTables = [
    ...(Array.isArray(safeBase.dmnTables) ? safeBase.dmnTables.map((d) => ({ ...d })) : []),
    ...(safeBase.dmnTable ? [{ ...safeBase.dmnTable }] : []),
  ];
  if (Array.isArray(patch.dmnTables)) dmnTables = patch.dmnTables.map((d) => ({ ...d }));
  for (const dt of [...(Array.isArray(patch.addDmnTables) ? patch.addDmnTables : []), ...(Array.isArray(patch.updateDmnTables) ? patch.updateDmnTables : [])]) {
    const idx = dmnTables.findIndex((d) => d.tableKey === dt.tableKey);
    if (idx >= 0) dmnTables[idx] = { ...dmnTables[idx], ...dt };
    else dmnTables.push({ ...dt });
  }
  if (dmnTables.length) {
    safeBase.dmnTables = dmnTables;
    delete safeBase.dmnTable;
  }

  // Flows
  let flowGraphs = [
    ...(Array.isArray(safeBase.flowGraphs) ? safeBase.flowGraphs.map((f) => ({ ...f })) : []),
    ...(safeBase.flowGraph ? [{ ...safeBase.flowGraph }] : []),
  ];
  if (Array.isArray(patch.flowGraphs)) flowGraphs = patch.flowGraphs.map((f) => ({ ...f }));
  for (const fg of [...(Array.isArray(patch.addFlows) ? patch.addFlows : []), ...(Array.isArray(patch.updateFlows) ? patch.updateFlows : [])]) {
    const idx = flowGraphs.findIndex((f) => f.ruleKey === fg.ruleKey);
    if (idx >= 0) flowGraphs[idx] = { ...flowGraphs[idx], ...fg };
    else flowGraphs.push({ ...fg });
  }
  if (flowGraphs.length) {
    safeBase.flowGraphs = flowGraphs;
    delete safeBase.flowGraph;
  }

  return safeBase;
}

function buildErGraph(sortedCollections = []) {
  const nodeMap = new Map();
  const edges = [];

  for (const col of sortedCollections) {
    const fields = Array.isArray(col.normalizedFields) ? col.normalizedFields : [];
    nodeMap.set(col.collectionName, {
      id: col.collectionName,
      label: col.collectionTitle || col.collectionName,
      kind: 'entity',
      fields: fields.map((f) => ({
        name: f.name,
        type: f.interface === 'formula' ? 'formula' : f.type,
        title: f.uiSchema?.title || f.title || f.name,
        required: Boolean(f.validation?.required || f.required || f.allowNull === false),
        unique: Boolean(f.validation?.unique),
        indexed: Boolean(f.index),
        validation: f.validation || null,
        formulaExpression: f.formulaExpression || f.formula || null,
        formulaReturnType: f.formulaReturnType || null,
        target: f.target || null,
        through: f.through || null,
        foreignKey: f.foreignKey || null,
        otherKey: f.otherKey || null,
        enumValues: Array.isArray(f.enum) ? f.enum : (Array.isArray(f.validation?.enum) ? f.validation.enum : null),
      })),
    });
  }

  for (const col of sortedCollections) {
    const fields = Array.isArray(col.normalizedFields) ? col.normalizedFields : [];
    for (const f of fields) {
      if (!['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(f.type) || !f.target) continue;
      if (!nodeMap.has(f.target)) {
        nodeMap.set(f.target, {
          id: f.target,
          label: f.target,
          kind: 'external',
          fields: [
            { name: 'id', type: 'bigInt', title: 'ID' },
            { name: 'organizationId', type: 'string', title: 'Org' },
          ],
        });
      }
      if (f.type === 'belongsToMany' && f.through && !nodeMap.has(f.through)) {
        nodeMap.set(f.through, {
          id: f.through,
          label: f.through,
          kind: 'join',
          fields: [
            { name: 'organizationId', type: 'string', title: 'Org', required: true, indexed: true },
            { name: f.foreignKey, type: 'bigInt', title: f.foreignKey, required: true, indexed: true },
            { name: f.otherKey, type: 'bigInt', title: f.otherKey, required: true, indexed: true },
          ],
        });
      }
      edges.push({
        id: `${col.collectionName}.${f.name}->${f.target}`,
        source: col.collectionName,
        target: f.target,
        type: f.type,
        fieldName: f.name,
        foreignKey: f.foreignKey || null,
        targetKey: f.targetKey || null,
        sourceKey: f.sourceKey || null,
        through: f.through || null,
        otherKey: f.otherKey || null,
      });
    }
  }

  return {
    nodes: [...nodeMap.values()],
    edges,
  };
}

function diffKeyMaps(beforeMap, afterMap) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [k, afterVal] of afterMap.entries()) {
    if (!beforeMap.has(k)) {
      added.push(k);
    } else if (JSON.stringify(beforeMap.get(k)) !== JSON.stringify(afterVal)) {
      modified.push(k);
    }
  }
  for (const k of beforeMap.keys()) {
    if (!afterMap.has(k)) removed.push(k);
  }
  return { added, modified, removed };
}

function computeSpecDiff(baseSpec = null, candidateSpec = {}, baseSorted = [], candidateSorted = [], baseRoles = [], candidateRoles = [], basePortals = [], candidatePortals = []) {
  const hasBase = Boolean(baseSpec && (baseSorted.length > 0 || baseRoles.length > 0 || basePortals.length > 0));
  const emptyBuckets = () => ({ added: [], modified: [], removed: [] });

  const baseColMap = new Map((hasBase ? baseSorted : []).map((c) => [c.collectionName, c.normalizedFields]));
  const candColMap = new Map(candidateSorted.map((c) => [c.collectionName, c.normalizedFields]));
  const collections = diffKeyMaps(baseColMap, candColMap);

  const baseFieldMap = new Map();
  const candFieldMap = new Map();
  const baseRelMap = new Map();
  const candRelMap = new Map();

  for (const c of (hasBase ? baseSorted : [])) {
    for (const f of c.normalizedFields || []) {
      const key = `${c.collectionName}.${f.name}`;
      baseFieldMap.set(key, f);
      if (['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(f.type)) {
        baseRelMap.set(key, { type: f.type, target: f.target, through: f.through || null, foreignKey: f.foreignKey || null, otherKey: f.otherKey || null });
      }
    }
  }
  for (const c of candidateSorted) {
    for (const f of c.normalizedFields || []) {
      const key = `${c.collectionName}.${f.name}`;
      candFieldMap.set(key, f);
      if (['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(f.type)) {
        candRelMap.set(key, { type: f.type, target: f.target, through: f.through || null, foreignKey: f.foreignKey || null, otherKey: f.otherKey || null });
      }
    }
  }

  const fields = diffKeyMaps(baseFieldMap, candFieldMap);
  const relations = diffKeyMaps(baseRelMap, candRelMap);

  const baseRoleMap = new Map((hasBase ? baseRoles : []).map((r) => [r.roleName, r]));
  const candRoleMap = new Map(candidateRoles.map((r) => [r.roleName, r]));
  const roles = diffKeyMaps(baseRoleMap, candRoleMap);

  const basePageMap = new Map((hasBase ? basePortals : []).map((p) => [`${p.portalSlug}:${p.pageTitle}`, p]));
  const candPageMap = new Map(candidatePortals.map((p) => [`${p.portalSlug}:${p.pageTitle}`, p]));
  const pages = diffKeyMaps(basePageMap, candPageMap);

  const baseBlockMap = new Map();
  const candBlockMap = new Map();
  for (const p of (hasBase ? basePortals : [])) {
    (p.blocks || []).forEach((b, idx) => {
      const use = String(b?.blockUse || b?.use || '').trim();
      const title = String(b?.title || use || idx).trim();
      baseBlockMap.set(`${p.portalSlug}:${use}:${title}`, b);
    });
  }
  for (const p of candidatePortals) {
    (p.blocks || []).forEach((b, idx) => {
      const use = String(b?.blockUse || b?.use || '').trim();
      const title = String(b?.title || use || idx).trim();
      candBlockMap.set(`${p.portalSlug}:${use}:${title}`, b);
    });
  }
  const blocks = diffKeyMaps(baseBlockMap, candBlockMap);

  const baseDmnList = hasBase ? [...(Array.isArray(baseSpec?.dmnTables) ? baseSpec.dmnTables : []), ...(baseSpec?.dmnTable ? [baseSpec.dmnTable] : [])] : [];
  const candDmnList = [...(Array.isArray(candidateSpec?.dmnTables) ? candidateSpec.dmnTables : []), ...(candidateSpec?.dmnTable ? [candidateSpec.dmnTable] : [])];
  const dmnTables = diffKeyMaps(
    new Map(baseDmnList.filter((d) => d?.tableKey).map((d) => [d.tableKey, d])),
    new Map(candDmnList.filter((d) => d?.tableKey).map((d) => [d.tableKey, d])),
  );

  const baseFlowList = hasBase ? [...(Array.isArray(baseSpec?.flowGraphs) ? baseSpec.flowGraphs : []), ...(baseSpec?.flowGraph ? [baseSpec.flowGraph] : [])] : [];
  const candFlowList = [...(Array.isArray(candidateSpec?.flowGraphs) ? candidateSpec.flowGraphs : []), ...(candidateSpec?.flowGraph ? [candidateSpec.flowGraph] : [])];
  const flows = diffKeyMaps(
    new Map(baseFlowList.filter((f) => f?.ruleKey).map((f) => [f.ruleKey, f])),
    new Map(candFlowList.filter((f) => f?.ruleKey).map((f) => [f.ruleKey, f])),
  );

  const cats = [collections, fields, relations, roles, pages, blocks, flows, dmnTables];
  const hasChanges = cats.some((c) => c.added.length > 0 || c.modified.length > 0 || c.removed.length > 0);
  const summary = `collections(+${collections.added.length}/~${collections.modified.length}/-${collections.removed.length}), fields(+${fields.added.length}/~${fields.modified.length}/-${fields.removed.length}), blocks(+${blocks.added.length}/-${blocks.removed.length})`;

  return {
    collections: collections || emptyBuckets(),
    fields: fields || emptyBuckets(),
    relations: relations || emptyBuckets(),
    roles: roles || emptyBuckets(),
    pages: pages || emptyBuckets(),
    blocks: blocks || emptyBuckets(),
    flows: flows || emptyBuckets(),
    dmnTables: dmnTables || emptyBuckets(),
    hasChanges,
    summary,
  };
}

function buildDraftSpecFromNaturalPrompt(promptText = '') {
  const raw = String(promptText || '').trim();
  const norm = stripDiacriticsSimple(raw).toLowerCase().replace(/\s+/g, ' ').trim();

  if (/(phong\s*kham|benh\s*nhan|kham\s*benh|don\s*thuoc|clinic|medical)/i.test(norm)) {
    return {
      appKey: 'clinic-suite',
      appName: 'Quản lý Phòng khám Đa khoa',
      creativeTheme: 'clean-light',
      collections: [
        {
          collectionName: 'latticeCustomClinicPatients',
          collectionTitle: 'Bệnh nhân',
          fields: [
            { name: 'code', type: 'string', title: 'Mã bệnh nhân', required: true, unique: true },
            { name: 'fullName', type: 'string', title: 'Họ và tên', required: true },
            { name: 'phone', type: 'string', title: 'Số điện thoại' },
            { name: 'allergies', type: 'text', title: 'Tiền sử dị ứng' },
            { name: 'status', type: 'string', title: 'Trạng thái' },
          ],
        },
        {
          collectionName: 'latticeCustomClinicVisits',
          collectionTitle: 'Phiếu Khám bệnh',
          fields: [
            { name: 'visitCode', type: 'string', title: 'Mã lượt khám', required: true, unique: true },
            { name: 'patient', type: 'belongsTo', target: 'latticeCustomClinicPatients', title: 'Bệnh nhân' },
            { name: 'doctorName', type: 'string', title: 'Bác sĩ phụ trách' },
            { name: 'diagnosis', type: 'text', title: 'Chẩn đoán' },
            { name: 'feeVnd', type: 'float', title: 'Phí khám (VNĐ)' },
            { name: 'status', type: 'string', title: 'Trạng thái' },
          ],
        },
        {
          collectionName: 'latticeCustomClinicPrescriptions',
          collectionTitle: 'Đơn thuốc',
          fields: [
            { name: 'rxCode', type: 'string', title: 'Mã đơn thuốc', required: true },
            { name: 'visit', type: 'belongsTo', target: 'latticeCustomClinicVisits', title: 'Phiếu khám' },
            { name: 'medication', type: 'string', title: 'Tên thuốc' },
            { name: 'quantity', type: 'integer', title: 'Số lượng' },
            { name: 'unitPrice', type: 'float', title: 'Đơn giá' },
            { name: 'totalAmount', type: 'formula', interface: 'formula', formulaExpression: 'quantity * unitPrice', formulaReturnType: 'float', title: 'Thành tiền' },
          ],
        },
      ],
      roles: [{ roleName: 'ldx_clinic_staff', roleTitle: 'Nhân viên Phòng khám' }],
      portals: [{
        portalSlug: 'clinic-ops',
        pageTitle: 'Quản lý Phòng khám Đa khoa',
        roleName: 'ldx_clinic_staff',
        collectionName: 'latticeCustomClinicVisits',
        creativeTheme: 'clean-light',
        blocks: [
          { blockUse: 'DxosPortalHeroBlockModel', title: 'Cổng Phòng khám Đa khoa' },
          { blockUse: 'DxosRecordWorkbenchBlockModel', title: 'Hàng chờ Khám bệnh', collection: 'latticeCustomClinicVisits' },
          { blockUse: 'DxosBiChartBlockModel', title: 'Thống kê Lượt khám theo Trạng thái', collection: 'latticeCustomClinicVisits', chartType: 'bar', groupBy: 'status', metricOp: 'count' },
        ],
      }],
    };
  }

  if (/(crm|ban\s*hang|co\s*hoi|bao\s*gia|khach\s*hang|b2b|deal|pipeline)/i.test(norm)) {
    return {
      appKey: 'b2b-crm-suite',
      appName: 'CRM Bán hàng B2B',
      creativeTheme: 'royal-indigo',
      collections: [
        {
          collectionName: 'latticeCustomCrmAccounts',
          collectionTitle: 'Khách hàng Doanh nghiệp',
          fields: [
            { name: 'code', type: 'string', title: 'Mã KH', required: true, unique: true },
            { name: 'companyName', type: 'string', title: 'Tên doanh nghiệp', required: true },
            { name: 'taxCode', type: 'string', title: 'Mã số thuế' },
            { name: 'tier', type: 'string', title: 'Phân hạng' },
            { name: 'status', type: 'string', title: 'Trạng thái' },
          ],
        },
        {
          collectionName: 'latticeCustomCrmDeals',
          collectionTitle: 'Cơ hội Kinh doanh B2B',
          fields: [
            { name: 'dealCode', type: 'string', title: 'Mã cơ hội', required: true, unique: true },
            { name: 'title', type: 'string', title: 'Tên cơ hội', required: true },
            { name: 'account', type: 'belongsTo', target: 'latticeCustomCrmAccounts', title: 'Khách hàng' },
            { name: 'stage', type: 'string', title: 'Giai đoạn' },
            { name: 'valueVnd', type: 'float', title: 'Giá trị (VNĐ)' },
            { name: 'probability', type: 'float', title: 'Xác suất (%)' },
            { name: 'expectedRevenue', type: 'formula', interface: 'formula', formulaExpression: 'valueVnd * probability / 100', formulaReturnType: 'float', title: 'Doanh thu kỳ vọng' },
          ],
        },
      ],
      roles: [{ roleName: 'ldx_crm_sales', roleTitle: 'Kinh doanh B2B' }],
      portals: [{
        portalSlug: 'b2b-crm',
        pageTitle: 'CRM Bán hàng B2B',
        roleName: 'ldx_crm_sales',
        collectionName: 'latticeCustomCrmDeals',
        creativeTheme: 'royal-indigo',
        blocks: [
          { blockUse: 'DxosPortalHeroBlockModel', title: 'CRM Bán hàng B2B' },
          { blockUse: 'DxosKanbanScheduleBlockModel', title: 'Pipeline Cơ hội B2B', collection: 'latticeCustomCrmDeals', statusField: 'stage' },
          { blockUse: 'DxosBiChartBlockModel', title: 'Giá trị Cơ hội theo Giai đoạn', collection: 'latticeCustomCrmDeals', chartType: 'bar', groupBy: 'stage', metricOp: 'sum', metricField: 'valueVnd' },
        ],
      }],
    };
  }

  if (/(itsm|ho\s*tro\s*noi\s*bo|helpdesk|ticket|su\s*co\s*it|yeu\s*cau\s*it)/i.test(norm)) {
    return {
      appKey: 'internal-itsm-suite',
      appName: 'ITSM Hỗ trợ Nội bộ',
      creativeTheme: 'industrial-cockpit',
      collections: [
        {
          collectionName: 'latticeCustomItAssets',
          collectionTitle: 'Tài sản & Thiết bị IT',
          fields: [
            { name: 'assetTag', type: 'string', title: 'Mã tài sản', required: true, unique: true },
            { name: 'name', type: 'string', title: 'Tên thiết bị', required: true },
            { name: 'category', type: 'string', title: 'Phân loại' },
            { name: 'status', type: 'string', title: 'Trạng thái' },
          ],
        },
        {
          collectionName: 'latticeCustomItTickets',
          collectionTitle: 'Phiếu Yêu cầu ITSM',
          fields: [
            { name: 'ticketCode', type: 'string', title: 'Mã phiếu', required: true, unique: true },
            { name: 'title', type: 'string', title: 'Tiêu đề sự cố', required: true },
            { name: 'asset', type: 'belongsTo', target: 'latticeCustomItAssets', title: 'Thiết bị liên quan' },
            { name: 'priority', type: 'string', title: 'Độ ưu tiên' },
            { name: 'slaHours', type: 'integer', title: 'Cam kết SLA (giờ)' },
            { name: 'status', type: 'string', title: 'Trạng thái' },
          ],
        },
      ],
      roles: [{ roleName: 'ldx_itsm_agent', roleTitle: 'Kỹ thuật viên ITSM' }],
      portals: [{
        portalSlug: 'itsm-desk',
        pageTitle: 'ITSM Hỗ trợ Nội bộ',
        roleName: 'ldx_itsm_agent',
        collectionName: 'latticeCustomItTickets',
        creativeTheme: 'industrial-cockpit',
        blocks: [
          { blockUse: 'DxosPortalHeroBlockModel', title: 'Bàn Hỗ trợ Kỹ thuật ITSM' },
          { blockUse: 'DxosRecordWorkbenchBlockModel', title: 'Hàng chờ Yêu cầu ITSM', collection: 'latticeCustomItTickets' },
          { blockUse: 'DxosBiChartBlockModel', title: 'Phân bố Mức độ Ưu tiên', collection: 'latticeCustomItTickets', chartType: 'pie', groupBy: 'priority', metricOp: 'count' },
        ],
      }],
    };
  }

  const words = norm.replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const slugBase = (words.join('-') || 'custom-app').slice(0, 28).replace(/^-+|-+$/g, '') || 'custom-app';
  const pascal = (words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'CustomApp').slice(0, 24);
  const colName = `latticeCustom${pascal}`;
  const roleSuffix = slugBase.replace(/-/g, '_').slice(0, 24) || 'custom_app';
  const title = raw.slice(0, 64) || 'Ứng dụng Doanh nghiệp Mới';

  return {
    appKey: `${slugBase}-app`,
    appName: title,
    creativeTheme: 'industrial-cockpit',
    collections: [
      {
        collectionName: colName,
        collectionTitle: title,
        fields: [
          { name: 'code', type: 'string', title: 'Mã hồ sơ', required: true, unique: true },
          { name: 'title', type: 'string', title: 'Tiêu đề', required: true },
          { name: 'description', type: 'text', title: 'Mô tả chi tiết' },
          { name: 'priority', type: 'string', title: 'Độ ưu tiên' },
          { name: 'status', type: 'string', title: 'Trạng thái' },
        ],
      },
    ],
    roles: [{ roleName: `ldx_${roleSuffix}`, roleTitle: `Điều hành ${title}` }],
    portals: [{
      portalSlug: slugBase,
      pageTitle: title,
      roleName: `ldx_${roleSuffix}`,
      collectionName: colName,
      creativeTheme: 'industrial-cockpit',
      blocks: [
        { blockUse: 'DxosPortalHeroBlockModel', title },
        { blockUse: 'DxosRecordWorkbenchBlockModel', title: `Quản lý ${title}`, collection: colName },
        { blockUse: 'DxosBiChartBlockModel', title: `Thống kê ${title}`, collection: colName, chartType: 'bar', groupBy: 'status', metricOp: 'count' },
      ],
    }],
  };
}

module.exports = {
  FORBIDDEN_PROTO_KEYS,
  assertNoPrototypePollution,
  cloneSafeDeep,
  buildDraftSpecFromNaturalPrompt,
  parseNaturalAppPlanOrPatch,
  applySpecPatch,
  buildErGraph,
  computeSpecDiff,
};

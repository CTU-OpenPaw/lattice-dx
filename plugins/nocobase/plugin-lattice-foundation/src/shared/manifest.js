// SPDX-License-Identifier: Apache-2.0
'use strict';
const id = /^[a-z][a-z0-9-]{0,63}$/;
const roles = /^[a-z][a-z0-9:_-]{0,79}$/;
const fieldName = /^[a-z][a-zA-Z0-9]{0,63}$/;
const actions = new Map([['records.create', ['records', 'records:write', ['title']]],
  ['tasks.create', ['tasks', 'tasks:assign', ['title', 'assigneeId', 'recordId']]],
  ['logistics.create',['orders','logistics:sales',['title','customerName','deliveryAddress','sku','quantity','warehouseAssigneeId','attachmentId']]]]);
const registries = new Set(['latticeDepartments', 'latticeEmployees', 'latticeLocations', 'latticeAssets']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validateManifest(value) {
  const errors = [];
  const error = (path, message) => errors.push(`${path}: ${message}`);
  const keys = (v, allowed, path) => {
    if (!object(v)) {error(path, 'expected object'); return false;}
    for (const key of Object.keys(v)) if (!allowed.includes(key)) error(`${path}.${key}`, 'unknown property');
    return true;
  };
  const label = v => typeof v === 'string' && !!v.trim() && v.length <= 200;
  if (!keys(value, ['schemaVersion', 'id', 'name', 'route', 'permissions', 'collections', 'blocks', 'transitions'], '$')) return errors;
  if (value.schemaVersion !== 1) error('schemaVersion', 'expected 1');
  if (typeof value.id !== 'string' || !id.test(value.id)) error('id', 'invalid id');
  if (!label(value.name)) error('name', 'required, max 200 characters');
  if (typeof value.route !== 'string' || value.route !== `/lattice/apps/${value.id}`) error('route', 'must equal /lattice/apps/<id>');
  const permission = (v, path) => {
    if (!Array.isArray(v) || !v.length || v.some(r => typeof r !== 'string' || !roles.test(r))) error(path, 'non-empty role list required');
  };
  permission(value.permissions, 'permissions');
  const collections = new Map();
  if (!Array.isArray(value.collections) || !value.collections.length) error('collections', 'non-empty list required');
  else value.collections.forEach((c, n) => {
    const path = `collections[${n}]`;
    if (!keys(c, ['id', 'source', 'resource'], path)) return;
    if (typeof c.id !== 'string' || !id.test(c.id) || collections.has(c.id)) error(`${path}.id`, 'invalid or duplicate');
    collections.set(c.id, c);
    if (c.source === 'lattice-api') {
      if (!['records', 'tasks', 'orders'].includes(c.resource)) error(`${path}.resource`, 'unsupported API collection');
    } else if (c.source === 'nocobase') {
      if (!registries.has(c.resource)) error(`${path}.resource`, 'unknown foundation collection');
    } else error(`${path}.source`, 'expected lattice-api or nocobase');
  });
  const blockIds = new Set();
  if (!Array.isArray(value.blocks) || !value.blocks.length) error('blocks', 'non-empty list required');
  else value.blocks.forEach((b, n) => {
    const path = `blocks[${n}]`;
    if (!keys(b, ['id', 'type', 'title', 'collection', 'permissions', 'fields', 'submit', 'columns', 'attachments'], path)) return;
    if (typeof b.id !== 'string' || !id.test(b.id) || blockIds.has(b.id)) error(`${path}.id`, 'invalid or duplicate');
    blockIds.add(b.id);
    if (!label(b.title)) error(`${path}.title`, 'required');
    permission(b.permissions, `${path}.permissions`);
    const collection = collections.get(b.collection);
    if (!collection) error(`${path}.collection`, 'unknown reference');
    if (b.type === 'form') {
      if (b.attachments !== undefined && (b.attachments !== true || !['records.create','logistics.create'].includes(b.submit?.actionId))) error(`${path}.attachments`, 'attachments require record/order creation');
      const fields = new Set();
      if (!Array.isArray(b.fields) || !b.fields.length) error(`${path}.fields`, 'non-empty list required');
      else b.fields.forEach((f, i) => {
        if (!keys(f, ['name', 'title', 'type', 'required', 'maxLength', 'pattern', 'reference'], `${path}.fields[${i}]`)) return;
        if (typeof f.name !== 'string' || !fieldName.test(f.name) || fields.has(f.name)) error(`${path}.fields[${i}].name`, 'invalid or duplicate');
        fields.add(f.name);
        if (!label(f.title) || !['string','positiveInteger'].includes(f.type) || (f.type==='positiveInteger'&&f.name!=='quantity') || typeof f.required !== 'boolean' || !Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 2000) error(`${path}.fields[${i}]`, 'invalid field definition');
        if (f.pattern !== undefined && f.pattern !== 'uuid') error(`${path}.fields[${i}].pattern`, 'only uuid supported');
        if (f.reference !== undefined && !((f.reference==='records'&&f.name==='recordId'&&f.pattern==='uuid')||(f.reference==='warehousePeople'&&f.name==='warehouseAssigneeId'))) error(`${path}.fields[${i}].reference`, 'unsupported reference');
      });
      if (keys(b.submit, ['actionId', 'version'], `${path}.submit`)) {
        const action = actions.get(b.submit.actionId);
        if (!action || b.submit.version !== 1) error(`${path}.submit`, 'unsupported action/version');
        else {
          if (collection?.source !== 'lattice-api' || collection.resource !== action[0]) error(`${path}.submit`, 'action/collection source mismatch');
          if (!Array.isArray(b.permissions) || !b.permissions.includes(action[1])) error(`${path}.permissions`, 'must include API action role');
          for (const f of fields) if (!action[2].includes(f)) error(`${path}.fields`, `API does not accept ${f}`);
          if (Array.isArray(b.fields)) for (const f of b.fields) {
            if (!object(f)) continue;
            const limit = {title: 200, assigneeId: 100, warehouseAssigneeId:100, attachmentId:36,quantity:7, recordId: 36}[f.name];
            if (limit && f.maxLength > limit) error(`${path}.fields`, `${f.name} exceeds API maximum ${limit}`);
            if (f.name === 'recordId' && (f.pattern !== 'uuid' || f.maxLength !== 36)) error(`${path}.fields`, 'recordId requires uuid pattern and maxLength 36');
          }
          if(b.submit.actionId==='logistics.create'&&(!Array.isArray(b.fields)||!b.fields.some(f=>f?.name==='quantity'&&f.type==='positiveInteger')||!b.fields.some(f=>f?.name==='warehouseAssigneeId'&&f.reference==='warehousePeople')))error(path,'Order requires numeric quantity and directory reference');
          for (const required of b.submit.actionId === 'tasks.create' ? ['title', 'assigneeId'] : b.submit.actionId==='logistics.create'?['title','customerName','deliveryAddress','sku','quantity','warehouseAssigneeId']:['title']) {
            if (!Array.isArray(b.fields) || !b.fields.some(f => f?.name === required && f.required)) error(`${path}.fields`, `required API field missing: ${required}`);
          }
        }
      }
      if ('columns' in b) error(path, 'form cannot have columns');
    } else if (b.type === 'list') {
      if (!Array.isArray(b.columns) || !b.columns.length || b.columns.some(c => typeof c !== 'string' || !fieldName.test(c))) error(`${path}.columns`, 'field names required');
      if ('fields' in b || 'submit' in b || 'attachments' in b) error(path, 'list cannot submit');
    } else error(`${path}.type`, 'unregistered block type');
  });
  const transitions = new Set();
  if (!Array.isArray(value.transitions)) error('transitions', 'list required');
  else value.transitions.forEach((t, n) => {
    const path = `transitions[${n}]`;
    if (!keys(t, ['id', 'collection', 'from', 'to', 'permission', 'availability', 'reason'], path)) return;
    if (typeof t.id !== 'string' || !id.test(t.id) || transitions.has(t.id)) error(`${path}.id`, 'invalid or duplicate');
    transitions.add(t.id);
    if (!collections.has(t.collection) || !label(t.from) || !label(t.to) || typeof t.permission !== 'string' || !roles.test(t.permission)) error(path, 'invalid transition');
    if (t.availability !== 'unavailable' || !label(t.reason)) error(path, 'business transition API is not implemented; reason required');
  });
  return errors;
}
function assertManifest(value) {
  const errors = validateManifest(value);
  if (errors.length) throw new Error(`Invalid application manifest: ${errors.join('; ')}`);
  return value;
}
function validateCatalog(manifests) {
  const errors = [], ids = new Set(), routes = new Set();
  for (const m of manifests) {
    errors.push(...validateManifest(m));
    if (!object(m)) continue;
    if (ids.has(m.id)) errors.push(`duplicate application id: ${m.id}`);
    if (routes.has(m.route)) errors.push(`duplicate application route: ${m.route}`);
    ids.add(m.id); routes.add(m.route);
  }
  return errors;
}
module.exports = {validateManifest, assertManifest, validateCatalog};

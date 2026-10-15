// SPDX-License-Identifier: Apache-2.0
'use strict';
const id = /^[a-z][a-z0-9-]{0,63}$/;
const roles = /^[a-z][a-z0-9:_-]{0,79}$/;
const fieldName = /^[a-z][a-zA-Z0-9]{0,63}$/;
const {defaultContracts}=require('./contracts');
const registries = new Set(['latticeDepartments', 'latticeEmployees', 'latticeLocations', 'latticeAssets']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validateManifest(value, contracts=defaultContracts) {
  const errors = [];
  const error = (path, message) => errors.push(`${path}: ${message}`);
  const keys = (v, allowed, path) => {
    if (!object(v)) {error(path, 'expected object'); return false;}
    for (const key of Object.keys(v)) if (!allowed.includes(key)) error(`${path}.${key}`, 'unknown property');
    return true;
  };
  const label = v => typeof v === 'string' && !!v.trim() && v.length <= 200;
  if (!keys(value, ['schemaVersion', 'id', 'name', 'route', 'permissions', 'collections', 'blocks', 'transitions', 'workspace'], '$')) return errors;
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
      if (!contracts.resource(c.resource)) error(`${path}.resource`, 'unsupported API collection');
    } else if (c.source === 'nocobase') {
      if (!registries.has(c.resource)) error(`${path}.resource`, 'unknown foundation collection');
    } else error(`${path}.source`, 'expected lattice-api or nocobase');
  });
  const blockIds = new Set();
  if (!Array.isArray(value.blocks) || !value.blocks.length) error('blocks', 'non-empty list required');
  else value.blocks.forEach((b, n) => {
    const path = `blocks[${n}]`;
    if (!keys(b, ['id', 'type', 'title', 'collection', 'permissions', 'fields', 'submit', 'columns', 'attachments','definitionId','pageSize','approvalBlockId','runId','actionLabels','fieldLabels','stateLabels','fileFields','allowUpload','attachmentBlockId','timelineBlockId','recordId','contextBlockId','entitySchemaId','entityFields','actionId','actionDescriptions'], path)) return;
    if (typeof b.id !== 'string' || !id.test(b.id) || blockIds.has(b.id)) error(`${path}.id`, 'invalid or duplicate');
    blockIds.add(b.id);
    if (!label(b.title)) error(`${path}.title`, 'required');
    permission(b.permissions, `${path}.permissions`);
    const collection = collections.get(b.collection);
    if (!collection) error(`${path}.collection`, 'unknown reference');
    const workflowBlock=['task-inbox','approval','workflow-form','attachment','activity-timeline','context-entity'].includes(b.type);
    for(const name of ['definitionId','pageSize','approvalBlockId','runId','actionLabels','fieldLabels','stateLabels','fileFields','allowUpload','attachmentBlockId','timelineBlockId','recordId','contextBlockId','entitySchemaId','entityFields','actionId','actionDescriptions'])if(name in b&&!workflowBlock)error(path,'workflow options require a workflow/evidence block');
    if(workflowBlock){
      if(collection?.source!=='lattice-api'||(collection.resource!=='workflows'&&!(b.type==='attachment'&&collection.resource==='records')))error(path,'workflow/evidence block requires workflows resource (or records for Attachment)');
      for(const name of ['fields','submit','columns','attachments'])if(name in b)error(path,'workflow block uses API action schema');
      if(b.definitionId!==undefined&&(typeof b.definitionId!=='string'||! /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(b.definitionId)))error(path,'invalid workflow definition ID');
      if(b.type==='task-inbox'){
        if(b.pageSize!==undefined&&(!Number.isInteger(b.pageSize)||b.pageSize<1||b.pageSize>100))error(path,'page size must be 1–100');
        if(b.runId!==undefined)error(path,'Inbox cannot bind fixed run ID');
        if(b.approvalBlockId!==undefined&&(!id.test(b.approvalBlockId)||!value.blocks.some(other=>other?.id===b.approvalBlockId&&other.type==='approval'&&other.definitionId===b.definitionId)))error(path,'approval reference must match definition scope');
      }else{
        if(b.pageSize!==undefined&&b.type!=='activity-timeline'||b.approvalBlockId!==undefined)error(path,'only Inbox/Timeline support paging; only Inbox links Approval');
        if(b.type==='activity-timeline'&&b.pageSize!==undefined&&(!Number.isInteger(b.pageSize)||b.pageSize<1||b.pageSize>100))error(path,'page size must be 1–100');
        if(b.runId!==undefined&&(typeof b.runId!=='string'||! /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.runId)))error(path,'run ID must be UUID');
      }
      for(const [name,type] of [['attachmentBlockId','attachment'],['timelineBlockId','activity-timeline'],['contextBlockId','context-entity']])if(b[name]!==undefined&&(!['approval','workflow-form'].includes(b.type)||!value.blocks.some(other=>other?.id===b[name]&&other.type===type&&other.definitionId===b.definitionId&&other.collection===b.collection)))error(path,'evidence reference must match Approval scope');
      if(b.type==='workflow-form'&&(typeof b.actionId!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(b.actionId)||['constructor','prototype','__proto__'].includes(b.actionId)))error(path,'workflow form requires safe actionId');
      if(b.actionId!==undefined&&b.type!=='workflow-form')error(path,'actionId requires workflow form');
      if(b.entitySchemaId!==undefined&&(b.type!=='context-entity'||typeof b.entitySchemaId!=='string'||! /^[a-z][a-z0-9-]{0,79}$/.test(b.entitySchemaId)))error(path,'entitySchemaId requires Context Entity schema slug');
      if(b.entityFields!==undefined&&(b.type!=='context-entity'||!Array.isArray(b.entityFields)||b.entityFields.length>30||new Set(b.entityFields.map(f=>f?.name)).size!==b.entityFields.length||b.entityFields.some(f=>!object(f)||Object.keys(f).some(k=>!['name','title'].includes(k))||typeof f.name!=='string'||! /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(f.name)||['constructor','prototype','__proto__'].includes(f.name)||!label(f.title))))error(path,'entityFields must declare safe unique plain fields');
      if(b.fileFields!==undefined&&(b.type!=='attachment'||!Array.isArray(b.fileFields)||b.fileFields.length>50||new Set(b.fileFields).size!==b.fileFields.length||b.fileFields.some(name=>typeof name!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)||['constructor','prototype','__proto__'].includes(name))))error(path,'fileFields must declare safe unique workflow field names');
      if(b.allowUpload!==undefined&&(b.type!=='attachment'||typeof b.allowUpload!=='boolean'))error(path,'allowUpload requires Attachment boolean');
      if(b.recordId!==undefined&&(b.type!=='attachment'||collection?.resource!=='records'||typeof b.recordId!=='string'||! /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.recordId)))error(path,'recordId requires record Attachment UUID');
      if(b.type==='attachment'&&collection?.resource==='records'&&(b.runId!==undefined||b.definitionId!==undefined||b.fileFields!==undefined))error(path,'record Attachment cannot use workflow configuration');
      for(const name of ['actionLabels','fieldLabels','stateLabels','actionDescriptions'])if(b[name]!==undefined&&(!object(b[name])||Object.entries(b[name]).some(([key,text])=>! /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key)||['constructor','prototype','__proto__'].includes(key)||!label(text))))error(path,'labels must map safe IDs to plain text');
    } else if (b.type === 'form') {
      if (b.attachments !== undefined && (b.attachments !== true || !contracts.action(b.submit?.actionId)?.attachments)) error(`${path}.attachments`, 'attachments require record/order creation');
      const fields = new Set();
      if (!Array.isArray(b.fields) || !b.fields.length) error(`${path}.fields`, 'non-empty list required');
      else b.fields.forEach((f, i) => {
        if (!keys(f, ['name', 'title', 'type', 'required', 'maxLength', 'pattern', 'reference'], `${path}.fields[${i}]`)) return;
        if (typeof f.name !== 'string' || !fieldName.test(f.name) || fields.has(f.name)) error(`${path}.fields[${i}].name`, 'invalid or duplicate');
        fields.add(f.name);
        if (!label(f.title) || !['string','positiveInteger'].includes(f.type) || typeof f.required !== 'boolean' || !Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 2000) error(`${path}.fields[${i}]`, 'invalid field definition');
        if (f.pattern !== undefined && f.pattern !== 'uuid') error(`${path}.fields[${i}].pattern`, 'only uuid supported');
        if (f.reference !== undefined && !contracts.reference(f.reference)) error(`${path}.fields[${i}].reference`, 'unsupported reference');
      });
      if (keys(b.submit, ['actionId', 'version'], `${path}.submit`)) {
        const action = contracts.action(b.submit.actionId);
        if (!action || b.submit.version !== action.version) error(`${path}.submit`, 'unsupported action/version');
        else {
          if (collection?.source !== 'lattice-api' || collection.resource !== action.resource) error(`${path}.submit`, 'action/collection source mismatch');
          if (!Array.isArray(b.permissions) || !b.permissions.includes(action.role)) error(`${path}.permissions`, 'must include API action role');
          for (const f of fields) if (!Object.hasOwn(action.fields,f)) error(`${path}.fields`, `API does not accept ${f}`);
          if (Array.isArray(b.fields)) for (const f of b.fields) {
            if (!object(f)) continue;
            const rule=action.fields[f.name];if(!rule)continue;
            if(f.maxLength>rule.maxLength)error(`${path}.fields`,`${f.name} exceeds API maximum ${rule.maxLength}`);
            if(f.type!==(rule.type||'string'))error(`${path}.fields`,`${f.name} requires ${rule.type||'string'}`);
            if(rule.pattern&&(f.pattern!==rule.pattern||f.maxLength!==rule.maxLength))error(`${path}.fields`,`${f.name} requires ${rule.pattern} pattern and maxLength ${rule.maxLength}`);
            if(f.reference!==rule.reference)error(`${path}.fields`,`${f.name} has incompatible reference`);
          }
          for(const [name,rule] of Object.entries(action.fields))if(rule.required&&(!Array.isArray(b.fields)||!b.fields.some(f=>f?.name===name&&f.required)))error(`${path}.fields`,`required API field missing: ${name}`);
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
  if(value.workspace!==undefined&&keys(value.workspace,['panels','blocks','note','showTransitions','home','shortcut'],'workspace')) {
    const layout=value.workspace;
    if(layout.home!==undefined&&typeof layout.home!=='boolean')error('workspace.home','boolean required');
    if(layout.shortcut!==undefined&&keys(layout.shortcut,['hidden','description','icon','createBlockId','createLabel'],'workspace.shortcut')){
      const shortcut=layout.shortcut;
      if(shortcut.hidden!==undefined&&typeof shortcut.hidden!=='boolean')error('workspace.shortcut.hidden','boolean required');
      if(shortcut.description!==undefined&&!label(shortcut.description))error('workspace.shortcut.description','plain text required');
      if(shortcut.icon!==undefined&&!['apps','cart','truck','wallet','inbox'].includes(shortcut.icon))error('workspace.shortcut.icon','registered icon required');
      if(shortcut.createBlockId!==undefined&&(!Array.isArray(value.blocks)||!value.blocks.some(b=>b?.id===shortcut.createBlockId&&b.type==='form')))error('workspace.shortcut.createBlockId','configured Form block required');
      if(shortcut.createLabel!==undefined&&!label(shortcut.createLabel))error('workspace.shortcut.createLabel','plain text required');
    }
    if(layout.note!==undefined&&(typeof layout.note!=='string'||layout.note.length>2000))error('workspace.note','text required, max 2000');
    if(layout.showTransitions!==undefined&&typeof layout.showTransitions!=='boolean')error('workspace.showTransitions','boolean required');
    const panelIds=new Set();
    if(layout.panels!==undefined) {
      if(!Array.isArray(layout.panels)||layout.panels.length>20)error('workspace.panels','list required, max 20');
      else layout.panels.forEach((panel,n)=>{
        const path=`workspace.panels[${n}]`;if(!keys(panel,['id','renderer'],path))return;
        if(typeof panel.id!=='string'||!id.test(panel.id)||panelIds.has(panel.id))error(path,'invalid or duplicate panel id');panelIds.add(panel.id);
        if(typeof panel.renderer!=='string'||!/^[a-z][a-z0-9.-]{0,79}$/.test(panel.renderer))error(path,'registered renderer name required');
      });
    }
    if(layout.blocks!==undefined) {
      const used=new Set();
      if(!Array.isArray(layout.blocks))error('workspace.blocks','list required');
      else layout.blocks.forEach((binding,n)=>{
        const path=`workspace.blocks[${n}]`;if(!keys(binding,['blockId','selectFrom'],path))return;
        if(!blockIds.has(binding.blockId)||used.has(binding.blockId))error(path,'unknown or duplicate block binding');used.add(binding.blockId);
        if(binding.selectFrom!==undefined&&(typeof binding.selectFrom!=='string'||!fieldName.test(binding.selectFrom)||['constructor','prototype'].includes(binding.selectFrom)))error(path,'safe result field required');
      });
    }
  }
  return errors;
}
function assertManifest(value,contracts=defaultContracts) {
  const errors = validateManifest(value,contracts);
  if (errors.length) throw new Error(`Invalid application manifest: ${errors.join('; ')}`);
  return value;
}
function validateCatalog(manifests,contracts=defaultContracts) {
  const errors = [], ids = new Set(), routes = new Set();
  for (const m of manifests) {
    errors.push(...validateManifest(m,contracts));
    if (!object(m)) continue;
    if (ids.has(m.id)) errors.push(`duplicate application id: ${m.id}`);
    if (routes.has(m.route)) errors.push(`duplicate application route: ${m.route}`);
    ids.add(m.id); routes.add(m.route);
  }
  return errors;
}
module.exports = {validateManifest, assertManifest, validateCatalog};

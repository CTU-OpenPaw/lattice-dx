/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {rolePresets,installRolePresets,migrateUnusedLegacyRoles,isLegacyPreset}=require('../src/server/native-roles');
test('business roles configure native fields and data scopes without custom workflow actions',()=>{
  const presets=rolePresets();assert.equal(presets.length,8);
  const opPreset=presets.find(p=>p.name==='ldx_operator');
  assert.ok(opPreset && opPreset.title==='Lattice — Vận hành');
  for(const preset of presets){assert.equal(preset.allowConfigure,false);assert.equal(preset.allowNewAiEmployee,false);assert.deepEqual(preset.snippets,[]);assert.ok(!preset.resources.some(resource=>resource.name==='latticeDocuments'));}
  const employee=presets.find(p=>p.name==='ldx_employee').resources.find(r=>r.name==='latticeRequests');
  assert.ok(employee.actions.find(a=>a.name==='view').scope.scope.$or);
  const update=employee.actions.find(a=>a.name==='update');assert.equal(update.scope.scope.status,'draft');assert.equal(update.scope.scope['requester.userId'],'{{ ctx.state.currentUser.id }}');
  for(const action of employee.actions.filter(a=>a.name!=='view'))for(const field of ['status','version','requesterId','assigneeId','organizationId'])assert.ok(!action.fields.includes(field));
  assert.ok(presets.find(p=>p.name==='ldx_director').resources.every(r=>r.actions.every(a=>a.name==='view')));
});
test('role provisioning preserves existing administrator edits',async()=>{
  const existing={name:'ldx_employee',title:'Edited role'},rows=[existing];
  const db={getRepository:()=>({findOne:async({filter})=>rows.find(r=>r.name===filter.name),create:async({values})=>rows.push(values)})};
  await installRolePresets(db);await installRolePresets(db);assert.equal(rows.length,8);assert.equal(rows[0],existing);
});
test('cutover preserves assigned or modified roles instead of resetting native policy',async()=>{
  const preset=rolePresets()[0];assert.equal(isLegacyPreset({...preset,title:'Edited'},preset),false);
  assert.equal(isLegacyPreset(preset,preset),false);
  const db={sequelize:{transaction:callback=>callback({})},getRepository:()=>({findOne:async()=>preset,count:async()=>1,destroy:async()=>assert.fail('must preserve existing role')})};
  const report=await migrateUnusedLegacyRoles(db);assert.deepEqual(report.migrated,[]);assert.equal(report.preserved.length,8);
});

test('unused legacy grant cutover leaves other native role settings intact',async()=>{
  const preset=rolePresets()[0];
  const legacy={...preset,allowNewAiEmployee:true,resources:preset.resources.map(resource=>({...resource,actions:resource.actions.map(action=>({name:action.name,fields:resource.actions[0].fields}))}))};
  legacy.resources.push({name:'latticeDocuments',dataSourceKey:'main',usingActionsConfig:true,actions:['submit','complete'].map(name=>({name,fields:[]}))});
  assert.equal(isLegacyPreset(legacy,preset),true);
  const created=[];
  const db={sequelize:{transaction:callback=>callback({})},getRepository:name=>({
    findOne:async({filter})=>filter.name===preset.name?legacy:null,count:async()=>0,
    destroy:async options=>{assert.equal(name,'dataSourcesRolesResources');assert.equal(options.filter.roleName,preset.name);},
    create:async({values})=>{assert.equal(name,'dataSourcesRolesResources');created.push(values);},
    update:async()=>assert.fail('must not change other native role options')
  })};
  const report=await migrateUnusedLegacyRoles(db);assert.deepEqual(report.migrated,[preset.name]);assert.equal(created.length,6);assert.equal(legacy.allowNewAiEmployee,true);
  assert.ok(!created.some(resource=>resource.name==='latticeDocuments'));
});
test('incident portal grants only missing, read-only resources to supported roles',async()=>{
  const {installIncidentPortalReadGrants}=require('../src/server/native-roles');
  const roles=['ldx_manager','ldx_warehouse','ldx_employee','ldx_director'];
  const resources=[{name:'latticeIncidentCases',roleName:'ldx_manager',dataSourceKey:'main',actions:[{name:'view',fields:['id']}]}];
  const db={
    sequelize:{transaction:callback=>callback({})},
    getRepository(name){
      if(name==='roles')return {findOne:async({filter})=>roles.includes(filter.name)?{name:filter.name}:null};
      return {
        findOne:async({filter})=>resources.find(row=>Object.entries(filter).every(([key,value])=>row[key]===value)),
        create:async({values})=>resources.push(values),
      };
    },
  };
  await installIncidentPortalReadGrants(db);
  await installIncidentPortalReadGrants(db);
  assert.equal(resources.length,6);
  assert.deepEqual(resources[0].actions,[{name:'view',fields:['id']}]);
  assert.ok(resources.every(row=>row.roleName!=='ldx_employee'));
  for(const row of resources.slice(1))assert.deepEqual(row.actions.map(action=>action.name),['view']);
});
test('20261129000100-sync-role-presets migration idempotently backfills missing ldx_operator on upgraded DBs',async()=>{
  const Module=require('node:module');
  const origLoad=Module._load;
  class MockMigration{constructor(ctx){this.context=ctx;}}
  Module._load=function(req,parent,isMain){if(req==='@nocobase/server')return {Migration:MockMigration};return origLoad.call(this,req,parent,isMain);};
  let Mig;
  try{Mig=require('../src/server/migrations/20261129000100-sync-role-presets');}finally{Module._load=origLoad;}
  const rows=rolePresets().filter(p=>p.name!=='ldx_operator');
  const db={getRepository:()=>({findOne:async({filter})=>rows.find(r=>r.name===filter.name)||null,create:async({values})=>rows.push(values)})};
  const mig=new Mig({db});
  assert.equal(mig.on,'afterSync');
  await mig.up();
  await mig.up();
  assert.equal(rows.length,8);
  assert.equal(rows.some(r=>r.name==='ldx_operator'),true);
});
test('T1-AISTUDIO-04: installIncidentManagerActionGrants and 20261208000200 migration grant create/update on latticeIncidentCases to ldx_manager and ldx_admin only', async () => {
  const { installIncidentManagerActionGrants } = require('../src/server/native-roles');
  const roles = ['ldx_manager', 'ldx_admin', 'ldx_employee', 'ldx_driver', 'ldx_director'];
  const resources = [
    { name: 'latticeIncidentCases', roleName: 'ldx_manager', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view', fields: ['id', 'code'] }] },
    { name: 'latticeIncidentCases', roleName: 'ldx_employee', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view', fields: ['id'] }] },
  ];
  const db = {
    sequelize: { transaction: (cb) => cb({}) },
    getRepository(name) {
      if (name === 'roles') return { findOne: async ({ filter }) => (roles.includes(filter.name) ? { name: filter.name } : null) };
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => resources.find((row) => Object.entries(filter).every(([k, v]) => row[k] === v)) || null,
          create: async ({ values }) => { resources.push(values); return values; },
          update: async ({ filter, values }) => {
            const idx = resources.findIndex((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
            if (idx >= 0) resources[idx] = { ...resources[idx], ...values };
            return [resources[idx]];
          },
        };
      }
      return null;
    },
  };

  await installIncidentManagerActionGrants(db);
  await installIncidentManagerActionGrants(db);

  const mgrRes = resources.find((r) => r.roleName === 'ldx_manager' && r.name === 'latticeIncidentCases');
  const admRes = resources.find((r) => r.roleName === 'ldx_admin' && r.name === 'latticeIncidentCases');
  const empRes = resources.find((r) => r.roleName === 'ldx_employee' && r.name === 'latticeIncidentCases');
  const drvRes = resources.find((r) => r.roleName === 'ldx_driver' && r.name === 'latticeIncidentCases');

  assert.deepEqual(mgrRes.actions.map((a) => a.name), ['view', 'create', 'update']);
  assert.deepEqual(admRes.actions.map((a) => a.name), ['view', 'create', 'update']);
  assert.equal(mgrRes.actions.find((a) => a.name === 'create').fields.includes('organizationId'), false);
  assert.deepEqual(empRes.actions.map((a) => a.name), ['view']);
  assert.equal(drvRes, undefined);

  const Module = require('node:module');
  const origLoad = Module._load;
  class MockMigration { constructor(ctx) { this.context = ctx; } }
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Migration: MockMigration };
    return origLoad.call(this, req, parent, isMain);
  };
  let Mig;
  try {
    Mig = require('../src/server/migrations/20261208000200-incident-manager-create-grant');
  } finally {
    Module._load = origLoad;
  }
  const mig = new Mig({ db });
  assert.equal(mig.on, 'afterSync');
  await mig.up();
});

test('LatticeFoundationPlugin ensures incident manager action grants safely on afterStart, start, and afterEnable', async () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  const Gateway = { registerRequestHandler() {}, unregisterRequestHandler() {} };
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Plugin: MockPlugin, Gateway };
    if (req === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/server/index')];
    const PluginCls = require('../src/server/index');
    const roles = ['ldx_manager', 'ldx_admin'];
    const resources = [
      { id: 10, name: 'latticeIncidentCases', roleName: 'ldx_manager', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view', fields: ['id'] }] },
    ];
    const listeners = {};
    const mockDb = {
      sequelize: { getDialect: () => 'sqlite', query: async () => [[]], transaction: (cb) => cb({}) },
      getRepository(name) {
        if (name === 'roles') return { findOne: async ({ filter }) => (roles.includes(filter.name) ? { name: filter.name } : null) };
        if (name === 'dataSourcesRolesResources') {
          return {
            findOne: async ({ filter }) => resources.find((row) => Object.entries(filter).every(([k, v]) => row[k] === v)) || null,
            create: async ({ values }) => { resources.push(values); return values; },
            update: async ({ filter, values }) => {
              const idx = resources.findIndex((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
              if (idx >= 0) resources[idx] = { ...resources[idx], ...values };
              return [resources[idx]];
            },
          };
        }
        return null;
      },
      on() {},
    };
    const mockApp = {
      db: mockDb,
      once(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
      resourceManager: { define() {}, use() {} },
      acl: { allow() {}, use() {}, registerSnippet() {} },
      pubSubManager: { subscribe() {}, publish() {} },
    };
    const plugin = new PluginCls(mockApp, {});
    await plugin.load();
    assert.equal((listeners.afterStart || []).length, 1);
    for (const fn of listeners.afterStart) fn();
    await new Promise((r) => setTimeout(r, 20));

    const mgr = resources.find((r) => r.roleName === 'ldx_manager');
    const adm = resources.find((r) => r.roleName === 'ldx_admin');
    assert.deepEqual(mgr.actions.map((a) => a.name), ['view', 'create', 'update']);
    assert.deepEqual(adm.actions.map((a) => a.name), ['view', 'create', 'update']);

    // start() and afterEnable() also succeed safely
    await plugin.start();
    await plugin.afterEnable();
    await plugin.unload();
  } finally {
    Module._load = origLoad;
  }
});

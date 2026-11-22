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
  const presets=rolePresets();assert.equal(presets.length,7);
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
  await installRolePresets(db);await installRolePresets(db);assert.equal(rows.length,7);assert.equal(rows[0],existing);
});
test('cutover preserves assigned or modified roles instead of resetting native policy',async()=>{
  const preset=rolePresets()[0];assert.equal(isLegacyPreset({...preset,title:'Edited'},preset),false);
  assert.equal(isLegacyPreset(preset,preset),false);
  const db={sequelize:{transaction:callback=>callback({})},getRepository:()=>({findOne:async()=>preset,count:async()=>1,destroy:async()=>assert.fail('must preserve existing role')})};
  const report=await migrateUnusedLegacyRoles(db);assert.deepEqual(report.migrated,[]);assert.equal(report.preserved.length,7);
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

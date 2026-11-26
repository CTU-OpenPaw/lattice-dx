/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';
const schemas=require('./schema');
const currentUser='{{ ctx.state.currentUser.id }}';
const protectedWrites=new Set(['id','createdAt','updatedAt','identitySubject','userId','organizationId','status','version','requesterId','assigneeId','decisionReason']);
function fieldsFor(name) {
  const schema=Object.values(schemas).find(schema=>schema.name===name);
  return ['id','createdAt','updatedAt',...schema.fields.flatMap(field=>field.type==='belongsTo'?[field.foreignKey]:field.type==='hasMany'?[]:[field.name])].filter(name=>name!=='identitySubject');
}
function grant(name,role) {
  const fields=fieldsFor(name),document=['latticeRequests','latticeOrders'].includes(name);
  const own={$or:[{'requester.userId':currentUser},{'assignee.userId':currentUser}]};
  const scope=(label,filter)=>({name:'Lattice — '+label,resourceName:name,dataSourceKey:'main',scope:filter});
  const view={name:'view',fields};
  if(document&&!['manager','admin','dispatcher','director'].includes(role))view.scope=scope('Tài liệu liên quan',own);
  const actions=[view];
  if(document&&role!=='director')actions.push(
    {name:'create',fields:fields.filter(field=>!protectedWrites.has(field))},
    {name:'update',fields:fields.filter(field=>!protectedWrites.has(field)),scope:scope('Nháp của tôi',{'requester.userId':currentUser,status:'draft'})}
  );
  return {name,dataSourceKey:'main',usingActionsConfig:true,actions};
}
function rolePresets() {
  const names={employee:'Nhân viên',manager:'Quản lý',operator:'Vận hành',warehouse:'Kho',dispatcher:'Điều phối',driver:'Tài xế',director:'Giám đốc (chỉ đọc)',admin:'Quản trị nghiệp vụ'};
  return Object.entries(names).map(([key,title])=>({name:'ldx_'+key,title:'Lattice — '+title,allowConfigure:false,allowNewMenu:false,allowNewAiEmployee:false,strategy:{actions:[]},snippets:[],resources:['latticeRequests','latticeOrders','latticeDepartments','latticeEmployees','latticeLocations','latticeAssets'].map(name=>grant(name,key))}));
}
async function installRolePresets(db) {
  for(const preset of rolePresets())if(!await db.getRepository('roles').findOne({filter:{name:preset.name}}))await db.getRepository('roles').create({values:preset});
}
function isLegacyPreset(role,preset) {
  if(role.title!==preset.title||role.allowConfigure!==false||role.allowNewMenu!==false||JSON.stringify(role.strategy)!==JSON.stringify(preset.strategy)||(role.snippets??[]).length)return false;
  const commands=preset.name==='ldx_director'?[]:['ldx_manager','ldx_admin'].includes(preset.name)?['submit','approve','reject','assign','complete']:preset.name==='ldx_dispatcher'?['submit','assign','complete']:['submit','complete'];
  const expected=[...preset.resources.map(resource=>({name:resource.name,actions:resource.actions.map(action=>action.name)})),...(commands.length?[{name:'latticeDocuments',actions:commands}]:[])];
  const resources=role.resources??[];
  return resources.length===expected.length&&expected.every(expected=>{
    const resource=resources.find(resource=>resource.name===expected.name);
    if(!resource||resource.dataSourceKey!=='main'||resource.usingActionsConfig!==true||resource.actions?.length!==expected.actions.length)return false;
    return expected.actions.every(name=>{
      const action=resource.actions.find(action=>action.name===name);
      if(!action||action.scopeId)return false;
      const expectedFields=resource.name==='latticeDocuments'?[]:fieldsFor(resource.name);
      return JSON.stringify([...(action.fields??[])].sort())===JSON.stringify([...expectedFields].sort());
    });
  });
}
async function migrateUnusedLegacyRoles(db) {
  const report={migrated:[],preserved:[]};
  await db.sequelize.transaction(async transaction=>{
    for(const preset of rolePresets()) {
      const model=await db.getRepository('roles').findOne({filter:{name:preset.name},appends:['resources','resources.actions'],transaction});
      if(!model)continue;
      const role=model.toJSON?model.toJSON():model;
      if(!isLegacyPreset(role,preset)||await db.getRepository('rolesUsers').count({filter:{roleName:preset.name},transaction})){report.preserved.push(preset.name);continue;}
      await db.getRepository('dataSourcesRolesResources').destroy({filter:{roleName:preset.name,dataSourceKey:'main'},transaction});
      for(const resource of preset.resources)await db.getRepository('dataSourcesRolesResources').create({values:{...resource,roleName:preset.name},transaction});
      // Replace only the known legacy resource grants. Preserve all other role
      // options, including the host's pre-existing AI-employee permission.
      report.migrated.push(preset.name);
    }
  });
  return report;
}
async function installIncidentPortalReadGrants(db) {
  const fields = {
    latticeIncidentCases: ['id', 'code', 'name', 'severity', 'status', 'assetId', 'assetEntityId'],
    latticeIncidentRules: ['id', 'code', 'name', 'assetEntityId', 'attribute', 'operator', 'threshold', 'unit', 'severity'],
  };
  const roles = db.getRepository('roles');
  const resources = db.getRepository('dataSourcesRolesResources');
  await db.sequelize.transaction(async transaction => {
    for (const roleName of ['ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_director', 'ldx_admin']) {
      if (!await roles.findOne({filter:{name:roleName},transaction})) continue;
      for (const [name, allowedFields] of Object.entries(fields)) {
        const filter = {name, roleName, dataSourceKey:'main'};
        if (await resources.findOne({filter,transaction})) continue;
        await resources.create({
          values: {...filter, usingActionsConfig:true, actions:[{name:'view', fields:allowedFields}]},
          transaction,
        });
      }
    }
  });
}
async function installIncidentManagerActionGrants(db) {
  if (!db || typeof db.getRepository !== 'function' || typeof db.sequelize?.transaction !== 'function') return;
  const roles = db.getRepository('roles');
  const resources = db.getRepository('dataSourcesRolesResources');
  if (!roles || !resources) return;
  const viewFields = ['id', 'code', 'name', 'severity', 'status', 'assetId', 'assetEntityId'];
  const writeFields = fieldsFor('latticeIncidentCases').filter((field) => !protectedWrites.has(field));
  const actionsRepo = db.getRepository('dataSourcesRolesResourcesActions');
  await db.sequelize.transaction(async (transaction) => {
    for (const roleName of ['ldx_manager', 'ldx_admin']) {
      if (!(await roles.findOne({ filter: { name: roleName }, transaction }))) continue;
      const filter = { name: 'latticeIncidentCases', roleName, dataSourceKey: 'main' };
      const existing = await resources.findOne({ filter, appends: ['actions'], transaction });
      if (!existing) {
        await resources.create({
          values: {
            ...filter,
            usingActionsConfig: true,
            actions: [
              { name: 'view', fields: viewFields },
              { name: 'create', fields: writeFields },
              { name: 'update', fields: writeFields },
            ],
          },
          transaction,
        });
        continue;
      }
      const rawActions = typeof existing.get === 'function' ? existing.get('actions') : existing.actions;
      const normalized = (Array.isArray(rawActions) ? rawActions : []).map((a) => {
        const plain = typeof a?.toJSON === 'function' ? a.toJSON() : a;
        return typeof plain === 'string'
          ? { name: plain }
          : {
              name: plain?.name,
              ...(Array.isArray(plain?.fields) ? { fields: [...plain.fields] } : {}),
              ...(plain?.scope ? { scope: plain.scope } : {}),
              ...(plain?.scopeId != null ? { scopeId: plain.scopeId } : {}),
            };
      }).filter((a) => Boolean(a.name));
      const missing = [];
      if (!normalized.some((a) => a.name === 'view')) missing.push({ name: 'view', fields: viewFields });
      if (!normalized.some((a) => a.name === 'create')) missing.push({ name: 'create', fields: writeFields });
      if (!normalized.some((a) => a.name === 'update')) missing.push({ name: 'update', fields: writeFields });
      if (!missing.length) continue;
      const nextActions = [...normalized, ...missing];
      if (typeof resources.update === 'function') {
        await resources.update({
          filter,
          values: { usingActionsConfig: true, actions: nextActions },
          updateAssociationValues: ['actions'],
          transaction,
        });
      } else if (actionsRepo && typeof actionsRepo.create === 'function' && existing.id != null) {
        for (const act of missing) {
          await actionsRepo.create({ values: { ...act, rolesResourceId: existing.id }, transaction });
        }
      } else if (Array.isArray(existing.actions)) {
        existing.actions.push(...missing);
      }
    }
  });
}
module.exports={rolePresets,installRolePresets,migrateUnusedLegacyRoles,isLegacyPreset,installIncidentPortalReadGrants,installIncidentManagerActionGrants};

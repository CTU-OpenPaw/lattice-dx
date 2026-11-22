/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {rolePresets}=require('../../plugins/nocobase/plugin-lattice-foundation/src/server/native-roles');

export function nodes(schema,predicate){
  const result=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(predicate(node))result.push(node);Object.values(node).forEach(visit);};
  visit(schema);return result;
}
function one(schema,predicate,label){const matches=nodes(schema,predicate);assert.equal(matches.length,1,'Expected one '+label);return matches[0];}

export function assertCheckpointTarget(host,db,app){
  const project=db.Config?.Labels?.['com.docker.compose.project'];
  assert.match(project??'',/^lattice-native-[a-z0-9-]+$/,'DB must belong to an isolated native project');
  assert.equal(app.Config?.Labels?.['com.docker.compose.project'],project,'API and backup DB belong to different projects');
  assert.equal(app.Config?.Labels?.['com.docker.compose.service'],'nocobase');
  const bindings=app.NetworkSettings?.Ports?.['80/tcp']??[];
  assert.ok(bindings.some(binding=>binding.HostIp==='127.0.0.1'&&binding.HostPort===host.port),'API port does not match the DB project');
  const env=Object.fromEntries((app.Config?.Env??[]).map(entry=>{const at=entry.indexOf('=');return [entry.slice(0,at),entry.slice(at+1)];}));
  assert.ok([db.Config?.Labels?.['com.docker.compose.service'],String(db.Name??'').replace(/^\//,'')].includes(env.DB_HOST),'NocoBase is not using the selected DB');
  assert.equal(env.DB_DATABASE,'nocobase');assert.equal(env.DB_USER,'nocobase');
}

// Compose a fixed fixture from native schema exports, not a new UI renderer.
export function checkpointSchema(template,bundle){
  assert.equal(bundle.format,'latticedx.native-ui-checkpoint');assert.equal(bundle.version,1);
  assert.equal(bundle.collection,'latticeRequests');assert.equal(bundle.field.name,'studioLabNote');
  const schema=structuredClone(template),field=bundle.collection+'.'+bundle.field.name;
  assert.equal(nodes(schema,node=>node['x-collection-field']===field).length,0,'Baseline already contains the checkpoint field');
  const table=one(schema,node=>node['x-decorator']==='TableBlockProvider'&&node['x-decorator-props']?.collection===bundle.collection,'request table');
  const form=one(table,node=>node['x-decorator']==='FormBlockProvider'&&node['x-use-decorator-props']==='useCreateFormBlockDecoratorProps','create form');
  const grid=one(form,node=>node['x-component']==='Grid','form grid');
  const columns=one(table,node=>node['x-component']==='TableV2','table columns');
  assert.equal(bundle.fragments.formRow['x-component'],'Grid.Row');
  assert.equal(bundle.fragments.tableColumn['x-component'],'TableV2.Column');
  assert.equal(bundle.fragments.filterAction['x-component'],'Filter.Action');
  grid.properties.checkpointNoteRow=structuredClone(bundle.fragments.formRow);
  columns.properties.checkpointNoteColumn=structuredClone(bundle.fragments.tableColumn);
  assert.equal(nodes(table.properties.actions,node=>node['x-component']==='Filter.Action').length,0,'Baseline already has a filter');
  table.properties.actions.properties.checkpointFilter=structuredClone(bundle.fragments.filterAction);
  assert.equal(nodes(schema,node=>node['x-collection-field']===field).length,2);
  return schema;
}

// Reuse native scopes; only a NEW fixture role receives the added field.
export function checkpointPolicy(bundle){
  const role=rolePresets().find(role=>role.name==='ldx_employee');
  const resource=structuredClone(role.resources.find(resource=>resource.name===bundle.collection));
  assert.ok(resource);
  for(const action of resource.actions)if(['view','create'].includes(action.name))action.fields.push(bundle.field.name);
  return resource;
}
export function assertFieldCompatible(existing,expected){
  for(const key of ['name','type','interface'])assert.equal(existing[key],expected[key],'Existing field differs: '+key);
  assert.equal(existing.uiSchema?.title,expected.uiSchema.title,'Existing field label differs; do not overwrite');
  assert.equal(existing.uiSchema?.['x-component'],expected.uiSchema['x-component'],'Existing field component differs');
}
export function canonical(value){
  return JSON.stringify(value,(_,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)
    ?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
}
export function resourceProjection(resources){
  return resources.map(resource=>({name:resource.name,dataSourceKey:resource.dataSourceKey,usingActionsConfig:resource.usingActionsConfig,
    actions:(resource.actions??[]).map(action=>({name:action.name,fields:[...(action.fields??[])].sort(),scope:action.scope?.scope??{}}))
      .sort((a,b)=>a.name.localeCompare(b.name))})).sort((a,b)=>a.name.localeCompare(b.name));
}
export function fieldGrantRepairs(before,after,field){
  assert.equal(after.length,before.length,'Resource grants changed during field creation');
  const repairs=[];
  for(const prior of before){
    const current=after.find(item=>String(item.id)===String(prior.id));assert.ok(current,'Resource grant disappeared');
    const normalized=structuredClone(current);
    for(const action of normalized.actions??[]){
      const old=prior.actions?.find(item=>String(item.id)===String(action.id));assert.ok(old,'Action grant changed');
      if(!(old.fields??[]).includes(field)&&(action.fields??[]).includes(field)){
        action.fields=action.fields.filter(name=>name!==field);
        repairs.push({resourceId:prior.id,actionId:action.id,fields:old.fields});
      }
    }
    assert.equal(canonical(resourceProjection([normalized])),canonical(resourceProjection([prior])),'Unexpected ACL change; refusing to overwrite');
  }
  return repairs;
}
export function assertPolicyCompatible(actual,expected){
  assert.equal(actual.usingActionsConfig,true);
  assert.equal(actual.actions?.length,expected.actions.length,'Unexpected role actions');
  for(const wanted of expected.actions){
    const action=actual.actions.find(action=>action.name===wanted.name);assert.ok(action,'Missing action '+wanted.name);
    assert.deepEqual([...(action.fields??[])].sort(),[...wanted.fields].sort(),'Field grants drifted: '+wanted.name);
    assert.equal(canonical(action.scope?.scope??{}),canonical(wanted.scope?.scope??{}),'Native scope drifted: '+wanted.name);
  }
}

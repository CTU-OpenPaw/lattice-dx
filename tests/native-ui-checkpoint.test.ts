// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {checkpointSchema,checkpointPolicy,assertFieldCompatible,assertPolicyCompatible,nodes,assertCheckpointTarget,fieldGrantRepairs} from '../scripts/lib/native-ui-checkpoint.mjs';
import {instantiateNativePage} from '../scripts/lib/native-ui-fixture.mjs';
const template=JSON.parse(await readFile(new URL('../scripts/fixtures/native-ui-page.json',import.meta.url),'utf8'));
const bundle=JSON.parse(await readFile(new URL('../scripts/fixtures/native-ui-checkpoint.json',import.meta.url),'utf8'));
describe('portable native configuration checkpoint',()=>{
  it('removes only native automatic field grants and rejects unrelated ACL drift',()=>{
    const before=[{id:1,name:'latticeRequests',usingActionsConfig:true,actions:[{id:2,name:'update',fields:['name'],scope:{scope:{status:'draft'}}}]}];
    const after=structuredClone(before);after[0].actions[0].fields.push('studioLabNote');
    expect(fieldGrantRepairs(before,after,'studioLabNote')).toEqual([{resourceId:1,actionId:2,fields:['name']}]);
    expect(fieldGrantRepairs(before,before,'studioLabNote')).toEqual([]);
    after[0].actions[0].scope.scope.status='submitted';
    expect(()=>fieldGrantRepairs(before,after,'studioLabNote')).toThrow(/ACL change/);
  });
  it('matches the loopback API port to the same Docker project and database before mutation',()=>{
    const db={Name:'/lattice-native-test-nocobase-db-1',Config:{Labels:{'com.docker.compose.project':'lattice-native-test','com.docker.compose.service':'nocobase-db'}}};
    const app={Config:{Labels:{'com.docker.compose.project':'lattice-native-test','com.docker.compose.service':'nocobase'},Env:['DB_HOST=nocobase-db','DB_DATABASE=nocobase','DB_USER=nocobase']},NetworkSettings:{Ports:{'80/tcp':[{HostIp:'127.0.0.1',HostPort:'13004'}]}}};
    expect(()=>assertCheckpointTarget(new URL('http://localhost:13004'),db,app)).not.toThrow();
    expect(()=>assertCheckpointTarget(new URL('http://localhost:13001'),db,app)).toThrow(/port/);
    const foreign=structuredClone(app);foreign.Config.Labels['com.docker.compose.project']='lattice-dx';
    expect(()=>assertCheckpointTarget(new URL('http://localhost:13004'),db,foreign)).toThrow(/projects/);
  });
  it('composes native exports without changing the shared baseline and remaps IDs for each install',()=>{
    const before=JSON.stringify(template),configured=checkpointSchema(template,bundle);
    expect(JSON.stringify(template)).toBe(before);
    const a=instantiateNativePage(configured,'new_page_a'),b=instantiateNativePage(configured,'new_page_b');
    expect(a.tabUid).not.toBe(b.tabUid);
    expect(nodes(a.schema,node=>node['x-collection-field']==='latticeRequests.studioLabNote')).toHaveLength(2);
    expect(nodes(a.schema,node=>node['x-component']==='Filter.Action')).toHaveLength(1);
    const idsA=new Set(nodes(a.schema,node=>!!node['x-uid']).map(node=>node['x-uid']));
    expect(nodes(b.schema,node=>!!node['x-uid']).some(node=>idsA.has(node['x-uid']))).toBe(false);
  });
  it('fails on an incompatible existing field rather than overwriting its definition or label',()=>{
    expect(()=>assertFieldCompatible(bundle.field,bundle.field)).not.toThrow();
    for(const change of [{type:'integer'},{uiSchema:{title:'User changed label'}},{uiSchema:{...bundle.field.uiSchema,'x-component':'Password'}}])expect(()=>assertFieldCompatible({...bundle.field,...change},bundle.field)).toThrow();
  });
  it('keeps native own-record scopes and limits the added field to view/create',()=>{
    const policy=checkpointPolicy(bundle);
    expect(policy.actions.find(a=>a.name==='view').fields).toContain('studioLabNote');
    expect(policy.actions.find(a=>a.name==='create').fields).toContain('studioLabNote');
    expect(policy.actions.find(a=>a.name==='update').fields).not.toContain('studioLabNote');
    expect(policy.actions.find(a=>a.name==='update').scope.scope.status).toBe('draft');
    expect(policy.actions.find(a=>a.name==='update').scope.scope['requester.userId']).toContain('currentUser.id');
    expect(()=>assertPolicyCompatible(policy,policy)).not.toThrow();
    const broad=structuredClone(policy);broad.actions.find(a=>a.name==='view').scope.scope={};
    expect(()=>assertPolicyCompatible(broad,policy)).toThrow(/scope/);
    const write=structuredClone(policy);write.actions.find(a=>a.name==='update').fields.push('studioLabNote');
    expect(()=>assertPolicyCompatible(write,policy)).toThrow(/grants/);
  });
  it('refuses a modified baseline instead of inserting duplicate or ambiguous controls',()=>{
    const configured=checkpointSchema(template,bundle);
    expect(()=>checkpointSchema(configured,bundle)).toThrow(/already contains/);
    const missing=structuredClone(template);missing.properties={};
    expect(()=>checkpointSchema(missing,bundle)).toThrow(/request table/);
  });
});

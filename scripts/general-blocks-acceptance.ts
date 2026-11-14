/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
type Call = (path:string,method?:string,payload?:unknown,who?:string,expected?:number,key?:string)=>Promise<any>;
export async function verifyGeneralBlocks(call:Call) {
  const domains=['people','contracts','assets'];
  const schemas=domains.map(domain=>({id:'general-'+domain,title:domain,fields:{label:{type:'text',required:true},active:{type:'boolean'},count:{type:'integer'}},relations:{related:{targetSchemaId:'general-'+domain}}}));
  const recipe={format:'latticedx.system-recipe',formatVersion:1,id:'general-office',version:'1.0.0',title:'General office',pages:[],schemas,entityPages:schemas.map(schema=>({id:schema.id,title:schema.title,schemaId:schema.id,schemaVersion:1,blocks:['list','create','detail','relations','history'],fields:['label','active','count'],actions:['create','update','archive','link','unlink'],query:{filters:[{field:'active',operator:'eq',value:true}],sort:{field:'label',direction:'asc'}}}))};
  await call('/v1/system-drafts','POST',{recipe},'designer',201);
  const plan=await call('/v1/studio/system-plan','POST',{recipe});
  assert.deepEqual(plan.manifest.bundle.definitions,[]);
  assert.equal(plan.preview.conflicts.length,0);
  const installed=await call('/v1/enterprise-modules/install','POST',{manifest:plan.manifest},'designer',201);
  const modulePath='/v1/enterprise-modules/general-office/versions/1.0.0/enabled';
  const enabled=await call(modulePath,'POST',{expectedRevision:installed.revision,enabled:true});
  const appPath='/v1/system-apps/general-office/versions/1.0.0';
  const runtime=await call(appPath,'GET',undefined,'handler');
  assert.equal(runtime.presentation.entityPages.length,3);assert.equal(runtime.schemas.length,3);assert.deepEqual(runtime.definitions,[]);
  assert.ok(runtime.schemas.every((schema:any)=>schema.version===1));
  await call(appPath,'GET',undefined,'irrelevant',404);await call(appPath,'GET',undefined,'foreign',404);
  const records=[];
  for(const schema of schemas){
    const body={schemaId:schema.id,schemaVersion:1,title:schema.title,attributes:{label:'Example '+schema.title,active:true,count:2}};
    const key='general-'+schema.id;
    let record=await call('/v1/entities','POST',body,'designer',201,key);
    assert.equal((await call('/v1/entities','POST',body,'designer',201,key)).id,record.id);
    const query={schemaId:schema.id,schemaVersion:1,filters:[{field:'active',operator:'eq',value:true}],sort:{field:'label',direction:'asc'},limit:1,offset:0};
    const result=await call('/v1/entities/query','POST',query);
    assert.equal(result.items[0].id,record.id);assert.equal(result.items.length,1);
    assert.equal((await call('/v1/entities/query','POST',query,'handler')).items.length,0);
    await call('/v1/entities/'+record.id,'GET',undefined,'handler',404);
    await call('/v1/entities','POST',body,'handler',403);
    await call('/v1/entities/'+record.id,'GET',undefined,'foreign',404);
    const next=await call('/v1/entities','POST',{...body,title:'Second '+schema.title},'designer',201);
    const page=await call('/v1/entities/query','POST',query);assert.equal(page.page.hasMore,true);
    const page2=await call('/v1/entities/query','POST',{...query,offset:page.page.nextOffset});assert.equal(page2.items.length,1);assert.notEqual(page2.items[0].id,page.items[0].id);
    const path='/v1/entities/'+record.id;
    record=await call(path,'PATCH',{expectedVersion:record.version,title:record.title,attributes:{...record.attributes,count:3}});
    await call(path,'PATCH',{expectedVersion:1,title:record.title,attributes:record.attributes},'designer',409);
    record=await call(path+'/relations','POST',{expectedVersion:record.version,name:'related',targetId:next.id});
    const relations=await call(path+'/relations');assert.equal(relations.items[0].targetId,next.id);
    record=await call(path+'/relations/related/'+next.id,'DELETE',{expectedVersion:record.version});
    assert.equal((await call(path+'/relations')).items.length,0);
    assert.ok((await call(path+'/history')).items.length>=4);
    records.push(record.id);
  }
  // A new draft does not mutate the installed presentation or its schema publication.
  await call('/v1/system-drafts/general-office','PUT',{recipe:{...recipe,title:'Draft only'},expectedRevision:1});
  assert.equal((await call(appPath)).title,'General office');
  await call(modulePath,'POST',{expectedRevision:enabled.revision,enabled:false});
  assert.equal((await call(appPath)).enabled,false);
  console.log('General blocks acceptance passed: three data domains, data-only install/enable/discovery, schema pins, real CRUD/relations/history/pagination, replay/conflict/role/tenant ACL and draft isolation.');
  return {appPath,records};
}

/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test'),assert=require('node:assert/strict');
const model=require('../src/client/entity-page-model');
const schema={id:'assets',version:1,fields:{name:{type:'text',required:true},count:{type:'integer'},hidden:{type:'text'},active:{type:'boolean'}},relations:{location:{targetSchemaId:'places'}}};
const page={id:'assets',schemaId:'assets',schemaVersion:1,fields:['name','count','active'],actions:['create','update','archive'],query:{filters:[{field:'count',operator:'gt',value:0}],sort:{field:'name',direction:'asc'}}};
test('entity queries pin schema and retain base filters while changing server offset',()=>{
 assert.deepEqual(model.entityPageQuery(page,20),{schemaId:'assets',schemaVersion:1,filters:page.query.filters,sort:page.query.sort,limit:20,offset:20});
 assert.equal(model.entityPageSchema(page,[schema]),schema);assert.throws(()=>model.entityPageSchema({...page,schemaVersion:2},[schema]));
});
test('subset updates retain hidden attributes and allow clearing optional exposed fields',()=>{
 assert.deepEqual(model.entityPageAttributes(page,schema,{name:'New',count:'',active:false},{hidden:'kept',count:4,name:'Old'}),{hidden:'kept',name:'New',active:false});
 assert.throws(()=>model.entityPageAttributes(page,schema,{name:'',count:'2'}));
 assert.throws(()=>model.entityPageAttributes({...page,fields:['missing']},schema,{}));
});
test('mutations require configured action, write capability, enabled module, and settled command',()=>{
 const session={busy:false,commands:{uncertain:false},capabilities:{'entities.write':{available:true}}};
 assert.equal(model.entityPageCanWrite(session,page,true,'update'),true);
 for(const [s,p,e,a] of [[session,page,false,'update'],[session,page,true,'link'],[{...session,busy:true},page,true,'update'],[{...session,commands:{uncertain:true}},page,true,'update'],[{...session,capabilities:{}},page,true,'update']])assert.equal(model.entityPageCanWrite(s,p,e,a),false);
});

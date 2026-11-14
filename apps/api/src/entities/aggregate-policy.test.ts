/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import {parseAggregateQuery,compileAggregateQuery} from './aggregate-policy.js';
import type {SchemaPublication} from './types.js';
const schema:SchemaPublication={id:'invoice',version:1,title:'Invoice',fields:{amount:{type:'decimal'},units:{type:'integer'},flag:{type:'boolean'},label:{type:'text'}},relations:{}};
const base={schemaId:'invoice',schemaVersion:1,metrics:[{name:'count',operation:'count'}]};
test('aggregate input rejects unsupported authority, pagination, unsafe aliases and metric shapes',()=>{
 for(const extra of [{limit:1},{offset:0},{sort:{}},{rawSql:'SELECT 1'},{ownerId:'bob'},{groupBy:null},{filters:null},{metrics:[]},{metrics:Array(11).fill({name:'c',operation:'count'})},{metrics:[{name:'constructor',operation:'count'}]},{metrics:[{name:'count',operation:'count',field:'amount'}]},{metrics:[{name:'sum',operation:'sum'}]},{metrics:[{name:'c',operation:'count'},{name:'c',operation:'count'}]}])expect(()=>parseAggregateQuery({...base,...extra})).toThrow();
 expect(parseAggregateQuery(base)).toEqual({...base,filters:[],groupBy:[]});
});
test('publication controls all aggregate fields and numeric metric types',()=>{
 for(const extra of [{groupBy:['missing']},{groupBy:['label','label']},{groupBy:['label','flag','units']},{metrics:[{name:'s',operation:'sum',field:'label'}]},{metrics:[{name:'s',operation:'avg',field:'missing'}]},{filters:[{field:'amount',operator:'gt',value:'1e2'}]}])expect(()=>compileAggregateQuery(parseAggregateQuery({...base,...extra}),schema)).toThrow();
});
test('aggregate SQL uses guarded numeric expressions, fixed aliases and text numeric outputs',()=>{
 const query=parseAggregateQuery({...base,groupBy:['amount','flag'],filters:[{field:'units',operator:'gte',value:1}],metrics:[{name:'total',operation:'sum',field:'amount'},{name:'average',operation:'avg',field:'amount'},{name:'count',operation:'count'}]});
 const compiled=compileAggregateQuery(query,schema,5);
 expect(compiled.values).toEqual(['units',1,'amount','flag','amount','amount']);
 expect(compiled.group).not.toContain('::text');
 expect(compiled.sourcePredicate).toContain('CASE WHEN');expect(compiled.select).toContain('round(avg(');expect(compiled.select).toContain(',18)::text');expect(compiled.select).toContain('count(*)::text');expect(compiled.select).toContain("jsonb_typeof(attributes -> $7)='string'");expect(compiled.select).toContain('::numeric END)::text');expect(compiled.select).not.toContain('total');expect(compiled.select).toContain('AS m0');
});

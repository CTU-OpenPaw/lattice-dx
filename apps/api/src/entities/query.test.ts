import {expect,test} from 'vitest';
import {parseEntityQuery,compileEntityQuery} from './query.js';
import type {SchemaPublication} from './types.js';
const schema:SchemaPublication={id:'invoice',version:1,title:'Invoice',fields:{amount:{type:'decimal'},count:{type:'integer'},flag:{type:'boolean'},date:{type:'date'},label:{type:'text',required:true}},relations:{}};
test('strict typed query rejects authority, invalid operators, types and undeclared fields',()=>{
 for(const input of [{schemaId:'invoice'}, {schemaId:'invoice',schemaVersion:1,ownerId:'bob'}, {schemaId:'invoice',schemaVersion:1,limit:0}]) expect(()=>parseEntityQuery(input)).toThrow();
 for(const filter of [{field:'flag',operator:'gt',value:true},{field:'amount',operator:'eq',value:'1e2'},{field:'date',operator:'eq',value:'2026-02-30'},{field:'unknown',operator:'exists'},{field:'id',operator:'exists'},{field:'label',operator:'exists',value:'x'}]) expect(()=>compileEntityQuery(parseEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[filter]}),schema)).toThrow();
 expect(()=>compileEntityQuery(parseEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field:'label',operator:'eq',value:''}]}),schema)).not.toThrow();
});
test('compiler parameterizes names and exact numeric values with existence checks and deterministic null ordering',()=>{
 const compiled=compileEntityQuery(parseEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field:'amount',operator:'ne',value:'9007199254740993.000000000000000001'},{field:'label',operator:'contains',value:'%_'}],sort:{field:'amount',direction:'asc'}}),schema,5);
 expect(compiled.values).toEqual(['amount','9007199254740993.000000000000000001','label','%_','amount']);
 expect(compiled.predicate).toContain('attributes ? $5'); expect(compiled.predicate).toContain('END <> $6::numeric'); expect(compiled.predicate).toContain('strpos(');
 expect(compiled.order).toContain('END ASC NULLS LAST');expect(compiled.order).toContain('id ASC');expect(compiled.predicate).not.toContain('9007199254740993');
});
test('numeric expressions guard JSON type and bounded decimal syntax inside CASE before casting',()=>{
 const decimal=compileEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field:'amount',operator:'gt',value:'1'}],sort:{field:'amount',direction:'asc'}},schema);
 expect(decimal.predicate).toContain("CASE WHEN jsonb_typeof(attributes -> $1)='string'");expect(decimal.predicate).toContain('length(');expect(decimal.predicate).toContain('<=38 THEN');expect(decimal.predicate).toContain('::numeric END');expect(decimal.order).toContain('CASE WHEN');
 const integer=compileEntityQuery({schemaId:'invoice',schemaVersion:1,sort:{field:'count',direction:'desc'}},schema);expect(integer.order).toContain("jsonb_typeof(attributes -> $1)='number'");expect(integer.order).toContain('{0,15}');
});
test('optional members must retain their declared type and JSON bounds',()=>{
 for(const optional of [{filters:null},{limit:null},{offset:null},{sort:null},{filters:Array(11).fill({field:'label',operator:'exists'})},{filters:[{field:'label',operator:'contains',value:'a'.repeat(17000)}]}])expect(()=>parseEntityQuery({schemaId:'invoice',schemaVersion:1,...optional})).toThrow();
});
test('all scalar equality operators and declared sort fields compile while wrong scalar types reject',()=>{
 const cases=[['amount','1.01'],['count',42],['flag',false],['date','2026-10-14'],['label','hello']] as const;
 for(const [field,value] of cases)for(const operator of ['eq','ne'] as const){const compiled=compileEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field,operator,value}],sort:{field,direction:'desc'}},schema);expect(compiled.values).toEqual([field,value,field]);expect(compiled.predicate).toContain('attributes ? $1');}
 for(const [field,value] of [['count','1'],['flag','false'],['label',1],['amount',1]] as const)expect(()=>compileEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field,operator:'eq',value}]},schema)).toThrow();
 expect(()=>compileEntityQuery({schemaId:'invoice',schemaVersion:1,sort:{field:'missing',direction:'asc'}},schema)).toThrow();
 expect(()=>compileEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field:'count',operator:'contains',value:1}]},schema)).toThrow();
 expect(compileEntityQuery({schemaId:'invoice',schemaVersion:1,filters:[{field:'amount',operator:'exists'}]},schema)).toEqual({predicate:'attributes ? $1',order:'created_at DESC,id DESC',values:['amount']});
});

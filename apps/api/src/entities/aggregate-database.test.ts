/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {aggregateEntitiesWithClient} from './aggregate-database.js';
import type {EntityClient} from './client.js';
const scope={actorId:'reader',organizationId:'org'};
const query={schemaId:'invoice',schemaVersion:1,metrics:[{name:'rows',operation:'count' as const},{name:'total',operation:'sum' as const,field:'amount'}]};
function client(rows:unknown[]=[]){
 const sql=vi.fn(async(text:string)=>text.includes('FROM enterprise_schema_versions')?{rows:[{definition:{id:'invoice',title:'Invoice',fields:{amount:{type:'decimal'},flag:{type:'boolean'}},relations:{}},version:1}]}:{rows});
 return {db:{query:sql} as unknown as EntityClient,sql};
}
test('same client uses current publication and uncapped eligible source CTE before aggregation',async()=>{
 const {db,sql}=client([{m0:'5103',m1:'99999999999999999999.30'}]);
 expect(await aggregateEntitiesWithClient(db,scope,query)).toEqual({schemaId:'invoice',schemaVersion:1,groupBy:[],groups:[{keys:[],metrics:{rows:'5103',total:'99999999999999999999.30'}}]});
 const [statement,values]=sql.mock.calls.at(-1)! as unknown as [string,unknown[]];
 expect(statement).toContain('WITH eligible AS MATERIALIZED');expect(statement).toContain('archived_at IS NULL');expect(statement).toContain('schema_id=$3 AND schema_version=$4');expect(statement).toContain('p.enabled=true');expect(statement).toContain('FROM eligible');expect(statement).toContain('LIMIT 201');expect(statement).not.toContain('LIMIT 500');expect(statement).not.toContain('OFFSET');expect(values.slice(0,4)).toEqual(['org','reader','invoice',1]);
 expect(sql.mock.calls.map(([s])=>s)).toContain("SET LOCAL statement_timeout = '3s'");expect(sql.mock.calls.map(([s])=>s)).toContain("SET LOCAL lock_timeout = '1s'");
});
test('SQL empty and missing numeric metrics remain null while count and bool group keys retain their types',async()=>{
 const {db}=client([{m0:'0',m1:null}]);expect((await aggregateEntitiesWithClient(db,scope,query)).groups).toEqual([{keys:[],metrics:{rows:'0',total:null}}]);
 const grouped=client([]);expect((await aggregateEntitiesWithClient(grouped.db,scope,{...query,groupBy:['flag']})).groups).toEqual([]);
 const boolean=client([{g0:false,m0:'1',m1:null}]);expect((await aggregateEntitiesWithClient(boolean.db,scope,{...query,groupBy:['flag']})).groups[0].keys).toEqual([false]);
});
test('201 groups reject and PostgreSQL timeout details are sanitized',async()=>{
 await expect(aggregateEntitiesWithClient(client(Array(201).fill({g0:'a',m0:'1',m1:null})).db,scope,{...query,groupBy:['amount']})).rejects.toMatchObject({statusCode:409});
 for(const code of ['57014','55P03']) {
 const {db,sql}=client();sql.mockRejectedValueOnce(Object.assign(new Error('private SQL detail'),{code}));
 await expect(aggregateEntitiesWithClient(db,scope,query)).rejects.toMatchObject({statusCode:503,message:'Aggregate query timed out.'});
 }
});

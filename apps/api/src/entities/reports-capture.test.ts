// SPDX-License-Identifier: Apache-2.0
import {expect,test,vi} from 'vitest';
import {captureAggregateWithSources,authorizeSnapshotSources} from './reports-capture.js';
import type {EntityClient} from './client.js';
const scope={actorId:'reader',organizationId:'org'};
const query={schemaId:'invoice',schemaVersion:1,metrics:[{name:'rows',operation:'count' as const}]};
test('capture rejects complete source overflow before any storage',async()=>{
 const sql=vi.fn(async(text:string)=>text.includes('enterprise_schema_versions')?{rows:[{version:1,definition:{id:'invoice',fields:{},relations:{}}}]}:{rows:[{sourceIds:Array(5001).fill('id'),groups:[],asOf:new Date()}]});
 await expect(captureAggregateWithSources({query:sql} as unknown as EntityClient,scope,query)).rejects.toMatchObject({statusCode:409});
 expect(sql.mock.calls.at(-1)![0]).toContain('eligible AS MATERIALIZED');
 expect(sql.mock.calls.at(-1)![0]).toContain('LIMIT 5001');
});
test('all source metadata is locked in bulk before current shared directory and ACL checks',async()=>{
 const sql=vi.fn(async(text:string)=>text.includes('FOR SHARE OF e')?{rows:[{id:'a',ownerId:'other',organizationId:'org',archivedAt:null}]}:text.includes('FOR SHARE OF p')?{rows:[{subject:'reader'}]}:{rows:[]});
 await expect(authorizeSnapshotSources({query:sql} as unknown as EntityClient,scope,['a'])).rejects.toMatchObject({statusCode:404});
 expect(sql.mock.calls.map(([s])=>s).join('\n')).toContain('ORDER BY e.id FOR SHARE OF e');
 expect(sql.mock.calls[1][0]).toContain('FOR SHARE OF p');
});

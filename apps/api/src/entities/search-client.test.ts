/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {searchEntities,searchEntitiesWithClient} from './search-client.js';
import {entityDatabase} from './database.js';
const scope={actorId:'reader',organizationId:'tenant'};
const input={q:'x | y',limit:1,offset:4};
function row(id:string){return {id,title:'ordinary',attributes:{amount:42},schemaId:'invoice',schemaVersion:1,ownerId:'reader',organizationId:'tenant',version:1,archivedAt:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'};}
test('same-client plain query puts tenant, current ACL, active and pin before stable pagination',async()=>{
 const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT id')?[row('a'),row('b')]:sql.startsWith('SELECT definition')?[{definition:{id:'invoice'},version:2}]:[]}));
 const client={query} as unknown as PoolClient;
 const result=await searchEntitiesWithClient(client,scope,{...input,schemaId:'invoice',schemaVersion:2});
 expect(query.mock.calls[0][0]).toBe("SET LOCAL statement_timeout = '3s'");
 const call=query.mock.calls.at(-1)! as unknown as [string,unknown[]];
 expect(call[1]).toEqual(['tenant','reader','x | y','invoice',2,2,4]);
 expect(call[0]).toContain("plainto_tsquery('simple'::regconfig,$3)");
 expect(call[0]).toContain('e.organization_id=$1');
 expect(call[0]).toContain('p.enabled=true');
 expect(call[0]).toContain('p.department_id=g.principal_id');
 expect(call[0]).toContain('e.archived_at IS NULL');
 expect(call[0]).toContain('e.schema_id=$4 AND e.schema_version=$5::integer');
 expect(call[0]).toContain('ORDER BY e.created_at DESC,e.id DESC LIMIT $6 OFFSET $7');
 expect(call[0]).not.toMatch(/ts_headline|ts_rank|COUNT\(/i);
 expect(result).toEqual({items:[{...row('a'),createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}],page:{limit:1,offset:4,hasMore:true,nextOffset:5}});
 expect(query.mock.calls.some(([sql])=>/BEGIN|COMMIT|ROLLBACK/.test(sql))).toBe(false);
});
test('unavailable pins fail before search; empty lexemes retain normal empty page',async()=>{
 const query=vi.fn(async(_sql:string)=>({rows:[]}));
 const client={query} as unknown as PoolClient;
 await expect(searchEntitiesWithClient(client,scope,{...input,schemaId:'invoice',schemaVersion:1})).rejects.toMatchObject({statusCode:404});
 expect(query).toHaveBeenCalledTimes(2);
 query.mockClear();
 expect(await searchEntitiesWithClient(client,scope,{...input,q:'!!!'})).toEqual({items:[],page:{limit:1,offset:4,hasMore:false,nextOffset:null}});
 expect(query).toHaveBeenCalledTimes(2);
});
test('wrapper uses one connection, commits or rolls back and sanitizes failures',async()=>{
 const release=vi.fn();
 const query=vi.fn(async(_sql:string)=>({rows:[]}));
 const connect=vi.fn(async()=>({query,release}));
 const pool={connect} as unknown as Pool;
 await searchEntities(pool,scope,input);
 expect(connect).toHaveBeenCalledTimes(1);
 expect(query.mock.calls.map(call=>call[0])).toEqual(['BEGIN',"SET LOCAL statement_timeout = '3s'",expect.stringContaining('plainto_tsquery'),'COMMIT']);
 expect(release).toHaveBeenCalledTimes(1);
 query.mockClear();
 query.mockImplementation(async(sql?:string)=>{if(sql?.startsWith('SELECT'))throw Object.assign(new Error('private SQL'),{code:'57014'});return {rows:[]};});
 await expect(searchEntities(pool,scope,input)).rejects.toMatchObject({statusCode:503,message:'search_unavailable'});
 expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 expect(release).toHaveBeenCalledTimes(2);
});
test('generated scalar-only simple vector and GIN initialization is additive',async()=>{
 const query=vi.fn(async(_sql:string)=>({rows:[]}));
 await entityDatabase({query} as unknown as Pool);
 const ddl=query.mock.calls.find(([sql])=>sql.includes('ADD COLUMN IF NOT EXISTS search_vector'))?.[0];
 expect(ddl).toContain('GENERATED ALWAYS AS');
 expect(ddl).toContain("to_tsvector('simple'::regconfig,coalesce(title,''))");
 expect(ddl).toContain(`jsonb_to_tsvector('simple'::regconfig,attributes,'["string","numeric","boolean"]'::jsonb)`);
 expect(ddl).toContain('STORED');
 expect(ddl).toContain('CREATE INDEX IF NOT EXISTS enterprise_entities_search_idx ON enterprise_entities USING gin(search_vector)');
});
test('connection and commit failures are sanitized and release the held client',async()=>{
 await expect(searchEntities({connect:async()=>{throw new Error('connection secret');}} as unknown as Pool,scope,input)).rejects.toMatchObject({statusCode:503,message:'search_unavailable'});
 const release=vi.fn(),query=vi.fn(async(sql:string)=>{if(sql==='COMMIT')throw new Error('SQL secret');return {rows:[]};});
 await expect(searchEntities({connect:async()=>({query,release})} as unknown as Pool,scope,input)).rejects.toMatchObject({statusCode:503,message:'search_unavailable'});
 expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(release).toHaveBeenCalledTimes(1);
});

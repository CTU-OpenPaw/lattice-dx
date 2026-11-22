/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import type {Pool} from 'pg';
import {contextLinksDatabase} from './database.js';
import type {EntityRepository} from '../entities/types.js';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',scope={organizationId:'org',actorId:'owner'},urn='urn:ngsi-ld:Asset:org:asset';
function fixture(){
 let visible=true,failReceipt=false,active=false,owner='owner',projection=false;let mappings:Record<string,unknown>[]=[],history:unknown[]=[],receipts:Record<string,unknown>[]=[];
 let snapshot:[typeof mappings,typeof history,typeof receipts]=[[],[],[]];
 const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
  if(sql==='BEGIN')snapshot=structuredClone([mappings,history,receipts]);
  if(sql==='ROLLBACK')[mappings,history,receipts]=snapshot;
  if(sql.includes('FROM enterprise_entities WHERE'))return {rows:visible&&values[1]==='org'?[{id:values[0],organizationId:'org',ownerId:owner,createdAt:new Date(),updatedAt:new Date(),archivedAt:null}]:[]};
  if(sql.includes('to_regclass'))return {rows:[{relation:projection?'ngsi_ld_asset_context':null}]};
  if(sql.includes('FROM public.ngsi_ld_asset_context'))return {rows:[{organizationId:values[0],entityId:values[1],businessId:'asset',status:'ready',observedAt:new Date(),receivedAt:new Date()}]};
  if(sql.startsWith('SELECT fingerprint'))return {rows:receipts.filter(r=>r.key===values[3]&&r.operation===values[2])};
  if(sql.startsWith('INSERT INTO enterprise_commands')){if(failReceipt)throw new Error('receipt failed');receipts.push({key:values[3],operation:values[2],fingerprint:values[4],result:JSON.parse(values[5] as string)});}
  if(sql.startsWith('SELECT')&&sql.includes('FROM enterprise_context_links WHERE'))return {rows:mappings.filter(r=>r.entityId===values[1])};
  if(sql.startsWith('INSERT INTO enterprise_context_links(')){
   if(mappings.some(r=>r.entityId!==values[1]&&r.externalId===values[2]&&values[2]!==null))throw Object.assign(new Error('unique'),{code:'23505'});
   const row={provider:'ngsi-ld',entityId:values[1],externalId:values[2],revision:values[3],updatedAt:new Date().toISOString()};mappings=mappings.filter(r=>r.entityId!==values[1]);mappings.push(row);return {rows:[row]};
  }
  if(sql.startsWith('INSERT INTO enterprise_context_link_history'))history.push(values);
  return {rows:[]};
 });
 const pool={query:async(sql:string,values?:unknown[])=>{if(active)throw new Error('nested pool acquisition');return query(sql,values);},connect:async()=>{if(active)throw new Error('max one client');active=true;return {query,release(){active=false;}};}} as unknown as Pool;
 return {pool,query,setVisible:(value:boolean)=>{visible=value;},setOwner:(value:string)=>{owner=value;},enableProjection:()=>{projection=true;},failReceipt:()=>{failReceipt=true;},state:()=>({mappings,history,receipts})};
}
test('versions survive tombstones, exact replay returns accepted result, conflicts and active uniqueness roll back',async()=>{
 const f=fixture(),repo=await contextLinksDatabase(f.pool,{} as EntityRepository);
 const first=await repo.put(scope,id,{externalId:urn,expectedRevision:0},'first');expect(first.revision).toBe(1);
 const removed=await repo.remove(scope,id,{expectedRevision:1},'remove');expect(removed).toMatchObject({externalId:null,revision:2});
 expect(await repo.put(scope,id,{externalId:urn,expectedRevision:0},'first')).toEqual(first);
 await expect(repo.put(scope,id,{externalId:urn+'2',expectedRevision:0},'first')).rejects.toMatchObject({statusCode:409,code:'idempotency_conflict'});
 await expect(repo.put(scope,id,{externalId:urn,expectedRevision:0},'stale')).rejects.toMatchObject({statusCode:409,code:'revision_conflict'});
 expect((await repo.put(scope,other,{externalId:urn,expectedRevision:0},'other')).revision).toBe(1);
 await expect(repo.put(scope,id,{externalId:urn,expectedRevision:2},'duplicate')).rejects.toMatchObject({statusCode:409,code:'external_id_conflict'});
 expect((await repo.put(scope,id,{externalId:urn+'2',expectedRevision:2},'rebind')).revision).toBe(3);
 expect(f.state().history).toHaveLength(4);expect(f.state().receipts).toHaveLength(4);
 expect(f.query.mock.calls[0][0]).toContain('WHERE external_id IS NOT NULL');
});
test('receipt failure rolls back mapping and audit; denied replay checks current ACL before conflicts',async()=>{
 const f=fixture(),repo=await contextLinksDatabase(f.pool,{} as EntityRepository);
 await repo.put(scope,id,{externalId:urn,expectedRevision:0},'first');f.setVisible(false);
 await expect(repo.put(scope,id,{externalId:urn+'2',expectedRevision:0},'first')).rejects.toMatchObject({statusCode:404});
 expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 f.setVisible(true);f.failReceipt();await expect(repo.remove(scope,id,{expectedRevision:1},'remove')).rejects.toThrow('receipt failed');
 expect(f.state().mappings[0]).toMatchObject({externalId:urn,revision:1});expect(f.state().history).toHaveLength(1);
});
test('read authorization precedes mapping/projection and context never fabricates observations',async()=>{
 const f=fixture(),repo=await contextLinksDatabase(f.pool,{} as EntityRepository,{projectionEnabled:true});f.setVisible(false);
 await expect(repo.context(scope,id)).rejects.toMatchObject({statusCode:404});expect(f.query.mock.calls.some(([sql])=>sql.includes('to_regclass'))).toBe(false);
 f.setVisible(true);expect(await repo.context(scope,id)).toMatchObject({status:'not_linked',mapping:null,observation:null});
 await repo.put(scope,id,{externalId:urn,expectedRevision:0},'first');
 const disabled=await contextLinksDatabase(f.pool,{} as EntityRepository);expect(await disabled.context(scope,id)).toMatchObject({status:'source_unavailable',observation:null});
 expect(f.query.mock.calls.some(([sql])=>sql.includes('to_regclass'))).toBe(false);
});
test('enabled projection reads on the one acquired client and denied sharing or tenants cannot replay receipts',async()=>{
 const f=fixture(),repo=await contextLinksDatabase(f.pool,{} as EntityRepository,{projectionEnabled:true});f.enableProjection();
 await repo.put(scope,id,{externalId:urn,expectedRevision:0},'first');expect(await repo.context(scope,id)).toMatchObject({status:'fresh',observation:{provider:'ngsi-ld',externalId:urn,status:'ready'}});
 await expect(repo.context({...scope,organizationId:'other'},id)).rejects.toMatchObject({statusCode:404});
 await expect(repo.put({...scope,organizationId:'other'},id,{externalId:'urn:ngsi-ld:Asset:other:asset',expectedRevision:0},'first')).rejects.toMatchObject({statusCode:404});
 f.setOwner('different-owner');
 await expect(repo.put(scope,id,{externalId:urn,expectedRevision:0},'first')).rejects.toMatchObject({statusCode:404});
 expect(f.query.mock.calls.some(([sql])=>sql.includes('FOR SHARE OF p'))).toBe(true);
});
test('removing absent or already removed mappings never writes an audit or receipt',async()=>{
 const f=fixture(),repo=await contextLinksDatabase(f.pool,{} as EntityRepository);
 await expect(repo.remove(scope,id,{expectedRevision:0},'absent')).rejects.toMatchObject({statusCode:409,code:'revision_conflict'});
 await repo.put(scope,id,{externalId:urn,expectedRevision:0},'first');await repo.remove(scope,id,{expectedRevision:1},'remove');
 await expect(repo.remove(scope,id,{expectedRevision:2},'again')).rejects.toMatchObject({statusCode:409});
 expect(f.state().history).toHaveLength(2);expect(f.state().receipts).toHaveLength(2);
});

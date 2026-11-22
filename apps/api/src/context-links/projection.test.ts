/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {readProjection} from './projection.js';
import {externalId as validateExternalId} from './policy.js';
const externalId='urn:ngsi-ld:Asset:org:asset';
const now=Date.parse('2026-10-15T10:00:00.000Z');
const row={organizationId:'org',entityId:externalId,businessId:'asset',status:'ready',observedAt:'2026-10-15T09:59:00.000Z',receivedAt:'2026-10-15T09:59:01.000Z'};
test('disabled projection does not query; missing known relation is explicitly unavailable',async()=>{
 const query=vi.fn(async()=>({rows:[{relation:null}]}));
 expect(await readProjection({query} as never,'org',externalId,false,now)).toEqual({status:'source_unavailable',observation:null});expect(query).not.toHaveBeenCalled();
 expect(await readProjection({query} as never,'org',externalId,true,now)).toEqual({status:'source_unavailable',observation:null});
 expect(query.mock.calls[0]).toEqual(["SELECT to_regclass('public.ngsi_ld_asset_context') AS relation"]);
});
test('fixed read-only source returns bounded provenance with observation age freshness',async()=>{
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:'ngsi_ld_asset_context'}]:[row]}));
 expect(await readProjection({query} as never,'org',externalId,true,now)).toEqual({status:'fresh',observation:{provider:'ngsi-ld',externalId,status:'ready',observedAt:row.observedAt,receivedAt:row.receivedAt}});
 expect((await readProjection({query} as never,'org',externalId,true,now+300_000)).status).toBe('stale');
 expect(query.mock.calls[1][0]).toContain('FROM public.ngsi_ld_asset_context WHERE organization_id=$1 AND entity_id=$2');
});
test('projection accepts the mapping business-ID alphabet including leading hyphen and rejects other characters',async()=>{
 const businessId='-asset',linkedId=`urn:ngsi-ld:Asset:org:${businessId}`;
 expect(validateExternalId(linkedId,'org')).toBe(linkedId);
 const query=async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:'present'}]:[{...row,entityId:linkedId,businessId}]});
 expect(await readProjection({query} as never,'org',linkedId,true,now)).toMatchObject({status:'fresh',observation:{externalId:linkedId,status:'ready'}});
 for(const businessId of ['asset.id','asset:id','asset id','á','']){
  const invalidId=`urn:ngsi-ld:Asset:org:${businessId}`;
  const query=async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:'present'}]:[{...row,entityId:invalidId,businessId}]});
  await expect(readProjection({query} as never,'org',invalidId,true,now)).rejects.toMatchObject({statusCode:503,code:'source_invalid'});
 }
});
test('bad scope, status, dates and source query failure are controlled unavailable errors',async()=>{
 for(const change of [{organizationId:'other'},{entityId:'wrong'},{businessId:'wrong'},{status:'workflow_done'},{observedAt:'2026-02-30T00:00:00Z'},{receivedAt:'tomorrow'},{observedAt:'2026-10-15T11:00:00Z'}]){
  const query=async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:'present'}]:[{...row,...change}]});
  await expect(readProjection({query} as never,'org',externalId,true,now)).rejects.toMatchObject({statusCode:503,code:'source_invalid'});
 }
 await expect(readProjection({query:async()=>{throw new Error('secret');}} as never,'org',externalId,true,now)).rejects.toMatchObject({statusCode:503,code:'source_unavailable'});
 const query=async(sql:string)=>({rows:sql.includes('to_regclass')?[{relation:'present'}]:[]});
 expect(await readProjection({query} as never,'org',externalId,true,now)).toEqual({status:'no_observation',observation:null});
});

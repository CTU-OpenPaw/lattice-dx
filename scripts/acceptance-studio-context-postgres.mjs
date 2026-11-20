/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Explicit opt-in acceptance: all fixture writes occur in a newly created, disposable database.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=String.raw`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {entityDatabase} from './src/entities/database.ts';
import {contextLinksDatabase} from './src/context-links/database.ts';
import {readProjection} from './src/context-links/projection.ts';

const database='studio_context_acceptance_'+randomUUID().replaceAll('-','');
const control=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:3000});
let pool,concurrent,created=false;
const safe=()=>assert.match(database,/^studio_context_acceptance_[a-f0-9]{32}$/);
const fail=(code)=>error=>error.code===code;
try {
 safe();await control.query('CREATE DATABASE '+database);created=true;
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+database;
 assert.notEqual(url.pathname,new URL(process.env.DATABASE_URL).pathname);
 const options={connectionString:url.href,connectionTimeoutMillis:3000,statement_timeout:5000};
 pool=new pg.Pool({...options,max:1});
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,database);
 const entities=await entityDatabase(pool),repo=await contextLinksDatabase(pool,entities);
 const scope={actorId:'owner',organizationId:'accept-a'},foreign={actorId:'owner',organizationId:'accept-b'},peer={actorId:'peer',organizationId:'accept-a'};
 for(const owner of [scope,foreign]){await entities.createSchema(owner,{id:'asset',title:'Acceptance asset',fields:{},relations:{}});await entities.publishSchema(owner,'asset',1);}
 const create=(owner,key)=>entities.create(owner,{schemaId:'asset',title:'Acceptance '+key,attributes:{}},key);
 const a=await create(scope,'a'),b=await create(scope,'b'),c=await create(scope,'c'),d=await create(scope,'d'),f=await create(foreign,'f');
 const urn='urn:ngsi-ld:Asset:accept-a:asset',input={externalId:urn,expectedRevision:0};
 const first=await repo.put(scope,a.id,input,'first');assert.equal(first.revision,1);
 assert.deepEqual(await repo.put(scope,a.id,input,'first'),first);
 await assert.rejects(()=>repo.put(scope,a.id,{...input,externalId:urn+'-other'},'first'),fail('idempotency_conflict'));
 await assert.rejects(()=>repo.put(scope,a.id,input,'stale'),fail('revision_conflict'));
 assert.equal((await repo.context(scope,a.id)).status,'source_unavailable');
 for(const method of ['get','context','history'])await assert.rejects(()=>method==='history'?repo.history(foreign,a.id,{limit:50,offset:0,q:''}):repo[method](foreign,a.id),error=>error.statusCode===404);
 await assert.rejects(()=>repo.get(peer,a.id),error=>error.statusCode===404);
 // Seed only the disposable database's directory, then grant/revoke through ordinary repository commands.
 await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES($1,$2,$3,true)',[peer.actorId,scope.organizationId,'Acceptance peer']);
 const sharedEntity=await create(scope,'shared-replay');
 const granted=await entities.share(scope,sharedEntity.id,{expectedVersion:sharedEntity.version,principal:{kind:'person',id:peer.actorId},permission:'read'},'grant-peer');
 const sharedInput={externalId:'urn:ngsi-ld:Asset:accept-a:shared-replay',expectedRevision:0};
 const sharedReceipt=await repo.put(peer,sharedEntity.id,sharedInput,'peer-receipt');
 assert.deepEqual(await repo.put(peer,sharedEntity.id,sharedInput,'peer-receipt'),sharedReceipt);
 await entities.revokeShare(scope,sharedEntity.id,{expectedVersion:granted.version,kind:'person',principalId:peer.actorId},'revoke-peer');
 await assert.rejects(()=>repo.put(peer,sharedEntity.id,sharedInput,'peer-receipt'),error=>error.statusCode===404);
 await assert.rejects(()=>repo.remove(peer,sharedEntity.id,{expectedRevision:1},'revoked-remove'),error=>error.statusCode===404);
 assert.deepEqual(await repo.get(scope,sharedEntity.id),sharedReceipt);
 assert.equal((await repo.history(scope,sharedEntity.id,{limit:100,offset:0,q:''})).items.length,1);
 await assert.rejects(()=>repo.put(foreign,a.id,{externalId:'urn:ngsi-ld:Asset:accept-b:asset',expectedRevision:0},'first'),error=>error.statusCode===404);
 await repo.put(foreign,f.id,{externalId:'urn:ngsi-ld:Asset:accept-b:asset',expectedRevision:0},'first');
 await assert.rejects(()=>repo.get(scope,f.id),error=>error.statusCode===404);
 const count=async table=>(await pool.query('SELECT count(*)::integer AS count FROM '+table)).rows[0].count;
 const before={history:await count('enterprise_context_link_history'),receipts:await count('enterprise_commands')};
 await pool.query("ALTER TABLE enterprise_commands ADD CONSTRAINT acceptance_receipt_failure CHECK(operation NOT LIKE 'context.links.%') NOT VALID");
 await assert.rejects(()=>repo.remove(scope,a.id,{expectedRevision:1},'rollback'),error=>error.code==='23514');
 assert.deepEqual(await repo.get(scope,a.id),first);assert.equal(await count('enterprise_context_link_history'),before.history);assert.equal(await count('enterprise_commands'),before.receipts);
 await pool.query('ALTER TABLE enterprise_commands DROP CONSTRAINT acceptance_receipt_failure');
 const removed=await repo.remove(scope,a.id,{expectedRevision:1},'rollback');assert.equal(removed.externalId,null);assert.equal(removed.revision,2);
 assert.deepEqual(await repo.put(scope,a.id,input,'first'),first);
 assert.equal((await repo.history(scope,a.id,{limit:100,offset:0,q:''})).items.length,2);
 assert.equal((await repo.context(scope,a.id)).status,'not_linked');
 await repo.put(scope,a.id,{externalId:urn,expectedRevision:2},'rebind');
 // A distinct pool permits true races, in addition to every max1 operation above.
 concurrent=new pg.Pool({...options,max:4});const races=await contextLinksDatabase(concurrent,entities);
 const shared='urn:ngsi-ld:Asset:accept-a:unique';
 const results=await Promise.allSettled([b,c].map((entity,index)=>races.put(scope,entity.id,{externalId:shared,expectedRevision:0},'unique-'+index)));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='external_id_conflict').length,1);
 const replays=await Promise.all(Array.from({length:5},()=>races.put(scope,d.id,{externalId:urn+'-replay',expectedRevision:0},'five-replays')));
 for(const replay of replays)assert.deepEqual(replay,replays[0]);
 assert.equal((await repo.history(scope,d.id,{limit:100,offset:0,q:''})).items.length,1);
 // Projection is public-qualified; a whole disposable database is mandatory, not search_path isolation.
 const enabled=await contextLinksDatabase(pool,entities,{projectionEnabled:true});
 assert.equal((await enabled.context(scope,a.id)).status,'source_unavailable');
 await pool.query('CREATE TABLE public.ngsi_ld_asset_context(organization_id text,entity_id text,business_id text,status text,observed_at timestamptz,received_at timestamptz)');
 assert.equal((await enabled.context(scope,a.id)).status,'no_observation');
 await pool.query("INSERT INTO public.ngsi_ld_asset_context VALUES($1,$2,'asset','ready',now(),now()),('accept-b',$3,'foreign','repair',now(),now())",[scope.organizationId,urn,'urn:ngsi-ld:Asset:accept-b:foreign']);
 const client=await pool.connect();try{await client.query('BEGIN READ ONLY');assert.equal((await readProjection(client,scope.organizationId,urn,true)).status,'fresh');await client.query('COMMIT');}finally{client.release();}
 const projectionBefore=(await pool.query('SELECT * FROM public.ngsi_ld_asset_context ORDER BY organization_id,entity_id')).rows;
 assert.equal((await enabled.context(scope,a.id)).status,'fresh');assert.equal((await repo.context(scope,a.id)).status,'source_unavailable');
 assert.deepEqual((await pool.query('SELECT * FROM public.ngsi_ld_asset_context ORDER BY organization_id,entity_id')).rows,projectionBefore);
 await pool.query("UPDATE public.ngsi_ld_asset_context SET observed_at=now()-interval '301 seconds' WHERE organization_id=$1",[scope.organizationId]);
 assert.equal((await enabled.context(scope,a.id)).status,'stale');
 await pool.query("UPDATE public.ngsi_ld_asset_context SET business_id='wrong' WHERE organization_id=$1",[scope.organizationId]);
 await assert.rejects(()=>enabled.context(scope,a.id),fail('source_invalid'));
 await pool.query('ALTER TABLE public.ngsi_ld_asset_context RENAME COLUMN status TO invalid_status');
 await assert.rejects(()=>enabled.context(scope,a.id),fail('source_unavailable'));
 console.log(JSON.stringify({database,result:'passed',checks:['pool-max1','tenant-and-current-resource-scope','revoked-share-receipt-replay-denied','revision-and-replay','late-receipt-rollback','retained-unbind-audit','concurrent-active-uniqueness','five-concurrent-receipts','projection-read-only-transaction','projection-disabled-missing-empty-fresh-stale-invalid-query-failure']}));
} finally {
 await concurrent?.end();await pool?.end();
 try{if(created){safe();await control.query('DROP DATABASE '+database);}}finally{await control.end();}
}
`;

try {
 const output=execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','node','--import','tsx','--input-type=module'],{cwd:fileURLToPath(new URL('../',import.meta.url)),input:source,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000});
 console.log(output.trim());
} catch {
 // Raw driver/CLI output can contain a connection URL or serialized private row.
 console.error('Studio context PostgreSQL acceptance failed. No raw driver output was printed; inspect locally with redaction. A failed cleanup may retain only a studio_context_acceptance_<random> database.');
 process.exitCode=1;
}

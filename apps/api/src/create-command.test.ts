// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { parseCreateKey, createFingerprint } from './create-command.js';
test('optional create key accepts only a single bounded opaque header',()=>{
 expect(parseCreateKey(undefined)).toBeUndefined();
 expect(parseCreateKey('retry-1:A')).toBe('retry-1:A');
 for(const value of ['', 'a,b', ['a','b'], ' x', 'x'.repeat(129)])expect(()=>parseCreateKey(value)).toThrow();
 expect(()=>parseCreateKey('a',['Idempotency-Key','a','idempotency-key','a'])).toThrow();
});
test('fingerprints are stable for normalized title and UUID but preserve assignee identity',()=>{
 expect(createFingerprint({title:'  Hello ',recordId:'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',assigneeId:'Alice'})).toBe(createFingerprint({assigneeId:'Alice',recordId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'Hello'}));
 expect(createFingerprint({title:'Hello',assigneeId:'Alice'})).not.toBe(createFingerprint({title:'Hello',assigneeId:'alice'}));
});
// These tests verify transaction orchestration; PostgreSQL race/persistence evidence is supplied by the live smoke.
import { runCreateCommand } from './create-command.js';
import type { Pool } from 'pg';
function commandPool(receipt?:{fingerprint:string;result:unknown},failReceipt=false) {
 const events:string[]=[];
 const client={async query(sql:string){
   if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')events.push(sql);
   if(sql.startsWith('SELECT fingerprint'))return {rows:receipt?[receipt]:[]};
   if(sql.startsWith('INSERT INTO foundation_create_commands')){events.push('receipt');if(failReceipt)throw new Error('receipt failed');}
   return {rows:[]};
 },release(){events.push('release');}};
 let connections=0;
 return {pool:{async connect(){connections++;return client;}} as unknown as Pool,events,connections:()=>connections};
}
test('replay validates current references before returning creation snapshot using one connection',async()=>{
 const snapshot={id:'task',status:'pending',version:1};
 const fixture=commandPool({fingerprint:createFingerprint({title:'Hello'}),result:snapshot});
 const identity={organizationId:'org',actorId:'alice',operation:'tasks.create' as const,key:'retry'};
 let creations=0;
 expect(await runCreateCommand(fixture.pool,identity,{title:' Hello '},async()=>{fixture.events.push('validate');},async()=>{creations++;return {id:'other'};})).toEqual(snapshot);
 expect(creations).toBe(0);expect(fixture.connections()).toBe(1);expect(fixture.events).toEqual(['BEGIN','validate','COMMIT','release']);
 await expect(runCreateCommand(fixture.pool,identity,{title:'Hello'},async()=>{throw new Error('revoked');},async()=>snapshot)).rejects.toThrow('revoked');
 expect(fixture.events.slice(-3)).toEqual(['BEGIN','ROLLBACK','release']);
});
test('conflicts and receipt insertion failures roll back and always release the client',async()=>{
 const identity={organizationId:'org',actorId:'alice',operation:'records.create' as const,key:'retry'};
 const conflict=commandPool({fingerprint:createFingerprint({title:'First'}),result:{id:'first'}});
 await expect(runCreateCommand(conflict.pool,identity,{title:'Different'},async()=>{},async()=>({id:'new'}))).rejects.toMatchObject({statusCode:409});
 expect(conflict.events).toEqual(['BEGIN','ROLLBACK','release']);
 const failed=commandPool(undefined,true);
 await expect(runCreateCommand(failed.pool,identity,{title:'First'},async()=>{},async()=>{failed.events.push('entity');return {id:'new'};})).rejects.toThrow('receipt failed');
 expect(failed.events).toEqual(['BEGIN','entity','receipt','ROLLBACK','release']);expect(failed.connections()).toBe(1);
});
test('no-key creates validate and create independently without writing receipts',async()=>{
 const fixture=commandPool();let creations=0;
 for(let i=0;i<2;i++)expect(await runCreateCommand(fixture.pool,{organizationId:'org',actorId:'alice',operation:'records.create'},{title:'Same'},async()=>{fixture.events.push('validate');},async()=>({id:++creations}))).toEqual({id:i+1});
 expect(fixture.events).not.toContain('receipt');expect(creations).toBe(2);
});

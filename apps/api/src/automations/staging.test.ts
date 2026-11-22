/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import type {PoolClient} from 'pg';
import {stageEntityEvent} from './staging.js';
const event={id:'event',entityId:'entity',schemaId:'invoice',schemaVersion:1,fromVersion:0,toVersion:1,operation:'entity.create' as const,actorSubject:'alice',occurredAt:new Date().toISOString()};
test('explicit missing rule stores preserves journal only fixtures',async()=>{
 const calls:string[]=[];await stageEntityEvent({async query(sql:string){calls.push(sql);return {rows:[]};}} as unknown as PoolClient,'org',event);
 expect(calls).toHaveLength(1);expect(calls[0]).toContain('to_regclass');
});
test('staging snapshots bounded matching current rules on caller connection without workflow calls or rule locks',async()=>{
 const calls:{sql:string;v:unknown[]}[]=[];const db={async query(sql:string,v:unknown[]=[]){calls.push({sql,v});if(sql.includes('to_regclass'))return {rows:[{present:true}]};if(sql.startsWith('SELECT'))return {rows:[{id:'rule',revision:2,snapshot:{id:'rule',enabled:true}}]};return {rows:[]};}} as unknown as PoolClient;
 await stageEntityEvent(db,'org',event);
 expect(calls[1].sql).toContain('LIMIT 10');expect(calls[1].sql).not.toMatch(/FOR (UPDATE|SHARE)/);
 expect(calls[2].sql).toContain('INSERT INTO entity_automation_deliveries');expect(calls[2].v).toContain(JSON.stringify({id:'rule',enabled:true}));
});
test('server derived chain depth eight journals without enqueueing recursive same schema creates',async()=>{
 const calls:string[]=[];
 await stageEntityEvent({async query(sql:string){calls.push(sql);if(sql.includes('to_regclass'))return {rows:[{present:true}]};return {rows:[{id:'rule',revision:1,snapshot:{schemaId:'invoice',operations:['entity.create']}}]};}} as unknown as PoolClient,'org',{...event,automationDepth:8});
 expect(calls).toHaveLength(0);
});

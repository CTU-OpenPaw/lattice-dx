/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import type {Pool} from 'pg';
import {automationsDatabase} from './database.js';
const actor={subject:'admin',organizationId:'org',roles:['workflow:design','data:automate']};
const rule={id:'invoice-start',schemaId:'invoice',schemaVersion:1,operations:['entity.create'] as const,serviceId:'automation',definitionId:'invoice-flow',definitionVersion:1,title:{source:'event',field:'entityId'} as const,input:{},enabled:true};
const def={id:'invoice-flow',version:1,title:'Flow',startRole:'start',initialState:'new',startFields:{},readerRoles:[],transitions:[]};
function fixture(count=0){const calls:{sql:string;v:unknown[]}[]=[];const client={release(){},async query(sql:string,v:unknown[]=[]){calls.push({sql,v});if(sql.includes('SELECT subject FROM workflow_services'))return {rows:[{subject:'actual-service'}]};if(sql.includes('SELECT subject,roles'))return {rows:[{subject:'actual-service',roles:['workflow:service','workflow:start','data:read','start']}]};if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{version:1}]};if(sql.includes('count(*)'))return {rows:[{count}]};if(sql.includes('RETURNING snapshot'))return {rows:[{snapshot:rule,revision:1,createdAt:new Date(),updatedAt:new Date()}]};return {rows:[],rowCount:0};}};return {calls,pool:{query:client.query,connect:async()=>client} as unknown as Pool};}
test('rule create validates current configured service/pins and serializes organization bounds before immutable revision insert',async()=>{
 const f=fixture();const repo=await automationsDatabase(f.pool,{get:async()=>def} as never,{} as never);
 expect(await repo.create({...rule,operations:[...rule.operations]},actor,'key')).toMatchObject({revision:1});
 expect(f.calls.some(c=>c.sql.includes('pg_advisory_xact_lock'))).toBe(true);
 expect(f.calls.some(c=>c.sql.includes('INSERT INTO entity_automation_rule_versions'))).toBe(true);
 expect(f.calls.some(c=>c.sql.includes('INSERT INTO workflow_services')||c.sql.includes('directory_people SET'))).toBe(false);
});
test('maximum rules bound rejects transaction without inserting a rule',async()=>{
 const f=fixture(100);const repo=await automationsDatabase(f.pool,{get:async()=>def} as never,{} as never);
 await expect(repo.create({...rule,operations:[...rule.operations]},actor,'key')).rejects.toThrow('rule_limit');
 expect(f.calls.some(c=>c.sql.includes('INSERT INTO entity_automation_rules('))).toBe(false);
});

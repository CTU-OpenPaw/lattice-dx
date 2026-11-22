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
import {workflowDatabase} from './database.js';

const actor={subject:'owner',organizationId:'org',roles:['workflow:start','incident:create','tasks:assign']};
const run={id:'11111111-1111-4111-8111-111111111111',definitionId:'incident-response',definitionVersion:1,ownerId:'owner',organizationId:'org',state:'open',version:1,data:{},createdAt:'2026-10-18',updatedAt:'2026-10-18'};
async function fixture(directoryRoles:string[]|null){
 const query=vi.fn(async(sql:string)=>{
  if(sql.includes('FROM directory_people'))return {rows:directoryRoles?[{roles:directoryRoles}]:[],rowCount:directoryRoles?1:0};
  if(sql.includes('FROM workflow_runs'))return {rows:[run],rowCount:1};
  if(sql.startsWith('INSERT INTO records'))throw Error('unauthorized creation reached mutation');
  if(sql.startsWith('UPDATE workflow_runs'))throw Error('unauthorized lifecycle reached mutation');
  return {rows:[],rowCount:0};
 });
 const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
 const definition={id:run.definitionId,version:1,title:'Incident',startRole:'incident:create',initialState:'open',startFields:{},readerRoles:[],transitions:[]};
 const repo=await workflowDatabase(pool,{get:async()=>definition,list:async()=>[definition]});query.mockClear();return {repo,query};
}
test('incident creation rejects disabled, revoked and worker principals before writes',async()=>{
 for(const [directoryRoles,jwtRoles] of [[null,actor.roles],[['incident:create'],actor.roles],[['workflow:start'],actor.roles],[actor.roles,[...actor.roles,'agent:worker']],[[...actor.roles,'connector:agent'],actor.roles]] as [string[]|null,string[]][]){
  const {repo,query}=await fixture(directoryRoles);
  await expect(repo.create({definitionId:run.definitionId,title:'Incident',input:{}},{...actor,roles:jwtRoles},'new')).rejects.toMatchObject({statusCode:403});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT')||sql.startsWith('UPDATE'))).toBe(false);
 }
});
test('incident owner cancellation and transfer recheck directory and reject workers',async()=>{
 for(const directoryRoles of [null,[],[...actor.roles,'agent:worker']]){
  const {repo,query}=await fixture(directoryRoles);
  await expect(repo.cancel!(run.id,{expectedVersion:1,reason:'Cancel'},actor,'cancel')).rejects.toMatchObject({statusCode:403});
  await expect(repo.taskTransfer!(run.id,{expectedVersion:1,reason:'Transfer',taskId:run.id,assigneeId:'next'},actor,'transfer')).rejects.toMatchObject({statusCode:403});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT')||sql.startsWith('UPDATE'))).toBe(false);
 }
});

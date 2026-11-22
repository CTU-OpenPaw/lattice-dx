/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {execFileSync} from 'node:child_process';
import { dockerContextArgs } from './lib/docker-context.mjs';
const source = `
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';import {eventsDatabase} from './src/events/database.ts';import {organizationDatabase} from './src/organization/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='completion_review_'+randomUUID().replaceAll('-','');let pool;
try{assert.match(schema,/^completion_review_[a-f0-9]{32}$/);await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:6});
await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);const registry=await definitionDatabase(pool);
let active=false,sourceLockedResolve,assigneeLockedResolve;const sourceLocked=new Promise(r=>sourceLockedResolve=r),assigneeLocked=new Promise(r=>assigneeLockedResolve=r);
function instrument(mode){return {query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,args)=>{if(active&&mode==='snapshot'&&sql==='LOCK TABLE directory_people IN EXCLUSIVE MODE')assigneeLockedResolve();const result=await c.query(sql,args);if(active&&mode==='event'&&typeof sql==='string'&&sql.startsWith('SELECT roles FROM directory_people')){sourceLockedResolve();await assigneeLocked;}if(active&&mode==='snapshot'&&typeof sql==='string'&&sql.startsWith('INSERT INTO directory_people')&&args[0]==='a-assignee'){assigneeLockedResolve();}return result;}};}};}
const workflows=await workflowDatabase(instrument('event'),registry),events=await eventsDatabase(instrument('event'),registry,workflows),directory=await organizationDatabase(instrument('snapshot'));
const actor={subject:'z-source',organizationId:'review-org',roles:['workflow:start','employee','workflow:event:receive','workflow:design','workflow:integrate']},admin={subject:'admin',organizationId:'review-org',roles:['directory:manage']};
const people=[{subject:'a-assignee',displayName:'Assignee',roles:['employee'],enabled:true},{subject:'z-source',displayName:'Source',roles:actor.roles,enabled:true}];await directory.replaceSnapshot(admin,{expectedRevision:0,people},'initial');
const def={id:'review-event',title:'Review',startRole:'employee',initialState:'draft',startFields:{recipient:'subject'},assignedReader:{field:'recipient',role:'employee',states:['draft']},readerRoles:[],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};await registry.create(def,actor);await registry.publish(def.id,1,actor);
await events.createSubscription({id:'review-sub',eventType:'review',sourceSubject:actor.subject,definitionId:def.id,definitionVersion:1,title:{source:'literal',value:'Review event'},input:{recipient:{source:'literal',value:'a-assignee'}},enabled:true},actor,'subscription');
active=true;const receive=events.receive({eventId:'review-event-one',eventType:'review',occurredAt:new Date().toISOString(),data:{}},actor);await sourceLocked;const snapshot=directory.replaceSnapshot(admin,{expectedRevision:1,people:people.map(p=>({...p,displayName:p.displayName+' updated'}))},'replace');
const results=await Promise.allSettled([receive,snapshot]);const summary=results.map((r,i)=>({operation:i?'replaceSnapshot':'receive',status:r.status,...(r.status==='rejected'?{code:r.reason.code,message:r.reason.message}: {})}));console.log(JSON.stringify({schema,results:summary}));assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
console.log('Directory concurrency passed: inbound source and different assignee complete while snapshot waits before locking person rows.');
}finally{await pool?.end();assert.match(schema,/^completion_review_[a-f0-9]{32}$/);await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',[...dockerContextArgs(), 'compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{encoding:'utf8',timeout:90000}).trim());

// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedTeamIntegration} from './seed-team-integration.mjs';
import {localConfig,loginActors,api} from './lib/team-integration.mjs';
async function smoke(){
 const config=localConfig(),actors=await loginActors(config),call=api(config,actors);
 const a=await seedTeamIntegration({config,actors}),ep='/v1/entities/'+a.entityId,wp='/v1/workflows/'+a.workflowId;
 const workflow=await call('warehouse',wp);assert.equal(workflow.ownerId,actors.alice.subject);assert.equal(workflow.organizationId,'org-a');assert.ok(workflow.availableTransitions.some(t=>t.id==='approve'));
 const inbox=await call('warehouse','/v1/workflows?inbox=true&definitionId='+a.definitionId);assert.ok(inbox.items.some(w=>w.id===a.workflowId));
 await call('warehouse',ep,'GET',undefined,404);await call('warehouse',wp+'/entity-context','GET',undefined,404);
 await call('bob',ep,'GET',undefined,403);await call('bob',wp,'GET',undefined,404);
 let entity=await call('alice',ep);
 entity=await call('alice',ep+'/shares','POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'});
 assert.equal((await call('warehouse',wp+'/entity-context')).context.entityId,a.entityId);assert.equal((await call('warehouse',ep)).id,a.entityId);
 await call('warehouse',ep,'PATCH',{expectedVersion:entity.version,title:'Read grant cannot edit',attributes:{assetCode:a.moduleId,description:'denied'}},404);
 entity=await call('alice',ep+'/shares/person/'+encodeURIComponent(actors.warehouse.subject),'DELETE',{expectedVersion:entity.version});
 await call('warehouse',ep,'GET',undefined,404);await call('warehouse',wp+'/entity-context','GET',undefined,404);assert.equal((await call('warehouse',wp)).id,a.workflowId);
 const command={action:'approve',expectedVersion:1,input:{reason:'Warehouse reviewed asset'}};
 await call('alice',wp+'/transitions','POST',command,403);await call('bob',wp+'/transitions','POST',command,404);
 const key=randomUUID(),approved=await call('warehouse',wp+'/transitions','POST',command,200,key);assert.equal(approved.state,'reviewed');assert.equal(approved.version,2);
 const replay=await call('warehouse',wp+'/transitions','POST',command,200,key);assert.equal(replay.version,approved.version);assert.equal(replay.state,approved.state);
 await call('warehouse',wp+'/transitions','POST',{action:'reopen',expectedVersion:1,input:{reason:'Stale revision'}},409);
 // This module is a workflow approval; it creates no ordinary foundation task or task wait.
 assert.equal(approved.waiting,undefined);
 const waits=await call('warehouse',wp+'/waits');assert.equal(waits.items.length,0);
 const tasks=await call('warehouse','/v1/tasks?limit=100');assert.ok(tasks.items.every(t=>t.title!=='Review '+a.moduleId));
 console.log('Team integration signed HTTP passed: fresh fixture, separate workflow/entity ACL, explicit grant/revoke, cross-tenant denial, approval authority, replay and stale version.');console.log(JSON.stringify(a,null,2));
}
smoke().catch(error=>{console.error(error instanceof assert.AssertionError?'Team integration assertion failed.':'Team integration smoke failed: '+error.message);process.exitCode=1;});


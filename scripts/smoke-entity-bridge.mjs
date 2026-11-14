/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {seedTeamIntegration} from './seed-team-integration.mjs';
import {localConfig,loginActors} from './lib/team-integration.mjs';
const {createBridge}=createRequire(import.meta.url)('../plugins/nocobase/action-bridge/bridge.cjs');
const config=localConfig(),actors=await loginActors(config);
const fixture=await seedTeamIntegration({config,actors});
// Only OAuth exchange/userinfo are fixture bootstraps. Every entity operation and
// catalog verification uses the actual signed token through Gateway/API/PostgreSQL.
const bridges=[];
async function connect(user){
 const actor=actors[user];
 const bridge=createBridge({gatewayUrl:config.gateway,tokenUrl:'https://fixture.invalid/token',userinfoUrl:'https://fixture.invalid/user',authorizationUrl:'https://fixture.invalid/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
 {fetch:async(url,options)=>url==='https://fixture.invalid/token'?Response.json({access_token:actor.token,expires_in:300}):url==='https://fixture.invalid/user'?Response.json({sub:actor.subject}):fetch(url,options)});
 const start=bridge.connect('fixture-'+user);await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
 bridges.push(()=>bridge.disconnect('fixture-'+user,start.browserId));
 return input=>bridge.entity('fixture-'+user,start.browserId,input);
}
try{
 const alice=await connect('alice'),warehouse=await connect('warehouse'),bob=await connect('bob');
 const key=randomUUID(),body={schemaId:fixture.schemaId,title:'Entity bridge acceptance',attributes:{assetCode:'bridge-'+randomUUID(),description:'Synthetic local fixture'}};
 const created=await alice({operation:'create',body,key});
 assert.equal((await alice({operation:'create',body,key})).id,created.id);
 assert.ok((await alice({operation:'list',query:{schemaId:fixture.schemaId,limit:'50',offset:'0'}})).items.some(item=>item.id===created.id));
 assert.equal((await alice({operation:'detail',id:created.id})).title,body.title);
 await assert.rejects(warehouse({operation:'detail',id:created.id}),error=>[403,404].includes(error.status));
 await assert.rejects(bob({operation:'detail',id:created.id}),error=>[403,404].includes(error.status));
 const updated=await alice({operation:'update',id:created.id,body:{expectedVersion:created.version,title:'Updated bridge fixture',attributes:body.attributes},key:randomUUID()});
 assert.equal(updated.version,created.version+1);
 await assert.rejects(alice({operation:'update',id:created.id,body:{expectedVersion:created.version,title:'Stale',attributes:body.attributes},key:randomUUID()}),{status:409});
 const archived=await alice({operation:'archive',id:created.id,body:{expectedVersion:updated.version},key:randomUUID()});
 assert.ok(archived.archivedAt);
 console.log(JSON.stringify({result:'PASS entity bridge + signed Gateway/API/PostgreSQL',entityId:created.id,checks:['list','create/replay','detail','denied users','update','stale version','archive'],authentication:'OAuth exchange fixture only; actual API token verification and authorization',fixture:'Retained local demo data; only newly created entity archived'}));
}finally{for(const close of bridges)close();}

/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {pathToFileURL} from 'node:url';
import {freshManifest,localConfig,loginActors,api,validateArtifact,writeArtifact} from './lib/team-integration.mjs';
export async function seedTeamIntegration({shared=false,config=localConfig(),actors}={}){
 actors??=await loginActors(config);const call=api(config,actors),manifest=freshManifest();
 const installed=await call('alice','/v1/enterprise-modules/install','POST',{manifest},201);
 const definitionId=manifest.bundle.definitions[0].id,schemaId=manifest.schemas[0].id;
 await call('alice','/v1/workflow-drafts/'+definitionId+'/publish','POST',{expectedRevision:1});
 await call('alice',`/v1/enterprise-modules/${manifest.id}/versions/1.0.0/enabled`,'POST',{expectedRevision:installed.revision,enabled:true});
 let entity=await call('alice','/v1/entities','POST',{schemaId,title:'Integration Asset '+manifest.id,attributes:{assetCode:manifest.id,description:'Shared backend asset review fixture'}},201);
 if(shared)entity=await call('alice',`/v1/entities/${entity.id}/shares`,'POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'});
 const workflow=await call('alice',`/v1/enterprise-modules/${manifest.id}/versions/1.0.0/bindings/asset-review/start`,'POST',{entityId:entity.id,title:'Review '+manifest.id,input:{}},201);
 const artifact=validateArtifact({format:'latticedx.team-integration',version:1,namespace:manifest.id.slice('team-asset-'.length),organizationId:'org-a',moduleId:manifest.id,schemaId,definitionId,moduleVersion:'1.0.0',entityId:entity.id,workflowId:workflow.id,ownerSubject:actors.alice.subject,warehouseSubject:actors.warehouse.subject,shared,urls:{entity:config.gateway+'/v1/entities/'+entity.id,workflow:config.gateway+'/v1/workflows/'+workflow.id,context:config.gateway+'/v1/workflows/'+workflow.id+'/entity-context'}});
 await writeArtifact(artifact);return artifact;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.slice(2).some(arg=>arg!=='--share'))throw new Error('Supported option: --share');
 seedTeamIntegration({shared:process.argv.includes('--share')}).then(a=>console.log(JSON.stringify(a,null,2))).catch(()=>{console.error('Team integration seed failed; check local services and credentials.');process.exitCode=1;});
}

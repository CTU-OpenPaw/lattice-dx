/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const template=JSON.parse(readFileSync(new URL('../../solutions/integration/asset-review.json',import.meta.url),'utf8'));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function requireValue(ok){if(!ok)throw new Error('Invalid team integration metadata.');}
export function freshManifest(){
 const m=structuredClone(template),tag=randomUUID().replaceAll('-','');
 m.id+='-'+tag;m.schemas[0].id+='-'+tag;m.bundle.definitions[0].id+='-'+tag;
 m.bindings[0].schemaId=m.schemas[0].id;m.bindings[0].definitionId=m.bundle.definitions[0].id;return m;
}
function localOrigin(value,port){const u=new URL(value);requireValue(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&u.port===port&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash);return u.origin;}
export function localConfig(env=process.env){return {gateway:localOrigin(env.TEAM_INTEGRATION_GATEWAY??'http://localhost:8080','8080'),identity:localOrigin(env.TEAM_INTEGRATION_IDENTITY??'http://localhost:8081','8081'),clientId:env.TEAM_INTEGRATION_CLIENT_ID??'dx-local'};}
export async function requestJson(url,{fetchImpl=fetch,method='GET',token,body,key,expected=200,headers={}}={}){
 const target=new URL(url);requireValue(!target.username&&!target.password&&['8080','8081'].includes(target.port));localOrigin(target.origin,target.port);
 let response;try{response=await fetchImpl(url,{method,redirect:'error',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}catch{throw new Error('Local integration HTTP transport failed.');}
 const json=(response.headers.get('content-type')??'').includes('application/json');
 if(response.status!==expected)throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}${json?'':' (non-JSON response)'}; expected ${expected}.`);
 if(!json)throw new Error(`HTTP ${response.status} (non-JSON response)`);
 try{return await response.json();}catch{throw new Error('Invalid local integration JSON response.');}
}
export async function loginActors(config=localConfig(),env=process.env){
 const result={};
 for(const user of ['alice','warehouse','bob']){
  const prefix='TEAM_INTEGRATION_'+user.toUpperCase();
  const data=new URLSearchParams({grant_type:'password',client_id:config.clientId,username:env[prefix+'_USERNAME']??user,password:env[prefix+'_PASSWORD']??`local-${user}-password`});
  const answer=await requestJson(config.identity+'/realms/lattice/protocol/openid-connect/token',{method:'POST',body:data.toString(),headers:{'content-type':'application/x-www-form-urlencoded'}});
  // Never print token claims: the signed API below establishes subject/tenant.
  const me=await requestJson(config.gateway+'/v1/workflow-members/me',{method:'POST',token:answer.access_token,body:{}});
  requireValue(typeof answer.access_token==='string'&&typeof me.subject==='string'&&me.organizationId===(user==='bob'?'org-b':'org-a'));
  result[user]={token:answer.access_token,subject:me.subject,organizationId:me.organizationId};
 }
 return result;
}
export function api(config,actors){return (user,path,method='GET',body,expected=200,key=randomUUID())=>requestJson(config.gateway+path,{token:actors[user].token,method,body,expected,key});}
export function validateArtifact(a){
 const keys=['format','version','namespace','organizationId','moduleId','schemaId','definitionId','moduleVersion','entityId','workflowId','ownerSubject','warehouseSubject','shared','urls'];
 requireValue(a&&typeof a==='object'&&Object.keys(a).length===keys.length&&Object.keys(a).every(k=>keys.includes(k)));
 requireValue(a.format==='latticedx.team-integration'&&a.version===1&&/^[a-f0-9]{32}$/.test(a.namespace)&&a.organizationId==='org-a'&&a.moduleVersion==='1.0.0');
 requireValue(a.moduleId==='team-asset-'+a.namespace&&a.schemaId==='team-asset-data-'+a.namespace&&a.definitionId==='team-asset-review-'+a.namespace&&uuid.test(a.entityId)&&uuid.test(a.workflowId));
 requireValue([a.ownerSubject,a.warehouseSubject].every(v=>typeof v==='string'&&/^[A-Za-z0-9._:@-]{1,200}$/.test(v))&&typeof a.shared==='boolean');
 requireValue(a.urls&&Object.keys(a.urls).sort().join(',')==='context,entity,workflow');
 const origin=localOrigin(new URL(a.urls.entity).origin,'8080');
 requireValue(a.urls.entity===origin+'/v1/entities/'+a.entityId&&a.urls.workflow===origin+'/v1/workflows/'+a.workflowId&&a.urls.context===a.urls.workflow+'/entity-context');return a;
}
export async function writeArtifact(a){validateArtifact(a);const dir=resolve('output/team-integration');await mkdir(dir,{recursive:true});const path=resolve(dir,a.namespace+'.json');await writeFile(path,JSON.stringify(a,null,2)+'\n',{flag:'wx'});return path;}




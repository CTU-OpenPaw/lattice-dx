/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Local fixtures only. Existing users/passwords/roles and clients are never reset.
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const rehearsal=process.argv.includes('--rehearsal');
const origin=rehearsal?'http://localhost:13001':'http://localhost:13000';
const clientId=rehearsal?'dx-native-rehearsal':'dx-native';
const callback=origin+'/api/enterpriseAuth:callback';
function kc(args,input){
  const result=spawnSync('docker',['exec',...(input?['-i']:[]),'lattice-dx-keycloak-1','/opt/keycloak/bin/kcadm.sh',...args],{input:input?JSON.stringify(input):undefined,encoding:'utf8',windowsHide:true,timeout:30000});
  if(result.status!==0)throw Error('Keycloak fixture command failed (output withheld).');
  return result.stdout.trim()?JSON.parse(result.stdout):null;
}
kc(['config','credentials','--server','http://localhost:8080','--realm','master','--user','admin','--password','local-admin-password']);
const clients=kc(['get','clients','-r','lattice','-q','clientId='+clientId]);
const client={clientId,enabled:true,publicClient:true,standardFlowEnabled:true,directAccessGrantsEnabled:false,implicitFlowEnabled:false,redirectUris:[callback],webOrigins:[origin],attributes:{'pkce.code.challenge.method':'S256'}};
if(clients.length===0)kc(['create','clients','-r','lattice','-f','-'],client);
else if(clients.length!==1||!clients[0].publicClient||!clients[0].standardFlowEnabled||clients[0].directAccessGrantsEnabled||clients[0].implicitFlowEnabled||JSON.stringify(clients[0].redirectUris)!==JSON.stringify(client.redirectUris)||clients[0].attributes?.['pkce.code.challenge.method']!=='S256')throw Error('Existing Keycloak client differs; inspect it explicitly instead of overwriting.');
async function call(path,{method='GET',values,token}={}){
  const r=await fetch(origin+'/api/'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token,'X-Role':'root'}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
  const body=await r.json();if(!r.ok)throw Error('Native auth fixture failed: '+path.split('?')[0]+' HTTP '+r.status);
  return body.data;
}
const {token}=await call('auth:signIn',{method:'POST',values:{email:'admin@nocobase.com',password:'admin123'}});
const name='native-keycloak';
let [authenticator]=await call('authenticators:list?filter='+encodeURIComponent(JSON.stringify({name})),{token});
if(!authenticator)authenticator=await call('authenticators:create',{method:'POST',token,values:{name,title:'Đăng nhập doanh nghiệp',authType:'lattice-keycloak',enabled:true,options:{}}});
else if(authenticator.authType!=='lattice-keycloak'||!authenticator.enabled)throw Error('Existing native authenticator differs; inspect instead of overwrite.');
const lab=JSON.parse(await readFile('output/native-platform/ui-lab.json','utf8'));
const mapped=[];
for(const [username,email] of [['alice','native.lab.employee@example.invalid'],['manager','native.lab.manager@example.invalid']]){
  const users=kc(['get','users','-r','lattice','-q','username='+username,'--fields','id,username']);
  const native=await call('users:list?filter='+encodeURIComponent(JSON.stringify({email})),{token});
  if(users.length!==1||native.length!==1)throw Error('Lab users must already exist.');
  await call('enterpriseAuth:link',{token,method:'POST',values:{authenticator:name,subject:users[0].id,userId:native[0].id}});
  mapped.push({keycloakUsername:username,nativeEmail:email,nativeUserId:native[0].id,subject:users[0].id});
}
await mkdir('output/native-platform',{recursive:true});
const evidence={at:new Date().toISOString(),origin,clientId,callback,authenticator:name,mapped,nativePage:lab.url??lab.pageUrl??'/admin/nativeuilabeb8c2601e3',scope:'Persistent local fixture only; existing credentials, native roles and data preserved.'};
await writeFile('output/native-platform/native-auth-lab'+(rehearsal?'-rehearsal':'')+'.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({result:'READY',origin,clientId,authenticator:name,mapped:mapped.map(m=>m.nativeEmail)}));

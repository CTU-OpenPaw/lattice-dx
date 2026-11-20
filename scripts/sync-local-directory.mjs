/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Local admin-only authoritative snapshot. No login/password/role mutation.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshotPerson,snapshotSql } from './directory-snapshot.mjs';
const base='http://localhost:8081';
const response=await fetch(`${base}/realms/master/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.LOCAL_KEYCLOAK_ADMIN??'admin',password:process.env.LOCAL_KEYCLOAK_ADMIN_PASSWORD??'local-admin-password'}),signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error('Local directory administrator authentication failed.');
const {access_token}=await response.json();
async function call(path){const result=await fetch(`${base}/admin/realms/lattice/${path}`,{headers:{authorization:`Bearer ${access_token}`},signal:AbortSignal.timeout(15000)});if(!result.ok)throw Error(`Directory administrator read failed (${result.status}).`);return result.json();}
const profile=await call('users/profile');
const adminOnly=name=>{const attribute=profile.attributes.find(item=>item.name===name);return attribute?.permissions?.edit?.includes('admin')&&!attribute.permissions.edit.includes('user');};
if(!adminOnly('organization_id'))throw Error('Directory requires administrator-only organization attributes; run identity:sync-local.');
const people=[];const pageSize=100;
for(let first=0;;first+=pageSize){
  const users=await call(`users?first=${first}&max=${pageSize}`);
  for(const entry of users){
    const user=await call(`users/${encodeURIComponent(entry.id)}`);
    const roles=await call(`users/${encodeURIComponent(entry.id)}/role-mappings/realm/composite`);
    const person=snapshotPerson(user,roles.map(role=>role.name),adminOnly('department_id'));
    if(person)people.push(person);
  }
  if(users.length<pageSize)break;
}
try{
  execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','postgres','psql','-U','lattice','-d','lattice','-v','ON_ERROR_STOP=1'],{cwd:fileURLToPath(new URL('../',import.meta.url)),input:snapshotSql(people),stdio:['pipe','pipe','pipe'],maxBuffer:8*1024*1024});
}catch{throw Error('Directory snapshot SQL failed; snapshot transaction rolled back. Start the current API to create its schema first.');}
console.log(`Local authoritative directory snapshot synchronized (${people.length} scoped identities); removed/disabled members disabled.`);

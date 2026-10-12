// SPDX-License-Identifier: Apache-2.0
// Add fixture roles to an existing LOCAL realm without deleting users or volumes.
import { readFile } from 'node:fs/promises';
const base='http://localhost:8081';
const realm=JSON.parse(await readFile(new URL('../infra/config/keycloak/lattice-realm.json',import.meta.url),'utf8'));
const auth=await fetch(`${base}/realms/master/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'admin',password:'local-admin-password'})});
if(!auth.ok)throw new Error('Cannot authenticate local fixture admin');
const {access_token}=await auth.json();
async function call(path,method='GET',body){
  const r=await fetch(`${base}/admin/realms/lattice/${path}`,{method,headers:{authorization:`Bearer ${access_token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok)throw new Error(`Local realm update ${method} ${path}: ${r.status}`);
  return r.status===204||r.status===201?undefined:r.json();
}
const existing=await call('roles');
for(const role of realm.roles.realm)if(!existing.some(r=>r.name===role.name))await call('roles','POST',role);
const clients=await call('clients?clientId=dx-local');
const mappers=await call(`clients/${clients[0].id}/protocol-mappers/models`);
for(const mapper of realm.clients[0].protocolMappers)if(!mappers.some(m=>m.name===mapper.name))await call(`clients/${clients[0].id}/protocol-mappers/models`,'POST',mapper);
for(const fixture of realm.users){
  const users=await call(`users?username=${encodeURIComponent(fixture.username)}&exact=true`);if(users.length!==1)throw new Error('Fixture user missing');
  const user=await call(`users/${users[0].id}`);
  await call(`users/${user.id}`,'PUT',{...user,attributes:{...user.attributes,...fixture.attributes}});
  const roles=await Promise.all(fixture.realmRoles.map(name=>call(`roles/${encodeURIComponent(name)}`)));
  await call(`users/${user.id}/role-mappings/realm`,'POST',roles);
}
console.log('Local fixture roles, organization mapper and attributes synchronized; no user/password/volume deleted.');

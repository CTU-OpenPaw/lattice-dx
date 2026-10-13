// SPDX-License-Identifier: Apache-2.0
// Add one isolated local fixture; never alter Alice/Bob or existing user attributes.
import assert from 'node:assert/strict';
const base='http://localhost:8081';
const response=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'admin',password:'local-admin-password'})});
assert.equal(response.status,200,'local fixture administration');const token=(await response.json()).access_token;
async function call(path,method='GET',body){const r=await fetch(base+'/admin/realms/lattice/'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,'fixture request '+r.status);return [201,204].includes(r.status)?null:r.json();}
const username='warehouse-demo',expected=['records:read','tasks:read','tasks:decide','files:read'];
// Keycloak 26 drops undeclared custom attributes on new users. Declare the
// organization claim admin-only; users must never be able to edit their scope.
const profile=await call('users/profile');
const attribute=profile.attributes.find(a=>a.name==='organization_id');
if(attribute)assert.deepEqual(attribute.permissions.edit,['admin'],'organization scope must be admin-only');
else {profile.attributes.push({name:'organization_id',displayName:'Organization scope',multivalued:false,permissions:{view:['admin'],edit:['admin']}});await call('users/profile','PUT',profile);}
let users=await call('users?username='+username+'&exact=true');
if(!users.length){await call('users','POST',{username,enabled:true,emailVerified:true,email:'warehouse-demo@example.invalid',firstName:'Warehouse',lastName:'Demo',attributes:{organization_id:['org-a']},credentials:[{type:'password',value:'local-warehouse-demo-password',temporary:false}]});users=await call('users?username='+username+'&exact=true');
  const roles=await Promise.all(expected.map(role=>call('roles/'+encodeURIComponent(role))));await call('users/'+users[0].id+'/role-mappings/realm','POST',roles);
}
assert.equal(users.length,1);const user=await call('users/'+users[0].id);
if(!user.attributes?.organization_id){assert.equal(user.email,'warehouse-demo@example.invalid');assert.equal(user.firstName,'Warehouse');await call('users/'+user.id,'PUT',{...user,attributes:{...user.attributes,organization_id:['org-a']}});}
else assert.deepEqual(user.attributes.organization_id,['org-a'],'existing fixture must have expected scope; do not overwrite');
const roles=await call('users/'+user.id+'/role-mappings/realm/composite');assert.ok(expected.every(name=>roles.some(r=>r.name===name)));assert.ok(!roles.some(r=>['records:write','tasks:assign','files:write'].includes(r.name)),'warehouse must not have write roles');
console.log('Local warehouse fixture ready in org-a; original users unchanged.');

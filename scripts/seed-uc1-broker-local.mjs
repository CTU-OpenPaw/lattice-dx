// SPDX-License-Identifier: Apache-2.0
// Explicit local fixture setup only; production receiver never invents references.
const ns='https://latticedx.example/ns/';
for(const [type,businessId,name] of [['Department','warehouse','Demo Warehouse'],['Location','office-1','Demo Office 1']]){
 const id=`urn:ngsi-ld:${type}:org-a:${businessId}`,url='http://localhost:1026/ngsi-ld/v1/entities',headers={'NGSILD-Tenant':'org-a',Accept:'application/ld+json'};
 const existing=await fetch(url+'/'+encodeURIComponent(id),{headers,signal:AbortSignal.timeout(5000)});
 if(existing.status===200){const value=await existing.json();if(value.id!==id||![type,ns+type].includes(value.type)||(value.organizationId??value[ns+'organizationId'])?.value!=='org-a'||(value.businessId??value[ns+'businessId'])?.value!==businessId)throw Error('Existing demo reference conflicts; unchanged');continue;}
 if(existing.status!==404)throw Error('Cannot inspect demo reference');await existing.body?.cancel();
 const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id,type:ns+type,[ns+'organizationId']:{type:'Property',value:'org-a'},[ns+'businessId']:{type:'Property',value:businessId},[ns+'name']:{type:'Property',value:name}}),signal:AbortSignal.timeout(5000)});
 if(response.status!==201)throw Error('Demo reference creation failed');await response.body?.cancel();
}
console.log('UC1 local broker references ready: Department org-a/warehouse and Location org-a/office-1. Existing entities preserved.');

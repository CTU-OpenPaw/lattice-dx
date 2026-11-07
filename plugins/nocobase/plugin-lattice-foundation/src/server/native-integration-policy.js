// SPDX-License-Identifier: Apache-2.0
const {createHash}=require('node:crypto');
const COLLECTIONS=['latticeAssets','latticeRequests','latticeOrders','latticeIncidentCases'];
function failure(code,status=400){return Object.assign(new Error(code),{status,code});}
function strict(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw failure('INTEGRATION_INVALID_FIELDS');}
function text(value,max){return typeof value==='string'&&value.trim()&&value.length<=max;}
function identifier(value){if(!['string','number'].includes(typeof value)||!/^[1-9]\d*$/.test(String(value))||String(value).length>19||(typeof value==='number'&&!Number.isSafeInteger(value)))throw failure('INTEGRATION_INVALID_RECORD_ID');return String(value);}
function eventId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value))throw failure('INTEGRATION_INVALID_EVENT_ID');return value;}
function envelope(input,now=Date.now()){
 strict(input,['eventId','kind','observedAt','data']);eventId(input.eventId);
 const observed=Date.parse(input.observedAt);
 if(typeof input.observedAt!=='string'||input.observedAt.length>40||!Number.isFinite(observed)||observed>now+60000||observed<now-86400000)throw failure('INTEGRATION_INVALID_OBSERVATION_TIME');
 const late=observed<now-300000;
 const data=input.data;
 if(input.kind==='observation'){
  strict(data,['assetId','attribute','value','unit']);identifier(data.assetId);
  if(typeof data.attribute!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(data.attribute)||typeof data.value!=='number'||!Number.isFinite(data.value)||!text(data.unit,32))throw failure('INTEGRATION_INVALID_OBSERVATION');
 }else if(['external-order','external-request'].includes(input.kind)){
  strict(data,['code','name','description','quantity','customer','origin','destination']);
  if(!text(data.code,100)||!text(data.name,200))throw failure('INTEGRATION_DOCUMENT_FIELDS_REQUIRED');
  for(const key of ['description','customer','origin','destination'])if(data[key]!==undefined&&!text(data[key],key==='description'?4000:200))throw failure('INTEGRATION_INVALID_DOCUMENT_FIELD');
  if(data.quantity!==undefined&&(typeof data.quantity!=='number'||!Number.isFinite(data.quantity)||data.quantity<=0))throw failure('INTEGRATION_INVALID_QUANTITY');
 }else throw failure('INTEGRATION_UNSUPPORTED_EVENT_KIND');
 return {...input,observedAt:new Date(observed).toISOString(),late};
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function fingerprint(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function receiptKey(org,user,id){return fingerprint([org,String(user),eventId(id)]);}
function recordInput(input){strict(input,['collection','recordId']);if(!COLLECTIONS.includes(input.collection))throw failure('INTEGRATION_COLLECTION_DENIED',403);return {collection:input.collection,recordId:identifier(input.recordId)};}
function proposalInput(input){
 strict(input,['eventId','collection','recordId','text','fingerprint','contextFingerprint']);eventId(input.eventId);recordInput({collection:input.collection,recordId:input.recordId});
 if(!text(input.text,12000)||!/^[a-f0-9]{64}$/.test(input.fingerprint??''))throw failure('INTEGRATION_INVALID_PROPOSAL');
 if(input.contextFingerprint!==undefined&&(input.collection!=='latticeAssets'||!/^[a-f0-9]{64}$/.test(input.contextFingerprint)))throw failure('INTEGRATION_INVALID_CONTEXT_EVIDENCE');
 return input;
}
module.exports={COLLECTIONS,failure,strict,identifier,envelope,proposalInput,recordInput,fingerprint,receiptKey};

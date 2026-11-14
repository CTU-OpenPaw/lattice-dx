/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {envelope,proposalInput,fingerprint,receiptKey}=require('../src/server/native-integration-policy');
const now=Date.parse('2026-11-06T01:00:00Z');
const base={eventId:'sensor-1',kind:'observation',observedAt:new Date(now-1000).toISOString(),data:{assetId:12,attribute:'temperature',value:38,unit:'CEL'}};
test('strict envelopes reject identity/approval injection and unsafe or excessive values',()=>{
 assert.equal(envelope(base,now).late,false);
 for(const extra of [{organizationId:'other'},{role:'root'},{handlerId:1},{status:'approved'},{url:'http://evil'}])assert.throws(()=>envelope({...base,...extra},now));
 for(const data of [{...base.data,value:Infinity},{...base.data,assetId:0},{...base.data,attribute:'__proto__'},{...base.data,attribute:['temperature']},{...base.data,action:'approve'}])assert.throws(()=>envelope({...base,data},now));
});
test('observations older than five minutes are labelled late; future and expired events rejected',()=>{
 assert.equal(envelope({...base,observedAt:new Date(now-360000).toISOString()},now).late,true);
 for(const time of [now+61000,now-86400001])assert.throws(()=>envelope({...base,observedAt:new Date(time).toISOString()},now));
});
test('receipt key derives scope from verified organization and source account',()=>{
 for(const value of [123,['123'],null,true])assert.throws(()=>receiptKey('org-a','12',value));
 assert.equal(receiptKey('org-a','12','sensor-1'),receiptKey('org-a','12','sensor-1'));
 assert.notEqual(receiptKey('org-a','12','sensor-1'),receiptKey('org-b','12','sensor-1'));
 assert.notEqual(receiptKey('org-a','12','sensor-1'),receiptKey('org-a','13','sensor-1'));
});
test('stable fingerprints cover nested authorized data independent of key order',()=>{
 assert.equal(fingerprint({a:1,b:{y:2,x:3}}),fingerprint({b:{x:3,y:2},a:1}));
 assert.notEqual(fingerprint({id:1,status:'draft'}),fingerprint({id:1,status:'approved'}));
});
test('proposal can contain only a bounded recommendation and exact native evidence reference',()=>{
 const input={eventId:'proposal-1',collection:'latticeOrders',recordId:12,text:'Review stock levels',fingerprint:'a'.repeat(64)};
 assert.equal(proposalInput(input).text,input.text);
 for(const extra of [{action:'approve'},{state:'approved'},{organizationId:'other'},{evidence:[{url:'file:///private'}]}])assert.throws(()=>proposalInput({...input,...extra}));
 for(const change of [{collection:'users'},{recordId:0},{text:'x'.repeat(12001)},{fingerprint:'fake'}])assert.throws(()=>proposalInput({...input,...change}));
});

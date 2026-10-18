// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'vitest';
import {canonicalEvent,eventStartKey,parseEvent,parseSubscription,requireDesigner,requireReceiver,resolveBinding} from './policy.js';
test('canonical envelope eventId binding cannot read a spoofed data eventId',()=>{
 const binding={source:'envelope',field:'eventId'} as const;
 expect(parseSubscription({...subscription,input:{notificationId:binding}})).toBeDefined();
 expect(resolveBinding(binding as any,{eventId:'spoof'},event)).toBe(event.eventId);
 expect(parseSubscription({...subscription,input:{notificationId:{source:'envelope',field:'organizationId'}}})).toBeUndefined();
});

const event={eventId:'opaque/01',eventType:'order-created',occurredAt:'2026-10-14T01:02:03.123Z',data:{z:'two',a:'one'}};
const subscription={id:'sub-one',eventType:event.eventType,sourceSubject:'source',definitionId:'order-flow',definitionVersion:1,title:{source:'literal',value:'Order'},input:{note:{source:'event',field:'a'}},enabled:true};
test('strict event parser bounds strings and rejects unreal UTC dates and authority fields',()=>{
 expect(parseEvent(event)).toEqual(event);
 for(const value of [{...event,organizationId:'other'},{...event,occurredAt:'2026-02-30T01:02:03Z'},{...event,occurredAt:'2026-10-14T01:02:03+00:00'},{...event,data:{a:42}},{...event,eventId:'x'.repeat(129)},{...event,data:Object.fromEntries(Array.from({length:51},(_,i)=>['f'+i,'x']))},{...event,data:{a:'😀'.repeat(2001)}}]) expect(parseEvent(value)).toBeUndefined();
 expect(parseEvent({...event,data:{a:'😀'.repeat(2000)}})).toBeDefined();
});
test('subscription parser accepts only bindings and positive pinned versions',()=>{
 expect(parseSubscription(subscription)).toEqual(subscription);
 for(const value of [{...subscription,definitionVersion:0},{...subscription,ownerId:'owner'},{...subscription,title:{source:'script',value:'danger'}},{...subscription,input:{note:{source:'event',field:'a',url:'http://remote'}}}]) expect(parseSubscription(value)).toBeUndefined();
 expect(parseSubscription({...subscription,expectedRevision:1},true)).toEqual({...subscription,expectedRevision:1});
 expect(parseSubscription(subscription,true)).toBeUndefined();
});
test('canonical event and deterministic start key isolate source organization subscription and revision',()=>{
 expect(canonicalEvent(event)).toBe(canonicalEvent({...event,data:{a:'one',z:'two'}}));
 const key=eventStartKey('org','source',event.eventId,subscription.id,1);
 expect(key).toMatch(/^[a-f0-9]{64}$/);
 expect(eventStartKey('org','source',event.eventId,subscription.id,1)).toBe(key);
 for(const args of [['other','source',event.eventId,subscription.id,1],['org','other',event.eventId,subscription.id,1],['org','source',event.eventId,subscription.id,2]] as const) expect(eventStartKey(args[0],args[1],args[2],args[3],args[4])).not.toBe(key);
});
test('event and subscription roles are explicit and creator authority is never inferred',()=>{
 expect(()=>requireReceiver({roles:['workflow:start']})).toThrow();
 expect(()=>requireReceiver({roles:['workflow:event:receive']})).not.toThrow();
 expect(()=>requireDesigner({roles:['workflow:design']})).toThrow();
 expect(()=>requireDesigner({roles:['workflow:design','workflow:integrate']})).not.toThrow();
});

/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {FastifyInstance} from 'fastify';
import {authorized,assetId} from './policy.js';

export class HandoverError extends Error {
 constructor(public statusCode:number,public code:string){super(code);}
}
export type HandoverEvent={eventId:string;eventType:string;organizationId:string;runId:string;recordId:string;definitionId:string;version:number;occurredAt:string;data:{assetId:string;departmentId:string;locationId:string;[key:string]:unknown}};
export type HandoverResult={assetId:string;status:string;sourceEventId:string};
export type HandoverOptions={assetHandover?:{token:string;tenant:string;deliver:(event:HandoverEvent)=>Promise<HandoverResult>}};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const component=/^[A-Za-z0-9_-]{1,128}$/;
export function parseHandover(value:unknown,key:unknown,tenant:string):HandoverEvent {
 const e=value as HandoverEvent|undefined;
 if(!e||typeof e!=='object'||Array.isArray(e))throw new HandoverError(400,'invalid_handover');
 if(e.organizationId!==tenant||e.eventType!=='asset.handed_over'||e.definitionId!=='procurement'||!uuid.test(e.eventId)||key!==e.eventId||!uuid.test(e.runId)||e.recordId!==e.runId||!Number.isSafeInteger(e.version)||e.version<1)throw new HandoverError(400,'invalid_handover');
 if(typeof e.occurredAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.occurredAt)||!Number.isFinite(Date.parse(e.occurredAt))||new Date(e.occurredAt).toISOString()!==e.occurredAt||Date.parse(e.occurredAt)>Date.now()+300000)throw new HandoverError(400,'invalid_handover');
 if(!e.data||typeof e.data!=='object'||!assetId(e.data.assetId,tenant)||typeof e.data.departmentId!=='string'||!component.test(e.data.departmentId)||typeof e.data.locationId!=='string'||!component.test(e.data.locationId))throw new HandoverError(400,'invalid_handover');
 return e;
}
export function registerAssetHandover(app:FastifyInstance,options:HandoverOptions){
 const config=options.assetHandover;
 if(config&&(!/^[A-Za-z0-9._~-]{32,256}$/.test(config.token)||!component.test(config.tenant)))throw Error('Invalid Asset handover configuration');
 app.register(async routes=>{
  routes.addHook('onRequest',async(request,reply)=>{
   if(!config)return reply.code(503).send({error:'handover_not_configured'});
   if(!authorized(request.headers.authorization,`Bearer ${config.token}`))return reply.code(403).send({error:'invalid_integration_credential'});
  });
  routes.post('/v1/integrations/asset-handovers',{bodyLimit:65536},async(request,reply)=>{
   try{return await config!.deliver(parseHandover(request.body,request.headers['idempotency-key'],config!.tenant));}
   catch(error){if(error instanceof HandoverError)return reply.code(error.statusCode).send({error:error.code});return reply.code(502).send({error:'handover_delivery_failed'});}
  });
 });
}

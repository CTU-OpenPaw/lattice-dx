/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isRecordId, type WorkflowActor, type WorkflowRun } from '@dx/contracts';
import { verifyIdentity } from './identity.js';
import type { WorkflowOptions } from './workflows/routes.js';
import { WorkflowError, availableTransitions } from './workflows/policy.js';
import { getDefinition } from '../../../solutions/workflows/definitions.js';
import { PageError, parsePage, textFilter } from './pagination.js';

function object(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));}
function text(value:unknown,max=2000):value is string{return typeof value==='string'&&!!value.trim()&&Array.from(value).length<=max;}
function key(req:FastifyRequest){const value=req.headers['idempotency-key'];if(typeof value!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(value))throw new WorkflowError(400,'Cần Idempotency-Key hợp lệ.');return value;}
function id(value:string){if(!isRecordId(value))throw new WorkflowError(400,'Order ID phải là UUID.');return value.toLowerCase();}
function view(run:WorkflowRun,actor:WorkflowActor){return {...run,...run.data,quantity:Number(run.data.quantity),availableTransitions:availableTransitions(getDefinition('logistics_order',run.definitionVersion)!,run,actor)};}

export function registerLogistics(app:FastifyInstance,options:WorkflowOptions){
  app.register(async routes=>{
    const actors=new WeakMap<object,WorkflowActor>();
    routes.setErrorHandler((error,_req,reply)=>error instanceof WorkflowError||error instanceof PageError?reply.code(error.statusCode).send({error:error.message}):reply.send(error));
    routes.addHook('preHandler',async(req,reply)=>{
      if(!options.identity||!options.workflows)return reply.code(503).send({error:'Logistics chưa cấu hình.'});
      let actor;try{actor=await verifyIdentity(req.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Token không hợp lệ.'});}
      if(!actor.organizationId||!actor.roles.some(r=>['logistics:sales','logistics:warehouse'].includes(r)))return reply.code(403).send({error:'Không có quyền Logistics.'});
      actors.set(req,{...actor,organizationId:actor.organizationId});
    });
    async function order(value:string,actor:WorkflowActor){const run=await options.workflows!.get(id(value),actor);if(run.definitionId!=='logistics_order')throw new WorkflowError(404,'Không tìm thấy đơn.');return run;}
    routes.post('/v1/logistics/orders',async(req,reply)=>{
      const body=req.body,actor=actors.get(req)!;
      if(!object(body,['title','customerName','deliveryAddress','sku','quantity','warehouseAssigneeId','attachmentId'])||!text(body.title,200)||!text(body.customerName)||!text(body.deliveryAddress)||!text(body.sku)||!text(body.warehouseAssigneeId,100)||!Number.isSafeInteger(body.quantity)||Number(body.quantity)<1||Number(body.quantity)>1_000_000||body.attachmentId!==undefined&&!isRecordId(body.attachmentId))throw new WorkflowError(400,'Dữ liệu đơn không hợp lệ.');
      if(!actor.roles.includes('logistics:sales')||!actor.roles.includes('workflow:start'))throw new WorkflowError(403,'Không có quyền tạo đơn.');
      const input={customerName:body.customerName.trim(),deliveryAddress:body.deliveryAddress.trim(),sku:body.sku.trim(),quantity:String(body.quantity),warehouseAssigneeId:body.warehouseAssigneeId,...(body.attachmentId?{attachmentId:body.attachmentId as string}:{})};
      return reply.code(201).send(view(await options.workflows!.create({definitionId:'logistics_order',title:body.title.trim(),input},actor,key(req)),actor));
    });
    routes.get<{Querystring:Record<string,unknown>}>('/v1/logistics/orders',async req=>{
      const actor=actors.get(req)!,query={...parsePage(req.query),state:textFilter(req.query.state),definitionId:'logistics_order'};
      if(!options.workflows!.listPage)throw new WorkflowError(503,'Phân trang chưa cấu hình.');
      const result=await options.workflows!.listPage(actor,false,query);return {...result,items:result.items.map(r=>view(r,actor))};
    });
    routes.get<{Params:{id:string}}>('/v1/logistics/orders/:id',async req=>{const actor=actors.get(req)!;return view(await order(req.params.id,actor),actor);});
    for(const action of ['submit','receive'] as const)routes.post<{Params:{id:string}}>(`/v1/logistics/orders/:id/${action}`,async req=>{
      const actor=actors.get(req)!,body=req.body;
      if(!object(body,action==='submit'?['expectedVersion']:['expectedVersion','receiptNote'])||!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||action==='receive'&&!text(body.receiptNote))throw new WorkflowError(400,'Dữ liệu bước không hợp lệ.');
      await order(req.params.id,actor);
      const input:Record<string,string>=action==='receive'?{receiptNote:(body.receiptNote as string).trim()}:{};
      return view(await options.workflows!.transition(id(req.params.id),{action,expectedVersion:Number(body.expectedVersion),input},actor,key(req)),actor);
    });
  });
}

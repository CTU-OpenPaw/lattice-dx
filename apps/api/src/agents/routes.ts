import {parseCreateKey,CreateCommandError} from '../create-command.js';
// SPDX-License-Identifier: Apache-2.0
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {isRecordId,type WorkflowActor} from '@dx/contracts';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {WorkflowError} from '../workflows/policy.js';
import {EntityError} from '../entities/policy.js';
import {FileReadError} from '../files/content.js';
import {PageError,parsePage} from '../pagination.js';
import type {AgentRepository} from './database.js';
import {assertHuman,bad,object,parseProposal,text,worker} from './policy.js';
export type AgentOptions={
  identity?:IdentityConfig;
  agents?:AgentRepository
};
const id=(value:unknown)=>{
  if(typeof value!=='string'||!isRecordId(value))bad(400,'Agent ID must be UUID.');
  return value.toLowerCase();
};
const key=(r:FastifyRequest)=>{
  const value=parseCreateKey(r.headers['idempotency-key'],r.raw.rawHeaders);
  if(!value)bad(400,'Idempotency-Key required.');
  return value;
};
export function registerAgents(app:FastifyInstance,options:AgentOptions){
  app.register(async routes=>{
    const actors=new WeakMap<object,WorkflowActor>();
    routes.setErrorHandler((e,_r,reply)=>{
      const code=e&&typeof e==='object'&&'code' in e?e.code:undefined;
      if(code==='FST_ERR_CTP_BODY_TOO_LARGE')return reply.code(413).send({error:'Agent request body too large.'});
      if(code==='FST_ERR_CTP_INVALID_JSON_BODY'||code==='FST_ERR_CTP_EMPTY_JSON_BODY')return reply.code(400).send({error:'Invalid agent JSON body.'});
      if(e instanceof CreateCommandError||e instanceof WorkflowError||e instanceof EntityError||e instanceof FileReadError||e instanceof PageError)return reply.code(e.statusCode).send({
        error:e.message
      });
      return reply.code(500).send({error:'Agent operation failed.'});
    });
    routes.addHook('preHandler',async(req,reply)=>{
      if(!options.identity||!options.agents)return reply.code(503).send({
        error:'Agent service unavailable.'
      });
      let a;
      try{
        a=await verifyIdentity(req.headers.authorization,options.identity);
      }
      catch{
        return reply.code(401).send({
          error:'Invalid token.'
        });
      }
      if(!a.organizationId)return reply.code(403).send({
        error:'Organization required.'
      });
      actors.set(req,{
        ...a,organizationId:a.organizationId
      });
    });
    const repo=options.agents!;
    routes.post('/v1/agent-jobs',async req=>{
      const a=actors.get(req)!;
      assertHuman(a);
      const b=object(req.body,['runId','waitId']);
      return repo.create(id(b.runId),id(b.waitId),a,key(req));
    });
    routes.get<{
      Querystring:Record<string,unknown>
    }
    >('/v1/agent-jobs',async req=>{
      const a=actors.get(req)!;
      assertHuman(a);
      const q=object(req.query,['runId','limit','offset']);
      return repo.list(id(q.runId),a,parsePage(q));
    });
    routes.get<{
      Params:{
        id:string
      }
    }
    >('/v1/agent-jobs/:id',async req=>repo.get(id(req.params.id),actors.get(req)!));
    routes.post<{
      Params:{
        id:string
      }
    }
    >('/v1/agent-jobs/:id/claim',async req=>{
      const a=actors.get(req)!;
      worker(a);
      object(req.body,[]);
      return repo.claim(id(req.params.id),a);
    });
    routes.get<{
      Params:{
        id:string
      };
      Querystring:Record<string,unknown>
    }
    >('/v1/agent-jobs/:id/context',async req=>{
      const a=actors.get(req)!;
      worker(a);
      object(req.query,[]);
      return repo.context(id(req.params.id),a,id(req.headers['x-agent-lease']));
    });
    routes.post<{
      Params:{
        id:string
      }
    }
    >('/v1/agent-jobs/:id/result',{bodyLimit:144*1024},async req=>{
      const a=actors.get(req)!;
      worker(a);
      const b=object(req.body,['leaseToken','proposal']);
      return repo.result(id(req.params.id),a,id(b.leaseToken),parseProposal(b.proposal));
    });
    routes.post<{
      Params:{
        id:string
      }
    }
    >('/v1/agent-jobs/:id/fail',async req=>{
      const a=actors.get(req)!;
      worker(a);
      const b=object(req.body,['leaseToken','code']);
      const code=text(b.code,40);
      if(!['model_unavailable','invalid_output','tool_denied','worker_error'].includes(code))bad(400,'Invalid failure code.');
      return repo.fail(id(req.params.id),a,id(b.leaseToken),code);
    });
    routes.post<{
      Params:{
        id:string
      }
    }
    >('/v1/agent-jobs/:id/retry',async req=>{
      const a=actors.get(req)!;
      assertHuman(a);
      const b=object(req.body,['expectedVersion']);
      if(!Number.isSafeInteger(b.expectedVersion)||(b.expectedVersion as number)<1)bad(400,'Invalid version.');
      return repo.retry(id(req.params.id),a,b.expectedVersion as number,key(req));
    });
  });
}

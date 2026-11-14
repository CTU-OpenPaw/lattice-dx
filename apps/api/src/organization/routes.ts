/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { CreateCommandError } from '../create-command.js';
import { parsePage, PageError } from '../pagination.js';
import { departmentId, mandatoryKey, OrganizationError, parseDepartmentCreate, parseDepartmentUpdate, parseSnapshot } from './policy.js';
import type { OrganizationActor, OrganizationRepository } from './types.js';
export type OrganizationOptions={
  organization?:OrganizationRepository;
  identity?:IdentityConfig
};
export function registerOrganization(app:FastifyInstance,options:OrganizationOptions){
  function handler(role:string,action:(req:FastifyRequest,actor:OrganizationActor,repository:OrganizationRepository,reply:FastifyReply)=>Promise<unknown>){
    return async(req:FastifyRequest,reply:FastifyReply)=>{
      if (!options.identity||!options.organization)return reply.code(503).send({
        error:'Organization directory is not configured.'
      });
      let actor;
      try{
        actor=await verifyIdentity(req.headers.authorization,options.identity);
      }
      catch{
        return reply.code(401).send({
          error:'Invalid token.'
        });
      }
      if (!actor.organizationId||!actor.roles.includes(role))return reply.code(403).send({
        error:'Directory role required.'
      });
      try{
        return await action(req,{
          ...actor,organizationId:actor.organizationId
        },options.organization,reply);
      } catch (error){
        if (error instanceof OrganizationError||error instanceof CreateCommandError||error instanceof PageError)return reply.code(error.statusCode).send({
          error:error.message
        });
        return reply.code(503).send({
          error:'Organization directory is unavailable.'
        });
      }
    };
  }
  function query(req:FastifyRequest){
    const value=req.query as Record<string,unknown>;
    if (Object.keys(value).some(k=>!['limit','offset','q'].includes(k)))throw new OrganizationError(400,'Invalid query.');
    return parsePage(value);
  }
  app.get('/v1/organization/departments',handler('directory:read',(req,actor,repo)=>repo.listDepartments(actor.organizationId,query(req))));
  app.post('/v1/organization/departments',handler('directory:manage',async(req,actor,repo,reply)=>reply.code(201).send(await repo.createDepartment(actor,parseDepartmentCreate(req.body),mandatoryKey(req.headers['idempotency-key'],req.raw.rawHeaders)))));
  app.patch('/v1/organization/departments/:id',handler('directory:manage',(req,actor,repo)=>repo.updateDepartment(actor,departmentId((req.params as {
    id:string
  }).id),parseDepartmentUpdate(req.body),mandatoryKey(req.headers['idempotency-key'],req.raw.rawHeaders))));
  app.get('/v1/organization/departments/:id/history',handler('directory:manage',(req,actor,repo)=>repo.departmentHistory(actor.organizationId,departmentId((req.params as {
    id:string
  }).id),query(req))));
  app.get('/v1/organization/directory-state',handler('directory:manage',(_req,actor,repo)=>repo.directoryState(actor.organizationId)));
  app.post('/v1/organization/directory-snapshot',{
    bodyLimit:131072
  },handler('directory:manage',(req,actor,repo)=>repo.replaceSnapshot(actor,parseSnapshot(req.body),mandatoryKey(req.headers['idempotency-key'],req.raw.rawHeaders))));
}

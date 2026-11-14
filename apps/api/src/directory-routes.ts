/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance } from 'fastify';
import { verifyIdentity, type IdentityConfig } from './identity.js';
import { DirectoryError, parseDirectoryQuery, sanitizePerson, type DirectoryOptions } from './directory.js';
export function registerDirectory(app:FastifyInstance,options:DirectoryOptions&{identity?:IdentityConfig}){
  app.get('/v1/directory/departments', async (req, reply) => {
    if (!options.identity || !options.directory?.departments) return reply.code(503).send({ error: 'Directory chưa được cấu hình.' });
    let actor;
    try {
      actor = await verifyIdentity(req.headers.authorization, options.identity);
    } catch {
      return reply.code(401).send({ error: 'Token không hợp lệ.' });
    }
    if (!actor.organizationId || !actor.roles.includes('directory:read')) return reply.code(403).send({ error: 'Không có quyền đọc directory.' });
    let query;
    try {
      query = parseDirectoryQuery(req.query);
    } catch (error) {
      if (error instanceof DirectoryError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
    try {
      const result = await options.directory.departments(actor.organizationId, query);
      return { items: result.items.map(item => ({ id: item.id, name: item.name, memberCount: item.memberCount })), page: result.page };
    } catch {
      return reply.code(503).send({ error: 'Directory chưa sẵn sàng.' });
    }
  });
  app.get('/v1/directory/people',async(req,reply)=>{
    if(!options.identity||!options.directory)return reply.code(503).send({error:'Directory chưa được cấu hình.'});
    let actor;try{actor=await verifyIdentity(req.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Token không hợp lệ.'});}
    if(!actor.organizationId||!actor.roles.includes('directory:read'))return reply.code(403).send({error:'Không có quyền đọc directory.'});
    let query;try{query=parseDirectoryQuery(req.query);}catch(error){if(error instanceof DirectoryError)return reply.code(error.statusCode).send({error:error.message});throw error;}
    try{const result=await options.directory.list(actor.organizationId,query);return {items:result.items.map(sanitizePerson),page:result.page};}catch{return reply.code(503).send({error:'Directory chưa sẵn sàng.'});}
  });
}

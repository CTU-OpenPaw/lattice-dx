/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import type {Pool} from 'pg';
import {reportsDatabase} from './reports-database.js';
import {canonicalJson} from './policy.js';
import {parseReportInput} from './reports-policy.js';
const scope={actorId:'owner',organizationId:'org'},id='00000000-0000-4000-8000-000000000001';
const input={title:'Report',query:{schemaId:'invoice',schemaVersion:1,metrics:[{name:'rows',operation:'count' as const}]}};
function database(handler:(sql:string,values:unknown[])=>unknown[]){
 const query=vi.fn(async(sql:string,values:unknown[]=[])=>({rows:handler(sql,values)})),release=vi.fn();
 return {pool:{query,connect:async()=>({query,release})} as unknown as Pool,query,release};
}
test('revoked replay authorizes dependency before fingerprint conflict and never exposes receipt values',async()=>{
 const {pool,query,release}=database(sql=>{
  if(sql.startsWith('SELECT fingerprint'))return [{fingerprint:'different',result:{snapshotId:id}}];
  if(sql.includes('FROM enterprise_report_snapshots WHERE id'))return [{id,title:'Report',version:1,createdAt:new Date(),asOf:new Date(),query:input.query,result:{private:'secret'}}];
  if(sql.includes('SELECT entity_id'))return [{id}];
  if(sql.includes('FOR SHARE OF e'))return [];
  return [];
 });
 const repo=await reportsDatabase(pool);
 await expect(repo.create(scope,input,'report-key')).rejects.toMatchObject({statusCode:404});
 expect(query.mock.calls.map(([sql])=>sql)).toContain('ROLLBACK');expect(release).toHaveBeenCalledOnce();
});
test('new command receipt stores ID only and a receipt failure rolls all storage back',async()=>{
 const {pool,query}=database(sql=>{
  if(sql.includes('FROM enterprise_schema_versions'))return [{version:1,definition:{id:'invoice',fields:{},relations:{}}}];
  if(sql.startsWith('WITH eligible'))return [{sourceIds:[],groups:[{m0:'0'}],asOf:new Date()}];
  return [];
 });
 const original=query.getMockImplementation()!;
 query.mockImplementation(async(sql,values=[])=>{
  if(sql.startsWith('INSERT INTO enterprise_commands'))throw new Error('forced receipt failure');
  return original(sql,values);
 });
 const repo=await reportsDatabase(pool);
 await expect(repo.create(scope,input,'report-key')).rejects.toThrow('forced receipt failure');
 const receipt=query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO enterprise_commands'))!;
 expect(Object.keys(JSON.parse(receipt[1]![5] as string))).toEqual(['snapshotId']);
 expect(receipt[1]![4]).toBe(createHash('sha256').update(canonicalJson(parseReportInput(input))).digest('hex'));
 expect(query.mock.calls.map(([sql])=>sql)).toContain('ROLLBACK');
});

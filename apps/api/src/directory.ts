/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Scope } from './foundation.js';
export interface DirectoryPerson { subject:string; organizationId:string; displayName:string; departmentId?:string; roles:string[] }
export interface DirectoryDepartment { id:string; name:string; memberCount:number }
export interface DirectoryQuery { limit:number; offset:number; q?:string; role?:string; department?:string }
export interface DirectoryPage { limit:number; offset:number; hasMore:boolean; nextOffset:number|null }
export interface DirectoryRepository {
  /** Only active members are returned by the authoritative snapshot. */
  find(subject:string,organizationId:string):Promise<DirectoryPerson|undefined>;
  departments?(organizationId:string,query:DirectoryQuery):Promise<{items:DirectoryDepartment[];page:DirectoryPage}>;
  list(organizationId:string,query:DirectoryQuery):Promise<{items:DirectoryPerson[];page:DirectoryPage}>;
}
export interface DirectoryOptions { directory?:DirectoryRepository }
export class DirectoryError extends Error { constructor(public statusCode:400|503,message:string){super(message)} }
export function sanitizePerson(person:DirectoryPerson):DirectoryPerson {
  return {subject:person.subject,organizationId:person.organizationId,displayName:person.displayName,...(person.departmentId?{departmentId:person.departmentId}:{}),roles:[...person.roles]};
}
export async function requireAssignee(subject:unknown,scope:Scope,directory:DirectoryRepository|undefined,requiredRole?:string):Promise<DirectoryPerson>{
  if(typeof subject!=='string'||!subject.trim()||subject!==subject.trim()||[...subject].length>100||/[\x00-\x1f\x7f]/.test(subject))throw new DirectoryError(400,'Assignee không hợp lệ.');
  if(!directory)throw new DirectoryError(503,'Directory chưa được cấu hình.');
  let person:DirectoryPerson|undefined;
  try{person=await directory.find(subject,scope.organizationId);}catch{throw new DirectoryError(503,'Directory chưa sẵn sàng.');}
  if(!person||person.subject!==subject||person.organizationId!==scope.organizationId||(requiredRole&&!person.roles.includes(requiredRole)))throw new DirectoryError(400,'Assignee không khả dụng trong đơn vị hoặc thiếu vai trò.');
  return sanitizePerson(person);
}
export function parseDirectoryQuery(value:unknown):DirectoryQuery{
  const input=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
  const number=(name:string,fallback:number,min:number,max:number)=>{const raw=input[name];if(raw===undefined)return fallback;if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)throw new DirectoryError(400,'Phân trang không hợp lệ.');return Number(raw)};
  const result:DirectoryQuery={limit:number('limit',50,1,100),offset:number('offset',0,0,Number.MAX_SAFE_INTEGER-100)};
  for(const name of ['q','role','department'] as const){const raw=input[name];if(raw!==undefined){if(typeof raw!=='string'||raw.length>200||/[\x00-\x1f\x7f]/.test(raw))throw new DirectoryError(400,'Bộ lọc không hợp lệ.');result[name]=raw.trim();}}
  return result;
}

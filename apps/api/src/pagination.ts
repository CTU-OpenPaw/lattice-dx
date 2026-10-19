// SPDX-License-Identifier: Apache-2.0
export type PageQuery = {limit:number;offset:number;q:string};
export type Page<T> = {items:T[];page:{limit:number;offset:number;hasMore:boolean;nextOffset:number|null}};
export class PageError extends Error { readonly statusCode=400; }
export function parsePage(query:Record<string,unknown>):PageQuery {
  function integer(value:unknown,fallback:number,max:number):number {
    if(value===undefined)return fallback;
    if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)throw new PageError('Phân trang không hợp lệ.');
    return Number(value);
  }
  const limit=integer(query.limit,50,100),offset=integer(query.offset,0,Number.MAX_SAFE_INTEGER-101);
  if(!limit||query.q!==undefined&&(typeof query.q!=='string'||Array.from(query.q).length>200))throw new PageError('Phân trang/bộ lọc không hợp lệ.');
  return {limit,offset,q:typeof query.q==='string'?query.q.trim():''};
}
export function textFilter(value:unknown,max=100):string|undefined {
  if(value===undefined)return;
  if(typeof value!=='string'||!value.trim()||Array.from(value).length>max)throw new PageError('Bộ lọc không hợp lệ.');
  return value.trim();
}
export function pageResult<T>(rows:T[],query:PageQuery):Page<T> {
  const hasMore=rows.length>query.limit;
  return {items:rows.slice(0,query.limit),page:{limit:query.limit,offset:query.offset,hasMore,nextOffset:hasMore?query.offset+query.limit:null}};
}

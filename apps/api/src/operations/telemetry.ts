/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export const WORKERS=['outbox','timers','waitTimeouts','automations','fileStorage'] as const;
export type WorkerId=typeof WORKERS[number];
export type WorkerResult='success'|'failure'|'idle';
export type WorkerObserver=(result:WorkerResult,durationMs:number)=>void;
export type RouteId=string;
export type Method='GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS'|'other';
export type StatusClass='1xx'|'2xx'|'3xx'|'4xx'|'5xx';
const METHODS:readonly string[]=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','other'];
const STATUSES:readonly string[]=['1xx','2xx','3xx','4xx','5xx'];
const BOUNDS=[10,50,100,500,1000,5000];
type Counter={count:number;buckets:number[]};
export interface MetricsSnapshot {scope:'process';startedAt:string;durationBucketsMs:number[];http:(Counter&{route:string;method:Method;statusClass:StatusClass})[];workers:(Counter&{worker:WorkerId;result:WorkerResult})[]}
export interface Telemetry {
 registerRoute(route:string):void;
 recordHttp(route:RouteId,method:Method|string,statusClass:StatusClass|string,durationMs:number):void;
 recordWorker(worker:WorkerId,result:WorkerResult,durationMs:number):void;
 snapshot():MetricsSnapshot;
}
export function createTelemetry(initialRoutes:readonly string[]=[]):Telemetry {
 const routes=new Set<string>();const http=new Map<string,MetricsSnapshot['http'][number]>();
 const workers=new Map<string,MetricsSnapshot['workers'][number]>();const startedAt=new Date().toISOString();
 const registerRoute=(route:string)=>{
  if(typeof route!=='string'||!route.startsWith('/')||route.length>512||/[?#\x00-\x20]/.test(route))throw new Error('Invalid telemetry route template');
  if(routes.has(route))return;if(routes.size>=128)throw new Error('Telemetry route limit exceeded');routes.add(route);
 };
 initialRoutes.forEach(registerRoute);
 const observe=(counter:Counter,duration:number)=>{
  if(!Number.isFinite(duration)||duration<0)throw new Error('Invalid telemetry duration');
  const index=BOUNDS.findIndex(bound=>duration<=bound),bucket=index<0?BOUNDS.length:index;
  counter.count=Math.min(Number.MAX_SAFE_INTEGER,counter.count+1);
  counter.buckets[bucket]=Math.min(Number.MAX_SAFE_INTEGER,counter.buckets[bucket]+1);
 };
 return {registerRoute,
  recordHttp(route,method,statusClass,duration){
   if(!Number.isFinite(duration)||duration<0)throw new Error('Invalid telemetry duration');
   route=routes.has(route)?route:'unmatched';method=METHODS.includes(method)?method:'other';statusClass=STATUSES.includes(statusClass)?statusClass:'5xx';
   const key=JSON.stringify([route,method,statusClass]);let counter=http.get(key);
   if(!counter){counter={route,method:method as Method,statusClass:statusClass as StatusClass,count:0,buckets:Array(7).fill(0)};http.set(key,counter);}observe(counter,duration);
  },
  recordWorker(worker,result,duration){
   if(!WORKERS.includes(worker)||!['success','failure','idle'].includes(result))throw new Error('Invalid telemetry worker');
   if(!Number.isFinite(duration)||duration<0)throw new Error('Invalid telemetry duration');
   const key=worker+':'+result;let counter=workers.get(key);
   if(!counter){counter={worker,result,count:0,buckets:Array(7).fill(0)};workers.set(key,counter);}observe(counter,duration);
  },
  snapshot(){return {scope:'process',startedAt,durationBucketsMs:[...BOUNDS],http:[...http.values()].map(row=>({...row,buckets:[...row.buckets]})),workers:[...workers.values()].map(row=>({...row,buckets:[...row.buckets]}))};},
 };
}
/** Repository results are deliberately inspected only for a fixed outcome, never retained. */
export function workerResult(value:unknown):WorkerResult {
 if(value===undefined||value===null||value===false||value===0||value==='idle')return 'idle';
 if(value==='failure')return 'failure';
 if(typeof value==='object'&&'status' in value)return value.status==='succeeded'||value.status==='cancelled'?'success':'failure';
 return 'success';
}
export async function observedTick(tick:()=>Promise<unknown>,observer?:WorkerObserver):Promise<void> {
 const started=performance.now();let result:WorkerResult;
 try{result=workerResult(await tick());}
 catch(error){observer?.('failure',Math.max(0,performance.now()-started));throw error;}
 observer?.(result,Math.max(0,performance.now()-started));
}
